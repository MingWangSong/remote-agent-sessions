# TmuxDock tool reference

[Overview](../README.md) · [中文指南](guide.zh-CN.md) · [Changelog](../CHANGELOG.md)

This index covers all **40 contributed commands**. Names match the current English UI. Context actions use the selected host, session, file or directory; commands in the Command Palette appear under **TmuxDock**. Availability follows the item's state. The legacy stop alias is retained for compatibility and hidden from the palette.

## Hosts and discovery

| Tool | Command ID | Effect |
| :--- | :--- | :--- |
| Add SSH Host | `remoteAgentSessions.addHost` | Add an existing SSH alias and optional tmux path/socket and default directory. |
| Edit Host | `remoteAgentSessions.editHost` | Change the selected host configuration. |
| Remove Host | `remoteAgentSessions.removeHost` | Remove a host from the local list; this does not terminate remote tmux processes. |
| Refresh Sessions | `remoteAgentSessions.refresh` | Refresh session discovery and saved snapshots. |
| SSH Terminal | `remoteAgentSessions.openSshTerminal` | Open a terminal to the selected SSH host. |
| Open Workspace | `remoteAgentSessions.openWorkspace` | Hand a remote directory to VS Code's Remote SSH workflow; requires the relevant VS Code support and can open another window. Session Files is the same-window alternative. |

## Sessions and recovery

| Tool | Command ID | Effect |
| :--- | :--- | :--- |
| New Session | `remoteAgentSessions.create` | Create a named tmux session for Codex, Claude, shell or a custom command. |
| Attach Session | `remoteAgentSessions.attach` | Connect to a live session, reusing its open terminal when available. |
| Rename Session | `remoteAgentSessions.rename` | Rename a live/recoverable session, checking its identity. |
| Session Details | `remoteAgentSessions.showDetails` | Inspect host, saved directory, layout, Agent binding and recovery details. |
| Edit Session Note | `remoteAgentSessions.addNote` | Save a local note on a managed record. |
| Reset Order | `remoteAgentSessions.resetOrder` | Reset the selected host's persisted drag order to creation-time order. |
| Enable Recovery | `remoteAgentSessions.adopt` | Save recovery metadata and ownership for an existing unmanaged tmux session. File browsing does not require this. |
| Stop Session | `remoteAgentSessions.delete` | Confirm, save the last directories/layout/known conversation links, then stop the session. |
| Restore Session | `remoteAgentSessions.restore` | Rebuild the same tmux name and saved layout; resume bound Agents according to restore policy. |
| Link Agent History | `remoteAgentSessions.bindAgentSession` | Explicitly select/verify the original conversation for an older unbound Agent record. Codex supports history search. |
| Edit Restore Command | `remoteAgentSessions.editCommand` | Configure a saved pane command for explicit recovery; do not place credentials in it. |
| Remove Record | `remoteAgentSessions.forget` | Confirm removal of local recovery metadata; a running remote session continues. |
| Terminate tmux Session | `remoteAgentSessions.terminate` | Compatibility alias of Stop Session. Hidden from the palette to avoid a duplicate action. |

Closing a terminal tab only detaches it. Stop Session stops processes and retains recovery. Remove Record removes saved metadata. None of these is the file action Delete Permanently.

## Working-directory tree and editor

| Tool | Command ID | Effect |
| :--- | :--- | :--- |
| Session Files | `remoteAgentSessions.showFiles` | Show the selected session's native secondary-sidebar directory tree. |
| Link Directory | `remoteAgentSessions.linkDirectory` | Change the fixed file root without changing the running pane's cwd or enabling recovery. |
| Pin File Tree | `remoteAgentSessions.pinFiles` | Toggle tree pinning through its compatibility command; the menu exposes the current pin/follow action. |
| Follow Active Session | `remoteAgentSessions.followFiles` | Resume following the active session and its working root. |
| Refresh Files and Preview | `remoteAgentSessions.refreshFiles` | Invalidate directory caches, retry the shared file channel and refresh HTML previews. |
| Load More Files | `remoteAgentSessions.loadMoreFiles` | Load the next page of a large directory through its Load more row. |
| Open Remote File | `remoteAgentSessions.openFile` | Open a file in VS Code's native editable editor. Native Save writes to the host. |
| New File | `remoteAgentSessions.newFile` | Create at the root from the toolbar, or inside a directory from its context menu; reject collisions. |
| New Folder | `remoteAgentSessions.newFolder` | Create a directory at the same applicable target; reject collisions. |
| Copy Full Path | `remoteAgentSessions.copyFilePath` | Copy the remote absolute filesystem path, without an SSH request. |
| Copy Relative Path | `remoteAgentSessions.copyRelativeFilePath` | Copy a path relative to the session root; the root itself becomes `.`. |
| Rename | `remoteAgentSessions.renameFile` | Rename a file/directory through native workspace file operations; reject existing targets and protect linked roots. |
| Delete Permanently | `remoteAgentSessions.deleteFilePermanently` | Confirm the host and full target path before deleting. A folder includes its contents; no Trash recovery is provided. Linked roots and their ancestors are protected. |

Native Save, session drag ordering, tree drag-to-move and desktop drag-to-upload are interactions rather than extra command IDs. The compact context menu exposes actions relevant to the selected item; linked root rows retain creation/upload/path-copy actions while rename/delete are hidden.

## Transfers and previews

| Tool | Command ID | Effect |
| :--- | :--- | :--- |
| Upload | `remoteAgentSessions.uploadFiles` | Select local files/folders and upload to the chosen root or directory using OpenSSH SFTP. |
| Download | `remoteAgentSessions.downloadFile` | Save a selected remote file locally through OpenSSH; retain the original local destination until success. |
| Preview HTML | `remoteAgentSessions.previewHtml` | Open a permanent, live static-HTML preview with root-scoped resources. |
| Preview MD | `remoteAgentSessions.previewMarkdown` | Open an independent permanent tab using VS Code's native Markdown renderer. |
| Open Preview in Browser | `remoteAgentSessions.openPreviewBrowser` | Open the active HTML preview in VS Code's browser surface. The HTML toolbar also exposes Browser. |

HTML's **Refresh** button reloads that preview. Every explicit preview gets its own tab in the active editor group; the extension never creates an automatic split. Transfers expose progress/cancellation; folder uploads never merge an existing target, and regular-file replacements ask first.

## Backup and migration

| Tool | Command ID | Effect |
| :--- | :--- | :--- |
| Export Session Backup | `remoteAgentSessions.export` | Export configured hosts and saved recovery records to a local JSON backup. |
| Import Session Backup | `remoteAgentSessions.importBackup` | Confirm and import a backup, preserving existing records and skipping matching entries. |
| Import 1.x Metadata | `remoteAgentSessions.importLegacy` | Import a selected remote 1.x metadata file into local records; keep the source file unchanged. |

Backups contain recovery metadata and configured commands, not the original CLI transcript files. Keep backups private and avoid credentials in commands or notes.

## Machine-scoped settings

| Setting (`remoteAgentSessions.` prefix) | Default | Use |
| :--- | :--- | :--- |
| `sshPath` | `ssh` | Local OpenSSH executable. |
| `connectTimeout` | `10` | Non-interactive SSH timeout in seconds, 3–120. |
| `multiplexSsh` | `true` | Reuse SSH connections on macOS/Linux; automatically disabled on Windows. |
| `attachOnCreate` | `true` | Attach immediately after creating a session. |
| `sessionTerminalLocation` | `editor` | Put terminals in editor tabs or the integrated terminal panel. |
| `restoreCommands` | `ask` | `ask`, `always` or `never`; controls saved recovery commands. |
| `refreshInterval` | `30` | Session refresh/snapshot interval in seconds, 10–3600. |
| `sessionFilesEnabled` | `true` | Enable/disable file browsing, creation, editing, transfers and previews. |

File polling is separate from session refresh and checks only active subscriptions. The current file workflow requires remote Python 3 on Linux/macOS and local OpenSSH. See the [main overview](../README.md#files--live-output) for limits and [Chinese guide](guide.zh-CN.md) for migration details.
