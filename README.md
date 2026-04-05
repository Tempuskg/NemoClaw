# 🦞 NVIDIA NemoClaw: Reference Stack for Running OpenClaw in OpenShell

<!-- start-badges -->
[![License](https://img.shields.io/badge/License-Apache_2.0-blue)](https://github.com/NVIDIA/NemoClaw/blob/main/LICENSE)
[![Security Policy](https://img.shields.io/badge/Security-Report%20a%20Vulnerability-red)](https://github.com/NVIDIA/NemoClaw/blob/main/SECURITY.md)
[![Project Status](https://img.shields.io/badge/status-alpha-orange)](https://github.com/NVIDIA/NemoClaw/blob/main/docs/about/release-notes.md)
[![Discord](https://img.shields.io/badge/Discord-Join-7289da)](https://discord.gg/XFpfPv9Uvx)
<!-- end-badges -->

<!-- start-intro -->
NVIDIA NemoClaw is an open source reference stack that simplifies running [OpenClaw](https://openclaw.ai) always-on assistants more safely.
It installs the [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) runtime, part of NVIDIA Agent Toolkit, which provides additional security for running autonomous agents.
<!-- end-intro -->

> **Alpha software**
>
> NemoClaw is available in early preview starting March 16, 2026.
> This software is not production-ready.
> Interfaces, APIs, and behavior may change without notice as we iterate on the design.
> The project is shared to gather feedback and enable early experimentation.
> We welcome issues and discussion from the community while the project evolves.

NemoClaw adds guided onboarding, a hardened blueprint, state management, messaging bridges, routed inference, and layered protection on top of the [NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) runtime. For the full feature list, refer to [Overview](https://docs.nvidia.com/nemoclaw/latest/about/overview.html). For the system diagram, component model, and blueprint lifecycle, refer to [How It Works](https://docs.nvidia.com/nemoclaw/latest/about/how-it-works.html) and [Architecture](https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html).

## Getting Started

Follow these steps to install NemoClaw and run your first sandboxed OpenClaw agent.

<!-- start-quickstart-guide -->

### Prerequisites

Before getting started, check the prerequisites to ensure you have the necessary software and hardware to run NemoClaw.

#### Hardware

| Resource | Minimum        | Recommended      |
|----------|----------------|------------------|
| CPU      | 4 vCPU         | 4+ vCPU          |
| RAM      | 8 GB           | 16 GB            |
| Disk     | 20 GB free     | 40 GB free       |

The sandbox image is approximately 2.4 GB compressed. During image push, the Docker daemon, k3s, and the OpenShell gateway run alongside the export pipeline, which buffers decompressed layers in memory. On machines with less than 8 GB of RAM, this combined usage can trigger the OOM killer. If you cannot add memory, configuring at least 8 GB of swap can work around the issue at the cost of slower performance.

#### Software

| Dependency | Version                          |
|------------|----------------------------------|
| Linux      | Ubuntu 22.04 LTS or later |
| Node.js    | 22.16 or later |
| npm        | 10 or later |
| Container runtime | Supported runtime installed and running |
| [OpenShell](https://github.com/NVIDIA/OpenShell) | Installed |

#### Container Runtimes

| Platform | Supported runtimes | Notes |
|----------|--------------------|-------|
| Linux | Docker | Primary supported path. |
| macOS (Apple Silicon) | Colima, Docker Desktop | Install Xcode Command Line Tools (`xcode-select --install`) and start the runtime before running the installer. |
| macOS (Intel) | Docker Desktop | Start the runtime before running the installer. |
| Windows WSL | Docker Desktop (WSL backend) | Supported target path. |
| DGX Spark | Docker | Use the standard installer and `nemoclaw onboard`. |

### Install NemoClaw and Onboard OpenClaw Agent

Download and run the installer script.
The script installs Node.js if it is not already present, then runs the guided onboard wizard to create a sandbox, configure inference, and apply security policies.

> **ℹ️ Note**
>
> NemoClaw creates a fresh OpenClaw instance inside the sandbox during the onboarding process.

```bash
curl -fsSL https://www.nvidia.com/nemoclaw.sh | bash
```

If you use nvm or fnm to manage Node.js, the installer may not update your current shell's PATH.
If `nemoclaw` is not found after install, run `source ~/.bashrc` (or `source ~/.zshrc` for zsh) or open a new terminal.

When the install completes, a summary confirms the running environment:

```text
──────────────────────────────────────────────────
Dashboard    http://127.0.0.1:18789/
Sandbox      my-assistant (Landlock + seccomp + netns)
Model        nvidia/nemotron-3-super-120b-a12b (NVIDIA Endpoints)
──────────────────────────────────────────────────
Run:         nemoclaw my-assistant connect
Status:      nemoclaw my-assistant status
Logs:        nemoclaw my-assistant logs --follow
──────────────────────────────────────────────────

[INFO]  === Installation complete ===
```

On WSL2, NemoClaw can also print a `VS Code/WSL` dashboard URL that uses the current WSL host IP and a one-time OpenClaw gateway token.
Use that URL exactly as printed when VS Code or the Windows browser cannot load the dashboard through `127.0.0.1`.
On affected Windows setups, the direct WSL host IP URL is the correct path and replacing it with `localhost` can fail.

### Chat with the Agent

Connect to the sandbox, then chat with the agent through the TUI or the CLI.

```bash
nemoclaw my-assistant connect
```

In the sandbox shell, open the OpenClaw terminal UI and start a chat:

```bash
openclaw tui
```

Alternatively, send a single message and print the response:

```bash
openclaw agent --agent main --local -m "hello" --session-id test
```

### Uninstall

To remove NemoClaw and all resources created during setup, run the uninstall script:

```bash
curl -fsSL https://raw.githubusercontent.com/NVIDIA/NemoClaw/refs/heads/main/uninstall.sh | bash
```

| Flag               | Effect                                              |
|--------------------|-----------------------------------------------------|
| `--yes`            | Skip the confirmation prompt.                       |
| `--keep-openshell` | Leave the `openshell` binary installed.              |
| `--delete-models`  | Also remove NemoClaw-pulled Ollama models.           |

For troubleshooting installation or onboarding issues, see the [Troubleshooting guide](https://docs.nvidia.com/nemoclaw/latest/reference/troubleshooting.html).

<!-- end-quickstart-guide -->

## Documentation

Refer to the following pages on the official documentation website for more information on NemoClaw.

| Page | Description |
|------|-------------|
| [Overview](https://docs.nvidia.com/nemoclaw/latest/about/overview.html) | What NemoClaw does and how it fits together. |
| [How It Works](https://docs.nvidia.com/nemoclaw/latest/about/how-it-works.html) | Plugin, blueprint, sandbox lifecycle, and protection layers. |
| [Architecture](https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html) | Plugin structure, blueprint lifecycle, sandbox environment, and host-side state. |
| [Inference Options](https://docs.nvidia.com/nemoclaw/latest/inference/inference-options.html) | Supported providers, validation, and routed inference configuration. |
| [Network Policies](https://docs.nvidia.com/nemoclaw/latest/reference/network-policies.html) | Baseline rules, operator approval flow, and egress control. |
| [Customize Network Policy](https://docs.nvidia.com/nemoclaw/latest/network-policy/customize-network-policy.html) | Static and dynamic policy changes, presets. |
| [Security Best Practices](https://docs.nvidia.com/nemoclaw/latest/security/best-practices.html) | Controls reference, risk framework, and posture profiles for sandbox security. |
| [Sandbox Hardening](https://docs.nvidia.com/nemoclaw/latest/deployment/sandbox-hardening.html) | Container security measures, capability drops, process limits. |
| [CLI Commands](https://docs.nvidia.com/nemoclaw/latest/reference/commands.html) | Full NemoClaw CLI command reference. |
| [Troubleshooting](https://docs.nvidia.com/nemoclaw/latest/reference/troubleshooting.html) | Common issues and resolution steps. |

## Project Structure

The following directories make up the NemoClaw repository.

```text
NemoClaw/
├── bin/              # CLI entry point and library modules (CJS)
├── nemoclaw/         # TypeScript plugin (Commander CLI extension)
│   └── src/
│       ├── blueprint/    # Runner, snapshot, SSRF validation, state
│       ├── commands/     # Slash commands, migration state
│       └── onboard/      # Onboarding config
├── nemoclaw-blueprint/   # Blueprint YAML and network policies
├── scripts/          # Install helpers, setup, automation
├── test/             # Integration and E2E tests
└── docs/             # User-facing docs (Sphinx/MyST)
```

## Community

Join the NemoClaw community to ask questions, share feedback, and report issues.

- [Discord](https://discord.gg/XFpfPv9Uvx)
- [GitHub Discussions](https://github.com/NVIDIA/NemoClaw/discussions)
- [GitHub Issues](https://github.com/NVIDIA/NemoClaw/issues)

Inference requests from the agent never leave the sandbox directly. OpenShell intercepts every call and routes it to the active provider through the managed `inference.local` endpoint.

| Provider     | Model                               | Use Case                                       |
|--------------|--------------------------------------|-------------------------------------------------|
| NVIDIA cloud | `nvidia/nemotron-3-super-120b-a12b` | Production. Requires an NVIDIA API key.         |
| Local Ollama | User-selected local model            | Experimental. Good for host-local inference.    |

## Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, coding standards, and the PR process.

Local inference options such as Ollama and vLLM are still experimental. On WSL2 with Docker Desktop, NemoClaw can discover Ollama on the Windows host, list models during onboarding, and route sandbox traffic through Docker Desktop hostnames such as `host.docker.internal`.

When you select an Ollama model, NemoClaw records the context window it discovers from the host Ollama service. It prefers the running-model context from `ollama ps`, then falls back to the configured `num_ctx` value reported by `ollama show`. This helps OpenClaw avoid advertising a larger prompt budget than the active Ollama model is actually serving.

On macOS, local inference still depends on OpenShell host-routing support in addition to the local service itself being reachable on the host.

### Verify Local Ollama Inference

When you use Local Ollama, verify the managed route from inside the sandbox instead of calling the host Ollama port directly.

First connect to the sandbox:

```console
$ nemoclaw my-assistant connect
```

Then send a direct test request through the managed route:

```console
$ curl -sk https://inference.local/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer unused" \
  -d '{"model":"qwen3.5:35b-a3b","messages":[{"role":"user","content":"Reply with exactly: OLLAMA_OK"}],"max_tokens":16}'
```

If the route is healthy, the response contains the model output from the selected Ollama model.

Use a fresh session ID when you switch providers or retest a local model with the OpenClaw CLI:

```console
$ openclaw agent --agent main --local -m "Reply with exactly: OLLAMA_OK" --session-id ollama-smoke
```

Do not use direct requests to `http://host.docker.internal:11434` from inside the sandbox as the primary validation step. The sandbox policy can block direct host egress even when the managed inference route is working correctly.

---

## Protection Layers

The sandbox starts with a default policy that controls network egress and filesystem access:

| Layer      | What it protects                                    | When it applies             |
|------------|-----------------------------------------------------|-----------------------------|
| Network    | Blocks unauthorized outbound connections.           | Hot-reloadable at runtime.  |
| Filesystem | Prevents reads/writes outside `/sandbox` and `/tmp`.| Locked at sandbox creation. |
| Process    | Blocks privilege escalation and dangerous syscalls. | Locked at sandbox creation. |
| Inference  | Reroutes model API calls to controlled backends.    | Hot-reloadable at runtime.  |

When the agent tries to reach an unlisted host, OpenShell blocks the request and surfaces it in the TUI for operator approval.

---

## Configuring Sandbox Policy

The sandbox policy is defined in a declarative YAML file and enforced by the OpenShell runtime.
NemoClaw ships a default policy in [`nemoclaw-blueprint/policies/openclaw-sandbox.yaml`](https://github.com/NVIDIA/NemoClaw/blob/main/nemoclaw-blueprint/policies/openclaw-sandbox.yaml) that denies all network egress except explicitly listed endpoints.

Operators can customize the policy in two ways:

| Method | How | Scope |
|--------|-----|-------|
| **Static** | Edit `openclaw-sandbox.yaml` and re-run `nemoclaw onboard`. | Persists across restarts. |
| **Dynamic** | Run `openshell policy set <policy-file>` on a running sandbox. | Session only; resets on restart. |

NemoClaw includes preset policy files for common integrations such as PyPI, Docker Hub, Slack, and Jira in `nemoclaw-blueprint/policies/presets/`. Apply a preset as-is or use it as a starting template.

NemoClaw is an open project — we are still determining which presets to ship by default. If you have suggestions, please open an [issue](https://github.com/NVIDIA/NemoClaw/issues) or [discussion](https://github.com/NVIDIA/NemoClaw/discussions).

When the agent attempts to reach an endpoint not covered by the policy, OpenShell blocks the request and surfaces it in the TUI (`openshell term`) for the operator to approve or deny in real time. Approved endpoints persist for the current session only.

For step-by-step instructions, see [Customize Network Policy](https://docs.nvidia.com/nemoclaw/latest/network-policy/customize-network-policy.html). For the underlying enforcement details, see the OpenShell [Policy Schema](https://docs.nvidia.com/openshell/latest/reference/policy-schema.html) and [Sandbox Policies](https://docs.nvidia.com/openshell/latest/sandboxes/policies.html) documentation.

---

## Key Commands

### Host commands (`nemoclaw`)

Run these on the host to set up, connect to, and manage sandboxes.

| Command                              | Description                                            |
|--------------------------------------|--------------------------------------------------------|
| `nemoclaw onboard`                  | Interactive setup wizard: gateway, providers, sandbox. |
| `nemoclaw <name> connect`            | Open an interactive shell inside the sandbox.          |
| `openshell term`                     | Launch the OpenShell TUI for monitoring and approvals. |
| `nemoclaw start` / `stop` / `status` | Manage auxiliary services (Telegram bridge, tunnel).   |

See the full [CLI reference](https://docs.nvidia.com/nemoclaw/latest/reference/commands.html) for all commands, flags, and options.

---

## Learn More

Refer to the documentation for more information on NemoClaw.

- [Overview](https://docs.nvidia.com/nemoclaw/latest/about/overview.html): Learn what NemoClaw does and how it fits together.
- [How It Works](https://docs.nvidia.com/nemoclaw/latest/about/how-it-works.html): Learn about the plugin, blueprint, and sandbox lifecycle.
- [Architecture](https://docs.nvidia.com/nemoclaw/latest/reference/architecture.html): Learn about the plugin structure, blueprint lifecycle, and sandbox environment.
- [Inference Profiles](https://docs.nvidia.com/nemoclaw/latest/reference/inference-profiles.html): Learn how NemoClaw configures routed inference providers.
- [Network Policies](https://docs.nvidia.com/nemoclaw/latest/reference/network-policies.html): Learn about egress control and policy customization.
- [CLI Commands](https://docs.nvidia.com/nemoclaw/latest/reference/commands.html): Learn about the full command reference.
- [Troubleshooting](https://docs.nvidia.com/nemoclaw/latest/reference/troubleshooting.html): Troubleshoot common issues and resolution steps.
- [Discord](https://discord.gg/XFpfPv9Uvx): Join the community for questions and discussion.

## Security

NVIDIA takes security seriously.
If you discover a vulnerability in NemoClaw, **DO NOT open a public issue.**
Use one of the private reporting channels described in [SECURITY.md](SECURITY.md):

- Submit a report through the [NVIDIA Vulnerability Disclosure Program](https://www.nvidia.com/en-us/security/report-vulnerability/).
- Send an email to [psirt@nvidia.com](mailto:psirt@nvidia.com) encrypted with the [NVIDIA PGP key](https://www.nvidia.com/en-us/security/pgp-key).
- Use [GitHub's private vulnerability reporting](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configuring-private-vulnerability-reporting-for-a-repository) to submit a report directly on this repository.

For security bulletins and PSIRT policies, visit the [NVIDIA Product Security](https://www.nvidia.com/en-us/security/) portal.

## Notice and Disclaimer

This software automatically retrieves, accesses or interacts with external materials. Those retrieved materials are not distributed with this software and are governed solely by separate terms, conditions and licenses. You are solely responsible for finding, reviewing and complying with all applicable terms, conditions, and licenses, and for verifying the security, integrity and suitability of any retrieved materials for your specific use case. This software is provided "AS IS", without warranty of any kind. The author makes no representations or warranties regarding any retrieved materials, and assumes no liability for any losses, damages, liabilities or legal consequences from your use or inability to use this software or any retrieved materials. Use this software and the retrieved materials at your own risk.

## License

Apache 2.0. See [LICENSE](LICENSE).
