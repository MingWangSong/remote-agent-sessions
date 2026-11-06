# Screenshot provenance

The public gallery uses dark artwork and real VS Code captures. It does not use private sessions, redacted customer screenshots or invented Agent responses.

## Reused images

`hero.png` and `01-workspace.png`–`03-restored.png` remain the existing artwork and session-lifecycle demonstration. They are not regenerated for this update. The session images use synthetic host/task names, isolated tmux and display-only Agent metadata; they show the shell stop/restore path.

## New file-workflow captures

| Image | Observed operation |
| --- | --- |
| `04-live-workspace.png` | The actual HTML webview resolves CSS, JS and JSON from a linked root. A saved state change refreshes the page to generation 02. |
| `05-file-operations.png` | A native editor save persists content through the Python file channel; an entire release-kit directory uploads through real OpenSSH SFTP; the native context menu displays the new actions. |
| `06-document-previews.png` | Repeated native Markdown previews and independent HTML panels remain permanent tabs in one editor group. No split is created. |

The capture workflow creates a disposable VS Code profile and extension storage, synthetic `DEMO · East` / `DEMO · West` hosts, an `atlas-lab` project and isolated tmux sockets. A local SSH shim executes the same commands against that fixture; SFTP uses the real OpenSSH server over its stdio transport. This is not a screenshot of a private remote host or a network performance benchmark.

Codex and Claude marks identify display-only demo session types. No Agent model is called, no conversation is fabricated, and no credentials, private code, hostnames or production services are used. The capture script checks the rendered workbench text for known private identifiers before writing each image. The fixture files in this directory are explicitly synthetic.

Run **Capture workspace showcase** in GitHub Actions (`.github/workflows/showcase.yml`). Its artifact contains the three PNGs and `provenance.json`, including the checks completed before capture. GUI capture is disabled on the local Mac by default; the workflow uses Linux/Xvfb.

The README uses repository-relative image links. Marketplace uses HTTPS PNGs pinned to the release tag, so its published gallery stays attached to the reviewed version. Both destinations reuse the same underlying captures and supply audience-specific captions.
