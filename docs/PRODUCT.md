# TmuxDock：把远程 tmux 会话停靠到本地 VS Code

一句话：在本地 VS Code 安装一次，通过已有 OpenSSH 配置集中查看、连接、记录和重建多台服务器上的 tmux 会话，尤其适合长期运行的 Agent CLI。

## 它是什么样子

左侧活动栏提供 TmuxDock 入口，侧栏按“SSH 主机 → tmux 会话”展示任务。本地点击会话后，插件创建一个 `ssh -tt` 终端并附着远端 tmux。Claude、Codex 或其他 Agent 仍在远端终端中运行；插件负责会话生命周期，不替代 Agent 本身。

```text
本地 VS Code
└── TmuxDock
    ├── dev-server           live sessions
    │   ├── api-refactor
    │   └── long-eval
    └── staging              offline
            │ 本机 OpenSSH
            ▼
         远端 tmux
```

产品图标由终端符号构成，在浅色和深色主题中跟随 VS Code 前景色显示。

## 为什么要用

tmux 解决“SSH 断开后进程不退出”，但没有解决多主机发现、任务说明、工作区记录和服务器重启后的重建。TmuxDock 在本地补齐这一层。

| 你的问题 | 本产品提供的帮助 |
| --- | --- |
| 多台服务器、十几个 tmux，记不住任务在哪 | 聚合主机和会话，显示名称、目录、Git 信息与状态 |
| 关闭本机窗口，担心 Agent 被杀 | Agent 继续运行在远端 tmux；以后点击同一会话继续 |
| 几天后不记得进度 | 本地保存备注、恢复命令和管理事件 |
| 服务器重启后 tmux 全丢 | 根据本地快照重建窗口、分屏、目录和显式命令 |
| 已经存在很多 tmux | 自动发现，按需纳管，不强迫迁移 |
| 不想每台服务器都安装插件 | 2.0 只安装在本地；远端仅需 SSH 与 tmux |

适合 VS Code、OpenSSH、Linux/macOS 服务器和长期运行的 Agent CLI 工作流。它不控制 Claude 官方 VS Code Webview，也不保存完整 AI 对话。

## 五分钟上手

1. 本机 VS Code 运行 **Extensions: Install from VSIX...**，选择 `tmuxdock-2.1.0.vsix`，确认 **Installed Locally**。
2. 远端安装 tmux 3.2+；先在普通本地终端执行一次 `ssh 主机别名`，完成主机指纹、密码或 MFA 交互。
3. 打开左侧 **TmuxDock**，点击 **Add SSH Host**，输入 `~/.ssh/config` 中的别名，例如 `dev-server`。
4. 展开服务器，点击已有会话即可连接；无需区分会话类型。需要保存恢复快照时右键 **Enable Recovery**。
5. 点击在线服务器行上的 **New tmux Session**，从实时远端子目录候选中选择工作目录，只输入一次名称；可以启动 Shell、Claude CLI、Codex CLI 或自定义命令。
6. 用 **Edit Session Note** 写进度；如需重启后续接对话，用 **Edit Restore Command** 保存该 Agent 官方支持的 resume 命令。不要写入密钥。
7. 右键 **Rename Session** 只输入一个名称并同步到真实 tmux；**Delete Session** 会停止进程并删除记录，而 **Terminate** 会保留可重建快照。

## 必须说清楚的边界

- 断线保活依赖远端 tmux 和服务器持续运行；插件不是云服务。
- 重建布局不等于恢复进程内存；旧 AI 对话需要相应 CLI 的 resume 能力。
- 本地保存任务元数据、备注和布局，不保存完整终端输出、AI 对话、SSH 密码或私钥。
- 自动快照只在本地 VS Code 运行且服务器可连接时发生。
- 当前版本不提供跨电脑同步、远端后台守护进程、自动总结或开机启动。

## 可以公开使用的简短介绍

“远程开发开了十几个 tmux，回来却不知道该进哪个？TmuxDock 把多台 SSH 服务器上的 tmux 会话停靠到本地 VS Code，记录进度，并在 tmux 丢失后按快照重建工作区。只安装一次，不替代你的 Agent，也不接管 SSH 凭据。”
