---
title:
  page: "NemoClaw CLI Commands Reference"
  nav: "Commands"
description:
  main: "Full CLI reference for slash commands and standalone NemoClaw commands."
  agent: "Lists all slash commands and standalone NemoClaw CLI commands. Use when looking up a command, checking command syntax, or browsing the CLI reference."
keywords: ["nemoclaw cli commands", "nemoclaw command reference"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "nemoclaw", "cli"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Commands

The `nemoclaw` CLI is the primary interface for managing NemoClaw sandboxes. It is installed when you run `npm install -g nemoclaw`.

## `/nemoclaw` Slash Command

The `/nemoclaw` slash command is available inside the OpenClaw chat interface for quick actions:

| Subcommand | Description |
|---|---|
| `/nemoclaw` | Show slash-command help and host CLI pointers |
| `/nemoclaw status` | Show sandbox and inference state |
| `/nemoclaw onboard` | Show onboarding status and reconfiguration guidance |
| `/nemoclaw eject` | Show rollback instructions for returning to the host installation |

## Standalone Host Commands

The `nemoclaw` binary handles host-side operations that run outside the OpenClaw plugin context.

### `nemoclaw help`, `nemoclaw --help`, `nemoclaw -h`

Show the top-level usage summary and command groups.
Running `nemoclaw` with no arguments shows the same help output.

```console
$ nemoclaw help
```

### `nemoclaw --version`, `nemoclaw -v`

Print the installed NemoClaw CLI version.

```console
$ nemoclaw --version
```

### `nemoclaw onboard`

Run the interactive setup wizard (recommended for new installs).
The wizard creates an OpenShell gateway, registers inference providers, builds the sandbox image, and creates the sandbox.
Use this command for new installs and for recreating a sandbox after changes to policy or configuration.

```console
$ nemoclaw onboard
```

The wizard prompts for a provider first, then collects the provider credential if needed.
Supported non-experimental choices include NVIDIA Endpoints, OpenAI, Anthropic, Google Gemini, and compatible OpenAI or Anthropic endpoints.
Credentials are stored in `~/.nemoclaw/credentials.json`.
The legacy `nemoclaw setup` command is deprecated; use `nemoclaw onboard` instead.

If you enable Brave Search during onboarding, NemoClaw currently stores the Brave API key in the sandbox's OpenClaw configuration.
That means the OpenClaw agent can read the key.
NemoClaw explores an OpenShell-hosted credential path first, but the current OpenClaw Brave runtime does not consume that path end to end yet.
Treat Brave Search as an explicit opt-in and use a dedicated low-privilege Brave key.

For non-interactive onboarding, you must explicitly accept the third-party software notice:

```console
$ nemoclaw onboard --non-interactive --yes-i-accept-third-party-software
```

or:

```console
$ NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE=1 nemoclaw onboard --non-interactive
```

To enable Brave Search in non-interactive mode, set:

```console
$ BRAVE_API_KEY=... \
  nemoclaw onboard --non-interactive
```

`BRAVE_API_KEY` enables Brave Search in non-interactive mode and also enables `web_fetch`.

The wizard prompts for a sandbox name.
Names must follow RFC 1123 subdomain rules: lowercase alphanumeric characters and hyphens only, and must start and end with an alphanumeric character.
Uppercase letters are automatically lowercased.

When onboarding completes, NemoClaw prints dashboard access details.
On most hosts, open `http://127.0.0.1:18789/`.
On WSL2, NemoClaw can also print a `VS Code/WSL` URL that includes the current WSL host IP and a one-time gateway token for the OpenClaw Control UI.
Use that URL exactly as printed when VS Code or the Windows browser cannot reach the dashboard through `127.0.0.1`.
If the WSL URL uses the current WSL host IP, keep that host IP in the browser URL. Do not replace it with `localhost`.

Before creating the gateway, the wizard runs preflight checks.
It verifies that Docker is reachable, warns on unsupported runtimes such as Podman, and prints host remediation guidance when prerequisites are missing.

### `nemoclaw list`

List all registered sandboxes with their model, provider, and policy presets.

```console
$ nemoclaw list
```

### `nemoclaw deploy`

:::{warning}
The `nemoclaw deploy` command is deprecated.
Prefer provisioning the remote host separately, then running the standard NemoClaw installer and `nemoclaw onboard` on that host.
:::

Deploy NemoClaw to a remote GPU instance through [Brev](https://brev.nvidia.com).
This command remains as a compatibility wrapper for the older Brev-specific bootstrap flow.

```console
$ nemoclaw deploy <instance-name>
```

### `nemoclaw <name> connect`

Connect to a sandbox by name.

```console
$ nemoclaw my-assistant connect
```

This command opens the sandbox shell.
It does not open the OpenClaw dashboard.
Use `nemoclaw <name> dashboard` to print or re-print the dashboard URL at any time.
On WSL2, prefer the printed `VS Code/WSL` URL when Windows cannot use `127.0.0.1`.

### `nemoclaw <name> backup`

Create a full sandbox backup.
The command captures the `/sandbox` filesystem into a tarball under `~/.nemoclaw/backups/<name>/` and writes a manifest with the sandbox registry metadata plus the active OpenShell inference provider and model needed for restore.

```console
$ nemoclaw my-assistant backup
```

Use `--label` to assign a stable backup name instead of a timestamp:

```console
$ nemoclaw my-assistant backup --label pre-upgrade
```

Use `--list` to show available backups for the sandbox:

```console
$ nemoclaw my-assistant backup --list
```

### `nemoclaw <name> restore [backup-id]`

Restore a sandbox backup.
If the sandbox does not exist, NemoClaw starts or reuses the OpenShell gateway, recreates the sandbox, restores the backup archive, and reapplies the saved provider, model, and policy metadata from the backup manifest or current local registry.

```console
$ nemoclaw my-assistant restore
```

Restore a specific backup by label or timestamp:

```console
$ nemoclaw my-assistant restore pre-upgrade
```

When restoring into a live sandbox, NemoClaw prompts for confirmation before overwriting files inside `/sandbox`.

### `nemoclaw <name> dashboard`

Print the dashboard access URL(s) for a sandbox.

```console
$ nemoclaw my-assistant dashboard
```

Use this command to retrieve the correct URL when you need it after onboarding.
On WSL2, the output includes a `VS Code/WSL` URL that contains the current WSL host IP and a one-time gateway token.
Use that URL exactly as printed. Do not replace the WSL host IP with `localhost`.

### `nemoclaw <name> status`

Show sandbox status, health, and inference configuration.

```console
$ nemoclaw my-assistant status
```

### `nemoclaw <name> logs`

View sandbox logs.
Use `--follow` to stream output in real time.

```console
$ nemoclaw my-assistant logs [--follow]
```

### `nemoclaw <name> destroy`

Stop the NIM container and delete the sandbox.
For a live sandbox, NemoClaw prompts for explicit confirmation before deletion.
If the entry is stale, NemoClaw offers to remove only the local registry entry.

:::{warning}
Destroying a sandbox permanently deletes all files inside it, including
[workspace files](../workspace/workspace-files.md) (SOUL.md, USER.md, IDENTITY.md, AGENTS.md, MEMORY.md, and daily memory notes).
Create a backup first with `nemoclaw <name> backup`, then follow the instructions at [Back Up and Restore](../workspace/backup-restore.md) if you need manual restore steps.
:::

```console
$ nemoclaw my-assistant destroy
```

For a stale registry entry:

```console
$ nemoclaw my-assistant destroy
```

NemoClaw reports that OpenShell cannot load the sandbox and prompts to remove the stale local entry instead of attempting a delete that cannot succeed.

### `nemoclaw <name> policy-add`

Add a policy preset to a sandbox.
Presets extend the baseline network policy with additional endpoints.

```console
$ nemoclaw my-assistant policy-add
```

### `nemoclaw <name> policy-list`

List available policy presets and show which ones are applied to the sandbox.

```console
$ nemoclaw my-assistant policy-list
```

### `openshell term`

Open the OpenShell TUI to monitor sandbox activity and approve network egress requests.
Run this on the host where the sandbox is running.

```console
$ openshell term
```

For a remote Brev instance, SSH to the instance and run `openshell term` there, or use a port-forward to the gateway.

### `nemoclaw start`

Start auxiliary services, such as the Telegram bridge and cloudflared tunnel.

```console
$ nemoclaw start
```

Requires `TELEGRAM_BOT_TOKEN` for the Telegram bridge.

### `nemoclaw stop`

Stop all auxiliary services.

```console
$ nemoclaw stop
```

### `nemoclaw status`

Show the sandbox list and the status of auxiliary services.

```console
$ nemoclaw status
```

### `nemoclaw setup-spark`

:::{warning}
The `nemoclaw setup-spark` command is deprecated.
Use the standard installer and run `nemoclaw onboard` instead, because current OpenShell releases handle the older DGX Spark cgroup behavior.
:::

This command remains as a compatibility alias to `nemoclaw onboard`.

```console
$ nemoclaw setup-spark
```

### `nemoclaw debug`

Collect diagnostics for bug reports.
Gathers system info, Docker state, gateway logs, and sandbox status into a summary or tarball.
Use `--sandbox <name>` to target a specific sandbox, `--quick` for a smaller snapshot, or `--output <path>` to save a tarball that you can attach to an issue.

```console
$ nemoclaw debug [--quick] [--sandbox NAME] [--output PATH]
```

| Flag | Description |
|------|-------------|
| `--quick` | Collect minimal diagnostics only |
| `--sandbox NAME` | Target a specific sandbox (default: auto-detect) |
| `--output PATH` | Write diagnostics tarball to the given path |

### `nemoclaw uninstall`

Run `uninstall.sh` to remove NemoClaw sandboxes, gateway resources, related images and containers, and local state.
The CLI uses the local `uninstall.sh` first and falls back to the hosted script if the local file is unavailable.

| Flag | Effect |
|---|---|
| `--yes` | Skip the confirmation prompt |
| `--keep-openshell` | Leave the `openshell` binary installed |
| `--delete-models` | Also remove NemoClaw-pulled Ollama models |

```console
$ nemoclaw uninstall [--yes] [--keep-openshell] [--delete-models]
```

### Legacy `nemoclaw setup`

Deprecated. Use `nemoclaw onboard` instead.
Running `nemoclaw setup` now delegates directly to `nemoclaw onboard`.

```console
$ nemoclaw setup
```
