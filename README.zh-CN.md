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
| 右侧原生目录树 | 跟随 session 的固定工作目录，使用当前文件图标主题和原生编辑器。 |
| 文件与实时预览 | 上传、下载文件；HTML 资源变化自动刷新；Markdown 复用 VS Code 自带预览。 |
| 重载保留标签 | 使用 VS Code 原生终端持久化，恢复标签及主机关联。 |

## Agent、文件、预览放在一个窗口

右键会话 → **Session Files**，在右侧查看固定工作目录。切换 session 标签时目录随之切换，也可通过 **Pin File Tree** 固定当前目录，**Follow Active Session** 恢复跟随。新会话把初始化目录保存为固定根目录；终端后续 `cd` 和 Delete / Restore 都不改变它。旧会话首次使用时自动固定已保存目录或当前活动分屏目录；也可用 **Link Directory** 修改，无需启用恢复功能。

文件单击用 VS Code 原生编辑器打开。目录右键可 **Upload**，文件右键可 **Download**；HTML 显示 **Preview HTML**，Markdown 显示 **Preview MD**。目录树内可把文件、文件夹拖入其他目录，拖回根目录行即可移回根目录；从桌面拖入文件或整个文件夹，可直接上传到根目录、子目录或空白区域。标题栏新建始终作用于根目录，目录右键新建作用于该目录。移动不覆盖同名目标，文件夹上传不合并已有目录。

HTML 支持相对路径和根路径的 CSS、JS、图片，Agent 修改已加载资源后自动重载；HTML 和 Markdown 每次预览都在当前编辑器分组新建独立标签，切换 session 不覆盖旧预览；不会自动分屏，Reload Window 后保留布局。Markdown 直接使用 VS Code 自带预览。

远端 Linux/macOS 需 Python 3；上传下载复用本地 OpenSSH，推荐 OpenSSH 9+ 的 SFTP 传输。上传覆盖同名文件前会确认，传输有进度和取消入口。保存先写临时文件再原子替换，失败不留下半截目标文件；单文件读取与保存限制 16 MiB。目录树右键支持 **Copy Full Path**（远端绝对路径）、**Copy Relative Path**（相对当前 session 根目录）、**Rename** 和 **Delete Permanently**。永久删除必须再次确认，删除文件夹包含全部内容；工作根目录不可重命名或删除。不跟随子级符号链接，不代理开发服务器/HMR。可关闭 `remoteAgentSessions.sessionFilesEnabled` 停用此功能。

## 从停止，到继续

**Stop Session** 保存后停止会话并保留恢复记录。打开 **Stopped / Recoverable**，点击对应会话，即可按快照重建。

![停止后保留恢复记录](media/showcase/02-recoverable.png)

![恢复同名 tmux 和保存目录](media/showcase/03-restored.png)

恢复工作区不等于恢复进程内存。原 Agent 历史需仍保存在远端，旧记录需显式绑定原对话。截图使用隔离配置和合成任务数据，展示真实插件的 Shell 恢复；Agent 图标来自演示配置，没有运行模型或编造 AI 对话。

## 三步开始

1. 本地安装 TmuxDock；本机需 OpenSSH，远端需 tmux 3.2+，VS Code 需 1.106+。
2. 在活动栏打开 TmuxDock，点击 **Add SSH Host**，输入已能通过 SSH 连接的别名。
3. 点击现有会话，或创建 Codex、Claude、Shell 会话。Agent CLI 需安装在远端。

关闭终端标签只断开连接，远端 tmux 继续运行；**Stop Session** 保存后停止；**Restore** 重建；**Remove Record** 永久移除本地记录、不停止远端进程。

## 本地控制，远端执行

插件运行在本地 VS Code，通过本机 OpenSSH 和 ssh-agent 连接远端。会话恢复元数据保存在本地，Agent 历史仍由远端 CLI 管理。不保存 SSH 密码、私钥或对话全文。支持备份导入导出，不提供云同步，也不控制官方 Agent 插件的聊天 Webview。

[配置与迁移](docs/guide.zh-CN.md) · [架构和开发](README.md#small-control-plane-real-remote-processes) · [测试证据](docs/evidence/README.md) · [参与贡献](CONTRIBUTING.md)

MIT 开源。Codex / OpenAI、Claude 标识归各自所有者所有；展示兼容工具不代表官方背书。
