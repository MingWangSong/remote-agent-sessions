# Changelog

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
