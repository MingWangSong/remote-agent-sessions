"use strict";
const vscode = require("vscode"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function wait(fn) {
  for (let i = 0; i < 160; i++) {
    if (await fn()) return;
    await sleep(100);
  }
  throw Error("Workspace acceptance timed out");
}
exports.run = async (api, controller, check) => {
  const root = path.join(process.env.RAS_TEST_DIRECTORY, "workspace-files");
  await fs.mkdir(path.join(root, "assets"), { recursive: true });
  await fs.writeFile(path.join(root, "report.txt"), "generation one");
  await fs.writeFile(
    path.join(root, "index.html"),
    '<!doctype html><link rel="stylesheet" href="/assets/style.css"><script type="module" src="/assets/main.js"></script><h1>Workspace demo</h1>',
  );
  await fs.writeFile(
    path.join(root, "assets", "style.css"),
    "body{background:#123}",
  );
  await fs.writeFile(
    path.join(root, "assets", "main.js"),
    'fetch("/data.json").then(r=>r.json()).then(()=>fetch("/beacon-loaded"))',
  );
  await fs.writeFile(path.join(root, "data.json"), '{"ok":true}');
  await fs.writeFile(
    path.join(root, "README.md"),
    "# Workspace notes\n\nGeneration one.",
  );
  const record = await controller.manager.create({
    title: "workspace-acceptance",
    cwd: root,
    host: controller.host.id,
  });
  const entry = () =>
    controller.manager.entries.find((e) => e.id === record.id);
  const files = api.sessionWorkspace;
  await check(
    "Session files: fixed creation root and native right sidebar list remote files",
    async () => {
      assert.equal(
        (await controller.manager.store.load()).find((r) => r.id === record.id)
          .workspaceRoot,
        root,
      );
      files.select(controller, entry(), true);
      await vscode.commands.executeCommand("remoteAgentSessions.showFiles");
      const children = await files.getChildren();
      assert.ok(children.some((e) => e.name === "index.html"));
      assert.ok(children.some((e) => e.name === "assets"));
      for (const [name, icon] of [
        ["index.html", "file"],
        ["assets", "folder"],
      ]) {
        const item = children.find((e) => e.name === name);
        const treeItem = files.getTreeItem(item);
        assert.equal(treeItem.iconPath.id, icon);
        assert.equal(treeItem.resourceUri.toString(), item.uri.toString());
      }
      assert.equal(
        files.view.description.includes(controller.host.label),
        true,
      );
    },
  );
  let doc;
  await check(
    "Markdown preview: reuses VS Code's built-in renderer and tracks remote document updates",
    async () => {
      const item = (await files.getChildren()).find(
        (e) => e.name === "README.md",
      );
      assert.equal(files.getTreeItem(item).contextValue, "remoteMarkdown");
      await vscode.commands.executeCommand(
        "remoteAgentSessions.previewMarkdown",
        item,
      );
      const source = vscode.workspace.textDocuments.find(
        (d) => d.uri.toString() === item.uri.toString(),
      );
      assert.ok(source);
      assert.equal(source.languageId, "markdown");
      assert.ok(
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .some((t) => t.input instanceof vscode.TabInputWebview),
      );
      await fs.writeFile(
        path.join(root, "README.md"),
        "# Workspace notes\n\nGeneration two.",
      );
      await wait(() => source.getText().includes("Generation two"));
    },
  );
  await check(
    "Session files: native read-only document refreshes after an Agent-style atomic replacement",
    async () => {
      const item = (await files.getChildren()).find(
        (e) => e.name === "report.txt",
      );
      await files.openFile(item);
      doc = vscode.window.activeTextEditor.document;
      assert.equal(doc.uri.scheme, "tmuxdock-remote");
      assert.equal(doc.getText(), "generation one");
      await assert.rejects(
        vscode.workspace.fs.writeFile(item.uri, Buffer.from("unsafe")),
        /permission|read.only/i,
      );
      await fs.writeFile(path.join(root, "report.tmp"), "generation two");
      await fs.rename(
        path.join(root, "report.tmp"),
        path.join(root, "report.txt"),
      );
      await wait(() => doc.getText() === "generation two");
    },
  );
  await check(
    "Session files: creation and deletion update expanded directory data",
    async () => {
      await fs.writeFile(path.join(root, "new.txt"), "new");
      await wait(async () => {
        files.cache.clear();
        return (await files.getChildren()).some((e) => e.name === "new.txt");
      });
      await fs.rm(path.join(root, "new.txt"));
      files.cache.clear();
      assert.equal(
        (await files.getChildren()).some((e) => e.name === "new.txt"),
        false,
      );
    },
  );
  await check(
    "HTML preview: actual webview loads root-relative CSS, modules and fetch resources",
    async () => {
      const item = (await files.getChildren()).find(
        (e) => e.name === "index.html",
      );
      await files.preview(item);
      const server = files.server;
      let loaded = false;
      server.server.on("request", (req) => {
        if (req.url.startsWith("/beacon-loaded")) loaded = true;
      });
      await wait(() => loaded);
      assert.ok(
        server.subscriptions.has(path.join(root, "assets", "style.css")),
      );
      assert.ok(server.subscriptions.has(path.join(root, "data.json")));
    },
  );
  await check(
    "HTML preview: remote CSS change automatically reloads its rendered page",
    async () => {
      let loads = 0;
      files.server.server.on("request", (req) => {
        if (req.url.startsWith("/beacon-loaded")) loads++;
      });
      await sleep(1600);
      loads = 0;
      await fs.writeFile(
        path.join(root, "assets", "style.css"),
        "body{background:#456}",
      );
      await wait(() => loads > 0);
    },
  );
  await check(
    "HTML preview: strict CSP remains intact and an external file replacement still refreshes the iframe",
    async () => {
      const pixel = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
        "base64",
      );
      await fs.writeFile(path.join(root, "assets", "v1.png"), pixel);
      await fs.writeFile(path.join(root, "assets", "v2.png"), pixel);
      const html = (name) =>
        "<!doctype html><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self'; script-src 'none'\"><img src=\"/assets/" +
        name +
        '">';
      let one = false,
        two = false;
      files.server.server.on("request", (req) => {
        if (req.url.startsWith("/assets/v1.png")) one = true;
        if (req.url.startsWith("/assets/v2.png")) two = true;
      });
      await fs.writeFile(path.join(root, "index.html"), html("v1.png"));
      await wait(() => one);
      await fs.writeFile(path.join(root, "index.html"), html("v2.png"));
      await wait(() => two);
      assert.equal(
        await fs.readFile(path.join(root, "index.html"), "utf8"),
        html("v2.png"),
      );
    },
  );
  await check(
    "Session files: pinning prevents automatic session changes, while root and last pane cwd remain separate",
    async () => {
      const other = await controller.manager.create({
        title: "other-workspace",
        cwd: process.env.RAS_TEST_DIRECTORY,
      });
      const owner = files.current.entry.id;
      files.pinned = true;
      files.select(
        controller,
        controller.manager.entries.find((e) => e.id === other.id),
      );
      assert.equal(files.current.entry.id, owner);
      files.pinned = false;
      const pane = (await controller.tmux.listWindows(record.tmuxSession))[0]
        .panes[0].id;
      await controller.tmux.sendCommand(record.tmuxSession, pane, "cd /tmp");
      await wait(
        async () =>
          !(
            await controller.tmux.listWindows(record.tmuxSession)
          )[0].panes[0].cwd.includes("workspace-files"),
      );
      await controller.manager.deleteSession(record);
      const saved = (await controller.manager.store.load()).find(
        (r) => r.id === record.id,
      );
      assert.equal(saved.workspaceRoot, root);
      assert.notEqual(saved.cwd, root);
      await controller.manager.restore(record, false);
      assert.equal(
        (await controller.manager.store.load()).find((r) => r.id === record.id)
          .workspaceRoot,
        root,
      );
      await controller.manager.deleteSession(other);
      await controller.manager.forget(other);
    },
  );
  await check(
    "Session files: cross-host switching isolates same-name files and ignores delayed directory responses",
    async () => {
      const firstId = controller.host.id;
      const secondRoot = path.join(
        process.env.RAS_TEST_DIRECTORY,
        "second-host-files",
      );
      await fs.mkdir(secondRoot);
      await fs.writeFile(path.join(secondRoot, "report.txt"), "host two");
      await fs.writeFile(
        path.join(secondRoot, "index.html"),
        "<h1>Host two</h1>",
      );
      const host = await api.registry.add({
        sshHost: "fake-second-files-host",
        label: "Second Files Host",
        defaultCwd: secondRoot,
        socketName: process.env.RAS_TEST_SOCKET + "-files",
      });
      await api.provider.reloadHosts();
      controller = api.controllers.find((c) => c.host.id === firstId);
      const second = api.controllers.find((c) => c.host.id === host.id);
      const record2 = require("../../src/model").createRecord({
        title: record.title,
        tmuxSession: record.tmuxSession,
        cwd: secondRoot,
        workspaceRoot: secondRoot,
        host: host.id,
      });
      await second.manager.store.save([record2]);
      await second.manager.reloadRecords();
      files.select(
        controller,
        controller.manager.entries.find((e) => e.id === record.id),
        true,
      );
      const firstService = files.service(controller);
      const original = firstService.list;
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      firstService.list = async (...args) => {
        await gate;
        return original.apply(firstService, args);
      };
      files.cache.clear();
      const delayed = files.getChildren();
      files.select(
        second,
        second.manager.entries.find((e) => e.id === record2.id),
        true,
      );
      const secondItems = await files.getChildren();
      release();
      assert.deepEqual(await delayed, []);
      firstService.list = original;
      const item = secondItems.find((e) => e.name === "report.txt");
      await files.openFile(item);
      assert.equal(
        vscode.window.activeTextEditor.document.getText(),
        "host two",
      );
      assert.equal(
        vscode.window.activeTextEditor.document.uri.authority,
        host.id,
      );
      const old = files.server;
      await files.preview(secondItems.find((e) => e.name === "index.html"));
      if (old) assert.equal(old.closed, true);
      assert.equal(files.previewContext.controller.host.id, host.id);
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
      files.panel?.dispose();
      await second.manager.forget(record2);
      await api.registry.remove(host.id);
      await api.provider.reloadHosts();
      files.reconcile();
      assert.equal(files.services.has(host.id), false);
      controller = api.controllers.find((c) => c.host.id === firstId);
    },
  );
  files.panel?.dispose();
  await controller.manager.deleteSession(record);
  await controller.manager.forget(record);
  files.reconcile();
};
