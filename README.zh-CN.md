![TmuxDock](media/showcase/hero.png)

# 让远程工作，始终停靠在手边。

**把多台主机上的 tmux、Codex 和 Claude，收进一个本地 VS Code 工作区。**

[安装插件](https://marketplace.visualstudio.com/items?itemName=mingwangsong.remote-agent-sessions) · [English](README.md) · [完整指南](docs/guide.zh-CN.md) · [更新记录](CHANGELOG.md)

![真实多主机会话工作区](media/showcase/01-workspace.png)

## 不止连接，更能接着工作

| 能力 | 使用体验 |
| --- | --- |
| 多主机停靠 | 用现有 SSH 配置发现、创建和连接 tmux，无需逐台安装插件。 |
| Agent 一眼识别 | Codex、Claude 使用官方标识，普通 Shell 使用终端图标；标签只保留简短会话名。 |
| 列表不再跳动 | 按创建时间排列，也可拖拽保存顺序；运行中与停止记录分开显示。 |
| 慢网络有反馈 | 操作显示进度和排队状态；已有标签本地直接复用。 |
| 删除后可恢复 | 先保存最后目录、布局和原对话 ID，再停止 tmux；恢复时重建同名会话并续接原对话。 |
| 重载保留标签 | 使用 VS Code 原生终端持久化，恢复标签及主机关联。 |

## 从停止，到继续

**Delete Session** 保留恢复记录。打开 **Stopped / Recoverable**，点击对应会话，即可按快照重建。

![停止后保留恢复记录](media/showcase/02-recoverable.png)

![恢复同名 tmux 和保存目录](media/showcase/03-restored.png)

恢复工作区不等于恢复进程内存。原 Agent 历史需仍保存在远端，旧记录需显式绑定原对话。截图使用隔离配置和合成任务数据，展示真实插件的 Shell 恢复；Agent 图标来自演示配置，没有运行模型或编造 AI 对话。

## 三步开始

1. 本地安装 TmuxDock；本机需 OpenSSH，远端需 tmux 3.2+，VS Code 需 1.90+。
2. 在活动栏打开 TmuxDock，点击 **Add SSH Host**，输入已能通过 SSH 连接的别名。
3. 点击现有会话，或创建 Codex、Claude、Shell 会话。Agent CLI 需安装在远端。

关闭终端标签只断开连接，远端 tmux 继续运行；**Delete / Terminate** 保存后停止；**Restore** 重建；**Forget** 永久移除本地记录、不停止远端进程。

## 本地控制，远端执行

插件运行在本地 VS Code，通过本机 OpenSSH 和 ssh-agent 连接远端。会话恢复元数据保存在本地，Agent 历史仍由远端 CLI 管理。不保存 SSH 密码、私钥或对话全文。支持备份导入导出，不提供云同步，也不控制官方 Agent 插件的聊天 Webview。

[配置与迁移](docs/guide.zh-CN.md) · [架构和开发](README.md#small-control-plane-real-remote-processes) · [测试证据](docs/evidence/README.md) · [参与贡献](CONTRIBUTING.md)

MIT 开源。Codex / OpenAI、Claude 标识归各自所有者所有；展示兼容工具不代表官方背书。
