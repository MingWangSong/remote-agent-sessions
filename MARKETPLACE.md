![TmuxDock — your remote sessions, one workspace](media/showcase/hero.png)

# Your remote work, docked.

**Keep Codex, Claude and shell sessions within reach — across SSH hosts, inside local VS Code.**

TmuxDock turns remote tmux sessions into a workspace you can browse, reconnect to and rebuild. Keep task tabs short, identify Agents by their official marks, and see the active machine in the status bar.

[Source code](https://github.com/MingWangSong/remote-agent-sessions) · [中文指南](https://github.com/MingWangSong/remote-agent-sessions/blob/main/README.zh-CN.md) · [Report an issue](https://github.com/MingWangSong/remote-agent-sessions/issues)

## One sidebar. Your running work.

![TmuxDock in a real dark VS Code workbench](media/showcase/01-workspace.png)

- **Multiple hosts, one view.** Connect through the SSH aliases you already use. Discover existing tmux sessions or create new ones.
- **Codex, Claude and shell at a glance.** Distinct icons, compact tab names and a host-aware status bar.
- **A list that stays put.** Creation-time sorting, saved drag ordering and separate running / recoverable groups.
- **Feedback when the network is slow.** Visible operation progress and queue state. Click an already-open tab to reuse it immediately.
- **Tabs that survive Reload Window.** Retain native terminal tabs and recover their host/session associations.

## Stop a session. Keep its context.

Before **Delete Session** closes a managed tmux workspace, TmuxDock saves its final directories, windows, panes and known Agent conversation links.

![A stopped session remains available to restore](media/showcase/02-recoverable.png)

Click the entry in **Stopped / Recoverable** to rebuild a new tmux session with the same name in the saved directories. A bound Agent resumes its original conversation ID; it does not start an unrelated chat.

![Restored shell workspace in its saved directory](media/showcase/03-restored.png)

| Action | Result |
| :--- | :--- |
| Close terminal tab | Detach the client; remote tmux work continues while the host is running. |
| Delete Session / Terminate | Save a recovery snapshot, then stop tmux and its processes. |
| Restore Session | Rebuild the saved workspace; resume bound Agents according to the restore policy. |
| Forget Session Record | Permanently remove local recovery metadata; leave running remote processes alone. |

## Start in three steps

1. Install TmuxDock **locally** in VS Code, then open its activity-bar icon.
2. Select **Add SSH Host** and enter an alias from your SSH config.
3. Click a session to connect, or create a named Codex, Claude or shell session.

You need **VS Code 1.90+**, local **OpenSSH**, and **tmux 3.2+** on the remote host. For Agent sessions, install that Agent's CLI on the host. Session discovery does not require a remote VS Code Server installation.

## Recovery you can understand

New built-in Agent sessions receive a known conversation ID and matching name. Recovery requires the original CLI history to remain on the remote host. Older records without a conversation link require an explicit binding; Codex supports browsing the original history. Missing history is reported rather than replaced with a guessed conversation.

Recovery rebuilds a workspace, **not process memory**. Commands follow `remoteAgentSessions.restoreCommands`: the default `ask` resumes verified bound Agents directly and asks about custom commands; `never` restores shells only. Full VS Code application restart can behave differently from Reload Window because terminal revival is managed by VS Code.

## Your SSH. Your machines. Your records.

TmuxDock uses local OpenSSH and your existing SSH config / agent. It stores recovery metadata locally, not SSH passwords, private keys or full conversation transcripts. Export / Import Session Backup lets you transfer saved records to another installation. TmuxDock manages CLI sessions in tmux, not Agent extensions' chat webviews.

**About these images:** actual extension UI and real tmux in an isolated demo profile. Host aliases and task names are synthetic; Agent icons use demo configuration. Screenshots show shell workspace recovery, not a live AI conversation. No model request or private user data was used.

---

**中文速览** · 多主机 tmux 统一停靠到本地 VS Code；Codex / Claude / Shell 图标区分；运行与停止分组，顺序稳定；删除前保存最后目录和原对话绑定，恢复同名 tmux 并续接原对话。关闭标签仅断开连接。详细配置、旧记录绑定与迁移请看[中文使用指南](https://github.com/MingWangSong/remote-agent-sessions/blob/main/docs/guide.zh-CN.md)。

Open source · MIT license · Independent project. Agent brand marks identify compatible tools and do not imply endorsement.
