# Contributing to TmuxDock

Use Node.js 22 and install tmux locally. Run `npm ci`, then `npm run verify` and `npm run test:integration`. Agent lifecycle changes also need `npm run test:agent-recovery`; UI changes need `npm run test:vscode`. Reload and icon checks have dedicated `test:reload` and `test:icons` commands. Session file changes also need `test:workspace-reload`.

Use isolated tmux sockets and temporary profiles. Never test destructive lifecycle actions on an existing user session. Keep credentials, real host aliases, private paths and transcripts out of fixtures, screenshots and issue reports.

Keep GitHub's `README.md` focused on the project and `MARKETPLACE.md` focused on installation and the user experience. `npm run package` selects the Marketplace copy as the packaged README. Screenshots are reproducible with `node scripts/capture-docs.js` on macOS with VS Code and tmux installed. Local macOS GUI test/capture scripts refuse to launch unless `RAS_ALLOW_LOCAL_UI=1` is explicitly set with permission to interrupt the desktop; use CI Xvfb for routine acceptance. The capture uses real plugin operations, synthetic aliases and task names, shell processes and display-only Agent metadata; it does not call a model.

Before a PR, describe the concrete user-visible behavior and relevant validation. See [known recovery constraints](README.md#from-stopped-to-working-again) and preserve identity checks, durable-before-stop ordering and shell quoting.
