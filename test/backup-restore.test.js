// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureSandboxGatewayForRestore,
  sandboxBackup,
  sandboxRestore,
  syncSandboxGithubTokenEnv,
} from "../bin/nemoclaw.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sandbox backup command", () => {
  it("creates a backup with an optional label", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const createBackup = vi.fn().mockReturnValue({
      backupDir: "/tmp/backups/the-crucible/pre-upgrade",
      archivePath: "/tmp/backups/the-crucible/pre-upgrade/sandbox.tar.gz",
      sizeBytes: 2048,
    });

    const result = sandboxBackup("the-crucible", ["--label", "pre-upgrade"], {
      isAvailable: true,
      createBackup,
      exit: null,
    });

    expect(createBackup).toHaveBeenCalledWith("the-crucible", { label: "pre-upgrade" });
    expect(result.backupDir).toContain("pre-upgrade");
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Creating backup for sandbox 'the-crucible'");
    expect(printed).toContain("Backup saved to /tmp/backups/the-crucible/pre-upgrade");
  });

  it("lists existing backups without requiring a live sandbox", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = sandboxBackup("the-crucible", ["--list"], {
      listBackups: vi
        .fn()
        .mockReturnValue([
          { id: "pre-upgrade", createdAt: "2026-03-28T10:20:30Z", sizeBytes: 1024 },
        ]),
      exit: null,
    });

    expect(result).toHaveLength(1);
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Backups for sandbox 'the-crucible'");
    expect(printed).toContain("pre-upgrade");
  });

  it("returns false when backup is requested for a stale sandbox", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.fn();

    const result = sandboxBackup("the-crucible", [], {
      isAvailable: false,
      exit: exitSpy,
      error: console.error,
    });

    expect(result).toBe(false);
    expect(exitSpy).toHaveBeenCalledWith(1);
    const printed = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Sandbox 'the-crucible' is stale");
  });
});

describe("sandbox restore command", () => {
  it("reuses an existing named gateway when restore startup reports reuse", () => {
    const logFn = vi.fn();
    const errorFn = vi.fn();
    const runFn = vi.fn().mockImplementation((command) => {
      if (command.includes("openshell gateway start --name nemoclaw")) {
        return {
          status: 1,
          stdout: "",
          stderr: "Gateway 'nemoclaw' already exists, reusing.",
        };
      }
      return { status: 0, stdout: "", stderr: "" };
    });
    let statusChecks = 0;
    const runCaptureFn = vi.fn().mockImplementation((command) => {
      if (command.startsWith("docker ps -a")) {
        return "";
      }
      if (command === "openshell status 2>&1") {
        statusChecks += 1;
        if (statusChecks === 1) {
          return "Status: Disconnected\nGateway: nemoclaw\nclient error (Connect)";
        }
        return "Status: Connected\nGateway: nemoclaw";
      }
      return "";
    });
    const spawnSyncFn = vi.fn();

    const result = ensureSandboxGatewayForRestore({
      error: errorFn,
      log: logFn,
      run: runFn,
      runCapture: runCaptureFn,
      spawnSync: spawnSyncFn,
    });

    expect(result).toBe(true);
    expect(logFn).toHaveBeenCalledWith("  ✓ Reused OpenShell gateway 'nemoclaw'");
    expect(errorFn).not.toHaveBeenCalled();
    expect(runFn).toHaveBeenCalledWith(
      expect.stringContaining("openshell gateway select 'nemoclaw' 2>&1"),
      expect.objectContaining({ ignoreError: true }),
    );
    expect(runFn).toHaveBeenCalledWith(
      expect.stringContaining("openshell gateway start --name nemoclaw 2>&1"),
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("recreates a missing sandbox before restoring the backup", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ensureGateway = vi.fn();
    const createSandbox = vi.fn().mockResolvedValue("the-crucible");
    const configureSandbox = vi.fn().mockResolvedValue();
    const restoreBackup = vi.fn().mockReturnValue({});

    const result = await sandboxRestore("the-crucible", ["pre-upgrade"], {
      isAvailable: false,
      resolveBackup: vi.fn().mockReturnValue({
        id: "pre-upgrade",
        path: "/tmp/backups/the-crucible/pre-upgrade",
        manifest: {
          registry: {
            gpuEnabled: true,
            model: "nvidia/nemotron-3-super-120b-a12b",
            provider: "nvidia-prod",
            policies: ["telegram"],
          },
        },
      }),
      ensureGateway,
      createSandbox,
      configureSandbox,
      restoreBackup,
      exit: null,
    });

    expect(ensureGateway).toHaveBeenCalled();
    expect(createSandbox).toHaveBeenCalledWith(true, null, null, null, "the-crucible");
    expect(restoreBackup).toHaveBeenCalledWith(
      "the-crucible",
      "/tmp/backups/the-crucible/pre-upgrade",
    );
    expect(configureSandbox).toHaveBeenCalledWith(
      "the-crucible",
      {
        registry: {
          gpuEnabled: true,
          model: "nvidia/nemotron-3-super-120b-a12b",
          provider: "nvidia-prod",
          policies: ["telegram"],
        },
      },
      { backupDir: "/tmp/backups/the-crucible/pre-upgrade" },
    );
    expect(result).toEqual({
      sandboxName: "the-crucible",
      backupId: "pre-upgrade",
      recreated: true,
    });
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Recreating sandbox 'the-crucible' from backup 'pre-upgrade'");
    expect(printed).toContain("Restoring backup 'pre-upgrade' into sandbox 'the-crucible'");
  });

  it("recreates a live sandbox when restore cannot attach through the current gateway", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const ensureGateway = vi.fn();
    const createSandbox = vi.fn().mockResolvedValue("the-crucible");
    const configureSandbox = vi.fn().mockResolvedValue();
    const restoreBackup = vi.fn().mockReturnValue({});
    const probeSandboxAccess = vi.fn().mockReturnValue({
      usable: false,
      output: "Error: ssh exited with status exit status: 255",
    });

    delete process.env.NEMOCLAW_RECREATE_SANDBOX;

    const result = await sandboxRestore("the-crucible", ["pre-upgrade"], {
      isAvailable: true,
      resolveBackup: vi.fn().mockReturnValue({
        id: "pre-upgrade",
        path: "/tmp/backups/the-crucible/pre-upgrade",
        manifest: {
          registry: {
            gpuEnabled: true,
          },
        },
      }),
      ensureGateway,
      createSandbox,
      configureSandbox,
      restoreBackup,
      probeSandboxAccess,
      exit: null,
    });

    expect(probeSandboxAccess).toHaveBeenCalledWith("the-crucible");
    expect(ensureGateway).toHaveBeenCalled();
    expect(createSandbox).toHaveBeenCalledWith(true, null, null, null, "the-crucible");
    expect(process.env.NEMOCLAW_RECREATE_SANDBOX).toBeUndefined();
    expect(restoreBackup).toHaveBeenCalledWith(
      "the-crucible",
      "/tmp/backups/the-crucible/pre-upgrade",
    );
    expect(result).toEqual({
      sandboxName: "the-crucible",
      backupId: "pre-upgrade",
      recreated: true,
    });
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("restore cannot attach to it through the current gateway");
    expect(printed).toContain("Recreating sandbox 'the-crucible' from backup 'pre-upgrade'");
  });

  it("cancels restoring into a live sandbox unless explicitly confirmed", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const restoreBackup = vi.fn();

    const result = await sandboxRestore("the-crucible", [], {
      isAvailable: true,
      probeSandboxAccess: vi.fn().mockReturnValue({ usable: true, output: "" }),
      prompt: vi.fn().mockResolvedValue("nope"),
      resolveBackup: vi.fn().mockReturnValue({
        id: "20260328-102030",
        path: "/tmp/backups/the-crucible/20260328-102030",
        manifest: {},
      }),
      restoreBackup,
      exit: null,
    });

    expect(result).toBe(false);
    expect(restoreBackup).not.toHaveBeenCalled();
    const printed = logSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(printed).toContain("Restore will overwrite files inside sandbox 'the-crucible'");
    expect(printed).toContain("Cancelled.");
  });
});

describe("restore token sync", () => {
  it("writes GitHub token environment when a token is available", () => {
    const runFn = vi.fn().mockReturnValue({ status: 0 });
    const logFn = vi.fn();
    const warnFn = vi.fn();

    const result = syncSandboxGithubTokenEnv("the-crucible", {
      githubToken: "gho_test_token",
      run: runFn,
      log: logFn,
      warn: warnFn,
    });

    expect(result).toBe(true);
    expect(runFn).toHaveBeenCalledTimes(1);
    expect(logFn).toHaveBeenCalledWith("  ✓ Synced GitHub token into sandbox environment");
    expect(warnFn).not.toHaveBeenCalled();
  });

  it("skips sync when no GitHub token is available", () => {
    const runFn = vi.fn();

    const result = syncSandboxGithubTokenEnv("the-crucible", {
      githubToken: "",
      run: runFn,
    });

    expect(result).toBe(false);
    expect(runFn).not.toHaveBeenCalled();
  });
});
