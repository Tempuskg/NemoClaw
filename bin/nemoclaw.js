#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { execFileSync, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ---------------------------------------------------------------------------
// Color / style — respects NO_COLOR and non-TTY environments.
// Uses exact NVIDIA green #76B900 on truecolor terminals; 256-color otherwise.
// ---------------------------------------------------------------------------
const _useColor = !process.env.NO_COLOR && !!process.stdout.isTTY;
const _tc =
  _useColor && (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit");
const G = _useColor ? (_tc ? "\x1b[38;2;118;185;0m" : "\x1b[38;5;148m") : "";
const B = _useColor ? "\x1b[1m" : "";
const D = _useColor ? "\x1b[2m" : "";
const R = _useColor ? "\x1b[0m" : "";
const _RD = _useColor ? "\x1b[1;31m" : "";
const {
  ROOT,
  SCRIPTS,
  run,
  runCapture,
  runInteractive,
  shellQuote,
  validateName,
} = require("./lib/runner");
const { resolveOpenshell } = require("./lib/resolve-openshell");
const {
  createSandbox,
  getDashboardForwardStartCommand,
  getDashboardAccessInfo,
  getDashboardGuidanceLines,
  setupInference,
  syncSandboxInferenceConfig,
  startGatewayForRecovery,
} = require("./lib/onboard");
const { getCredential } = require("./lib/credentials");
const registry = require("./lib/registry");
const nim = require("./lib/nim");
const policies = require("./lib/policies");
const backupStore = require("./lib/sandbox-backup");
const { runTelegramProbe } = require("./lib/telegram-diagnostics");
const { parseGatewayInference } = require("./lib/inference-config");
const { getVersion } = require("./lib/version");
const onboardSession = require("./lib/onboard-session");
const { parseLiveSandboxNames } = require("./lib/runtime-recovery");
const { NOTICE_ACCEPT_ENV, NOTICE_ACCEPT_FLAG } = require("./lib/usage-notice");
const { executeDeploy } = require("../dist/lib/deploy");

// ── Global commands ──────────────────────────────────────────────

const GLOBAL_COMMANDS = new Set([
  "onboard",
  "list",
  "deploy",
  "setup",
  "setup-spark",
  "start",
  "stop",
  "status",
  "debug",
  "uninstall",
  "help",
  "--help",
  "-h",
  "--version",
  "-v",
]);

const REMOTE_UNINSTALL_URL =
  "https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh";
let OPENSHELL_BIN = null;
const MIN_LOGS_OPENSHELL_VERSION = "0.0.7";
const NEMOCLAW_GATEWAY_NAME = "nemoclaw";
const DASHBOARD_FORWARD_PORT = "18789";
const GATEWAY_NAME = NEMOCLAW_GATEWAY_NAME;

function getOpenshellBinary() {
  if (!OPENSHELL_BIN) {
    OPENSHELL_BIN = resolveOpenshell();
  }
  if (!OPENSHELL_BIN) {
    console.error("openshell CLI not found. Install OpenShell before using sandbox commands.");
    process.exit(1);
  }
  return OPENSHELL_BIN;
}

function runOpenshell(args, opts = {}) {
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: opts.stdio ?? "inherit",
  });
  if (result.status !== 0 && !opts.ignoreError) {
    console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
    process.exit(result.status || 1);
  }
  return result;
}

function captureOpenshell(args, opts = {}) {
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: { ...process.env, ...opts.env },
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
  };
}

function cleanupGatewayAfterLastSandbox() {
  runOpenshell(["forward", "stop", DASHBOARD_FORWARD_PORT], { ignoreError: true });
  runOpenshell(["gateway", "destroy", "-g", NEMOCLAW_GATEWAY_NAME], { ignoreError: true });
  run(
    `docker volume ls -q --filter "name=openshell-cluster-${NEMOCLAW_GATEWAY_NAME}" | grep . && docker volume ls -q --filter "name=openshell-cluster-${NEMOCLAW_GATEWAY_NAME}" | xargs docker volume rm || true`,
    { ignoreError: true },
  );
}

function hasNoLiveSandboxes() {
  const liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (liveList.status !== 0) {
    return false;
  }
  return parseLiveSandboxNames(liveList.output).size === 0;
}

function isMissingSandboxDeleteResult(output = "") {
  return /\bNotFound\b|\bNot Found\b|sandbox not found|sandbox .* not found|sandbox .* not present|sandbox does not exist|no such sandbox/i.test(
    stripAnsi(output),
  );
}

function getSandboxDeleteOutcome(deleteResult) {
  const output = `${deleteResult.stdout || ""}${deleteResult.stderr || ""}`.trim();
  return {
    output,
    alreadyGone: deleteResult.status !== 0 && isMissingSandboxDeleteResult(output),
  };
}

function parseVersionFromText(value = "") {
  const match = String(value || "").match(/([0-9]+\.[0-9]+\.[0-9]+)/);
  return match ? match[1] : null;
}

function versionGte(left = "0.0.0", right = "0.0.0") {
  const lhs = String(left)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const rhs = String(right)
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(lhs.length, rhs.length);
  for (let index = 0; index < length; index += 1) {
    const a = lhs[index] || 0;
    const b = rhs[index] || 0;
    if (a > b) return true;
    if (a < b) return false;
  }
  return true;
}

function getInstalledOpenshellVersion() {
  const versionResult = captureOpenshell(["--version"], { ignoreError: true });
  return parseVersionFromText(versionResult.output);
}

function stripAnsi(value = "") {
  // eslint-disable-next-line no-control-regex
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function getGatewayClusterContainerName(gatewayName = GATEWAY_NAME) {
  return `openshell-cluster-${gatewayName}`;
}

function isGatewayConnected(statusOutput) {
  return /Status:\s+Connected/i.test(stripAnsi(statusOutput));
}

function hasGatewayConnectFailure(statusOutput) {
  return /(client error \(Connect\)|transport error|tcp connect error|Connection refused|Connection reset by peer)/i.test(
    stripAnsi(statusOutput),
  );
}

function hasSandboxAttachHandshakeFailure(logOutput) {
  return /handshake verification failed/i.test(stripAnsi(logOutput));
}

function getServiceSandboxEnv(listSandboxes = () => registry.listSandboxes()) {
  const { defaultSandbox } = listSandboxes();
  const safeName =
    defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  return safeName ? `SANDBOX_NAME="${safeName}" ` : "";
}

function isOpenShellSandboxAvailable(name, runCaptureFn = runCapture) {
  if (!name) return false;
  const output = runCaptureFn(`openshell sandbox get ${shellQuote(name)} 2>/dev/null`, {
    ignoreError: true,
  });
  return String(output || "").trim().length > 0;
}

function getStatusSandboxes(_options = {}) {
  const listSandboxesFn = _options.listSandboxes || (() => registry.listSandboxes());
  const runCaptureFn = _options.runCapture || runCapture;
  const { sandboxes, defaultSandbox } = listSandboxesFn();
  return {
    defaultSandbox,
    sandboxes: sandboxes.map((sandbox) => ({
      ...sandbox,
      isLive: isOpenShellSandboxAvailable(sandbox.name, runCaptureFn),
    })),
  };
}

function getStaleSandboxWarningLines() {
  return [
    "[stale] present in the local NemoClaw registry only; OpenShell cannot load it.",
    "        Workspace files such as SOUL.md, USER.md, IDENTITY.md, AGENTS.md, and MEMORY.md are no longer available unless you restored a backup.",
    "        Recreate the sandbox with `nemoclaw onboard` or restore workspace files from backup before continuing.",
  ];
}

function printStaleSandboxWarning(sandboxName, action, _options = {}) {
  const errorFn = _options.error || console.error;
  const lines = [
    `  Sandbox '${sandboxName}' is stale; OpenShell cannot ${action} it.`,
    ...getStaleSandboxWarningLines().map((line) => `  ${line}`),
  ];
  for (const line of lines) {
    errorFn(line);
  }
}

function ensureLiveSandboxForAction(sandboxName, action, _options = {}) {
  const isAvailable =
    _options.isAvailable ??
    isOpenShellSandboxAvailable(sandboxName, _options.runCapture || runCapture);
  if (isAvailable) return true;
  printStaleSandboxWarning(sandboxName, action, _options);
  return false;
}

// ── Sandbox process health (OpenClaw gateway inside the sandbox) ─────────

/**
 * Run a command inside the sandbox via SSH and return { status, stdout, stderr }.
 * Returns null if SSH config cannot be obtained.
 */
function executeSandboxCommand(sandboxName, command) {
  const sshConfigResult = captureOpenshell(["sandbox", "ssh-config", sandboxName], {
    ignoreError: true,
  });
  if (sshConfigResult.status !== 0 || !sshConfigResult.output.trim()) return null;

  const tmpFile = path.join(os.tmpdir(), `nemoclaw-ssh-${process.pid}-${Date.now()}.conf`);
  fs.writeFileSync(tmpFile, sshConfigResult.output, { mode: 0o600 });
  try {
    const result = spawnSync(
      "ssh",
      [
        "-F",
        tmpFile,
        "-o",
        "StrictHostKeyChecking=no",
        "-o",
        "UserKnownHostsFile=/dev/null",
        "-o",
        "ConnectTimeout=5",
        "-o",
        "LogLevel=ERROR",
        `openshell-${sandboxName}`,
        command,
      ],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"], timeout: 15000 },
    );
    return {
      status: result.status ?? 1,
      stdout: (result.stdout || "").trim(),
      stderr: (result.stderr || "").trim(),
    };
  } catch {
    return null;
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Check whether the OpenClaw gateway process is running inside the sandbox.
 * Uses the gateway's HTTP endpoint (port 18789) as the source of truth,
 * since the gateway runs as a separate user and pgrep may not see it.
 * Returns true (running), false (stopped), or null (cannot determine).
 */
function isSandboxGatewayRunning(sandboxName) {
  const result = executeSandboxCommand(
    sandboxName,
    "curl -sf --max-time 3 http://127.0.0.1:18789/ > /dev/null 2>&1 && echo RUNNING || echo STOPPED",
  );
  if (!result) return null;
  if (result.stdout === "RUNNING") return true;
  if (result.stdout === "STOPPED") return false;
  return null;
}

/**
 * Restart the OpenClaw gateway process inside the sandbox after a pod restart.
 * Cleans stale lock/temp files, sources proxy config, and launches the gateway
 * in the background. Returns true on success.
 */
function recoverSandboxProcesses(sandboxName) {
  // The recovery script runs as the sandbox user (non-root). This matches
  // the non-root fallback path in nemoclaw-start.sh — no privilege
  // separation, but the gateway runs and inference works.
  const script = [
    // Source proxy config (written to .bashrc by nemoclaw-start on first boot)
    "[ -f ~/.bashrc ] && . ~/.bashrc 2>/dev/null;",
    // Re-check liveness before touching anything — another caller may have
    // already recovered the gateway between our initial check and now (TOCTOU).
    "if curl -sf --max-time 3 http://127.0.0.1:18789/ > /dev/null 2>&1; then echo ALREADY_RUNNING; exit 0; fi;",
    // Clean stale lock files from the previous run (gateway checks these)
    "rm -rf /tmp/openclaw-*/gateway.*.lock 2>/dev/null;",
    // Clean stale temp files from the previous run
    "rm -f /tmp/gateway.log /tmp/auto-pair.log;",
    "touch /tmp/gateway.log; chmod 600 /tmp/gateway.log;",
    "touch /tmp/auto-pair.log; chmod 600 /tmp/auto-pair.log;",
    // Resolve and start gateway
    'OPENCLAW="$(command -v openclaw)";',
    'if [ -z "$OPENCLAW" ]; then echo OPENCLAW_MISSING; exit 1; fi;',
    'nohup "$OPENCLAW" gateway run > /tmp/gateway.log 2>&1 &',
    "GPID=$!; sleep 2;",
    // Verify the gateway actually started (didn't crash immediately)
    'if kill -0 "$GPID" 2>/dev/null; then echo "GATEWAY_PID=$GPID"; else echo GATEWAY_FAILED; cat /tmp/gateway.log 2>/dev/null | tail -5; fi',
  ].join(" ");

  const result = executeSandboxCommand(sandboxName, script);
  if (!result) return false;
  return (
    result.status === 0 &&
    (result.stdout.includes("GATEWAY_PID=") || result.stdout.includes("ALREADY_RUNNING"))
  );
}

/**
 * Re-establish the dashboard port forward (18789) to the sandbox.
 */
function ensureSandboxPortForward(sandboxName) {
  runOpenshell(["forward", "stop", DASHBOARD_FORWARD_PORT], { ignoreError: true });
  runOpenshell(["forward", "start", "--background", DASHBOARD_FORWARD_PORT, sandboxName], {
    ignoreError: true,
  });
}

/**
 * Detect and recover from a sandbox that survived a gateway restart but
 * whose OpenClaw processes are not running. Returns an object describing
 * the outcome: { checked, wasRunning, recovered }.
 */
function checkAndRecoverSandboxProcesses(sandboxName, { quiet = false } = {}) {
  const running = isSandboxGatewayRunning(sandboxName);
  if (running === null) {
    return { checked: false, wasRunning: null, recovered: false };
  }
  if (running) {
    return { checked: true, wasRunning: true, recovered: false };
  }

  // Gateway not running — attempt recovery
  if (!quiet) {
    console.log("");
    console.log("  OpenClaw gateway is not running inside the sandbox (sandbox likely restarted).");
    console.log("  Recovering...");
  }

  const recovered = recoverSandboxProcesses(sandboxName);
  if (recovered) {
    // Wait for gateway to bind its HTTP port before declaring success
    spawnSync("sleep", ["3"]);
    if (isSandboxGatewayRunning(sandboxName) !== true) {
      // Gateway process started but HTTP endpoint never came up
      if (!quiet) {
        console.error("  Gateway process started but is not responding.");
        console.error("  Check /tmp/gateway.log inside the sandbox for details.");
      }
      return { checked: true, wasRunning: false, recovered: false };
    }
    ensureSandboxPortForward(sandboxName);
    if (!quiet) {
      console.log(`  ${G}✓${R} OpenClaw gateway restarted inside sandbox.`);
      console.log(`  ${G}✓${R} Dashboard port forward re-established.`);
    }
  } else if (!quiet) {
    console.error("  Could not restart OpenClaw gateway automatically.");
    console.error("  Connect to the sandbox and run manually:");
    console.error("    nohup openclaw gateway run > /tmp/gateway.log 2>&1 &");
  }

  return { checked: true, wasRunning: false, recovered };
}

function buildRecoveredSandboxEntry(name, metadata = {}) {
  return {
    name,
    model: metadata.model || null,
    provider: metadata.provider || null,
    gpuEnabled: metadata.gpuEnabled === true,
    policies: Array.isArray(metadata.policies)
      ? metadata.policies
      : Array.isArray(metadata.policyPresets)
        ? metadata.policyPresets
        : [],
    nimContainer: metadata.nimContainer || null,
  };
}

function upsertRecoveredSandbox(name, metadata = {}) {
  let validName;
  try {
    validName = validateName(name, "sandbox name");
  } catch {
    return false;
  }

  const entry = buildRecoveredSandboxEntry(validName, metadata);
  if (registry.getSandbox(validName)) {
    registry.updateSandbox(validName, entry);
    return false;
  }
  registry.registerSandbox(entry);
  return true;
}

function shouldRecoverRegistryEntries(current, session, requestedSandboxName) {
  const hasSessionSandbox = Boolean(session?.sandboxName);
  const missingSessionSandbox =
    hasSessionSandbox && !current.sandboxes.some((sandbox) => sandbox.name === session.sandboxName);
  const missingRequestedSandbox =
    Boolean(requestedSandboxName) &&
    !current.sandboxes.some((sandbox) => sandbox.name === requestedSandboxName);
  const hasRecoverySeed =
    current.sandboxes.length > 0 || hasSessionSandbox || Boolean(requestedSandboxName);
  return {
    missingRequestedSandbox,
    shouldRecover:
      hasRecoverySeed &&
      (current.sandboxes.length === 0 || missingRequestedSandbox || missingSessionSandbox),
  };
}

function seedRecoveryMetadata(current, session, requestedSandboxName) {
  const metadataByName = new Map(current.sandboxes.map((sandbox) => [sandbox.name, sandbox]));
  let recoveredFromSession = false;

  if (!session?.sandboxName) {
    return { metadataByName, recoveredFromSession };
  }

  metadataByName.set(
    session.sandboxName,
    buildRecoveredSandboxEntry(session.sandboxName, {
      model: session.model || null,
      provider: session.provider || null,
      nimContainer: session.nimContainer || null,
      policyPresets: session.policyPresets || null,
    }),
  );
  const sessionSandboxMissing = !current.sandboxes.some(
    (sandbox) => sandbox.name === session.sandboxName,
  );
  const shouldRecoverSessionSandbox =
    current.sandboxes.length === 0 ||
    sessionSandboxMissing ||
    requestedSandboxName === session.sandboxName;
  if (shouldRecoverSessionSandbox) {
    recoveredFromSession = upsertRecoveredSandbox(
      session.sandboxName,
      metadataByName.get(session.sandboxName),
    );
  }
  return { metadataByName, recoveredFromSession };
}

async function recoverRegistryFromLiveGateway(metadataByName) {
  if (!resolveOpenshell()) {
    return 0;
  }

  let liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
  if (liveList.status !== 0) {
    const recovery = await recoverNamedGatewayRuntime();
    const canInspectLiveGateway =
      recovery.recovered ||
      recovery.before?.state === "healthy_named" ||
      recovery.after?.state === "healthy_named";
    if (!canInspectLiveGateway) {
      return 0;
    }
    liveList = captureOpenshell(["sandbox", "list"], { ignoreError: true });
    if (liveList.status !== 0) {
      return 0;
    }
  }

  let recoveredFromGateway = 0;
  const liveNames = Array.from(parseLiveSandboxNames(liveList.output));
  for (const name of liveNames) {
    const metadata = metadataByName.get(name) || {};
    if (upsertRecoveredSandbox(name, metadata)) {
      recoveredFromGateway += 1;
    }
  }
  return recoveredFromGateway;
}

function applyRecoveredDefault(currentDefaultSandbox, requestedSandboxName, session) {
  const recovered = registry.listSandboxes();
  const preferredDefault =
    requestedSandboxName || (!currentDefaultSandbox ? session?.sandboxName || null : null);
  if (
    preferredDefault &&
    recovered.sandboxes.some((sandbox) => sandbox.name === preferredDefault)
  ) {
    registry.setDefault(preferredDefault);
  }
  return registry.listSandboxes();
}

async function recoverRegistryEntries({ requestedSandboxName = null } = {}) {
  const current = registry.listSandboxes();
  const session = onboardSession.loadSession();
  const recoveryCheck = shouldRecoverRegistryEntries(current, session, requestedSandboxName);
  if (!recoveryCheck.shouldRecover) {
    return { ...current, recoveredFromSession: false, recoveredFromGateway: 0 };
  }

  const seeded = seedRecoveryMetadata(current, session, requestedSandboxName);
  const shouldProbeLiveGateway = current.sandboxes.length > 0 || Boolean(session?.sandboxName);
  const recoveredFromGateway = shouldProbeLiveGateway
    ? await recoverRegistryFromLiveGateway(seeded.metadataByName)
    : 0;
  const recovered = applyRecoveredDefault(current.defaultSandbox, requestedSandboxName, session);
  return {
    ...recovered,
    recoveredFromSession: seeded.recoveredFromSession,
    recoveredFromGateway,
  };
}

function hasNamedGateway(output = "") {
  return stripAnsi(output).includes("Gateway: nemoclaw");
}

function getActiveGatewayName(output = "") {
  const match = stripAnsi(output).match(/^\s*Gateway:\s+(.+?)\s*$/m);
  return match ? match[1].trim() : "";
}

function getNamedGatewayLifecycleState() {
  const status = captureOpenshell(["status"]);
  const gatewayInfo = captureOpenshell(["gateway", "info", "-g", "nemoclaw"]);
  const cleanStatus = stripAnsi(status.output);
  const activeGateway = getActiveGatewayName(status.output);
  const connected = /^\s*Status:\s*Connected\b/im.test(cleanStatus);
  const named = hasNamedGateway(gatewayInfo.output);
  const refusing = /Connection refused|client error \(Connect\)|tcp connect error/i.test(
    cleanStatus,
  );
  if (connected && activeGateway === "nemoclaw" && named) {
    return { state: "healthy_named", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (activeGateway === "nemoclaw" && named && refusing) {
    return { state: "named_unreachable", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (activeGateway === "nemoclaw" && named) {
    return { state: "named_unhealthy", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  if (connected) {
    return { state: "connected_other", status: status.output, gatewayInfo: gatewayInfo.output };
  }
  return { state: "missing_named", status: status.output, gatewayInfo: gatewayInfo.output };
}

async function recoverNamedGatewayRuntime() {
  const before = getNamedGatewayLifecycleState();
  if (before.state === "healthy_named") {
    return { recovered: true, before, after: before, attempted: false };
  }

  runOpenshell(["gateway", "select", "nemoclaw"], { ignoreError: true });
  let after = getNamedGatewayLifecycleState();
  if (after.state === "healthy_named") {
    process.env.OPENSHELL_GATEWAY = "nemoclaw";
    return { recovered: true, before, after, attempted: true, via: "select" };
  }

  const shouldStartGateway = [before.state, after.state].some((state) =>
    ["missing_named", "named_unhealthy", "named_unreachable", "connected_other"].includes(state),
  );

  if (shouldStartGateway) {
    try {
      await startGatewayForRecovery();
    } catch {
      // Fall through to the lifecycle re-check below so we preserve the
      // existing recovery result shape and emit the correct classification.
    }
    runOpenshell(["gateway", "select", "nemoclaw"], { ignoreError: true });
    after = getNamedGatewayLifecycleState();
    if (after.state === "healthy_named") {
      process.env.OPENSHELL_GATEWAY = "nemoclaw";
      return { recovered: true, before, after, attempted: true, via: "start" };
    }
  }

  return { recovered: false, before, after, attempted: true };
}

function getSandboxGatewayState(sandboxName) {
  const result = captureOpenshell(["sandbox", "get", sandboxName]);
  const output = result.output;
  if (result.status === 0) {
    return { state: "present", output };
  }
  if (/\bNotFound\b|\bNot Found\b|sandbox not found/i.test(output)) {
    return { state: "missing", output };
  }
  if (
    /transport error|Connection refused|handshake verification failed|Missing gateway auth token|device identity required/i.test(
      output,
    )
  ) {
    return { state: "gateway_error", output };
  }
  return { state: "unknown_error", output };
}

function printGatewayLifecycleHint(output = "", sandboxName = "", writer = console.error) {
  const cleanOutput = stripAnsi(output);
  if (/No gateway configured/i.test(cleanOutput)) {
    writer(
      "  The selected NemoClaw gateway is no longer configured or its metadata/runtime has been lost.",
    );
    writer(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before expecting existing sandboxes to reconnect.",
    );
    writer(
      "  If the gateway has to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    return;
  }
  if (
    /Connection refused|client error \(Connect\)|tcp connect error/i.test(cleanOutput) &&
    /Gateway:\s+nemoclaw/i.test(cleanOutput)
  ) {
    writer(
      "  The selected NemoClaw gateway exists in metadata, but its API is refusing connections after restart.",
    );
    writer("  This usually means the gateway runtime did not come back cleanly after the restart.");
    writer(
      "  Retry `openshell gateway start --name nemoclaw`; if it stays in this state, rebuild the gateway before expecting existing sandboxes to reconnect.",
    );
    return;
  }
  if (/handshake verification failed/i.test(cleanOutput)) {
    writer("  This looks like gateway identity drift after restart.");
    writer(
      "  Existing sandboxes may still be recorded locally, but the current gateway no longer trusts their prior connection state.",
    );
    writer(
      "  Try re-establishing the NemoClaw gateway/runtime first. If the sandbox is still unreachable, recreate just that sandbox with `nemoclaw onboard`.",
    );
    return;
  }
  if (/Connection refused|transport error/i.test(cleanOutput)) {
    writer(
      `  The sandbox '${sandboxName}' may still exist, but the current gateway/runtime is not reachable.`,
    );
    writer("  Check `openshell status`, verify the active gateway, and retry.");
    return;
  }
  if (/Missing gateway auth token|device identity required/i.test(cleanOutput)) {
    writer(
      "  The gateway is reachable, but the current auth or device identity state is not usable.",
    );
    writer("  Verify the active gateway and retry after re-establishing the runtime.");
  }
}

// eslint-disable-next-line complexity
async function getReconciledSandboxGatewayState(sandboxName) {
  let lookup = getSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    return lookup;
  }

  if (lookup.state === "gateway_error") {
    const recovery = await recoverNamedGatewayRuntime();
    const retried = getSandboxGatewayState(sandboxName);
    if (retried.state === "present" || retried.state === "missing") {
      return {
        ...retried,
        recoveredGateway: true,
        recoveryVia: recovery.via || (recovery.attempted ? "gateway reattach" : null),
      };
    }
    if (recovery.recovered && /handshake verification failed/i.test(retried.output)) {
      return {
        state: "identity_drift",
        output: retried.output,
        recoveredGateway: true,
        recoveryVia: recovery.via || (recovery.attempted ? "gateway reattach" : null),
      };
    }
    if (recovery.recovered) {
      return {
        ...retried,
        recoveredGateway: true,
        recoveryVia: recovery.via || (recovery.attempted ? "gateway reattach" : null),
      };
    }
    const latestLifecycle = getNamedGatewayLifecycleState();
    const latestStatus = stripAnsi(latestLifecycle.status || "");
    if (/No gateway configured/i.test(latestStatus)) {
      return {
        state: "gateway_missing_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (
      /Connection refused|client error \(Connect\)|tcp connect error/i.test(latestStatus) &&
      /Gateway:\s+nemoclaw/i.test(latestStatus)
    ) {
      return {
        state: "gateway_unreachable_after_restart",
        output: latestLifecycle.status || lookup.output,
      };
    }
    if (
      recovery.after?.state === "named_unreachable" ||
      recovery.before?.state === "named_unreachable"
    ) {
      return {
        state: "gateway_unreachable_after_restart",
        output: recovery.after?.status || recovery.before?.status || lookup.output,
      };
    }
    return { ...lookup, gatewayRecoveryFailed: true };
  }

  return lookup;
}

async function ensureLiveSandboxOrExit(sandboxName) {
  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    return lookup;
  }
  if (lookup.state === "missing") {
    registry.removeSandbox(sandboxName);
    console.error(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
    console.error("  Removed stale local registry entry.");
    console.error(
      "  Run `nemoclaw list` to confirm the remaining sandboxes, or `nemoclaw onboard` to create a new one.",
    );
    process.exit(1);
  }
  if (lookup.state === "identity_drift") {
    console.error(
      `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
    );
    console.error(
      "  Recreate this sandbox with `nemoclaw onboard` once the gateway runtime is stable.",
    );
    process.exit(1);
  }
  if (lookup.state === "gateway_unreachable_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist, but the selected NemoClaw gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.error(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
    process.exit(1);
  }
  if (lookup.state === "gateway_missing_after_restart") {
    console.error(
      `  Sandbox '${sandboxName}' may still exist locally, but the NemoClaw gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.error(lookup.output);
    }
    console.error(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.error(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
    process.exit(1);
  }
  console.error(`  Unable to verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
  if (lookup.output) {
    console.error(lookup.output);
  }
  printGatewayLifecycleHint(lookup.output, sandboxName);
  console.error("  Check `openshell status` and the active gateway, then retry.");
  process.exit(1);
}

function printOldLogsCompatibilityGuidance(installedVersion = null) {
  const versionText = installedVersion ? ` (${installedVersion})` : "";
  console.error(
    `  Installed OpenShell${versionText} is too old or incompatible with \`nemoclaw logs\`.`,
  );
  console.error(`  NemoClaw expects \`openshell logs <name>\` and live streaming via \`--tail\`.`);
  console.error(
    "  Upgrade OpenShell by rerunning `nemoclaw onboard`, or reinstall the OpenShell CLI and try again.",
  );
}

function resolveUninstallScript() {
  const candidates = [path.join(ROOT, "uninstall.sh"), path.join(__dirname, "..", "uninstall.sh")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

function exitWithSpawnResult(result) {
  if (result.status !== null) {
    process.exit(result.status);
  }

  if (result.signal) {
    const signalNumber = os.constants.signals[result.signal];
    process.exit(signalNumber ? 128 + signalNumber : 1);
  }

  process.exit(1);
}

function waitForGatewayConnection(attempts = 15, delaySeconds = 2) {
  for (let i = 0; i < attempts; i += 1) {
    const status = runCapture("openshell status 2>&1", { ignoreError: true });
    if (isGatewayConnected(status)) {
      return true;
    }
    spawnSync("sleep", [String(delaySeconds)]);
  }
  return false;
}

function resumeStoppedGateway() {
  const containerName = getGatewayClusterContainerName();
  const containers = runCapture("docker ps -a --format '{{.Names}}\t{{.Status}}'", {
    ignoreError: true,
  });
  const containerLine = containers
    .split("\n")
    .find((line) => line.startsWith(`${containerName}\t`));

  if (!containerLine) {
    return false;
  }

  if (containerLine.includes("\tUp ")) {
    return waitForGatewayConnection();
  }

  if (!/(\tExited|\tCreated|\tDead)/.test(containerLine)) {
    return false;
  }

  const startResult = spawnSync("docker", ["start", containerName], {
    cwd: ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (startResult.status !== 0) {
    return false;
  }

  return waitForGatewayConnection();
}

function _ensureSandboxGatewayReachable() {
  const status = runCapture("openshell status 2>&1", { ignoreError: true });
  if (isGatewayConnected(status)) {
    return;
  }

  if (hasGatewayConnectFailure(status) && resumeStoppedGateway()) {
    console.log(`  ✓ Resumed OpenShell gateway '${GATEWAY_NAME}'`);
    return;
  }

  console.error("");
  console.error(`  OpenShell gateway '${GATEWAY_NAME}' is not reachable.`);
  console.error("  NemoClaw cannot connect to a sandbox until the local gateway is healthy.");
  console.error("");
  console.error("  Check:       openshell status");
  console.error(`  Recover:     docker start ${getGatewayClusterContainerName()}`);
  console.error(`  Fallback:    openshell gateway start --name ${GATEWAY_NAME}`);
  console.error("");
  if (status) {
    console.error("  OpenShell reported:");
    console.error(
      status
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  }
  process.exit(1);
}

function ensureSandboxGatewayForRestore(options = {}) {
  const errorFn = options.error || console.error;
  const status = runCapture("openshell status 2>&1", { ignoreError: true });
  if (isGatewayConnected(status)) {
    return true;
  }

  if (hasGatewayConnectFailure(status) && resumeStoppedGateway()) {
    console.log(`  ✓ Resumed OpenShell gateway '${GATEWAY_NAME}'`);
    return true;
  }

  const startResult = run(`openshell gateway start --name ${GATEWAY_NAME} 2>&1`, {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  if (startResult.status === 0 && waitForGatewayConnection()) {
    console.log(`  ✓ Started OpenShell gateway '${GATEWAY_NAME}'`);
    return true;
  }

  const output = [status, startResult.stdout, startResult.stderr].filter(Boolean).join("\n").trim();
  errorFn(`  Could not start OpenShell gateway '${GATEWAY_NAME}' for restore.`);
  if (output) {
    errorFn(
      output
        .split("\n")
        .map((line) => `    ${line}`)
        .join("\n"),
    );
  }
  throw new Error(`OpenShell gateway '${GATEWAY_NAME}' is not reachable.`);
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function parseBackupActionArgs(args) {
  const parsed = { label: null, list: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--list") {
      parsed.list = true;
      continue;
    }
    if (arg === "--label") {
      const label = args[i + 1];
      if (!label) {
        throw new Error("Missing value for --label.");
      }
      parsed.label = label;
      i += 1;
      continue;
    }
    throw new Error(`Unknown backup option: ${arg}`);
  }
  return parsed;
}

function parseRestoreActionArgs(args) {
  if (args.length > 1) {
    throw new Error("Usage: nemoclaw <name> restore [backup-id]");
  }
  if (args[0] && args[0].startsWith("-")) {
    throw new Error(`Unknown restore option: ${args[0]}`);
  }
  return { backupId: args[0] || null };
}

function hydrateRestoreCredentialEnv(provider) {
  const credentialMap = {
    "nvidia-nim": "NVIDIA_API_KEY",
    "nvidia-prod": "NVIDIA_API_KEY",
  };
  const credentialName = credentialMap[provider];
  if (!credentialName) return;
  const credentialValue = getCredential(credentialName);
  if (credentialValue) {
    process.env[credentialName] = credentialValue;
  }
}

async function configureSandboxFromBackupManifest(sandboxName, manifest, _options = {}) {
  const currentEntry = registry.getSandbox(sandboxName) || {};
  const manifestEntry = (manifest && manifest.registry) || {};
  const registryEntry = {
    ...currentEntry,
    ...manifestEntry,
    model: manifestEntry.model || currentEntry.model || null,
    provider: manifestEntry.provider || currentEntry.provider || null,
    providerBaseUrl: manifestEntry.providerBaseUrl || currentEntry.providerBaseUrl || null,
  };
  if (!registryEntry.provider && !registryEntry.model && !(registryEntry.policies || []).length)
    return;

  await configureSandboxProviderAndModel(sandboxName, registryEntry);
  configureSandboxPolicies(sandboxName, registryEntry);
  updateOrRegisterSandbox(sandboxName, registryEntry);
}

async function configureSandboxProviderAndModel(sandboxName, registryEntry) {
  if (registryEntry.provider && registryEntry.model) {
    hydrateRestoreCredentialEnv(registryEntry.provider);
    const { modelMetadata } = await setupInference(
      sandboxName,
      registryEntry.model,
      registryEntry.provider,
      {
        allowWarmupFailure: true,
        providerBaseUrl: registryEntry.providerBaseUrl || null,
      },
    );
    await syncSandboxInferenceConfig(sandboxName, registryEntry.model, registryEntry.provider, {
      modelMetadata,
      providerBaseUrl: registryEntry.providerBaseUrl || null,
    });
  }
}

function configureSandboxPolicies(sandboxName, registryEntry) {
  for (const presetName of registryEntry.policies || []) {
    policies.applyPreset(sandboxName, presetName);
  }
}

function updateOrRegisterSandbox(sandboxName, registryEntry) {
  const updatedEntry = registry.getSandbox(sandboxName);
  const mergedEntry = {
    ...(updatedEntry || {}),
    ...(registryEntry || {}),
    name: sandboxName,
    createdAt: (updatedEntry && updatedEntry.createdAt) || registryEntry.createdAt,
  };
  if (updatedEntry) {
    registry.updateSandbox(sandboxName, mergedEntry);
  } else {
    registry.registerSandbox(mergedEntry);
  }
}

function printSandboxBackups(sandboxName, listBackupsFn = backupStore.listBackups) {
  const backups = listBackupsFn(sandboxName);
  console.log("");
  if (backups.length === 0) {
    console.log(`  No backups found for sandbox '${sandboxName}'.`);
    console.log("");
    return backups;
  }

  console.log(`  Backups for sandbox '${sandboxName}':`);
  for (const backup of backups) {
    const date = backup.createdAt
      ? backup.createdAt.replace("T", " ").replace(/\.\d+Z$/, "Z")
      : "unknown";
    console.log(`    ${backup.id.padEnd(24)}${date}  ${formatBytes(backup.sizeBytes)}`);
  }
  console.log("");
  return backups;
}

function sandboxBackup(sandboxName, actionArgs = [], options = {}) {
  const errorFn = options.error || console.error;
  const exitFn = options.exit === undefined ? process.exit : options.exit;
  const createBackupFn = options.createBackup || backupStore.createBackup;
  const listBackupsFn = options.listBackups || backupStore.listBackups;

  try {
    const parsed = parseBackupActionArgs(actionArgs);
    if (parsed.list) {
      return printSandboxBackups(sandboxName, listBackupsFn);
    }

    if (!ensureLiveSandboxForAction(sandboxName, "back up", options)) {
      if (exitFn) {
        exitFn(1);
      }
      return false;
    }

    console.log("");
    console.log(`  Creating backup for sandbox '${sandboxName}'...`);
    const result = createBackupFn(sandboxName, { label: parsed.label });
    console.log(`  ✓ Backup saved to ${result.backupDir}`);
    console.log(
      `  Archive: ${path.basename(result.archivePath)} (${formatBytes(result.sizeBytes)})`,
    );
    console.log("");
    return result;
  } catch (error) {
    errorFn(`  ${error.message}`);
    if (exitFn) {
      exitFn(1);
    }
    return false;
  }
}

async function sandboxRestore(sandboxName, actionArgs = [], _options = {}) {
  const errorFn = _options.error || console.error;
  const exitFn = _options.exit === undefined ? process.exit : _options.exit;
  const promptFn = _options.prompt || require("./lib/credentials").prompt;
  const resolveBackupFn = _options.resolveBackup || backupStore.resolveBackup;
  const restoreBackupFn = _options.restoreBackup || backupStore.restoreBackup;
  const createSandboxFn = _options.createSandbox || createSandbox;
  const configureSandboxFn = _options.configureSandbox || configureSandboxFromBackupManifest;
  const ensureGatewayFn = _options.ensureGateway || ensureSandboxGatewayForRestore;

  try {
    const parsed = parseRestoreActionArgs(actionArgs);
    const selectedBackup = resolveBackupFn(sandboxName, parsed.backupId);
    const manifest = selectedBackup.manifest || backupStore.readManifest(selectedBackup.path);
    const isLive =
      _options.isAvailable ??
      isOpenShellSandboxAvailable(sandboxName, _options.runCapture || runCapture);

    if (isLive) {
      if (!(await confirmRestoreOverwrite(promptFn, sandboxName, selectedBackup.id))) {
        return false;
      }
    } else {
      await _restoreCreateSandbox(
        ensureGatewayFn,
        createSandboxFn,
        manifest,
        sandboxName,
        selectedBackup.id,
      );
    }

    await _restoreBackupAndConfigure(
      restoreBackupFn,
      configureSandboxFn,
      sandboxName,
      selectedBackup,
      manifest,
    );
    return { sandboxName, backupId: selectedBackup.id, recreated: !isLive };
  } catch (error) {
    errorFn(`  ${error.message}`);
    if (exitFn) {
      exitFn(1);
    }
    return false;
  }
}

async function _restoreCreateSandbox(
  ensureGatewayFn,
  createSandboxFn,
  manifest,
  sandboxName,
  backupId,
) {
  ensureGatewayFn();
  console.log("");
  console.log(`  Recreating sandbox '${sandboxName}' from backup '${backupId}'...`);
  await createSandboxFn(
    Boolean(manifest && manifest.registry && manifest.registry.gpuEnabled),
    null,
    null,
    null,
    sandboxName,
  );
}

async function _restoreBackupAndConfigure(
  restoreBackupFn,
  configureSandboxFn,
  sandboxName,
  selectedBackup,
  manifest,
) {
  console.log(`  Restoring backup '${selectedBackup.id}' into sandbox '${sandboxName}'...`);
  restoreBackupFn(sandboxName, selectedBackup.path);
  await configureSandboxFn(sandboxName, manifest || {}, { backupDir: selectedBackup.path });
  console.log(`  ✓ Restored backup '${selectedBackup.id}' into sandbox '${sandboxName}'`);
  console.log("");
}

async function confirmRestoreOverwrite(promptFn, sandboxName, backupId) {
  console.log("");
  console.log(`  Restore will overwrite files inside sandbox '${sandboxName}'.`);
  const confirm = await promptFn(`  Type RESTORE to continue restoring '${backupId}': `);
  if (confirm !== "RESTORE") {
    console.log("  Cancelled.");
    console.log("");
    return false;
  }
  return true;
}

function _explainSandboxConnectFailure(sandboxName, result) {
  const recentLogs = runCapture(`openshell logs "${sandboxName}" 2>&1 | tail -n 80`, {
    ignoreError: true,
  });

  if (hasSandboxAttachHandshakeFailure(recentLogs)) {
    console.error("");
    console.error(
      `  OpenShell reached sandbox '${sandboxName}', but the shell attach handshake was rejected.`,
    );
    console.error(
      "  This usually happens when an older sandbox is reused after the gateway session changed.",
    );
    console.error("");
    console.error(`  Workaround:  openshell sandbox connect --editor vscode "${sandboxName}"`);
    console.error("  Recovery:    nemoclaw onboard");
    console.error(
      `               Then choose 'y' if prompted to recreate sandbox '${sandboxName}'.`,
    );
    exitWithSpawnResult(result);
  }

  console.error(
    `  Command failed (exit ${result.status}): openshell sandbox connect "${sandboxName}"`,
  );
  exitWithSpawnResult(result);
}

// ── Commands ─────────────────────────────────────────────────────

async function onboard(args) {
  const { onboard: runOnboard } = require("./lib/onboard");
  const allowedArgs = new Set(["--non-interactive", "--resume", NOTICE_ACCEPT_FLAG]);
  const unknownArgs = args.filter((arg) => !allowedArgs.has(arg));
  if (unknownArgs.length > 0) {
    console.error(`  Unknown onboard option(s): ${unknownArgs.join(", ")}`);
    console.error(
      `  Usage: nemoclaw onboard [--non-interactive] [--resume] [${NOTICE_ACCEPT_FLAG}]`,
    );
    process.exit(1);
  }
  const nonInteractive = args.includes("--non-interactive");
  const resume = args.includes("--resume");
  const acceptThirdPartySoftware =
    args.includes(NOTICE_ACCEPT_FLAG) || String(process.env[NOTICE_ACCEPT_ENV] || "") === "1";
  await runOnboard({ nonInteractive, resume, acceptThirdPartySoftware });
}

async function setup(args = []) {
  console.log("");
  console.log("  ⚠  `nemoclaw setup` is deprecated. Use `nemoclaw onboard` instead.");
  console.log("");
  await onboard(args);
}

async function setupSpark(args = []) {
  console.log("");
  console.log("  ⚠  `nemoclaw setup-spark` is deprecated.");
  console.log("  Current OpenShell releases handle the old DGX Spark cgroup issue themselves.");
  console.log("  Use `nemoclaw onboard` instead.");
  console.log("");
  await onboard(args);
}

async function deploy(instanceName) {
  await executeDeploy({
    instanceName,
    env: process.env,
    rootDir: ROOT,
    getCredential,
    validateName,
    shellQuote,
    run,
    runInteractive,
    execFileSync: (file, args, opts = {}) =>
      String(execFileSync(file, args, { encoding: "utf-8", ...opts })),
    spawnSync,
    log: console.log,
    error: console.error,
    stdoutWrite: (message) => process.stdout.write(message),
    exit: (code) => process.exit(code),
  });
}

async function start() {
  const { startAll } = require("./lib/services");
  const { defaultSandbox } = registry.listSandboxes();
  const safeName =
    defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  await startAll({ sandboxName: safeName || undefined });
}

function stop() {
  const { stopAll } = require("./lib/services");
  const { defaultSandbox } = registry.listSandboxes();
  const safeName =
    defaultSandbox && /^[a-zA-Z0-9._-]+$/.test(defaultSandbox) ? defaultSandbox : null;
  stopAll({ sandboxName: safeName || undefined });
}

function debug(args) {
  const { runDebug } = require("./lib/debug");
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--help":
      case "-h":
        console.log("Collect NemoClaw diagnostic information\n");
        console.log("Usage: nemoclaw debug [--quick] [--output FILE] [--sandbox NAME]\n");
        console.log("Options:");
        console.log("  --quick, -q        Only collect minimal diagnostics");
        console.log("  --output, -o FILE  Write a tarball to FILE");
        console.log("  --sandbox NAME     Target sandbox name");
        process.exit(0);
        break;
      case "--quick":
      case "-q":
        opts.quick = true;
        break;
      case "--output":
      case "-o":
        if (!args[i + 1] || args[i + 1].startsWith("-")) {
          console.error("Error: --output requires a file path argument");
          process.exit(1);
        }
        opts.output = args[++i];
        break;
      case "--sandbox":
        if (!args[i + 1] || args[i + 1].startsWith("-")) {
          console.error("Error: --sandbox requires a name argument");
          process.exit(1);
        }
        opts.sandboxName = args[++i];
        break;
      default:
        console.error(`Unknown option: ${args[i]}`);
        process.exit(1);
    }
  }
  if (!opts.sandboxName) {
    opts.sandboxName = registry.listSandboxes().defaultSandbox || undefined;
  }
  runDebug(opts);
}

function uninstall(args) {
  const localScript = resolveUninstallScript();
  if (localScript) {
    console.log(`  Running local uninstall script: ${localScript}`);
    const result = spawnSync("bash", [localScript, ...args], {
      stdio: "inherit",
      cwd: ROOT,
      env: process.env,
    });
    exitWithSpawnResult(result);
  }

  // Download to file before execution — prevents partial-download execution.
  // Upstream URL is a rolling release so SHA-256 pinning isn't practical.
  console.log(`  Local uninstall script not found; falling back to ${REMOTE_UNINSTALL_URL}`);
  const uninstallDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-uninstall-"));
  const uninstallScript = path.join(uninstallDir, "uninstall.sh");
  let result;
  let downloadFailed = false;
  try {
    try {
      execFileSync("curl", ["-fsSL", REMOTE_UNINSTALL_URL, "-o", uninstallScript], {
        stdio: "inherit",
      });
    } catch {
      console.error(`  Failed to download uninstall script from ${REMOTE_UNINSTALL_URL}`);
      downloadFailed = true;
    }
    if (!downloadFailed) {
      result = spawnSync("bash", [uninstallScript, ...args], {
        stdio: "inherit",
        cwd: ROOT,
        env: process.env,
      });
    }
  } finally {
    fs.rmSync(uninstallDir, { recursive: true, force: true });
  }
  if (downloadFailed) process.exit(1);
  exitWithSpawnResult(result);
}

function showStatus(_options = {}) {
  const runFn = _options.run || run;
  // Show sandbox registry
  const { sandboxes, defaultSandbox } = getStatusSandboxes(_options);
  if (sandboxes.length > 0) {
    console.log("");
    console.log("  Sandboxes:");
    for (const sb of sandboxes) {
      const def = sb.name === defaultSandbox ? " *" : "";
      const model = sb.model ? ` (${sb.model})` : "";
      const stale = sb.isLive ? "" : " [stale]";
      console.log(`    ${sb.name}${def}${model}${stale}`);
    }
    if (sandboxes.some((sb) => !sb.isLive)) {
      for (const line of getStaleSandboxWarningLines()) {
        console.log(`    ${line}`);
      }
    }
    console.log("");
  }

  // Show service status
  const liveSandboxes = sandboxes.filter((sandbox) => sandbox.isLive);
  const liveDefaultSandbox = liveSandboxes.some((sandbox) => sandbox.name === defaultSandbox)
    ? defaultSandbox
    : liveSandboxes[0]?.name || null;
  const sandboxEnv = getServiceSandboxEnv(() => ({
    sandboxes: liveSandboxes,
    defaultSandbox: liveDefaultSandbox,
  }));
  runFn(`${sandboxEnv}bash "${SCRIPTS}/start-services.sh" --status`);
}

async function listSandboxes() {
  const recovery = await recoverRegistryEntries();
  const { sandboxes, defaultSandbox } = recovery;
  if (sandboxes.length === 0) {
    console.log("");
    const session = onboardSession.loadSession();
    if (session?.sandboxName) {
      console.log(
        `  No sandboxes registered locally, but the last onboarded sandbox was '${session.sandboxName}'.`,
      );
      console.log(
        "  Retry `nemoclaw <name> connect` or `nemoclaw <name> status` once the gateway/runtime is healthy.",
      );
    } else {
      console.log("  No sandboxes registered. Run `nemoclaw onboard` to get started.");
    }
    console.log("");
    return;
  }

  // Query live gateway inference once; prefer it over stale registry values.
  const live = parseGatewayInference(
    captureOpenshell(["inference", "get"], { ignoreError: true }).output,
  );

  console.log("");
  if (recovery.recoveredFromSession) {
    console.log("  Recovered sandbox inventory from the last onboard session.");
    console.log("");
  }
  if (recovery.recoveredFromGateway > 0) {
    console.log(
      `  Recovered ${recovery.recoveredFromGateway} sandbox entr${recovery.recoveredFromGateway === 1 ? "y" : "ies"} from the live OpenShell gateway.`,
    );
    console.log("");
  }
  console.log("  Sandboxes:");
  for (const sb of sandboxes) {
    const def = sb.name === defaultSandbox ? " *" : "";
    const model = (live && live.model) || sb.model || "unknown";
    const provider = (live && live.provider) || sb.provider || "unknown";
    const gpu = sb.gpuEnabled ? "GPU" : "CPU";
    const presets = sb.policies && sb.policies.length > 0 ? sb.policies.join(", ") : "none";
    console.log(`    ${sb.name}${def}`);
    console.log(`      model: ${model}  provider: ${provider}  ${gpu}  policies: ${presets}`);
  }
  console.log("");
  console.log("  * = default sandbox");
  console.log("");
}

// ── Sandbox-scoped actions ───────────────────────────────────────

async function sandboxConnect(sandboxName) {
  await ensureLiveSandboxOrExit(sandboxName);
  const result = spawnSync(getOpenshellBinary(), ["sandbox", "connect", sandboxName], {
    stdio: [process.stdin.isTTY ? "inherit" : "ignore", "pipe", "pipe"],
    cwd: ROOT,
    env: process.env,
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  exitWithSpawnResult(result);
}

// eslint-disable-next-line complexity
async function sandboxStatus(sandboxName) {
  const sb = registry.getSandbox(sandboxName);
  const live = parseGatewayInference(
    captureOpenshell(["inference", "get"], { ignoreError: true }).output,
  );
  if (sb) {
    console.log("");
    console.log(`  Sandbox: ${sb.name}`);
    console.log(`    Model:    ${(live && live.model) || sb.model || "unknown"}`);
    console.log(`    Provider: ${(live && live.provider) || sb.provider || "unknown"}`);
    console.log(`    GPU:      ${sb.gpuEnabled ? "yes" : "no"}`);
    console.log(`    Policies: ${(sb.policies || []).join(", ") || "none"}`);
  }

  const lookup = await getReconciledSandboxGatewayState(sandboxName);
  if (lookup.state === "present") {
    console.log("");
    if (lookup.recoveredGateway) {
      console.log(
        `  Recovered NemoClaw gateway runtime via ${lookup.recoveryVia || "gateway reattach"}.`,
      );
      console.log("");
    }
    console.log(lookup.output);
  } else if (lookup.state === "missing") {
    registry.removeSandbox(sandboxName);
    console.log("");
    console.log(`  Sandbox '${sandboxName}' is not present in the live OpenShell gateway.`);
    console.log("  Removed stale local registry entry.");
  } else if (lookup.state === "identity_drift") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' is recorded locally, but the gateway trust material rotated after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Existing sandbox connections cannot be reattached safely after this gateway identity change.",
    );
    console.log(
      "  Recreate this sandbox with `nemoclaw onboard` once the gateway runtime is stable.",
    );
  } else if (lookup.state === "gateway_unreachable_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist, but the selected NemoClaw gateway is still refusing connections after restart.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Retry `openshell gateway start --name nemoclaw` and verify `openshell status` is healthy before reconnecting.",
    );
    console.log(
      "  If the gateway never becomes healthy, rebuild the gateway and then recreate the affected sandbox.",
    );
  } else if (lookup.state === "gateway_missing_after_restart") {
    console.log("");
    console.log(
      `  Sandbox '${sandboxName}' may still exist locally, but the NemoClaw gateway is no longer configured after restart/rebuild.`,
    );
    if (lookup.output) {
      console.log(lookup.output);
    }
    console.log(
      "  Start the gateway again with `openshell gateway start --name nemoclaw` before retrying.",
    );
    console.log(
      "  If the gateway had to be rebuilt from scratch, recreate the affected sandbox afterward.",
    );
  } else {
    console.log("");
    console.log(`  Could not verify sandbox '${sandboxName}' against the live OpenShell gateway.`);
    if (lookup.output) {
      console.log(lookup.output);
    }
    printGatewayLifecycleHint(lookup.output, sandboxName, console.log);
  }

  // OpenClaw process health inside the sandbox
  if (lookup.state === "present") {
    const processCheck = checkAndRecoverSandboxProcesses(sandboxName, { quiet: true });
    if (processCheck.checked) {
      if (processCheck.wasRunning) {
        console.log(`    OpenClaw: ${G}running${R}`);
      } else if (processCheck.recovered) {
        console.log(`    OpenClaw: ${G}recovered${R} (gateway restarted after sandbox restart)`);
      } else {
        console.log(`    OpenClaw: ${_RD}not running${R}`);
        console.log("");
        console.log("  The sandbox is alive but the OpenClaw gateway process is not running.");
        console.log("  This typically happens after a gateway restart (e.g., laptop close/open).");
        console.log("");
        console.log("  To recover, run:");
        console.log(`    ${D}nemoclaw ${sandboxName} connect${R}  (auto-recovers on connect)`);
        console.log("  Or manually inside the sandbox:");
        console.log(`    ${D}nohup openclaw gateway run > /tmp/gateway.log 2>&1 &${R}`);
      }
    }
  }

  // NIM health
  const nimStat =
    sb && sb.nimContainer ? nim.nimStatusByName(sb.nimContainer) : nim.nimStatus(sandboxName);
  console.log(
    `    NIM:      ${nimStat.running ? `running (${nimStat.container})` : "not running"}`,
  );
  if (nimStat.running) {
    console.log(`    Healthy:  ${nimStat.healthy ? "yes" : "no"}`);
  }
  console.log("");
}

function sandboxLogs(sandboxName, follow) {
  const installedVersion = getInstalledOpenshellVersion();
  if (installedVersion && !versionGte(installedVersion, MIN_LOGS_OPENSHELL_VERSION)) {
    printOldLogsCompatibilityGuidance(installedVersion);
    process.exit(1);
  }

  const args = ["logs", sandboxName];
  if (follow) args.push("--tail");
  const result = spawnSync(getOpenshellBinary(), args, {
    cwd: ROOT,
    env: process.env,
    encoding: "utf-8",
    stdio: follow ? ["ignore", "inherit", "pipe"] : ["ignore", "pipe", "pipe"],
  });
  const stdout = String(result.stdout || "");
  const stderr = String(result.stderr || "");
  const combined = `${stdout}${stderr}`;
  if (!follow && stdout) {
    process.stdout.write(stdout);
  }
  if (result.status === 0) {
    return;
  }
  if (stderr) {
    process.stderr.write(stderr);
  }
  if (
    /unrecognized subcommand 'logs'|unexpected argument '--tail'|unexpected argument '--follow'/i.test(
      combined,
    ) ||
    (installedVersion && !versionGte(installedVersion, MIN_LOGS_OPENSHELL_VERSION))
  ) {
    printOldLogsCompatibilityGuidance(installedVersion);
    process.exit(1);
  }
  if (result.status === null || result.signal) {
    exitWithSpawnResult(result);
  }
  console.error(`  Command failed (exit ${result.status}): openshell ${args.join(" ")}`);
  exitWithSpawnResult(result);
}

async function sandboxPolicyAdd(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  const { prompt: askPrompt } = require("./lib/credentials");
  const answer = await policies.selectFromList(allPresets, { applied });
  if (!answer) return;

  const confirm = await askPrompt(`  Apply '${answer}' to sandbox '${sandboxName}'? [Y/n]: `);
  if (confirm.toLowerCase() === "n") return;

  policies.applyPreset(sandboxName, answer);
}

function sandboxPolicyList(sandboxName) {
  const allPresets = policies.listPresets();
  const applied = policies.getAppliedPresets(sandboxName);

  console.log("");
  console.log(`  Policy presets for sandbox '${sandboxName}':`);
  allPresets.forEach((p) => {
    const marker = applied.includes(p.name) ? "●" : "○";
    console.log(`    ${marker} ${p.name} — ${p.description}`);
  });
  console.log("");
}

function sandboxDashboard(sandboxName) {
  if (!ensureLiveSandboxForAction(sandboxName, "open the dashboard for")) {
    process.exit(1);
  }
  // Ensure dashboard forward is alive before printing links.
  run(`openshell forward stop 18789 "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
  run(`${getDashboardForwardStartCommand(sandboxName)} 2>/dev/null || true`, { ignoreError: true });

  const dashboardAccess = getDashboardAccessInfo(sandboxName);
  const dashboardGuidance = getDashboardGuidanceLines(dashboardAccess);
  console.log("");
  console.log(`  ${"─".repeat(50)}`);
  for (const access of dashboardAccess) {
    console.log(`  ${access.label.padEnd(12)}${access.url}`);
  }
  for (const guidance of dashboardGuidance) {
    console.log(`  ${guidance}`);
  }
  console.log(`  ${"─".repeat(50)}`);
  console.log("");
}

// eslint-disable-next-line complexity
async function sandboxDestroy(sandboxName, args = []) {
  const optionBag = typeof args === "object" && args !== null && !Array.isArray(args) ? args : {};
  const flagArgs = Array.isArray(args) ? args : [];
  const promptFn = optionBag.prompt || require("./lib/credentials").prompt;
  const runFn = optionBag.run || null;
  const stopNimFn = optionBag.stopNim || null;
  const removeSandboxFn = optionBag.removeSandbox || ((name) => registry.removeSandbox(name));
  const hasExplicitAvailability = Object.prototype.hasOwnProperty.call(optionBag, "isAvailable");
  const skipConfirm = flagArgs.includes("--yes") || flagArgs.includes("--force");
  const isLive = hasExplicitAvailability ? optionBag.isAvailable : true;

  console.log("");

  if (hasExplicitAvailability && !isLive) {
    for (const line of getStaleSandboxWarningLines()) {
      console.log(`  ${line}`);
    }
    if (!skipConfirm) {
      const answer = await promptFn(
        `  Remove stale local sandbox entry '${sandboxName}' from the NemoClaw registry? [y/N]: `,
      );
      if (!/^y(es)?$/i.test(answer || "")) {
        console.log("  Cancelled.");
        console.log("");
        return false;
      }
    }
    const removed = removeSandboxFn(sandboxName);
    if (removed && registry.listSandboxes().sandboxes.length === 0 && hasNoLiveSandboxes()) {
      cleanupGatewayAfterLastSandbox();
    }
    console.log(`  Removed stale sandbox entry '${sandboxName}' from the local registry`);
    console.log("");
    return true;
  }

  if (!skipConfirm) {
    console.log(
      `  Warning: destroying sandbox '${sandboxName}' permanently deletes workspace files.`,
    );
    console.log(
      "  This includes SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes.",
    );
    console.log(
      `  Run 'nemoclaw ${sandboxName} backup' before continuing if you need to keep those customizations.`,
    );
    const answer = await promptFn(
      `  Type DESTROY to permanently delete sandbox '${sandboxName}': `,
    );
    if (answer !== "DESTROY") {
      console.log("  Cancelled.");
      console.log("");
      return false;
    }
  }

  console.log(`  Stopping NIM for '${sandboxName}'...`);
  const sb = registry.getSandbox(sandboxName);
  if (stopNimFn) {
    stopNimFn(sandboxName);
  } else if (sb && sb.nimContainer) {
    nim.stopNimContainerByName(sb.nimContainer);
  } else {
    nim.stopNimContainer(sandboxName);
  }

  console.log(`  Deleting sandbox '${sandboxName}'...`);
  if (runFn) {
    runFn(`openshell sandbox delete "${sandboxName}" 2>/dev/null || true`, { ignoreError: true });
    removeSandboxFn(sandboxName);
    console.log(`  Sandbox '${sandboxName}' destroyed`);
    console.log("");
    return true;
  }

  const deleteResult = runOpenshell(["sandbox", "delete", sandboxName], {
    ignoreError: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { output: deleteOutput, alreadyGone } = getSandboxDeleteOutcome(deleteResult);

  if (deleteResult.status !== 0 && !alreadyGone) {
    if (deleteOutput) {
      console.error(`  ${deleteOutput}`);
    }
    console.error(`  Failed to destroy sandbox '${sandboxName}'.`);
    process.exit(deleteResult.status || 1);
  }

  const removed = removeSandboxFn(sandboxName);
  if (
    (deleteResult.status === 0 || alreadyGone) &&
    removed &&
    registry.listSandboxes().sandboxes.length === 0 &&
    hasNoLiveSandboxes()
  ) {
    cleanupGatewayAfterLastSandbox();
  }
  if (alreadyGone) {
    console.log(`  Sandbox '${sandboxName}' was already absent from the live gateway.`);
  }
  console.log(`  ${G}✓${R} Sandbox '${sandboxName}' destroyed`);
  console.log("");
  return true;
}

// ── Help ─────────────────────────────────────────────────────────

function help() {
  console.log(`
  ${B}${G}NemoClaw${R}  ${D}v${getVersion()}${R}
  ${D}Deploy more secure, always-on AI assistants with a single command.${R}

  ${G}Getting Started:${R}
    ${B}nemoclaw onboard${R}                 Configure inference endpoint and credentials
                                    ${D}(non-interactive: ${NOTICE_ACCEPT_FLAG} or ${NOTICE_ACCEPT_ENV}=1)${R}

  Sandbox Management:
    nemoclaw list                    List all sandboxes
    nemoclaw <name> connect          Connect to a sandbox
    nemoclaw <name> backup           Create a full sandbox backup
    nemoclaw <name> restore [id]     Restore a backup into a sandbox
    nemoclaw <name> dashboard        Show dashboard access URL(s)
    nemoclaw <name> status           Show sandbox status and health
    nemoclaw <name> logs [--follow]  View sandbox logs
    nemoclaw <name> telegram-probe   Probe api.telegram.org from inside a sandbox
    nemoclaw <name> destroy          Stop NIM + delete sandbox

  ${G}Policy Presets:${R}
    nemoclaw <name> policy-add       Add a network or filesystem policy preset
    nemoclaw <name> policy-list      List presets ${D}(● = applied)${R}

  ${G}Compatibility Commands:${R}
    nemoclaw setup                   Deprecated alias for ${B}nemoclaw onboard${R}
    nemoclaw setup-spark             Deprecated alias for ${B}nemoclaw onboard${R}
    nemoclaw deploy <instance>       Deprecated Brev-specific bootstrap path

  ${G}Services:${R}
    nemoclaw start                   Start auxiliary services ${D}(Telegram, tunnel)${R}
    nemoclaw stop                    Stop all services
    nemoclaw status                  Show sandbox list and service status

  Troubleshooting:
    nemoclaw debug [--quick]         Collect diagnostics for bug reports
    nemoclaw debug --output FILE     Save diagnostics tarball for GitHub issues

  Cleanup:
    nemoclaw uninstall [flags]       Run uninstall.sh (local first, curl fallback)

  ${G}Uninstall flags:${R}
    --yes                            Skip the confirmation prompt
    --keep-openshell                 Leave the openshell binary installed
    --delete-models                  Remove NemoClaw-pulled Ollama models

  ${D}Powered by NVIDIA OpenShell · Nemotron · Agent Toolkit
  Credentials saved in ~/.nemoclaw/credentials.json (mode 600)${R}
  ${D}https://www.nvidia.com/nemoclaw${R}
`);
}

// ── Dispatch ─────────────────────────────────────────────────────

function shouldShowHelp(cmd) {
  return !cmd || cmd === "help" || cmd === "--help" || cmd === "-h";
}

async function dispatchSandboxAction(sandboxName, action, actionArgs) {
  switch (action) {
    case "connect":
      await sandboxConnect(sandboxName);
      break;
    case "status":
      await sandboxStatus(sandboxName);
      break;
    case "logs":
      sandboxLogs(sandboxName, actionArgs.includes("--follow"));
      break;
    case "backup":
      sandboxBackup(sandboxName, actionArgs);
      break;
    case "restore":
      await sandboxRestore(sandboxName, actionArgs);
      break;
    case "dashboard":
      sandboxDashboard(sandboxName);
      break;
    case "telegram-probe":
      await runTelegramProbe(sandboxName);
      break;
    case "policy-add":
      await sandboxPolicyAdd(sandboxName);
      break;
    case "policy-list":
      sandboxPolicyList(sandboxName);
      break;
    case "destroy":
      await sandboxDestroy(sandboxName, actionArgs);
      break;
    default:
      console.error(`  Unknown action: ${action}`);
      console.error(
        "  Valid actions: connect, status, logs, backup, restore, dashboard, telegram-probe, policy-add, policy-list, destroy",
      );
      process.exit(1);
  }
}

async function handleSandboxCommand(cmd, args) {
  const sandbox = registry.getSandbox(cmd);
  const isLiveSandbox = sandbox ? false : isOpenShellSandboxAvailable(cmd);
  const hasBackups = backupStore.hasSandboxBackups(cmd);
  if (sandbox || isLiveSandbox || hasBackups) {
    validateName(cmd, "sandbox name");
    const action = args[0] || "connect";
    if (!sandbox && isLiveSandbox) {
      if (action === "connect") {
        captureOpenshell(["sandbox", "list"], { ignoreError: true });
      }
      registry.registerSandbox({ name: cmd, gpuEnabled: false });
    }
    const actionArgs = args.slice(1);
    await dispatchSandboxAction(cmd, action, actionArgs);
    return;
  }
  if (args[0] === "connect") {
    validateName(cmd, "sandbox name");
    await recoverRegistryEntries({ requestedSandboxName: cmd });
    if (registry.getSandbox(cmd)) {
      await sandboxConnect(cmd);
      return;
    }
  }
  suggestUnknownCommand(cmd);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (shouldShowHelp(cmd)) {
    help();
    return;
  }
  if (GLOBAL_COMMANDS.has(cmd)) {
    switch (cmd) {
      case "onboard":
        await onboard(args);
        break;
      case "setup":
        await setup(args);
        break;
      case "setup-spark":
        await setupSpark(args);
        break;
      case "deploy":
        await deploy(args[0]);
        break;
      case "start":
        await start();
        break;
      case "stop":
        stop();
        break;
      case "status":
        showStatus();
        break;
      case "debug":
        debug(args);
        break;
      case "uninstall":
        uninstall(args);
        break;
      case "list":
        await listSandboxes();
        break;
      case "--version":
      case "-v":
        console.log(`nemoclaw v${getVersion()}`);
        break;
      default:
        help();
        break;
    }
    return;
  }
  await handleSandboxCommand(cmd, args);
}

function suggestUnknownCommand(cmd) {
  console.error(`  Unknown command: ${cmd}`);
  console.error("");
  const allNames = registry.listSandboxes().sandboxes.map((s) => s.name);
  if (allNames.length > 0) {
    console.error(`  Registered sandboxes: ${allNames.join(", ")}`);
  }
  console.error("  Try: nemoclaw <sandbox-name> connect");
  console.error("");
  console.error("  Run 'nemoclaw help' for usage.");
  process.exit(1);
}

if (require.main === module || path.basename(process.argv[1] || "") === "nemoclaw.js") {
  main();
}

module.exports = {
  ensureLiveSandboxForAction,
  configureSandboxFromBackupManifest,
  getServiceSandboxEnv,
  getGatewayClusterContainerName,
  getStaleSandboxWarningLines,
  getStatusSandboxes,
  hasGatewayConnectFailure,
  hasSandboxAttachHandshakeFailure,
  isOpenShellSandboxAvailable,
  isGatewayConnected,
  main,
  printStaleSandboxWarning,
  printSandboxBackups,
  sandboxBackup,
  sandboxDestroy,
  sandboxRestore,
  showStatus,
};
