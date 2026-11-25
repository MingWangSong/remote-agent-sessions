"use strict";
const vscode = require("vscode"),
  fs = require("node:fs/promises"),
  path = require("node:path"),
  assert = require("node:assert/strict");
const http = require("node:http");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Workspace reload state timed out");
}
function layout() {
  return vscode.window.tabGroups.all.map((g) => ({
    column: g.viewColumn,
    tabs: g.tabs.map((t) => ({
      label: t.label,
      preview: t.isPreview,
      uri: t.input?.uri?.toString() || null,
      type: t.input?.viewType || t.input?.constructor?.name,
    })),
  }));
}
async function readBrowserPage(address) {
  const url = new URL(address);
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port: url.port, path: url.pathname, agent: false, headers: { Host: url.host } }, response => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", chunk => { text += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, text }));
      response.on("error", reject);
    }).on("error", reject);
  });
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
        manifest.publisher + "." + manifest.name,
    )
    .activate();
  const previews = api.sessionWorkspace.previews;
  if (!state) {
    const root = path.join(process.env.RAS_TEST_DIRECTORY, "project");
    for (const name of ["index.html", "second.html"])
      await fs.writeFile(path.join(root, name), "<h1>Reload preview</h1>");
    await fs.writeFile(path.join(root, "browser-only.html"), '<link rel="stylesheet" href="browser.css"><h1>External browser before reload</h1>');
    await fs.writeFile(path.join(root, "browser.css"), "h1{color:blue}");
    await fs.writeFile(path.join(root, "README.md"), "# Before reload");
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
    // createTerminal returns before VS Code has created and named its pty.
    // A blank pending terminal tab is not a persisted terminal yet. Wait for
    // the actual attachment before taking the before-reload layout snapshot.
    await wait(async () => {
      const terminal = vscode.window.terminals.find(t => t.name === r.title);
      return terminal && await terminal.processId && vscode.window.tabGroups.all.some(g =>
        g.tabs.some(t => t.label === r.title && t.input instanceof vscode.TabInputTerminal));
    });
    await wait(async () => (await c.tmux.list()).find(s => s.owner === r.id)?.attached === 1);
    await vscode.commands.executeCommand("remoteAgentSessions.showFiles");
    const items = await api.sessionWorkspace.getChildren(
      api.sessionWorkspace.rootItem(),
    );
    const note = items.find((e) => e.name === "note.txt");
    await api.sessionWorkspace.openFile(note);
    await api.sessionWorkspace.openFile(note);
    const browserPanel = await api.sessionWorkspace.preview(items.find(node => node.name === "browser-only.html"));
    let browserUrl;
    await previews.launchBrowser(browserPanel, async uri => { browserUrl = uri.toString(); return true; });
    assert.match((await readBrowserPage(browserUrl)).text, /External browser before reload/);
    const browserPanelTitle = browserPanel.panel.title;
    browserPanel.panel.dispose();
    await wait(() => layout().every(group => group.tabs.every(tab => tab.label !== browserPanelTitle)));
    for (let i = 0; i < 2; i++)
      await vscode.commands.executeCommand(
        "remoteAgentSessions.previewMarkdown",
        items.find((e) => e.name === "README.md"),
      );
    for (const name of ["index.html", "second.html"]) {
      const p = await api.sessionWorkspace.preview(
        items.find((e) => e.name === name),
      );
      await wait(() => p.server?.subscriptions.size > 0);
      // Starting the local server no longer waits for an SSH stat. VS Code's
      // native tab event can arrive after open() resolves; snapshot only once
      // the actual permanent tab exists, not during that UI handoff.
      await wait(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
        tab.label === p.panel.title && !tab.isPreview)));
    }
    assert.equal(
      vscode.window.tabGroups.all.length,
      1,
      "opening previews must not create editor groups",
    );
    state = {
      phase: 0,
      host: host.id,
      record: r.id,
      root,
      checks: [],
      originalTmux: (await c.tmux.list()).find((s) => s.owner === r.id).id,
      browserUrl,
    };
  } else {
    const c = api.controllers.find((c) => c.host.id === state.host);
    assert.ok(c);
    assert.equal(
      c.manager.records.find((r) => r.id === state.record).workspaceRoot,
      state.root,
    );
    assert.equal(
      (await c.tmux.list()).find((s) => s.owner === state.record).id,
      state.originalTmux,
    );
    await fs.writeFile(path.join(state.root, "browser-only.html"), "<h1>External browser after reload " + state.phase + "</h1>");
    const browserPage = await readBrowserPage(state.browserUrl);
    assert.equal(browserPage.status, 200);
    assert.match(browserPage.text, new RegExp("External browser after reload " + state.phase));
    assert.equal((await readBrowserPage(new URL("browser.css", state.browserUrl))).text, "h1{color:blue}");
    // VS Code initially exposes unresolved editor placeholders. Check the
    // group/tab counts first; compare full identities after revealing them.
    const shape = (groups) =>
      groups.map((g) => ({ column: g.column, count: g.tabs.length }));
    try {
      await wait(() => JSON.stringify(shape(layout())) === JSON.stringify(shape(state.layout)));
    } catch (error) {
      throw new Error(error.message + " " + JSON.stringify({expected:state.layout, actual:layout(), terminalNames:vscode.window.terminals.map(t=>t.name)}));
    }
    // Native webviews/custom editors deserialize lazily. Reveal the existing
    // restored tabs instead of opening replacements that could mask tab loss.
    const group = vscode.window.tabGroups.activeTabGroup;
    for (let i = 0; i < group.tabs.length; i++) {
      await vscode.commands.executeCommand(
        "workbench.action.openEditorAtIndex" + (i + 1),
      );
      await wait(() => group.tabs[i]?.isActive);
      const tab = state.layout[0].tabs[i];
      if (tab.label.startsWith("Preview · ")) {
        const name = tab.label.slice("Preview · ".length);
        try {
          await wait(() =>
            [...previews.items].some(
              (p) =>
                path.basename(p.state.file) === name &&
                p.server?.subscriptions.size > 0,
            ),
          );
        } catch (error) {
          throw new Error(
            error.message +
              " " +
              JSON.stringify({
                tab: name,
                layout: layout(),
                previews: [...previews.items].map((p) => ({
                  state: p.state,
                  server: Boolean(p.server),
                  html: p.panel.webview.html.slice(0, 700),
                })),
              }),
          );
        }
      } else if (tab.uri?.startsWith("tmuxdock-remote:")) {
        await wait(() =>
          vscode.workspace.textDocuments.some(
            (d) => d.uri.toString() === tab.uri,
          ),
        );
      }
    }
    await wait(
      () =>
        previews.items.size === 2 &&
        [...previews.items].every((i) => i.server?.subscriptions.size > 0),
    );
    for (const p of previews.items) {
      assert.equal(p.context.record.id, state.record);
      assert.equal(p.state.root, state.root);
      assert.notEqual(p.server.origin, state.previousOrigins[p.state.file]);
    }
    const markdown = () =>
      vscode.workspace.textDocuments.filter(
        (d) =>
          d.uri.path.endsWith("README.md") &&
          d.uri.fragment.startsWith("tmuxdockPreview="),
      );
    await wait(() => markdown().length === 2);
    const note = vscode.workspace.textDocuments.find(
      (d) =>
        d.uri.scheme === "tmuxdock-remote" && d.uri.path.endsWith("note.txt"),
    );
    assert.ok(note);
    await fs.writeFile(
      path.join(state.root, "note.txt"),
      "after reload " + state.phase,
    );
    await fs.writeFile(
      path.join(state.root, "README.md"),
      "# After reload " + state.phase,
    );
    await wait(
      () =>
        note.getText() === "after reload " + state.phase &&
        markdown().every((d) =>
          d.getText().includes("After reload " + state.phase),
        ),
    );
    await wait(() => JSON.stringify(layout()) === JSON.stringify(state.layout));
    assert.deepEqual(layout(), state.layout);
    state.checks.push(
      "reload " +
        state.phase +
        ": HTML and Markdown tabs retain layout and live updates, and the external browser keeps the same URL after its editor tab was closed",
    );
  }
  if (state.phase < 2) {
    state.phase++;
    state.previousOrigins = Object.fromEntries(
      [...previews.items].map((i) => [i.state.file, i.server.origin]),
    );
    state.layout = layout();
    await fs.writeFile(file, JSON.stringify(state));
    await sleep(1200);
    await vscode.commands.executeCommand("workbench.action.reloadWindow");
    await new Promise(() => {});
  }
  previews.dispose();
  for (const terminal of vscode.window.terminals) terminal.dispose();
  await api.controllers
    .find((c) => c.host.id === state.host)
    .tmux.run(["kill-server"]);
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
