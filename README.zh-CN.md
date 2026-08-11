<h1 align="center">ChatGPT Web for Codex</h1>

<p align="center">
  <strong>将 ChatGPT Web（包括 Pro）作为 Codex 原生模型使用。</strong><br>
  切换模型档位，保留原有工作流。
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

> Windows 用户请参阅 [Windows 安装指南](docs/windows.md)。Windows 使用显式的原生前台应用/
> `session`，不会注册开机或登录启动项；关闭应用会停止代理、隧道和受控 Chrome。

在 Codex 原生模型选择器中选择 **ChatGPT Web — Instant**、**Medium**、**High**、
**Extra High** 或 **Pro**。桥接程序会把完整的 Codex 任务上下文发送到一个全新的
ChatGPT 临时聊天，附加图片，并将可见的推理过程、工具活动和 Markdown 流式传回同一个
Codex 任务。

<p align="center">
  <img src="assets/demo.gif" alt="ChatGPT Web 在原生 Codex harness 中运行" width="960">
</p>

```text
Codex task ──Responses + SSE──▶ codex-chatgpt-web ──controlled Chrome──▶ ChatGPT
     ▲                                │                                      │
     └──────── native UI, context, images, tracing, and tool lifecycle ──────┘
```

## 亮点

- **原生 Codex harness。** 使用的仍然是你熟悉的 Codex 模型选择器、任务历史、上下文生命周期、
  审批、沙箱、流式输出、追踪和工具界面，而不是另一个聊天客户端。与 OpenCodex 类似，
  它只更换模型后端，同时保留原生工作流。
- **本地优先的任务会话。** Codex 仍然是电脑上任务历史的真实来源。每个浏览器轮次都会从一个
  全新的 ChatGPT 临时聊天开始，并接收完整的累计 Codex 上下文，因此浏览器聊天不会在任务之间
  复用，也不会加入普通 ChatGPT 历史记录。
- **通过 MCP 使用完整 Codex harness。** 在完整模式下，Instant 到 Extra High 可以通过 MCP
  使用当前 Codex 任务的文件系统、shell、图片、审批以及已配置的工具和应用。调用及其真实结果
  会留在同一个浏览器响应中，不会被模拟成文本。
- **Pro 仍然实用。** Pro 是唯一的例外：ChatGPT 当前的 Pro 模式不会暴露此桥接程序所需的自定义
  MCP 连接器。它的原生能力（包括网页搜索和研究）仍然可用。你可以先用 Instant 到 Extra High
  收集本地工作区上下文，再切换到 Pro；Pro 会收到完整的累计 Codex 任务，用于更深入的分析。
- **故障时明确失败，并经过人工测试。** 模型选择、超长内联上下文、图片、流式输出、可见追踪、
  上下文压缩、原生工具轮次、取消操作和 Pro 均已在 macOS 上完成端到端测试。Windows 会运行共享
  协议测试，以及原生运行时、安装程序、Job Object 清理和真实系统 Chrome 启动冒烟测试；经过身份
  验证的 ChatGPT 轮次仍需使用实际账户手动验证。UI 变化或能力缺失会产生明确错误，而不是静默回退。

临时聊天是 ChatGPT 的隐私模式，并不代表匿名或仅在本地推理：提示仍会由 OpenAI 处理，并受账户
设置及 OpenAI [临时聊天政策](https://help.openai.com/en/articles/8914046-temporary-chat-faq)
约束。本项目为非官方项目；用户仍需自行遵守适用的 OpenAI 条款和工作区政策。

## 快速开始

仅浏览器模式需要 macOS 或 Windows、Google Chrome 和 ChatGPT 账户。它不需要 API 密钥、隧道、
OpenCodex 或额外下载 Playwright 浏览器。

### Windows

从[最新版本](https://github.com/miuuyy/codex-chatgpt-web/releases/latest)下载与电脑架构匹配的离线安装程序：

- Intel/AMD Windows：`codex-chatgpt-web-windows-x64-setup.exe`
- Windows ARM64：`codex-chatgpt-web-windows-arm64-setup.exe`

双击安装程序并选择 **Install**，保留 **Launch Codex ChatGPT Web now**。在原生 Windows
应用中完成仅浏览器模式设置，通过专用 Chrome 窗口登录，然后选择 **Start session**。
使用 ChatGPT Web 模型时请保持该应用打开。

安装仅作用于当前用户，不需要管理员权限。它会创建开始菜单快捷方式、可选的桌面快捷方式和
“已安装的应用”卸载项，但绝不会创建 Windows 服务、计划任务、Run 注册表项、Startup
启动项或其他开机/登录持久化。关闭应用会停止代理、完整模式隧道和受控 Chrome；登录或重启后，
请重新打开应用并手动启动会话。

若要从源码构建同一个离线安装程序，请安装 Bun 1.3.11，运行
`bun install --frozen-lockfile`、`bun run verify` 和 `bun run package:windows`。
完整说明、校验和、PowerShell 高级安装、完整 harness 设置、故障排查和卸载步骤请参阅
[Windows 安装指南](docs/windows.md)。

可以在应用中选择 **Uninstall Codex ChatGPT Web...**，或从
**设置 → 应用 → 已安装的应用** 卸载。当前用户卸载界面可选择保留或删除私有的浏览器/配置数据，
会恢复此前的 Codex 路由，并只删除已验证的运行时、自有快捷方式、精确的 PATH 条目和 HKCU
卸载记录。

### macOS

```bash
curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh \
  | sh -s -- --browser-only --acknowledge-unofficial
```

在安装程序打开的唯一一个 Chrome 窗口中登录，重启一次 Codex，然后选择一个
**ChatGPT Web — …** 模型。只有通过身份验证的账户支持 Pro 时，Pro 才会显示。
完成后，程序会在 macOS 登录后自动启动，无需再次执行终端命令。

## 模式

| 模式 | 模型 | 本地 Codex 工具 | 额外设置 |
| --- | --- | --- | --- |
| **仅浏览器** | Instant 到 Pro | 不可用；Codex 会显示警告 | 无 |
| **完整 harness** | Instant 到 Pro | Instant–Extra High：可用；Pro：只读 | OpenAI 隧道 + ChatGPT 连接器 |

模型选择器中的每一项都对应一个固定的 ChatGPT 模式。Codex 仍会显示内置的 Effort 和 Speed
选项，但更改它们不会在后台静默切换所选的浏览器模型。Pro 会收到 Codex 已经收集的完整上下文，
但 ChatGPT Pro 无法主动发起本地 MCP/工具调用。

代理继续使用 Codex 内置的 `openai` provider 作为模型目录来源。在**仅浏览器**模式下，它只把
官方目录用作元数据模板，只暴露新增的 ChatGPT Web 条目，并拒绝原生模型的 Responses/压缩转发；
这样仅浏览器模式会安全地失败，而不会把任务静默切换到原生 Codex 后端。**完整 harness** 模式则
继续保留原生模型目录和原生转发，并与 ChatGPT Web 模型同时可用。两种模式下，任务历史、审批、
沙箱和工具结果仍由 Codex 管理。

## 完整 harness

完整模式通过官方
[OpenAI tunnel-client](https://github.com/openai/tunnel-client)
将 ChatGPT 的工具调用连接回当前 Codex 任务。该隧道为出站连接：不会暴露公网 IP、开放入站端口，
也不需要配置路由器端口转发。

下面的命令展示 macOS 发布版流程。Windows 请使用
[Windows 指南中的完整 harness 步骤](docs/windows.md#full-harness-setup)；Windows 上由前台
`session` 命令统一管理隧道。

1. 在 [Platform 隧道设置](https://platform.openai.com/settings/organization/tunnels)中创建隧道。
2. 在 [Platform API 密钥设置](https://platform.openai.com/settings/organization/api-keys)中创建一个仅具有
   **Tunnels Read + Use** 权限的运行时密钥。
3. 安装并导入密钥：

   ```bash
   curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ~/.local/bin/codex-chatgpt-web tunnel key-import
   ```

4. 使用你的隧道 ID 运行设置：

   ```bash
   ~/.local/bin/codex-chatgpt-web setup --full \
     --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
     --acknowledge-unofficial
   ```

5. 当 `doctor` 报告 ready 时，在
   [ChatGPT 连接器设置](https://chatgpt.com/#settings/Connectors)中将该隧道连接到一个名为
   `Codex Native` 的 ChatGPT 连接器，扫描其工具，配置需要的操作权限，然后重启一次 Codex。

写入/修改操作需要 ChatGPT 工作区及管理员政策允许。OpenAI 目前仅为 Business 和
Enterprise/Edu 工作区说明了这些操作；个人 Pro 账户仅限 read/fetch MCP 权限。请参阅
[开发者模式和 MCP 应用](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt)。
除非显式启用 `--auto-approve-tool-calls`，否则意外的审批提示会直接失败；该选项只会点击
**Allow once**，绝不会授予永久权限。

## 日常操作

```bash
codex-chatgpt-web session              # Windows：原生前台应用的高级命令行替代方式
codex-chatgpt-web doctor
codex-chatgpt-web service status       # macOS 托管服务
codex-chatgpt-web tunnel status        # 完整模式
codex-chatgpt-web browser check
codex-chatgpt-web login                # 刷新已过期的 ChatGPT 会话
codex-chatgpt-web uninstall --yes
```

设置程序会将私有状态保存在 `~/.codex-chatgpt-web`（Windows 上为对应的用户配置目录）下，并记录
此前的 Codex 路由，以便卸载时恢复。macOS 安装带版本的 launchd 服务；Windows 使用显式的前台
应用/`session` 所有者。除非显式提供 `--replace-codex-route`，否则它不会替换不同的路由；任务仍在
活动时，它也会拒绝停止或更新。

如果你在原生工具轮次之间停止 Codex 任务，Codex 将不再有可用于发送取消信号的 Responses 请求。
此时可以在不停止 daemon 的情况下中止仍保留的浏览器轮次，然后重试更新：

```bash
codex-chatgpt-web service cancel-turns
```

## 限制和安全性

- 这是非官方浏览器自动化，并非 OpenAI API。ChatGPT UI 变更可能破坏选择器；发生变化时会明确
  失败，而不是静默切换模型或传输方式。
- 浏览器状态是敏感的登录凭据。切勿共享或提交 `~/.codex-chatgpt-web/browser`。
- Responses 监听器只绑定到 loopback，但以同一本地用户身份运行的其他进程仍可访问它。
  请仅在可信的单用户工作站上使用。
- 浏览器轮次会串行执行，以保护单一 profile 并防止任务之间复用对话内容。
- macOS 使用托管 launchd 服务。Windows 有意使用前台应用/会话，不创建任何自动启动项。
- Codex Desktop 会将 Pro 的 wire effort 固定显示为 **Ultra**，并始终显示 **Standard** speed。
  这些控件不会改变固定的 ChatGPT Web 模型；重命名它们需要修改已签名的 Codex 应用。
- Playwright 启动已安装的 Chrome 时，macOS 可能提示 Bun 被阻止修改应用。桥接程序不会修改
  Chrome；保持拒绝该 App Management 权限是正常且符合预期的。

启用完整模式前，请阅读完整的[架构说明](docs/architecture.md)和
[安全模型](docs/security-model.md)。安全漏洞请通过 [SECURITY.md](SECURITY.md) 报告。

## 开发

```bash
bun install --frozen-lockfile
bun run verify
```

`verify` 会运行依赖审计、严格 TypeScript 检查、harness/MCP/配置测试、可重定位运行时冒烟测试，
以及在可用时进行一次真实的系统 Chrome 无头启动。

- [架构说明](docs/architecture.md)
- [安全模型](docs/security-model.md)
- [贡献指南](CONTRIBUTING.md)

## 致谢与免责声明

Responses 转换、Codex 目录集成和浏览器 harness 的部分代码依据 MIT 许可证改编自
[OpenCodex](https://github.com/lidge-jun/opencodex)。详情请参阅
[第三方声明](LICENSES/NOTICE.md)。

本项目是实验性的独立软件，与 OpenAI 无关联，也未获得 OpenAI 背书。不得使用本项目规避使用限制
或访问控制。在公开分发前，请查阅 OpenAI 当前的
[使用条款](https://openai.com/policies/terms-of-use/)和
[服务协议](https://openai.com/policies/services-agreement/)。
