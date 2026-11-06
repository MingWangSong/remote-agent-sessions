"use strict";
const vscode = require("vscode"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Workspace reload state timed out");
}
exports.run = async () => {
  const file = path.join(
    process.env.RAS_TEST_DIRECTORY,
    "workspace-reload-state.json",
  );
  let state = await fs
    .readFile(file, "utf8")
    .then(JSON.parse)
    .catch(() => null);
  const manifest = require("../../package.json");
  const api = await vscode.extensions
    .getExtension(
      process.env.RAS_TEST_EXTENSION_ID ||
        `${manifest.publisher}.${manifest.name}`,
    )
    .activate();
  if (!state) {
    const root = path.join(process.env.RAS_TEST_DIRECTORY, "project");
    await fs.writeFile(
      path.join(root, "index.html"),
      "<h1>Reload preview</h1>",
    );
    await fs.writeFile(path.join(root, "note.txt"), "before reload");
    const host = await api.registry.add({
      sshHost: "fake-workspace-reload",
      label: "Workspace reload host",
      defaultCwd: root,
      socketName: process.env.RAS_TEST_SOCKET,
    });
    await api.provider.reloadHosts();
    const c = api.controllers.find((c) => c.host.id === host.id);
    const r = await c.manager.create({
      title: "Workspace reload session",
      cwd: root,
    });
    await api.attachEntry(
      c,
      c.manager.entries.find((e) => e.id === r.id),
    );
    await vscode.commands.executeCommand("remoteAgentSessions.showFiles");
    const items = await api.sessionWorkspace.getChildren();
    await api.sessionWorkspace.openFile(
      items.find((e) => e.name === "note.txt"),
    );
    await api.sessionWorkspace.openFile(
      items.find((e) => e.name === "note.txt"),
    );
    await api.sessionWorkspace.preview(
      items.find((e) => e.name === "index.html"),
    );
    await wait(() => api.sessionWorkspace.server?.subscriptions.size > 0);
    state = {
      phase: 0,
      host: host.id,
      record: r.id,
      root,
      checks: [],
      originalTmux: (await c.tmux.list()).find((s) => s.owner === r.id).id,
    };
  } else {
    const c = api.controllers.find((c) => c.host.id === state.host);
    assert.ok(c);
    const r = c.manager.records.find((r) => r.id === state.record);
    assert.equal(r.workspaceRoot, state.root);
    assert.equal(
      (await c.tmux.list()).find((s) => s.owner === r.id).id,
      state.originalTmux,
    );
    // Native webviews deserialize lazily when their tab becomes visible.
    await wait(() => api.sessionWorkspace.server?.subscriptions.size > 0);
    assert.equal(api.sessionWorkspace.previewContext.record.id, state.record);
    assert.equal(api.sessionWorkspace.current.record.id, state.record);
    assert.notEqual(api.sessionWorkspace.server.origin, state.previousOrigin);
    try {
      await wait(() =>
        vscode.workspace.textDocuments.some(
          (d) =>
            d.uri.scheme === "tmuxdock-remote" &&
            d.uri.path.endsWith("note.txt"),
        ),
      );
    } catch (e) {
      throw Error(
        e.message +
          " " +
          JSON.stringify({
            tabs: vscode.window.tabGroups.all.map((g) =>
              g.tabs.map((t) => ({
                label: t.label,
                input: t.input?.constructor?.name,
                uri: t.input?.uri?.toString(),
                preview: t.isPreview,
              })),
            ),
            documents: vscode.workspace.textDocuments.map((d) =>
              d.uri.toString(),
            ),
          }),
      );
    }
    const docs = vscode.workspace.textDocuments.filter(
      (d) => d.uri.scheme === "tmuxdock-remote",
    );
    await fs.writeFile(
      path.join(state.root, "note.txt"),
      "after reload " + state.phase,
    );
    await wait(
      () =>
        docs.find((d) => d.uri.path.endsWith("note.txt")).getText() ===
        "after reload " + state.phase,
    );
    state.checks.push(
      "reload " +
        state.phase +
        ": fixed root, native file refresh, preview association and original tmux identity survive",
    );
  }
  if (state.phase < 2) {
    state.phase++;
    state.previousOrigin = api.sessionWorkspace.server.origin;
    await fs.writeFile(file, JSON.stringify(state));
    await sleep(1200);
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
    await new Promise(() => {});
  }
  api.sessionWorkspace.panel?.dispose();
  for (const terminal of vscode.window.terminals) terminal.dispose();
  const c = api.controllers.find((c) => c.host.id === state.host);
  await c.tmux.run(["kill-server"]);
  await fs.writeFile(
    process.env.RAS_TEST_REPORT,
    JSON.stringify(
      { passed: state.checks.length, checks: state.checks, reloads: 2 },
      null,
      2,
    ),
  );
  return false;
};
