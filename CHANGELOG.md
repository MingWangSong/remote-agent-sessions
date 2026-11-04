# Changelog

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
