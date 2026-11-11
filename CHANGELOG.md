# Changelog

## 3.3.7 — 2026-11-11

- Fix false remote-file timeouts on slow links: the serial helper's head response uses an inactivity timeout refreshed by arriving bytes; queued requests receive their timeout when preceding responses finish. Keep the existing four-request window and timeout for silent connections.
- Update file-opening progress after each completed chunk. A genuine read timeout offers Retry and Download; retain cancellation, binary integrity, file-change detection and shared-channel recovery.
- Cover queued slow responses, long fragmented responses, silent-channel recovery and timeout actions. Reproduce and verify a 2.47 MiB PDF read over the affected SSH link without opening desktop windows.

## 3.3.6 — 2026-11-11

- Fix relative images in native Markdown previews. Keep independent tab identities in URI fragments so Markdown's resource-root permissions allow image requests without a query.
- Preserve native rendering, remote source files, independent tabs, current editor groups, file-move retargeting and Reload Window restoration. Reopen previews created by older versions to load the corrected resource root.
- Add real VS Code/Xvfb acceptance that checks all 15 relative PNGs decode inside the rendered preview, along with a regression check for preview URI identity.

## 3.3.5 — 2026-11-09

- Fix desktop image/file/folder uploads when VS Code's tree drag-and-drop supplies a serialized cancellation token without its event method. Keep native upload progress cancellation available.
- Recheck cancellation after upload preflight, retain per-transfer isolation and clean partial staging. Add binary PNG drops to root/subdirectories and cancellation regression coverage.

## 3.3.4 — 2026-11-09

- Fix copying selected text from rendered HTML with VS Code's Copy action and Ctrl/Cmd+C, including Unicode and multiline selections inside the preview iframe.
- Keep clipboard handling local to actual Copy gestures and the focused preview. Validate the frame source/origin, clear stale selections after navigation, and add no clipboard-read or page-to-extension clipboard-write API.
- Preserve original HTML files, document CSP restrictions, resource URLs, streaming and range responses. Verify the real OS clipboard in isolated VS Code/Xvfb acceptance.

## 3.3.3 — 2026-11-09

- Open supported files directly without the 2 MiB confirmation. Show cancellable native progress with the filename, host and transferred size, and reuse in-flight opens for repeated clicks.
- Detect files above 16 MiB before content transfer and offer Download. Give missing-file, permission and connection failures specific guidance with Refresh or Retry where applicable.
- Cancel only the requested read, retain the shared SSH channel, and reuse the verified snapshot when handing the file to VS Code's native editor. Focus loaded documents immediately without another read and preserve unsaved edits.
- Keep slower earlier opens from stealing focus or replacing a newer preview; preserve the user's editor groups and native image editors.

## 3.3.2 — 2026-11-06

- Refresh the GitHub overview and dedicated Marketplace copy with a dark, technical gallery for session files, native editing, recursive uploads and independent previews. Reuse the original session/recovery images.
- Document all 40 commands and 8 machine-scoped settings; add screenshot provenance and a reproducible Linux/Xvfb capture workflow with synthetic data and real tmux/SFTP.
- Pin Marketplace images to the release tag and verify all seven gallery images in the packaged extension.
- Wait for a fully attached, named terminal before taking window-reload test checkpoints, retaining the complete layout and persistence assertions.

## 3.3.1 — 2026-11-06

- Remove ellipses from file context actions and shorten file, session and host menu labels. Keep command IDs, operation behavior and permanent-delete confirmation unchanged.

## 3.3.0 — 2026-11-06

- Remove the redundant absolute working path above Session Files; keep the actionable root folder and full-path tooltips.
- Add Copy Absolute Path and Copy Relative Path for tree files, folders and the root. Relative paths use the session working root (`.` for the root); copying requires no SSH request.
- Add Rename and Delete Permanently context actions for files/folders. Reuse native editor file operations; reject rename collisions and require an explicit modal confirmation before permanent deletion, including a warning for folder contents.
- Protect linked working roots and their ancestors from rename/delete, require recursive directory deletion explicitly, and never follow child symbolic links.

## 3.2.0 — 2026-11-06

- Add native tree drag-and-drop: move files and folders within a linked session root, or drop local files and complete folders onto the root, any subdirectory or empty tree space to upload. Reuse WorkspaceEdit for native editor moves and OpenSSH SFTP for recursive transfers.
- Show an actionable root row. Toolbar New File/New Folder always use the session root; directory context actions use that directory.
- Allow legacy and unmanaged sessions to browse, link and edit files without enabling recovery. Freeze a legacy session’s saved/current directory on first use, preserving explicit roots and recovery ownership.
- Stage uploads before committing, reject folder merges and move collisions, confirm regular-file replacement, detect destination changes during uploads, and clean owned staging directories after completion/cancellation.
- Retarget independent HTML/Markdown previews after moves without adding editor groups. Clarify file-tree pin/follow actions and retain existing recovery behavior.

## 3.1.0 — 2026-11-06

- Add New File and New Folder actions to Session Files, including root toolbar actions and creation inside selected directories. Reject existing names without overwriting their contents.
- Enable native editing and Save for linked remote files, including new files. Save through the shared SSH file channel with temporary-file staging, fsync, atomic replacement and detection of changes during a save.
- Refresh file trees, native documents and independent HTML/Markdown previews after successful writes. Keep preview HTTP endpoints read-only and preserve remote path boundaries, permissions and existing session recovery behavior.
- Bound file saves to 16 MiB, preserve executable permission bits, and clean temporary files on failed writes. File and folder removal/rename remain outside these actions.

## 3.0.1 — 2026-11-06

- Keep every HTML and Markdown preview in its own permanent tab, including repeated opens of the same file. Use the active editor group and never create a split automatically.
- Keep HTML previews attached to their original file when switching sessions; retain independent live updates, browser actions and Reload Window restoration for every tab.
- Reuse VS Code's built-in Markdown preview editor with independent document identities and shared remote file watches. Remove the redundant HTML Pin button.
- Simplify session menus: merge Delete/Terminate into Stop Session (Keep Recovery Record), move auxiliary actions into More Actions, and show original-conversation binding only when needed. Preserve existing command IDs.

## 3.0.0 — 2026-11-06

- Add Session Files in VS Code's native secondary sidebar with the active file icon theme, lazy directory loading, saved expansion, session following and pinning.
- Keep each new session's initial workspace root separate from the last terminal directory saved for recovery; let older records explicitly link a root.
- Reuse native read-only editors and the built-in Markdown preview. Keep the context menu focused on file upload/download and applicable previews.
- Add static HTML preview with root-relative resources, automatic refresh after remote saves, independent pinning and Reload Window restoration.
- Reuse one persistent read-only SSH file channel per host with paged/chunked reads, bounded concurrency, watch reference counting and failure backoff. Explicit transfers reuse OpenSSH with cancellation and staged replacement.
- Require VS Code 1.106+ for the native secondary sidebar; remote file browsing requires Python 3 on Linux/macOS. Keep existing terminal recovery paths intact and run GUI acceptance under CI Xvfb by default.

## 2.5.1 — 2026-11-05

- Redesign GitHub and Marketplace introductions with distinct copy, a dark visual identity and sanitized real-workbench screenshots.
- Package the dedicated Marketplace README explicitly and add reproducible isolated screenshot capture.

## 2.5.0 — 2026-11-05

- Make Delete recoverable: durably save the final working directories, pane layout and original Agent conversation bindings before stopping tmux. Keep the saved entry in Stopped / Recoverable; Forget explicitly removes it.
- Restore creates the same tmux name in the final saved directories and resumes the same Codex / Claude conversation. Pass Codex its explicit working directory and resolve Claude's transcript across project directories.
- Preserve running sessions when snapshot persistence or conversation verification fails; recheck remote identity before stopping, and retain recovery data if stopping fails.
- Cover Delete → manager reload → Restore with real tmux and isolated Agent fixtures, including changed directories, repeated recovery and missing history. No model requests are sent by these tests.

## 2.4.4 — 2026-11-04

- Let legacy Codex records choose their original conversation from remote history by title, preview, date and working directory, with pagination, all-directory and archived-history views.
- Keep manual UUID entry as a fallback; never auto-bind by matching names, directories or dates. Discovery sends no model turn and creates no conversation.
- Verify and persist the explicitly selected ID for future exact resume. Choosing an archived history unarchives that same conversation before binding it.

## 2.4.3 — 2026-11-04

- Use registered font icons with the original official Codex and Claude outlines for terminal tabs, avoiding lost nested image URIs on native restore and stale versioned asset paths after updates.
- Preserve Claude’s official terracotta color and automatic theme contrast for Codex; sidebar SVGs remain unchanged.
- Verify actual rendered font glyphs across two window reloads and light/dark themes. Keep an opt-in full-restart diagnostic for the separate, still-unfixed VS Code pty revival issue (microsoft/vscode#335203).

## 2.4.2 — 2026-11-04

- Resize the existing product icon to 1024x1024 for Marketplace upload and enforce its dimensions during package verification.
- Cancel queued editor-tab status updates when a newer terminal-panel selection arrives, preserving hidden status on ordinary terminals.
- Retain the exact conversation recovery, reload persistence and tmux 3.2a compatibility fixes.

## 2.4.1 — 2026-11-04

- Avoid resolving stale session targets in the saved terminal connection guard, which can terminate a tmux 3.2a server.
- Verify the exact original ID, creation time and owner through a literal full-line match in the session inventory before attach.
- Keep all-platform CI diagnostics and assert that same-name replacements remain alive and unattached.

## 2.4.0 — 2026-11-04

- Keep attached terminal tabs across Reload Window through native terminal persistence, preserving editor layout, names and active tabs.
- Restore host/session associations by verified metadata or workspace-local native process IDs when VS Code omits original launch options.
- Retain status bar identity, sidebar selection and immediate reuse after reload without restarting agents or recreating closed tabs.
- Guard saved connection-process revival with the original tmux ID, creation time and owner before attach.
- Add two actual window reloads in isolated VS Code acceptance, covering colliding titles on two hosts, editor groups, ordinary files, panel terminals, closed tabs and unchanged process IDs.

## 2.3.2 — 2026-11-04

- Group ordered literal-send/Enter, split/layout and pane/window selection into single SSH requests, preserving argv and fail-fast ordering.
- Combine owner assignment with the initial single-pane snapshot only when no later selection or layout step is needed.
- Validate each distinct restore directory once, with up to three concurrent read-only checks before creating panes.
- Preserve durable intent, post-commit startup commands, original conversation verification and rollback boundaries.
- Add isolated fault, quoting, hook, geometry and selection regression coverage.

## 2.3.1 — 2026-11-04

- Eliminate SSH calls for local notes, restore-command edits, attach bookkeeping and forgetting records.
- Remove duplicate UI refreshes after manager operations.
- Carry complete window/pane snapshots in the existing inventory query; reuse them for polling and stop snapshots.
- Share Git results by directory within a poll and bound independent read concurrency to three.
- Focus existing terminals immediately even while another operation on the host is slow.
- Cache Claude CLI capability checks for five minutes and combine Codex bind verification/rename into one connection.
- Keep destructive-operation identity checks and exact Agent history verification intact.


## 2.3.0 — 2026-11-04

- Bind newly created Claude/Codex sessions to stable original conversation IDs and matching names.
- Use Claude session-id/name and Codex app-server thread creation/name APIs without sending a model turn.
- Persist pane-level recovery bindings before launching; resume exact IDs after stop/reload and refuse missing history.
- Add verified original-conversation binding for legacy records; never guess via --last or silently start a replacement conversation.
- Resume bound Agent panes directly under the default restore policy while retaining custom-command prompts and shell-only settings.
- Synchronize host status and visible sidebar selection from actual editor tab activation; hide host status on ordinary file tabs.
- Add no-model-turn CLI metadata verification and isolated real tmux + CLI-fixture lifecycle acceptance.


## 2.2.4 — 2026-11-04

- Shorten terminal editor titles to the session name and reuse the session type icon.
- Add stable numeric suffixes only when an open terminal has the same name.
- Show the selected TmuxDock terminal host in the status bar, with full context on hover and a click-through to session details.
- Keep host/SSH target in the terminal startup banner; hide host status when a regular terminal is selected.
- Preserve terminal reuse by host/session identity independently of the short display name.


## 2.2.3 — 2026-11-04

- Replace generic agent glyphs with the exact SVG marks from the official Codex and Claude Code VS Code extensions.
- Use original black/white Codex sidebar marks for light/dark themes and the original terracotta Claude mark.
- Preserve branding colors in stopped groups; group labels continue to communicate liveness.
- Package all assets locally, document provenance and verify all media files byte-for-byte in the VSIX.


## 2.2.2 — 2026-11-03

- Distinguish Codex, Claude and shell/custom sessions with robot, sparkle and terminal icons; preserve type shapes in stopped groups.
- Infer types from configured agents, live pane command names and saved startup commands, without guessing from session titles.
- Gather session identity and pane command names in a single tmux query, with no extra SSH round trips.
- Remove branch text from session rows; retain it in session details.


## 2.2.1 — 2026-11-03

- Separate running sessions from stopped/recoverable records under each SSH host.
- Expand Running by default and collapse Stopped / Recoverable; hide empty groups and show counts.
- Keep unavailable/conflicting states in a separate group without treating connection failures as stopped sessions.
- Preserve creation-time and saved drag order within each group; reject cross-group moves.


## 2.2.0 — 2026-11-03

- Show foreground operation progress, elapsed time and busy tree icons, including while queued; coalesce repeated clicks.
- Serialize foreground actions per host and keep background snapshots outside the action queue and remote I/O outside the snapshot database lock.
- Sort sessions by creation time (oldest first), persist drag-and-drop order per host and add a reset-order command.
- Preserve unmanaged tree identity across rename and avoid activity/status-based reordering.
- Remove full snapshots before create/attach and redundant refreshes after creation; reuse existing terminals immediately.
- Query all windows/panes in one tmux call and repository/branch state in one SSH invocation.
- Skip redundant initial pane selection; retain restore validation, durable intent, rollback and ownership checks.
- Cover delayed attach feedback, duplicate clicks, actual tree drag/drop, persistent order and concurrent foreground edits during snapshots.

## 2.1.0 — 2026-09-15

- Rebrand the user-facing product as **TmuxDock**: remote tmux is the product core, while Agent CLIs remain a first-class use case.
- Publish under the official `mingwangsong` publisher while preserving command and setting identifiers.
- Add **Import Session Backup** so development-build metadata can be safely merged into the Marketplace build without overwriting matching hosts or sessions.
- Keep a single **New tmux Session** action on each online SSH host row.
- Move manual refresh from the TmuxDock title bar to each SSH host row.
- Do not repeat the tmux session name in the tree description; show only branch and recovery state there.
- Add a live remote-directory picker with child-directory suggestions.
- Use one session name for both TmuxDock display and the real tmux session; support spaces and Unicode.
- Present pre-existing tmux sessions as ordinary sessions, with optional **Enable Recovery** instead of an `unmanaged` badge.
- Rename both saved records and real remote tmux sessions, including pre-existing sessions.
- Add permanent **Delete Session** for remote tmux plus local metadata, with explicit confirmation.
- Keep **Terminate** for recoverable records and **Forget** for leaving live processes untouched.
- Verify live identity before rename, terminate, or delete to avoid acting on a same-name replacement.
- Cover the lifecycle in unit, real tmux, real SSH, source Extension Host and packaged VSIX tests.

## 2.0.1 — 2026-09-15

- Open attached sessions as terminal editors in the central editor area by default.
- Add `remoteAgentSessions.sessionTerminalLocation` for users who prefer the integrated terminal panel.
- Verify the requested editor location in the actual VS Code extension host and packaged VSIX.

## 2.0.0 — 2026-09-14

- Move the extension to the local UI host; install once instead of once per SSH server.
- Add a local SSH host registry and an aggregated host → session tree.
- Run remote tmux and Git operations through the user's local OpenSSH configuration.
- Add SSH connection multiplexing on macOS/Linux for responsive refreshes.
- Add host actions for SSH terminal, Remote SSH workspace and safe 1.x metadata import.
- Keep session metadata locally per host and export all hosts in one backup.
- Replace the activity-bar artwork with a filled theme-aware SVG.
- Add SSH quoting, validation and real remote-host acceptance coverage.

## 1.0.1 — 2026-09-13

- Add the product icon to the extension manifest; preserve the theme-aware Activity Bar icon.
- Add product positioning, a reproducible demo, evidence, and a public-launch checklist.
- Configure the private source repository and verify the packaged icon byte-for-byte.
- Keep test reports inside the checkout for reproducible CI execution.
- No changes to the session-management runtime.

## 1.0.0 — 2026-09-13

- Add cross-process transaction locking, atomic fsync writes and previous-version backup.
- Validate stored records; refuse to overwrite corrupt databases.
- Add automatic snapshots of windows, panes, directories, layouts and pane restore commands.
- Bind commands to stable pane IDs through rename/reorder operations.
- Persist creation intent before launching tmux; rollback incomplete workspace reconstruction.
- Make repeated and concurrent restores idempotent.
- Track session ownership to detect same-name replacement and follow manual tmux renames.
- Use direct tmux terminals and reuse terminals within each VS Code window.
- Add configurable restore commands and backup export.
- Preserve history in unavailable states; serialize UI operations and coalesce background refresh.
- Add actual tmux integration tests, multi-process persistence tests and VS Code host acceptance tests.
- Produce an offline-installable VSIX with its runtime dependencies included.
