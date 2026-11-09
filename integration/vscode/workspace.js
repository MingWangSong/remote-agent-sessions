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
      const roots = await files.getChildren();
      assert.equal(roots.length, 1);
      assert.equal(roots[0].uri.path, root);
      assert.equal(files.getTreeItem(roots[0]).contextValue, "remoteRoot");
      const children = await files.getChildren(roots[0]);
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
  await check(
    "Session files: compact header and absolute/relative Copy Path use the selected node without SSH",
    async () => {
      assert.equal(files.view.message, undefined);
      const rootItem = files.rootItem();
      const folder = (await files.getChildren(rootItem)).find(
        (e) => e.name === "assets",
      );
      const child = (await files.getChildren(folder)).find(
        (e) => e.name === "style.css",
      );
      const clipboard = await vscode.env.clipboard.readText();
      const ssh = controller.ssh.run;
      controller.ssh.run = async () => {
        throw Error("Copy Path must not use SSH");
      };
      try {
        for (const [item, absolute, relative] of [
          [rootItem, root, "."],
          [folder, path.join(root, "assets"), "assets"],
          [child, path.join(root, "assets", "style.css"), "assets/style.css"],
        ]) {
          await vscode.commands.executeCommand(
            "remoteAgentSessions.copyFilePath",
            item,
          );
          assert.equal(await vscode.env.clipboard.readText(), absolute);
          await vscode.commands.executeCommand(
            "remoteAgentSessions.copyRelativeFilePath",
            item,
          );
          assert.equal(await vscode.env.clipboard.readText(), relative);
        }
      } finally {
        controller.ssh.run = ssh;
        await vscode.env.clipboard.writeText(clipboard);
      }
    },
  );
  let doc, htmlPreview;
  await require("./fileOpening").run(files, controller, root, check);
  await check(
    "Markdown preview: reuses VS Code's built-in renderer and tracks remote document updates",
    async () => {
      const item = (await files.getChildren(files.rootItem())).find(
        (e) => e.name === "README.md",
      );
      assert.equal(files.getTreeItem(item).contextValue, "remoteMarkdown");
      await vscode.commands.executeCommand(
        "remoteAgentSessions.previewMarkdown",
        item,
      );
      const source = vscode.workspace.textDocuments.find(
        (d) =>
          d.uri.path === item.uri.path &&
          d.uri.query.startsWith("tmuxdockPreview="),
      );
      assert.ok(source);
      assert.equal(source.languageId, "markdown");
      await wait(() =>
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .some(
            (t) =>
              t.input instanceof vscode.TabInputCustom &&
              t.input.viewType === "vscode.markdown.preview.editor",
          ),
      );
      await fs.writeFile(
        path.join(root, "README.md"),
        "# Workspace notes\n\nGeneration two.",
      );
      await wait(() => source.getText().includes("Generation two"));
    },
  );
  await check(
    "Session files: native editing saves to the remote host and Agent replacements refresh the document",
    async () => {
      const item = (await files.getChildren(files.rootItem())).find(
        (e) => e.name === "report.txt",
      );
      await files.openFile(item);
      doc = vscode.window.activeTextEditor.document;
      assert.equal(doc.uri.scheme, "tmuxdock-remote");
      assert.equal(doc.getText(), "generation one");
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        doc.uri,
        new vscode.Range(
          doc.positionAt(0),
          doc.positionAt(doc.getText().length),
        ),
        "saved from VS Code",
      );
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(doc.isDirty, true);
      assert.equal(await doc.save(), true);
      assert.equal(
        await fs.readFile(path.join(root, "report.txt"), "utf8"),
        "saved from VS Code",
      );
      assert.equal(doc.isDirty, false);
      await fs.writeFile(path.join(root, "report.tmp"), "generation two");
      await fs.rename(
        path.join(root, "report.tmp"),
        path.join(root, "report.txt"),
      );
      await wait(() => doc.getText() === "generation two");
    },
  );
  await check(
    "Session files: native creation commands create and reveal files/folders without overwriting existing contents",
    async () => {
      const create = async (command, item, name) => {
        const ask = files.askEntryName;
        files.askEntryName = async () => name;
        try {
          return await vscode.commands.executeCommand(
            "remoteAgentSessions." + command,
            item,
          );
        } finally {
          files.askEntryName = ask;
        }
      };
      await create("newFolder", undefined, "created-folder");
      assert.ok(
        (await fs.stat(path.join(root, "created-folder"))).isDirectory(),
      );
      const folder = (await files.getChildren(files.rootItem())).find(
        (e) => e.name === "created-folder",
      );
      assert.ok(folder);
      await files.view.reveal(folder, { select: true, focus: false });
      await create("newFile", undefined, "root-created.txt");
      assert.equal(
        await fs.readFile(path.join(root, "root-created.txt"), "utf8"),
        "",
      );
      await create("newFile", folder, "created.md");
      const target = path.join(root, "created-folder", "created.md");
      assert.equal(await fs.readFile(target, "utf8"), "");
      await wait(
        () => vscode.window.activeTextEditor?.document.uri.path === target,
      );
      const created = vscode.window.activeTextEditor.document;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(
        created.uri,
        new vscode.Position(0, 0),
        "# Created and saved",
      );
      await vscode.workspace.applyEdit(edit);
      assert.equal(await created.save(), true);
      assert.equal(await fs.readFile(target, "utf8"), "# Created and saved");
      await assert.rejects(
        files.service(controller).create(target, "file"),
        (error) => error.code === "FileExists",
      );
      assert.equal(await fs.readFile(target, "utf8"), "# Created and saved");
      await vscode.workspace.fs.createDirectory(
        folder.uri.with({ path: path.join(root, "nested", "child") }),
      );
      assert.ok(
        (await fs.stat(path.join(root, "nested", "child"))).isDirectory(),
      );
    },
  );
  await check(
    "Markdown previews: repeated and different files keep independent pinned tabs without splitting",
    async () => {
      const groups = vscode.window.tabGroups.all.length;
      const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
      const first = (await files.getChildren(files.rootItem())).find(
        (e) => e.name === "README.md",
      );
      await fs.writeFile(path.join(root, "second.md"), "# Second document");
      files.cache.clear();
      const second = (await files.getChildren(files.rootItem())).find(
        (e) => e.name === "second.md",
      );
      for (const item of [first, second, first])
        await vscode.commands.executeCommand(
          "remoteAgentSessions.previewMarkdown",
          item,
        );
      const markdownTabs = () =>
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .filter(
            (t) =>
              t.input instanceof vscode.TabInputCustom &&
              t.input.viewType === "vscode.markdown.preview.editor",
          );
      await wait(() => markdownTabs().length === 4);
      assert.equal(vscode.window.tabGroups.all.length, groups);
      assert.ok(
        markdownTabs().every(
          (t) => t.group.viewColumn === column && !t.isPreview,
        ),
      );
      assert.equal(
        new Set(markdownTabs().map((t) => t.input.uri.toString())).size,
        4,
      );
      await fs.writeFile(
        path.join(root, "README.md"),
        "# All original previews update",
      );
      await wait(() =>
        vscode.workspace.textDocuments
          .filter(
            (d) =>
              d.uri.path === first.uri.path &&
              d.uri.query.startsWith("tmuxdockPreview="),
          )
          .every((d) => d.getText().includes("All original previews update")),
      );
      const firstTab = markdownTabs()[0];
      await vscode.window.tabGroups.close(firstTab);
      await fs.writeFile(
        path.join(root, "README.md"),
        "# Surviving previews update",
      );
      await wait(() =>
        vscode.workspace.textDocuments
          .filter(
            (d) =>
              d.uri.path === first.uri.path &&
              d.uri.query.startsWith("tmuxdockPreview="),
          )
          .every((d) => d.getText().includes("Surviving previews update")),
      );
    },
  );
  await check(
    "Session files: creation and deletion update expanded directory data",
    async () => {
      await fs.writeFile(path.join(root, "new.txt"), "new");
      await wait(async () => {
        files.cache.clear();
        return (await files.getChildren(files.rootItem())).some(
          (e) => e.name === "new.txt",
        );
      });
      await fs.rm(path.join(root, "new.txt"));
      files.cache.clear();
      assert.equal(
        (await files.getChildren(files.rootItem())).some(
          (e) => e.name === "new.txt",
        ),
        false,
      );
    },
  );
  await check(
    "HTML preview: actual webview loads root-relative CSS, modules and fetch resources",
    async () => {
      const item = (await files.getChildren(files.rootItem())).find(
        (e) => e.name === "index.html",
      );
      htmlPreview = await files.preview(item);
      const server = htmlPreview.server;
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
      htmlPreview.server.server.on("request", (req) => {
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
  await require("./clipboard").run(files, controller, root, htmlPreview, check);
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
      htmlPreview.server.server.on("request", (req) => {
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
    "HTML previews: every request adds a fixed tab in the current group and closing one preserves others",
    async () => {
      const groups = vscode.window.tabGroups.all.length;
      const column = vscode.window.tabGroups.activeTabGroup.viewColumn;
      const item = (await files.getChildren(files.rootItem())).find(
        (e) => e.name === "index.html",
      );
      const originalServer = htmlPreview.server;
      const second = await files.preview(item);
      const third = await files.preview(item);
      assert.equal(files.previews.items.size, 3);
      assert.equal(htmlPreview.server, originalServer);
      assert.equal(originalServer.closed, false);
      assert.equal(vscode.window.tabGroups.all.length, groups);
      await wait(
        () =>
          second.panel.viewColumn === column &&
          third.panel.viewColumn === column,
      );
      assert.notEqual(second.server.origin, third.server.origin);
      assert.ok(!third.panel.webview.html.includes('id="pin"'));
      const surviving = third.server;
      second.panel.dispose();
      await wait(() => files.previews.items.size === 2);
      assert.equal(surviving.closed, false);
      assert.equal(originalServer.closed, false);
      third.panel.dispose();
      htmlPreview.panel.reveal(column);
    },
  );
  await require("./workspaceActions").run(files, controller, root, check);
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
      const delayed = files.getChildren(files.rootItem());
      files.select(
        second,
        second.manager.entries.find((e) => e.id === record2.id),
        true,
      );
      const secondItems = await files.getChildren(files.rootItem());
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
      const old = htmlPreview.server;
      const secondPreview = await files.preview(
        secondItems.find((e) => e.name === "index.html"),
      );
      assert.equal(old.closed, false);
      assert.equal(secondPreview.context.controller.host.id, host.id);
      assert.notEqual(secondPreview.server.origin, old.origin);
      await vscode.commands.executeCommand(
        "workbench.action.closeActiveEditor",
      );
      files.previews.dispose();
      await second.manager.forget(record2);
      await api.registry.remove(host.id);
      await api.provider.reloadHosts();
      files.reconcile();
      assert.equal(files.services.has(host.id), false);
      controller = api.controllers.find((c) => c.host.id === firstId);
    },
  );
  files.previews.dispose();
  await controller.manager.deleteSession(record);
  await controller.manager.forget(record);
  files.reconcile();
};
