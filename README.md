<p align="center"><img src="media/showcase/hero.png" alt="TmuxDock — remote sessions, one workspace" width="100%"></p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=mingwangsong.remote-agent-sessions"><img src="https://img.shields.io/visual-studio-marketplace/v/mingwangsong.remote-agent-sessions?style=flat-square&amp;label=Marketplace&amp;color=70e1c4&amp;labelColor=111827" alt="Marketplace version"></a>
  <a href="https://github.com/MingWangSong/remote-agent-sessions/actions/workflows/ci.yml"><img src="https://github.com/MingWangSong/remote-agent-sessions/actions/workflows/ci.yml/badge.svg" alt="Build status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-ae9bff?style=flat-square&amp;labelColor=111827" alt="MIT license"></a>
</p>

<p align="center"><b>Your Agents. Their files. The live output. One local VS Code workspace.</b><br>Remote tmux control · native file editing · HTML and Markdown previews · explicit recovery</p>
<p align="center"><a href="README.zh-CN.md">简体中文</a> · <a href="https://marketplace.visualstudio.com/items?itemName=mingwangsong.remote-agent-sessions">Install</a> · <a href="docs/commands.md">All 40 tools</a> · <a href="docs/guide.zh-CN.md">User guide</a> · <a href="CONTRIBUTING.md">Contribute</a></p>

## Keep the work. Lose the window shuffle.

TmuxDock brings remote tmux sessions into **local VS Code**. Dock Codex, Claude and shell terminals across SSH hosts, browse the session's working files beside them, and inspect rendered output in the same window.

Closing a terminal tab detaches the client; tmux keeps the remote processes running while its host remains available. Deliberately stopping a managed session saves its final directories, layout and known Agent conversation IDs for a later rebuild.

![Existing session control: multiple hosts, official Agent marks, compact tabs and separated live/recoverable groups](media/showcase/01-workspace.png)

## The control surface

| Module | Available tools and behavior |
| :--- | :--- |
| **Hosts** | Add, edit and remove SSH aliases; refresh discovery; open an SSH terminal or remote workspace. |
| **Sessions** | Create Codex, Claude, shell or custom-command sessions; attach/reuse tabs; rename; inspect details and notes. |
| **Recovery** | Enable snapshots for existing sessions; stop with saved context; restore; link original Agent history; edit restore commands or remove records. |
| **Navigation** | Creation-time ordering, persistent session drag ordering, separate live/recoverable groups, compact Agent icons and host-aware status. |
| **Files** | Native secondary-sidebar tree and file icons; new files/folders; edit/save; rename; copy full/relative paths; confirmed permanent deletion. |
| **Transfers** | Drop local files or complete folders onto a root/subdirectory to upload; use Upload/Download; drag tree entries to move them. |
| **Previews** | Live static HTML with CSS, JS and assets; VS Code's native Markdown renderer; independent permanent tabs in the current editor group. |
| **Continuity** | Follow or pin the file tree; keep the initial working root fixed; restore terminal, file and preview associations after Reload Window. |
| **Portability** | Export/import local recovery backups; import legacy 1.x metadata. |

The [complete tool reference](docs/commands.md) lists every command ID, its entry point and effect, plus all machine-scoped settings. Existing session-control and recovery examples below remain the original demo captures; the gallery that follows covers the newer file workflow.

## Files / live output

### Inspect the result beside the task

![Real VS Code HTML preview with synthetic project files in the native Session Files tree](media/showcase/04-live-workspace.png)

**Session Files** opens the session's fixed root in the native right sidebar. Preview a report or prototype without opening a second remote window. HTML resolves linked resources inside the root and reloads when requested files change. The image above was captured after a real saved JSON update changed the page to generation 02.

New sessions retain their initial root even after a terminal `cd` or Stop/Restore. Older sessions freeze their saved or active pane directory on first use; **Link Directory** can change it without enabling recovery. **Pin File Tree** and **Follow Active Session** control whether the tree follows tab changes.

### Move the files, keep the context

![Actual file editing, recursively uploaded release-kit folder and compact native file context menu](media/showcase/05-file-operations.png)

- **Create and edit:** root toolbar actions create at the working root; directory context actions create in that directory. Native Save writes back through the shared file channel.
- **Transfer and move:** drop desktop files/folders onto a root, subdirectory or empty tree space to upload. Drag tree entries into another directory to move them; drag back onto the root row to move back. Upload and Download remain available as explicit actions.
- **Keep intent clear:** Copy Full Path returns the remote absolute path; Copy Relative Path uses the session root (`.` for the root itself). Rename rejects collisions. Delete Permanently shows a second confirmation with the full target path; linked roots and their ancestors are protected.

Folder uploads preserve the directory structure and never merge an existing target folder. Regular-file uploads ask before replacement, stage the transfer before commit and offer cancellation. Child symbolic links are not followed.

### Let documents stay open

![Independent HTML and native Markdown preview tabs in one editor group, with the remote working tree still visible](media/showcase/06-document-previews.png)

Every explicit HTML or Markdown preview gets its own permanent tab, including repeated opens of the same file. Switching sessions does not replace a preview. TmuxDock uses the active editor group; it creates no split automatically. Rename/move retargets its owned previews, and Reload Window restores their associations and layout.

<details>
<summary><b>Requirements and boundaries for files</b></summary>

| Requirement / limit | Detail |
| :--- | :--- |
| Remote runtime | Python 3 on Linux or macOS; no remote VS Code Server or separately installed web service required. |
| Local transfer tools | OpenSSH `sftp` / `scp`; OpenSSH 9+ recommended. Existing SSH config and host-key checks remain in use. |
| Editor reads and saves | Up to 16 MiB per file; save stages content, preserves permission bits and detects changes made during the save. |
| HTML resources | Static HTML, linked CSS/JS/images and root-relative resources; up to 128 MiB per resource. Not a framework dev-server/HMR proxy. |
| Preview trust | HTML scripts require a trusted VS Code workspace. Preview HTTP listeners bind only to local loopback. |
| File watching | Shared, bounded polling of expanded directories, open documents and requested preview resources; pauses when idle and backs off after failures. |
| Disable files | Set `remoteAgentSessions.sessionFilesEnabled` to `false`. |

</details>

*New images: actual extension UI, a disposable profile, synthetic hosts/project documents, isolated tmux and real OpenSSH SFTP against a local fixture. Agent marks identify demo session types; no model or private conversation is used. [Capture provenance](docs/showcase/README.md).*

## From stopped to working again

**Save before stopping.** Stop Session retains a recovery record. A snapshot or conversation verification failure leaves the running session intact.

![Original demo: stopped shell session retained in Stopped / Recoverable](media/showcase/02-recoverable.png)

**Restore the workspace.** Select the saved session to recreate its tmux name, windows, panes and working directories. Bound Codex / Claude sessions use their original conversation IDs; custom commands follow your restore policy.

![Original demo: restored shell workspace showing the same session name and saved directory](media/showcase/03-restored.png)

*These existing captures demonstrate shell Stop → Restore. Recovery rebuilds a workspace; it does not restore process memory or recreate deleted CLI history. Exact Agent-ID recovery is tested with isolated CLI fixtures, without model requests.*

## Get started

**Requirements:** VS Code 1.106+, local OpenSSH and a reachable host with tmux 3.2+. For Agent sessions, install that CLI on the host. Git is optional for repository metadata.

```sh
code --install-extension mingwangsong.remote-agent-sessions
```

1. Open TmuxDock and select **Add SSH Host**. Enter an alias already usable with `ssh your-alias`.
2. Click an existing session, or create a named Codex, Claude or shell session.
3. Select **Session Files** to browse its root; open or preview a file in the same window.

Close a terminal tab to detach. **Stop Session** saves and stops; **Restore Session** rebuilds; **Remove Record** removes local recovery metadata without stopping a running remote process. These are separate from permanent file deletion.

<details>
<summary><b>Recovery behavior</b></summary>

- New built-in Agent sessions receive a known conversation ID and the final tmux name. The original CLI history must still exist remotely.
- Older records without an ID need an explicit link to the original history. Codex history can be searched by title, directory and date; similar names never cause automatic binding.
- Missing directories or conversations produce an error; TmuxDock does not guess with `--last` or silently create a replacement conversation.
- `restoreCommands=never` rebuilds shells only. The default `ask` policy resumes verified bound Agents directly and asks about custom commands.
- Reload Window uses VS Code native persistence. Full application restart can behave differently; reconnect from the session sidebar when necessary.

</details>

## Small control plane. Real remote processes.

```text
Local VS Code                               Your SSH host
┌────────────────────────────┐   OpenSSH     ┌──────────────────────────┐
│ Session tree + terminal tabs│ ────────────► │ tmux / Codex / Claude / sh│
│ Native files + editor      │ ◄───────────► │ Python file channel      │
│ HTML / Markdown previews   │   SFTP / SCP  │ Working directories      │
│ Local recovery metadata    │              │ Original CLI histories   │
└────────────────────────────┘              └──────────────────────────┘
```

The extension runs in the **local UI extension host** and reuses your SSH configuration and agent. It stores recovery metadata locally, not SSH passwords, private keys or full conversation transcripts. HTML uses a root-scoped local preview server; file operations and watching share a persistent SSH channel per host.

TmuxDock manages Agent **CLI sessions in tmux**. It does not control official Agent chat webviews, record full terminal output, provide cloud sync or reproduce Explorer's Git and Timeline features.

## Develop with confidence

```sh
npm ci
npm run verify
npm run test:integration
npm run test:agent-recovery
npm run test:vscode
npm run package
npm run verify:package
```

Tests use temporary files and isolated tmux sockets. CI covers Ubuntu 22.04, Ubuntu 24.04 and macOS; Linux runs native VS Code acceptance, rendering, icon and reload checks under Xvfb. Local macOS GUI tests are disabled by default. The separate [showcase workflow](.github/workflows/showcase.yml) captures only synthetic fixtures.

[All tools](docs/commands.md) · [User guide](docs/guide.zh-CN.md) · [Validation evidence](docs/evidence/README.md) · [Contributing](CONTRIBUTING.md) · [Changelog](CHANGELOG.md)

[Report an issue](https://github.com/MingWangSong/remote-agent-sessions/issues) with the extension version, local OS, remote tmux version and a sanitized reproduction. Never include credentials or private conversation transcripts.

MIT licensed. Codex / OpenAI and Claude marks identify compatible tools; their use does not imply endorsement.
