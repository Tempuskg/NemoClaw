// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("discord bridge", () => {
  it("builds Discord channel agent commands", () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalChannelId = process.env.DISCORD_CHANNEL_ID;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.DISCORD_BOT_TOKEN = "token";
    process.env.DISCORD_CHANNEL_ID = "98765";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const {
      buildAgentCommand,
      buildDiscordToolCheckCommand,
    } = require("../scripts/discord-bridge.js");

    try {
      const command = buildAgentCommand("it's from discord", "12345");
      const checkCommand = buildDiscordToolCheckCommand();
      assert.match(command, /openclaw agent/);
      assert.match(command, /--channel discord/);
      assert.match(command, /DISCORD_BOT_TOKEN='token'/);
      assert.match(command, /--session-id 'dc-12345'/);
      assert.match(command, /-m 'it'\\''s from discord'/);
      assert.match(checkCommand, /openclaw message send/);
      assert.match(checkCommand, /DISCORD_BOT_TOKEN='token'/);
      assert.match(checkCommand, /--channel discord/);
      assert.match(checkCommand, /--target '98765'/);
      assert.match(checkCommand, /--dry-run --json/);
    } finally {
      restoreResolve.mockRestore();
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_CHANNEL_ID = originalChannelId;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/discord-bridge.js")];
    }
  });

  it("chunks Discord messages at 2000 characters", () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalChannelId = process.env.DISCORD_CHANNEL_ID;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.DISCORD_BOT_TOKEN = "token";
    process.env.DISCORD_CHANNEL_ID = "98765";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const { buildMessageChunks } = require("../scripts/discord-bridge.js");

    try {
      const chunks = buildMessageChunks("x".repeat(4500));
      assert.equal(chunks.length, 3);
      assert.equal(chunks[0].length, 2000);
      assert.equal(chunks[1].length, 2000);
      assert.equal(chunks[2].length, 500);
    } finally {
      restoreResolve.mockRestore();
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_CHANNEL_ID = originalChannelId;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/discord-bridge.js")];
    }
  });

  it("replaces the known false negative when sandbox Discord delivery is available", () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalChannelId = process.env.DISCORD_CHANNEL_ID;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.DISCORD_BOT_TOKEN = "token";
    process.env.DISCORD_CHANNEL_ID = "98765";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const { normalizeAgentResponse } = require("../scripts/discord-bridge.js");

    try {
      const response = normalizeAgentResponse(
        "I'm still having trouble sending messages via the OpenClaw Discord tool despite the configuration we tried.",
        true,
      );

      assert.match(response, /Discord delivery is available from inside the sandbox/);
      assert.doesNotMatch(
        response,
        /still having trouble sending messages via the OpenClaw Discord tool/i,
      );
      assert.equal(normalizeAgentResponse("All good.", true), "All good.");
      assert.match(
        normalizeAgentResponse(
          "I'm still having trouble sending messages via the OpenClaw Discord tool despite the configuration we tried.",
          false,
        ),
        /still having trouble sending messages via the OpenClaw Discord tool/i,
      );
    } finally {
      restoreResolve.mockRestore();
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_CHANNEL_ID = originalChannelId;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/discord-bridge.js")];
    }
  });

  it("only probes Discord delivery for the known false negative response", async () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalChannelId = process.env.DISCORD_CHANNEL_ID;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.DISCORD_BOT_TOKEN = "token";
    process.env.DISCORD_CHANNEL_ID = "98765";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const { maybeNormalizeAgentResponse } = require("../scripts/discord-bridge.js");
    const verifySpy = vi.fn();

    try {
      assert.equal(await maybeNormalizeAgentResponse("All good.", "98765", verifySpy), "All good.");
      assert.equal(verifySpy.mock.calls.length, 0);

      verifySpy.mockResolvedValueOnce(true);
      const normalized = await maybeNormalizeAgentResponse(
        "I'm still having trouble sending messages via the OpenClaw Discord tool despite the configuration we tried.",
        "98765",
        verifySpy,
      );

      assert.match(normalized, /Discord delivery is available from inside the sandbox/);
      assert.equal(verifySpy.mock.calls.length, 1);
    } finally {
      restoreResolve.mockRestore();
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_CHANNEL_ID = originalChannelId;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/discord-bridge.js")];
    }
  });

  it("filters noisy stderr warnings from bridge failures", () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalChannelId = process.env.DISCORD_CHANNEL_ID;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.DISCORD_BOT_TOKEN = "token";
    process.env.DISCORD_CHANNEL_ID = "98765";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const { formatAgentFailure, summarizeStderr } = require("../scripts/discord-bridge.js");

    try {
      const stderr = [
        "(node:20407) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.",
        "(Use `node --trace-warnings ...` to show where the warning was created)",
        "ssh: connect to host failed",
      ].join("\n");

      assert.equal(summarizeStderr(stderr), "ssh: connect to host failed");
      assert.match(formatAgentFailure(255, stderr), /Agent session failed while reaching sandbox/);
      assert.match(formatAgentFailure(255, stderr), /ssh: connect to host failed/);
      assert.doesNotMatch(formatAgentFailure(255, stderr), /UNDICI-EHPA/);
    } finally {
      restoreResolve.mockRestore();
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_CHANNEL_ID = originalChannelId;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/discord-bridge.js")];
    }
  });

  it("filters non-fatal sandbox startup stderr noise from bridge failures", () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalChannelId = process.env.DISCORD_CHANNEL_ID;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.DISCORD_BOT_TOKEN = "token";
    process.env.DISCORD_CHANNEL_ID = "98765";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const { formatAgentFailure, summarizeStderr } = require("../scripts/discord-bridge.js");

    try {
      const stderr = [
        "[SECURITY] CAP_SETPCAP not available — runtime already restricts capabilities",
        "[tools] read failed: ENOENT: no such file or directory, access '/sandbox/.openclaw/workspace/SentinelEditor/app/src/main/java/com/sentinel/Navigation.kt'",
        "ssh: connect to host failed",
      ].join("\n");

      assert.equal(summarizeStderr(stderr), "ssh: connect to host failed");
      assert.doesNotMatch(formatAgentFailure(255, stderr), /CAP_SETPCAP/);
      assert.doesNotMatch(formatAgentFailure(255, stderr), /Navigation\.kt/);
      assert.match(formatAgentFailure(255, stderr), /ssh: connect to host failed/);
    } finally {
      restoreResolve.mockRestore();
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_CHANNEL_ID = originalChannelId;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/discord-bridge.js")];
    }
  });

  it("filters gateway runtime banners from Discord replies", () => {
    const originalToken = process.env.DISCORD_BOT_TOKEN;
    const originalChannelId = process.env.DISCORD_CHANNEL_ID;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.DISCORD_BOT_TOKEN = "token";
    process.env.DISCORD_CHANNEL_ID = "98765";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const { extractAgentResponse, isResponseNoiseLine } = require("../scripts/discord-bridge.js");

    try {
      const stdout = [
        "[gateway] Running as non-root (uid=998) — privilege separation disabled",
        "Hello! How can I help you today? 🌟",
      ].join("\n");

      assert.equal(
        isResponseNoiseLine(
          "[gateway] Running as non-root (uid=998) — privilege separation disabled",
        ),
        true,
      );
      assert.equal(extractAgentResponse(stdout, 0, ""), "Hello! How can I help you today? 🌟");
    } finally {
      restoreResolve.mockRestore();
      process.env.DISCORD_BOT_TOKEN = originalToken;
      process.env.DISCORD_CHANNEL_ID = originalChannelId;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/discord-bridge.js")];
    }
  });
});
