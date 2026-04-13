#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { spawnSync } = require("child_process");
const path = require("path");
const { getCredential } = require("../bin/lib/credentials");
const { validateName } = require("../bin/lib/runner");

function parseArgs(argv) {
  const args = { sandbox: process.env.NEMOCLAW_SANDBOX || "default", statusOnly: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--sandbox") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--sandbox requires a value");
      }
      args.sandbox = value;
      i += 1;
      continue;
    }
    if (arg === "--status") {
      args.statusOnly = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function usage() {
  console.log("Usage: node scripts/restart-discord-bridge.js [--sandbox <name>] [--status]");
  console.log("  --sandbox <name>  Sandbox name for service PID namespace (default: $NEMOCLAW_SANDBOX or 'default')");
  console.log("  --status          Show service status only");
}

function loadRequiredCredentials(env) {
  const required = ["NVIDIA_API_KEY", "DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID"];
  const missing = [];

  for (const key of required) {
    if (!env[key]) {
      const stored = getCredential(key);
      if (stored) {
        env[key] = stored;
      }
    }
    if (!env[key]) {
      missing.push(key);
    }
  }

  return missing;
}

function runStartServices(repoRoot, env, sandbox, extraArgs = []) {
  const script = path.join(repoRoot, "scripts", "start-services.sh");
  const args = [script, "--sandbox", sandbox, ...extraArgs];
  const result = spawnSync("bash", args, { cwd: repoRoot, env, stdio: "inherit" });
  return result.status ?? 1;
}

function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(2);
  }

  if (parsed.help) {
    usage();
    return;
  }

  try {
    validateName(parsed.sandbox, "sandbox");
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const env = { ...process.env, SANDBOX_NAME: parsed.sandbox };

  if (parsed.statusOnly) {
    process.exit(runStartServices(repoRoot, env, parsed.sandbox, ["--status"]));
  }

  const missing = loadRequiredCredentials(env);
  if (missing.length > 0) {
    console.error(`Missing required credentials: ${missing.join(", ")}`);
    console.error("Run 'nemoclaw onboard' to set them, or export them in your shell.");
    process.exit(2);
  }

  const stopCode = runStartServices(repoRoot, env, parsed.sandbox, ["--stop"]);
  if (stopCode !== 0) {
    process.exit(stopCode);
  }

  const startCode = runStartServices(repoRoot, env, parsed.sandbox);
  if (startCode !== 0) {
    process.exit(startCode);
  }

  process.exit(runStartServices(repoRoot, env, parsed.sandbox, ["--status"]));
}

main();
