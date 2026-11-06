# Release workflow

TmuxDock publishes from the public repository `MingWangSong/remote-agent-sessions` to the existing Marketplace item `mingwangsong.remote-agent-sessions`. Use the original `mingwangsong` publisher; do not create a second listing.

## Build a reviewable release

1. Update the version consistently in `package.json`, `package-lock.json` and Agent client metadata; write a release-focused changelog.
2. Keep GitHub's project/architecture documentation separate from the installation-focused `MARKETPLACE.md`. Verify the [complete command index](commands.md) against the contributed commands.
3. Reuse existing gallery images where the behavior has not changed. Run the isolated **Capture workspace showcase** workflow for new features; review every image and its [provenance](showcase/README.md). Never capture private host data or real Agent conversations for public marketing.
4. Run the normal verification workflow. Native VS Code, icon and Reload Window checks run under Linux/Xvfb. Do not open local GUI test windows unless the user explicitly requests them.
5. Build and verify the official VSIX:

   ```sh
   npm run package
   npm run verify:package
   ```

   Packaging uses `MARKETPLACE.md`. Integrity verification compares runtime/media bytes, dependencies and the published gallery. Keep the generated SHA-256 with the artifact.

## Publish in order

1. Push the reviewed source and screenshots to public `main`. Synchronize the private archive without merging its unrelated history into the public repository.
2. Create the matching `vX.Y.Z` GitHub Release with the official VSIX and checksum. Marketplace image URLs are pinned to that tag; verify they are publicly readable before uploading.
3. Open the [publisher management page](https://marketplace.visualstudio.com/manage/publishers/mingwangsong) using the existing owner account. Update **TmuxDock** with the new official VSIX. A user's explicit request to publish authorizes the upload; do not ask for duplicate release approval.
4. Wait for Marketplace validation. Verify the public version, description/gallery and downloadable artifact against the reviewed package. Record the release URL, source commit, CI run and checksum.

The current workflow can use an already authenticated browser; credentials are not copied into source, logs or chat. For future unattended publication, Microsoft documents trusted publishing with GitHub OIDC. Configure access separately rather than silently creating a token or expanding publisher permissions.

## Local compatibility build

The historical development installation uses `local.remote-agent-sessions`; the Marketplace uses `mingwangsong.remote-agent-sessions`. Their extension storage identities differ. Keep the local publisher identity when updating that development installation. To move between identities, export and import a recovery backup deliberately; do not overwrite live VS Code storage or assume it migrates automatically.

Publishing an official VSIX does not require reloading the user's current VS Code window. Leave window reload to the user's convenient time.

Reference: [Microsoft's publishing guide](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
