# TmuxDock 2.1.0

把多台 SSH 服务器上的 tmux 会话停靠到本地 VS Code：一处查看、连接、记录和重建；特别适合 Claude Code、Codex 等 Agent CLI。

## 2.0 架构

插件只安装并运行在本机的 VS Code UI Extension Host，不需要安装到每台 SSH 服务器。它使用本机 OpenSSH、`~/.ssh/config` 和 ssh-agent 连接远端，再调用远端 tmux 和 Git。

```text
本地 VS Code / TmuxDock
├── dev-server
│   ├── claude-task
│   └── codex-task
└── another-host
        │ local OpenSSH
        ▼
      remote tmux
```

插件不保存 SSH 密码或私钥，也不会绕过主机指纹检查。服务器只需要 tmux 3.2+；不需要 VS Code Server 才能被查询。

## 安装与添加服务器

要求：本机 VS Code 1.90+ 和 OpenSSH；远端 Linux/macOS、tmux 3.2+。Windows 本机需安装并配置 OpenSSH Client。

1. 在本地 VS Code 窗口运行 **Extensions: Install from VSIX...**，选择 `tmuxdock-2.1.0.vsix`。
2. 在扩展详情中确认显示 **Installed Locally**，不要点击 Install in SSH。
3. 点击左侧 **TmuxDock** 图标，再点击顶部 **Add SSH Host** 图标。
4. 输入 `~/.ssh/config` 中的别名（例如 `dev-server`）或 `user@host`；tmux socket 留空即管理默认 server，也可填写命名 socket 进行隔离。首次主机指纹确认和交互式登录请先在普通终端执行一次 `ssh 主机`。
5. 添加成功后，侧栏按“服务器 → 会话”展示所有主机。

macOS/Linux 默认使用 OpenSSH ControlMaster 复用两分钟连接，减少一个刷新周期内反复握手。Windows 自动禁用连接复用。

## 日常操作

| 对象 | 操作 | 效果 |
| --- | --- | --- |
| 顶部 Add Host | Add SSH Host | 添加本地控制的 SSH 主机 |
| 服务器右键 | Edit Host Configuration | 修改 SSH 目标、显示名、tmux 路径、命名 socket 和默认目录 |
| 服务器行 New Session | New tmux Session | 实时浏览远端子目录后创建 tmux，可启动 Shell、Claude CLI、Codex CLI 或自定义命令 |
| 服务器行 Refresh | Refresh Sessions | 只刷新该 SSH 主机的 tmux 会话与恢复快照 |
| 服务器右键 | Open Remote Workspace | 用 Remote SSH 在新窗口打开目录 |
| 服务器右键 | Open SSH Terminal | 打开交互式 SSH，处理密码、二次验证或诊断 |
| 服务器右键 | Import 1.x Metadata | 从远端旧版 globalStorage 导入记录，原文件保持不变 |
| 会话点击 | Attach Session | 从本机通过 SSH 连接 tmux，并在中央编辑区打开；同一窗口重复点击会复用终端 |
| 现有会话右键 | Enable Recovery | 可选：保存恢复快照；不启用也能正常连接、改名和删除 |
| 会话右键 | Edit Session Note | 保存进度与下一步 |
| 会话右键 | Edit Restore Command | 为窗口/分屏设置明确的 Agent 续聊或启动命令 |
| 会话右键 | Rename Session | 只输入一次名称，同时作为列表显示名和真实远端 tmux 名 |
| 会话右键 | Delete Session | 永久停止远端 tmux 并删除本地记录，需要二次确认 |
| 会话右键 | Terminate | 终止远端 tmux 及其中进程，需要确认 |
| 会话右键 | Forget | 只忘记本地记录，不终止远端进程 |

`Delete Session` 是一键永久删除；`Terminate` 保留快照供以后重建，`Forget` 则保留远端进程。重命名与删除都会先核对会话身份，防止误操作一个同名但已被替换的 tmux。

远端原本就存在的 tmux 和 TmuxDock 新建的会话使用同一列表、同一点击与右键操作，不再显示 `unmanaged` 类型。区别只在于旧会话尚未保存恢复快照；需要重启后重建时再点 **Enable Recovery** 即可。新建流程只询问一次 Session Name，工作目录使用可输入、可逐级进入的远端子目录选择器。

每台主机显示在线/离线、运行中和可重建数量。手动刷新位于对应服务器行；会话主标题已是 tmux 名，右侧描述只显示 Git 分支或可重建状态等附加信息。在线时插件定期保存窗口、分屏、布局、目录和 Git 信息。

## 断线与恢复

- 关闭本地终端、VS Code 或电脑：远端服务器仍运行时，tmux 和 Agent CLI 继续工作。
- tmux server 消失或服务器重启：本地记录显示 **rebuild available**；恢复前可检查保存的命令，选择运行命令或只重建 shell。
- 工作区重建不恢复进程内存。Claude/Codex 旧对话必须使用各自 CLI 官方支持的 resume 命令。

Claude Code 官方 VS Code 插件是真正的 AI Agent；TmuxDock 是远程 tmux/任务生命周期控制器。它可以管理在 tmux 中运行的 `claude`、`codex` 等 CLI，但不控制 Claude 官方插件的 Webview 会话。

Marketplace 正式版扩展 ID 为 `mingwangsong.remote-agent-sessions`，命令与配置键继续使用 `remoteAgentSessions.*`。从开发版 `local.remote-agent-sessions` 切换前，请先执行 **Export Session Backup**；安装正式版后执行 **Import Session Backup**，它只合并数据，不覆盖同名主机或 session。

## 数据、安全与迁移

- 主机列表和会话记录保存在本地扩展 globalStorage，按主机隔离；导出备份权限为 `0600`。
- SSH 目标作为进程参数传递；远端命令参数逐项 POSIX 引用，并拒绝换行、NUL、以 `-` 开头的主机和非法 socket 名。
- 状态查询使用 `BatchMode=yes` 和超时；交互式 SSH/attach 允许正常认证提示。
- 不记录完整终端输出、环境变量、SSH 凭据或 AI 对话全文。不要把 Token 写入恢复命令。
- 1.x 数据通常位于远端 `~/.vscode-server/data/User/globalStorage/local.remote-agent-sessions/sessions.json`。使用 Import 1.x Metadata；导入不会删除或覆盖旧文件。
- TmuxDock stores recovery metadata locally. Before changing computers or moving from a development build to the Marketplace build, run **Export Session Backup**, then use **Import Session Backup** in the new installation. Import merges data and never overwrites matching hosts or sessions.

## 配置

| 设置 | 默认 | 说明 |
| --- | --- | --- |
| `remoteAgentSessions.sshPath` | `ssh` | 本机 OpenSSH 可执行文件 |
| `remoteAgentSessions.connectTimeout` | `10` | 非交互状态检查的连接超时秒数 |
| `remoteAgentSessions.multiplexSsh` | `true` | macOS/Linux 复用 SSH 连接；Windows 自动关闭 |
| `remoteAgentSessions.attachOnCreate` | `true` | 创建后立即 attach |
| `remoteAgentSessions.sessionTerminalLocation` | `editor` | `editor` 在中央编辑区打开；可改为 `panel` 使用集成终端面板 |
| `remoteAgentSessions.restoreCommands` | `ask` | `ask`、`always` 或 `never` |
| `remoteAgentSessions.refreshInterval` | `30` | 多主机刷新和快照间隔秒数 |

## 开发与验证

```bash
npm ci
npm run verify
npm run test:integration
npm run test:vscode
RAS_SSH_HOST=你的测试别名 npm run test:ssh
npm run package
npm run verify:package
RAS_TEST_VSIX=dist/tmuxdock-2.1.0.vsix npm run test:vscode
```

测试使用临时目录、随机 tmux socket 和隔离的 VS Code profile。真实 SSH 测试只读比较默认 tmux server，在随机 socket 上创建和清理测试会话。

## 当前范围

2.0 聚焦本地多主机控制、tmux 保活、布局快照、备注和显式恢复命令。远端元数据镜像、跨电脑同步、完整终端日志、自动 Agent 对话总结、官方 Claude Webview 会话控制和开机自动启动不属于当前版本。

详细验证见 TEST-REPORT.md。产品定位、演示和推广计划见 docs/。
