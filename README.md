<h1 align="center">ChatGPT Web for Codex</h1>

<p align="center">
  <strong>Use ChatGPT Web (including Pro) as native Codex models.</strong><br>
  Change the model tier, save your workflow.
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a>
</p>

<p align="center">
  <a href="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml"><img src="https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/macOS-arm64%20%7C%20Intel-black?logo=apple" alt="macOS arm64 and Intel">
  <img src="https://img.shields.io/badge/Free_AI-no_API_fees-10a37f" alt="Free AI with no API fees">
  <img src="https://img.shields.io/badge/Windows-x64%20%7C%20ARM64-0078d4?logo=windows11" alt="Windows x64 and ARM64">
</p>

Pick **ChatGPT Web — Instant**, **Medium**, **High**, **Extra High**, or **Pro** in Codex's native
model picker. The bridge sends the complete Codex task context to a fresh ChatGPT Temporary Chat,
attaches images, and streams visible reasoning, tool activity, and Markdown back into the same
Codex task.

<p align="center">
  <img src="assets/demo.gif" alt="ChatGPT Web running inside the native Codex harness" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──controlled Chrome──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

## Highlights

- **Native Codex harness.** This is the same model-picker, task history, context lifecycle,
  approvals, sandbox, streaming, tracing, and tool UI you already use in Codex—not a second chat
  client. Like OpenCodex, it changes the model backend while preserving the native workflow.
- **Local-first task sessions.** Codex remains the source of truth for task history on your
  computer. Every browser turn starts in a fresh ChatGPT Temporary Chat and receives the complete
  accumulated Codex context, so browser chats are not reused across tasks or added to normal
  ChatGPT history.
- **The full Codex harness over MCP.** In full mode, Instant through Extra High can use the active
  Codex task's filesystem, shell, images, approvals, and configured tools/apps through MCP. Calls
  and real results stay inside the same browser response—nothing is simulated as text.
- **Pro stays useful.** Pro is the one exception: ChatGPT's current Pro mode does not expose the
  custom MCP connector this bridge needs. Its native capabilities, including web search and
  research, remain available. Gather local workspace context with Instant through Extra High,
  switch to Pro, and Pro receives the complete accumulated Codex task for deeper analysis.
- **Fail-closed and manually tested.** Model selection, long inline context, images, streaming,
  visible trace, compaction, native tool rounds, cancellation, and Pro were exercised end-to-end on
  macOS. Windows runs the shared protocol suite plus native runtime, installer, Job Object cleanup,
  and real system-Chrome launch smokes; authenticated ChatGPT turns still require account-level
  manual verification. UI drift and missing capabilities produce explicit errors rather than
  silent fallbacks.

Temporary Chat is a ChatGPT privacy mode, not anonymity or local-only inference: prompts are still
processed by OpenAI and are subject to the account's settings and OpenAI's
[Temporary Chat policy](https://help.openai.com/en/articles/8914046-temporary-chat-faq). This project
is unofficial; users remain responsible for complying with applicable OpenAI terms and workspace
policies.

## Quick start

Browser-only mode needs macOS or Windows, Google Chrome, and a ChatGPT account. It does not need an
API key, tunnel, OpenCodex, or a Playwright browser download.

### Windows

Download the architecture-matching offline setup from the
[latest release](https://github.com/miuuyy/codex-chatgpt-web/releases/latest):

- `codex-chatgpt-web-windows-x64-setup.exe` for Intel/AMD Windows
Double-click it, choose **Install**, and leave **Launch Codex ChatGPT Web now** checked. The native
Windows control center handles both browser-only and full-harness setup; you do not need to run the
setup CLI for normal use.

For browser-only mode, keep **Browser-only (Recommended)** selected on the **Setup** tab, accept the
unofficial-software notice, choose **Set up and sign in**, finish signing in through the dedicated
Chrome window, close that Chrome window completely, then choose **Start session** on **Home**.

For full harness, create the OpenAI tunnel and runtime key first, then select **Full mode (Advanced)**
in the same **Setup** tab and enter them directly in the GUI. After setup, start the foreground
session, attach and scan the connector while that session is running, and restart Codex once. See
[Full harness on Windows](#full-harness-on-windows) below for the complete GUI flow.
Keep the control center open while using the ChatGPT Web models; closing it stops the foreground
runtime, controlled Chrome, and the full-mode tunnel.

The per-user installer requires no administrator access and creates Start Menu plus optional
Desktop shortcuts and an Apps & Features uninstall entry. It deliberately creates no service,
Scheduled Task, Run key, Startup entry, or other boot/login persistence. Closing the app stops the
proxy, tunnel (full mode), and controlled Chrome; open it and start a session again after login or
reboot.

To build the same offline setup from this checkout, install Bun 1.3.11 and run
`bun install --frozen-lockfile`, `bun run verify`, then `bun run package:windows`. See the complete
[Windows setup guide](docs/windows.md) for checksums, advanced PowerShell installation, full-harness
setup, lifecycle details, troubleshooting, and uninstall.

Choose **Uninstall Codex ChatGPT Web...** in the app or use
**Settings → Apps → Installed apps**. The per-user removal UI can keep or delete private
browser/configuration data, restores the prior Codex route, and removes only its verified runtime,
owned shortcuts, exact PATH entry, and HKCU uninstall record.

### macOS

The macOS release bundles Bun, so no system Node/Bun installation is needed:

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh \
  | sh -s -- --browser-only --acknowledge-unofficial
```

Sign in through the one Chrome window opened by setup, restart Codex once, and select a
**ChatGPT Web — …** model. Pro appears only when it is available on the authenticated account.
Normal macOS use starts automatically after login and does not require another terminal command.

## Modes

| Mode | Models | Local Codex tools | Extra setup |
| --- | --- | --- | --- |
| **Browser-only** | Instant through Pro | No; Codex shows a warning | None |
| **Full harness** | Instant through Pro | Instant–Extra High: yes; Pro: read-only | OpenAI tunnel + ChatGPT connector |

Every picker entry has one fixed ChatGPT mode. Codex still displays its built-in Effort and Speed
rows, but changing them cannot silently change the selected browser model. Pro receives the full
context already collected by Codex, but ChatGPT Pro cannot initiate local MCP/tool calls.

The proxy keeps Codex's built-in `openai` provider as the catalog source. In **browser-only** mode,
it uses the official catalog only as a metadata template, exposes only the added ChatGPT Web
entries, and rejects native-model Responses/compaction passthrough. This makes browser-only fail
closed instead of silently switching a task onto the native Codex backend. **Full harness** mode
keeps the native catalog entries and native passthrough available alongside the ChatGPT Web models.
Task history, approvals, sandboxing, and tool results remain owned by Codex in both modes.

## Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

### Full harness on Windows

The Windows control center can configure full mode end-to-end. The runtime and tunnel are
foreground-owned, so keep the control center open whenever Codex is using the ChatGPT Web models.

1. Before running setup, create a tunnel in
   [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a runtime key with **Tunnels Read + Use** in
   [Platform API key settings](https://platform.openai.com/settings/organization/api-keys).
3. Open **Codex ChatGPT Web** and go to **Setup**. Under **1. Choose a mode**, select
   **Full mode (Advanced) - adds local tools through an OpenAI tunnel**.
4. Under **2. Advanced full-mode credentials**, paste the `tunnel_...` id into **Tunnel ID** and
   paste the runtime key into **Runtime key**. The key is passed to setup through redirected stdin;
   it is not placed in command-line arguments or GUI logs.
5. Under **3. Connection details**, keep **Connector name** as `Codex Native` unless you intend to
   use a different matching name in ChatGPT. The default port and detected Chrome path normally do
   not need changing. Leave **Automatically click per-call Allow once prompts** off unless you
   explicitly want the bridge to accept those one-time prompts for you.
6. Check the unofficial-software acknowledgement and choose **Set up and sign in**. When the
   dedicated Chrome window opens, sign in to ChatGPT, confirm the composer is visible, then close
   that Chrome window completely. Setup returns you to **Home** when it succeeds.
7. On **Home**, choose **Start session**. Wait until the foreground runtime is healthy; in full mode
   the Responses proxy starts first and the tunnel may take a little longer to become ready. Keep
   this control-center window open.
8. While that foreground session is running, complete the ChatGPT account-side app/connector setup
   described in [Set up the Codex Native app in ChatGPT](#set-up-the-codex-native-app-in-chatgpt).
   The **Settings & Support** tab has shortcuts to **ChatGPT Connectors**, **Tunnel settings**, and
   **Runtime keys**.
9. Restart Codex once, then choose a **ChatGPT Web - ...** model in Codex. Instant through Extra
   High can call the current Codex task's local tools in full mode. Pro still receives the complete
   accumulated task context but cannot initiate these local MCP/tool calls.

If you rerun or repair full-mode setup later, the GUI can reuse already configured tunnel
credentials; leave a credential field blank when the control center says that saved value is
available. Use **Diagnostics > Run diagnostics** if the session or tunnel does not become ready.
The advanced CLI equivalents remain documented in the
[Windows setup guide](docs/windows.md#full-harness-setup).

#### Set up the Codex Native app in ChatGPT

This is the account-side part of full harness. In current ChatGPT terminology, the private MCP
integration is a **custom app**; older UI and this project may also call it a **connector**. You do
not need to find or install a public `Codex Native` listing from the Plugins Directory. You are
creating a private custom MCP app that points at the tunnel started by the Windows control center.

Keep **Codex ChatGPT Web** open with **Start session** running while you do these steps. The tunnel
is foreground-owned on Windows, so ChatGPT cannot scan the app while the control center is closed.

Before starting, check the account/workspace role. On Business, an admin/owner enables developer
mode and creates the custom app. On Enterprise/Edu, an admin/owner can grant developer-mode access
to authorized users, who then enable it for their own account. Pro can enable developer mode for a
custom MCP app, but is limited to read/fetch MCP access rather than the full write-capable feature
set.

1. Open ChatGPT on the web and enable **Developer mode** for the account that will use the bridge.
   When your account has permission, the toggle is under **Settings > Apps > Advanced Settings**;
   workspace admins/owners may need to enable developer-mode access first.
2. Open the custom app creation flow. Admins/owners can use **Workspace settings > Apps > Create**;
   authorized users can use **Settings > Apps > Create** when their workspace permits developer
   mode.
3. Create the app with the same name used in the Windows GUI, normally `Codex Native`. Attach the
   OpenAI tunnel created earlier to this custom MCP app/connector. If ChatGPT still labels this area
   **Connectors**, use that equivalent create/attach flow.
4. Choose **Scan Tools** and wait for the scan to finish. The Windows foreground session must still
   be running. Confirm that the scanned tools belong to `Codex Native` before saving or creating the
   app.
5. Review the app's action permissions. Only enable the read, file, command, process, or other
   actions you actually intend ChatGPT to use. Write/modify actions also depend on the ChatGPT plan,
   workspace policy, and admin controls.
6. Save/create the app. For private testing on the same authorized account, it can remain a
   developer-mode app. If other workspace members need it, an admin/owner must publish or otherwise
   enable the app for those members according to the workspace's app policy.
7. Confirm the app appears under **Settings > Apps > Enabled Apps** (developer-mode apps may show a
   **Dev** label), then return to Codex and restart Codex once before the first full-harness task.

If the account cannot enable developer mode or the **Create** action is unavailable, check the
workspace role and app policy rather than changing the local tunnel configuration. OpenAI currently
documents full MCP, including write/modify actions, for Business and Enterprise/Edu workspaces.
Pro accounts can use developer mode with custom MCP apps for read/fetch access, but not the full
write-capable MCP feature set. See [developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)
and [Apps in ChatGPT](https://help.openai.com/en/articles/11487775-connectors-in-chatgpt).

### Full harness on macOS / CLI

The commands below show the macOS release path:

1. Create a tunnel in [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels).
2. Create a runtime key with **Tunnels Read + Use** in [Platform API key settings](https://platform.openai.com/settings/organization/api-keys).
3. Install and import the key:

   ```bash
   curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ~/.local/bin/codex-chatgpt-web tunnel key-import
   ```

4. Run setup with your tunnel id:

   ```bash
   ~/.local/bin/codex-chatgpt-web setup --full \
     --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
     --acknowledge-unofficial
   ```

5. While `doctor` reports ready, attach that tunnel to a ChatGPT connector named `Codex Native`
   in [ChatGPT connector settings](https://chatgpt.com/#settings/Connectors), scan its tools, set
   the intended action permissions, and restart Codex once.

Write/modify actions require a ChatGPT workspace and admin policy that permit them. OpenAI
currently documents those actions for Business and Enterprise/Edu workspaces; personal Pro is
limited to read/fetch MCP permissions. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

## Operations

```bash
codex-chatgpt-web session               # Windows advanced alternative to the foreground GUI
codex-chatgpt-web doctor
codex-chatgpt-web service status        # macOS managed service
codex-chatgpt-web tunnel status        # full mode
codex-chatgpt-web browser check
codex-chatgpt-web login                # refresh an expired ChatGPT session
codex-chatgpt-web uninstall --yes
```

Setup stores private state under `~/.codex-chatgpt-web` (the equivalent user-profile path on
Windows) and journals the previous Codex route so uninstall can restore it. macOS installs
versioned launchd services. Windows instead uses the explicit foreground GUI/session owner
described above. Setup refuses to replace a different route unless `--replace-codex-route` is
explicit, and refuses to stop or update while a task is still active.

If you stop a Codex task between native tool rounds, no Responses request remains on which Codex
can signal cancellation. Abort the retained browser turn without stopping the daemon, then retry
the update:

```bash
codex-chatgpt-web service cancel-turns
```

## Limitations and security

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- Browser state is a sensitive login artifact. Never share or commit
  `~/.codex-chatgpt-web/browser`.
- The Responses listener is loopback-only, but another process running as the same local user can
  reach it. Use a trusted single-user workstation.
- Browser turns are serialized to protect one profile and prevent transcript reuse across tasks.
- macOS uses managed launchd services. Windows intentionally uses a foreground app/session and
  creates no automatic startup entry.
- Codex Desktop hardcodes Pro's wire effort as **Ultra** and always shows a **Standard** speed row.
  Those controls do not alter the fixed ChatGPT Web model. Renaming them would require patching the
  signed Codex app.
- macOS may report that Bun was prevented from modifying apps when Playwright launches installed
  Chrome. The bridge does not modify Chrome; leaving that App Management permission denied is
  expected.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

## Development

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` runs dependency auditing, strict TypeScript checks, harness/MCP/config tests, a
relocatable runtime smoke test, and a real headless launch of system Chrome where available.

- [Architecture](docs/architecture.md)
- [Security model](docs/security-model.md)
- [Contributing](CONTRIBUTING.md)

## Credits and disclaimer

Portions of the Responses translation, Codex catalog integration, and browser harness were adapted
from [OpenCodex](https://github.com/lidge-jun/opencodex) under the MIT license. See
[third-party notices](LICENSES/NOTICE.md).

This project is experimental, independent software. It is not affiliated with or endorsed by
OpenAI, and it must not be used to evade usage limits or access controls. Review OpenAI's current
[Terms of Use](https://openai.com/policies/terms-of-use/) and
[Services Agreement](https://openai.com/policies/services-agreement/) before public distribution.
