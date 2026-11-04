# TmuxDock 2.4.1

把多台 SSH 服务器上的 tmux 会话停靠到本地 VS Code：一处查看、连接、记录和重建；特别适合 Claude Code、Codex 等 Agent CLI。

## 重载后保留标签

执行 **Developer: Reload Window** 后，TmuxDock 使用 VS Code 原生终端持久化保留已打开标签的名称、顺序、编辑器分组、当前选中项及底部终端。重载后按进程 ID 和主机/session 身份恢复扩展关联，机器状态栏、侧栏选中和点击复用继续正常；不会仅凭同名标签猜测所属主机。

重载只重连已有终端进程，不会重新运行 Agent 启动命令，也不会把关闭的标签或 Stopped 会话自动复活。若 VS Code 在完整重启后重新启动保存的连接进程，连接脚本会先检查原 tmux ID、创建时间和 owner，拒绝连接同名替代会话。

需保持 VS Code 的 `terminal.integrated.enablePersistentSessions` 开启（默认开启）；扩展不覆盖你的终端设置。升级前由 2.3.x 创建的旧标签使用临时终端标记，需在加载新版后从侧栏重新打开一次，此后重载会保留。

## Agent 对话恢复

通过 **Claude Code CLI** 或 **Codex CLI** 选项新建时，Agent 对话默认使用最终的 tmux session 名（包括自动避重名后缀）。Claude 通过 `--session-id` / `--name` 初始化；Codex 通过官方 app-server 创建、命名并保存对话 ID，再按该 ID 打开 CLI。TmuxDock 不发送初始模型提示，不自动改变 CLI 的权限或沙箱配置。

Stop / Terminate 保留原对话 ID 和每个 pane 的恢复绑定。点击停止组中的已绑定 Agent 会话，默认直接按 ID 恢复同一对话，而不是运行一个新的 `claude` / `codex`。配置 `restoreCommands=never` 仍只恢复 shell；其他自定义 pane 命令仍按原有策略询问。原对话历史必须仍保存在服务器上的 CLI 数据目录中；历史缺失时明确报错，不使用 `--last` 猜测，也不静默新建。Claude 首次交互尚未产生可保存历史时，不能承诺恢复一段不存在的对话。

旧版本 Stop 记录没有保存对话 ID：右键 **Bind Original Agent Conversation**，粘贴原 CLI 对话 UUID，验证通过后绑定。此后可以直接续聊；恢复旧记录时也会提供绑定或只重建 shell 的选择。绑定不会复制或保存对话全文。普通 shell 与自定义命令不自动转换为 Agent 恢复。

## 2.3.2 延迟优化

新建和恢复把有先后依赖的 tmux 命令放进同一次 SSH 请求，保留原命令顺序和失败即停止语义；启动命令仍在恢复记录持久化后发送。恢复时相同目录只校验一次，不同目录最多三路只读并发。普通会话实测新建从 11 次降至 9 次 SSH 调用，恢复从 10 次降至 8 次；窗口/分屏布局、选择钩子、身份检查和原 Agent 对话校验保持原有行为。

## 2.3.1 延迟优化

备注、恢复命令和连接记录仅更新本地持久化数据，不再为此查询 SSH。已打开的终端直接复用，不排队等待同主机的慢刷新。远端变更完成后去掉重复列表刷新；后台快照复用一次 tmux 查询中的全部窗口和分屏数据，并按目录合并 Git 查询（不同目录最多三路只读并发）。Claude CLI 能力检查短暂缓存，Codex 旧对话绑定在同一个元数据连接中完成验证和命名；不缓存或跳过恢复时的历史存在性检查。

## 2.2 使用体验

终端编辑区标签只显示 session 名称和类型图标，不加服务器名称。重名标签仅追加 `· 2` 等短编号，其他标签不改名。选中 TmuxDock 终端时，底部状态栏显示所属服务器，悬停显示 SSH 目标与 session 信息，点击打开详情；切到普通终端时隐藏。终端启动提示也保留主机信息。编辑器标签切换会同步状态栏和可见侧栏中的会话选中项；切到普通文件标签时隐藏机器状态栏。旧标签请关闭后重新点击会话，以使用新标题。

Codex 使用官方 Codex 扩展的 OpenAI Blossom 标识（浅色主题黑色、深色主题白色），Claude 使用官方 Claude Code 扩展的陶土色标识，常规 Shell/自定义任务使用终端图标。品牌标识保留原始形状与颜色，运行/停止状态通过分组体现。类型依据保存的 Agent 配置、当前分屏进程名及恢复命令识别；未知进程显示普通终端，不根据会话名称猜测。分支信息保留在详情页，列表标题和描述均不显示。

每台服务器下按状态分组：**Running**（运行中，默认展开）、**Stopped / Recoverable**（已停止且有恢复记录，默认折叠）。连接失败或身份冲突单列为 **Status unavailable**，不误报为已停止。空组不显示。排序和拖拽在各组内生效，不能通过跨组拖拽改变会话状态。

- 点击操作立即显示通知进度、当前阶段、等待时长及服务器/会话行的旋转图标；慢请求或排队都有可见反馈，失败显示错误。
- 同一会话的重复点击合并；不同服务器独立执行操作，后台快照不会占用前台操作队列。
- 会话默认按创建时间从早到晚排列，不随活动时间、备注、连接或后台刷新跳动。
- 在同一服务器内拖拽会话到目标会话上方对应的位置，保存自定义顺序；拖到服务器行则移到末尾。新会话追加到自定义顺序之后。顺序保存在本机，重载后仍生效。
- 服务器右键 **Reset Session Order (Creation Time)** 恢复创建时间排序。
- 创建和连接不再预先快照全部会话；窗口与分屏用一次远程调用读取，Git 信息也合并查询。已有终端可直接复用。

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

1. 在本地 VS Code 窗口运行 **Extensions: Install from VSIX...**，选择 `tmuxdock-2.4.1.vsix`。
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

每台主机显示在线/离线、运行中和可重建数量。手动刷新位于对应服务器行；会话主标题已是 tmux 名，右侧描述只显示可重建状态等信息，不显示 Git 分支。在线时插件定期保存窗口、分屏、布局、目录和 Git 信息。

## 断线与恢复

- 关闭本地终端、VS Code 或电脑：远端服务器仍运行时，tmux 和 Agent CLI 继续工作。
- tmux server 消失或服务器重启：本地记录显示 **rebuild available**；恢复前可检查保存的命令，选择运行命令或只重建 shell。
- 工作区重建不恢复进程内存。新建的已绑定 Claude/Codex 对话会自动使用官方 resume 接口；旧记录须先绑定原对话 ID。

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
npm run test:agent-recovery
npm run test:vscode
RAS_SSH_HOST=你的测试别名 npm run test:ssh
npm run package
npm run verify:package
RAS_TEST_VSIX=dist/tmuxdock-2.4.1.vsix npm run test:vscode
```

测试使用临时目录、随机 tmux socket 和隔离的 VS Code profile。真实 SSH 测试只读比较默认 tmux server，在随机 socket 上创建和清理测试会话。

## 当前范围

当前版本聚焦本地多主机控制、tmux 保活、Agent 对话身份绑定与恢复、布局快照、备注和自定义恢复命令。远端元数据镜像、跨电脑同步、完整终端日志、自动 Agent 对话总结、官方 Claude Webview 会话控制和开机自动启动不属于当前版本。

详细验证见 TEST-REPORT.md。产品定位、演示和推广计划见 docs/。
