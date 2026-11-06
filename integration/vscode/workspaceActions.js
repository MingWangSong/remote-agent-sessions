"use strict";
const vscode = require("vscode"),
  assert = require("node:assert/strict"),
  fs = require("node:fs/promises"),
  path = require("node:path");
const { MIME } = require("../../src/sessionFileActions");
const token = {
  isCancellationRequested: false,
  onCancellationRequested: () => new vscode.Disposable(() => {}),
};
exports.run = async (files, controller, root, check) => {
  const owner = files.current.entry;
  const children = async () => {
    files.cache.clear();
    return files.getChildren(files.rootItem());
  };
  const item = async (name) => (await children()).find((e) => e.name === name);
  const drag = async (source, target) => {
    const data = new vscode.DataTransfer();
    files.actions.handleDrag(source, data, token);
    assert.ok(data.get(MIME));
    return files.actions.handleDrop(target, data, token);
  };
  await check(
    "Session files: native drag moves files/folders between directories and the root without overwriting",
    async () => {
      const folder = await item("assets");
      const report = await item("report.txt");
      await files.openFile(report);
      assert.equal(await drag([report], files.rootItem()), true);
      assert.equal(await drag([report], folder), true);
      const moved = path.join(root, "assets", "report.txt");
      assert.equal(await fs.readFile(moved, "utf8"), "generation two");
      assert.ok(
        vscode.workspace.textDocuments.some(
          (d) => d.uri.path === moved && d.getText() === "generation two",
        ),
      );
      const nested = (await files.getChildren(folder)).find(
        (e) => e.name === "report.txt",
      );
      assert.equal(await drag([nested], files.rootItem()), true);
      await fs.mkdir(path.join(root, "drag-folder"));
      await fs.writeFile(
        path.join(root, "drag-folder", "inner.txt"),
        "folder contents",
      );
      assert.equal(await drag([await item("drag-folder")], folder), true);
      assert.equal(
        await fs.readFile(
          path.join(root, "assets", "drag-folder", "inner.txt"),
          "utf8",
        ),
        "folder contents",
      );
      const inside = (await files.getChildren(folder)).find(
        (e) => e.name === "drag-folder",
      );
      assert.equal(await drag([inside], inside), false);
      await fs.writeFile(path.join(root, "assets", "report.txt"), "collision");
      assert.equal(await drag([await item("report.txt")], folder), false);
      assert.equal(
        await fs.readFile(path.join(root, "assets", "report.txt"), "utf8"),
        "collision",
      );
      assert.equal(
        await fs.readFile(path.join(root, "report.txt"), "utf8"),
        "generation two",
      );
    },
  );
  await check(
    "Session files: desktop file/folder drops upload to root/subdirectories and clean incomplete transfers",
    async () => {
      const local = path.join(process.env.RAS_TEST_DIRECTORY, "desktop-drops");
      await fs.mkdir(path.join(local, "folder", "child"), { recursive: true });
      await fs.writeFile(path.join(local, "from-desktop.txt"), "desktop file");
      await fs.writeFile(
        path.join(local, "folder", "child", "notes.md"),
        "# Uploaded folder",
      );
      const original = files.actions.putLocal;
      files.actions.putLocal = async (_c, source, destination) =>
        fs.cp(source, destination, { recursive: true });
      const drop = async (paths, target) => {
        const data = new vscode.DataTransfer();
        data.set(
          "text/uri-list",
          new vscode.DataTransferItem(
            "# OS files\r\n" +
              paths.map((p) => vscode.Uri.file(p).toString()).join("\r\n"),
          ),
        );
        return files.actions.handleDrop(target, data, token);
      };
      try {
        assert.equal(
          await drop([path.join(local, "from-desktop.txt")], undefined),
          true,
        );
        const folder = await item("assets");
        await fs.writeFile(
          path.join(local, "native-file.txt"),
          "native transfer",
        );
        const nativeData = new vscode.DataTransfer();
        nativeData.set("application/octet-stream", {
          asFile: () => ({
            uri: vscode.Uri.file(path.join(local, "native-file.txt")),
          }),
        });
        assert.equal(
          await files.actions.handleDrop(files.rootItem(), nativeData, token),
          true,
        );
        assert.equal(
          await fs.readFile(path.join(root, "native-file.txt"), "utf8"),
          "native transfer",
        );
        assert.equal(await drop([path.join(local, "folder")], folder), true);
        assert.equal(
          await fs.readFile(path.join(root, "from-desktop.txt"), "utf8"),
          "desktop file",
        );
        assert.equal(
          await fs.readFile(
            path.join(root, "assets", "folder", "child", "notes.md"),
            "utf8",
          ),
          "# Uploaded folder",
        );
        assert.equal(await drop([path.join(local, "folder")], folder), false);
        await fs.writeFile(path.join(local, "failure.txt"), "partial");
        files.actions.putLocal = async (_c, _source, destination) => {
          await fs.writeFile(destination, "partial");
          throw Error("fixture interrupted");
        };
        assert.equal(
          await drop([path.join(local, "failure.txt")], files.rootItem()),
          false,
        );
        await assert.rejects(fs.stat(path.join(root, "failure.txt")), {
          code: "ENOENT",
        });
        assert.equal(
          (await fs.readdir(root)).some((name) =>
            name.startsWith(".tmuxdock-upload-"),
          ),
          false,
        );
        assert.equal(
          (await fs.readdir(path.join(root, "assets"))).some((name) =>
            name.startsWith(".tmuxdock-upload-"),
          ),
          false,
        );
      } finally {
        files.actions.putLocal = original;
      }
    },
  );
  await check(
    "Session files: a delayed desktop drop retains its original directory across session switches",
    async () => {
      const other = await controller.manager.create({
        title: "upload-switch",
        cwd: path.join(root, "assets"),
      });
      const source = path.join(
        process.env.RAS_TEST_DIRECTORY,
        "switch-upload.txt",
      );
      await fs.writeFile(source, "original target");
      const put = files.actions.putLocal;
      files.actions.putLocal = async (_c, local, destination) =>
        fs.copyFile(local, destination);
      const transfer = new vscode.DataTransfer();
      transfer.set("text/uri-list", {
        asString: async () => {
          files.select(
            controller,
            controller.manager.entries.find((e) => e.id === other.id),
            true,
          );
          return vscode.Uri.file(source).toString();
        },
        asFile: () => undefined,
      });
      try {
        assert.equal(
          await files.actions.handleDrop(undefined, transfer, token),
          true,
        );
        assert.equal(
          await fs.readFile(path.join(root, "switch-upload.txt"), "utf8"),
          "original target",
        );
        await assert.rejects(
          fs.stat(path.join(root, "assets", "switch-upload.txt")),
          { code: "ENOENT" },
        );
      } finally {
        files.actions.putLocal = put;
        files.select(controller, owner, true);
        await controller.manager.deleteSession(other);
        await controller.manager.forget(other);
      }
    },
  );
  await check(
    "Session files: moving HTML and Markdown preserves independent previews and editor groups",
    async () => {
      const folder = await item("assets"),
        groups = vscode.window.tabGroups.all.length;
      const previews = [...files.previews.items].filter(
        (p) => p.state.file === path.join(root, "index.html"),
      );
      const markdown = () =>
        vscode.window.tabGroups.all
          .flatMap((g) => g.tabs)
          .filter(
            (t) =>
              t.input instanceof vscode.TabInputCustom &&
              t.input.viewType === "vscode.markdown.preview.editor",
          );
      const count = markdown().length;
      assert.equal(
        await drag([await item("index.html"), await item("README.md")], folder),
        true,
      );
      assert.ok(
        previews.every(
          (p) =>
            p.state.file === path.join(root, "assets", "index.html") &&
            p.server &&
            !p.closed,
        ),
      );
      assert.equal(markdown().length, count);
      assert.ok(
        markdown()
          .filter((t) => t.input.uri.path.endsWith("README.md"))
          .every(
            (t) => t.input.uri.path === path.join(root, "assets", "README.md"),
          ),
      );
      assert.equal(vscode.window.tabGroups.all.length, groups);
      const nested = await files.getChildren(folder);
      assert.equal(
        await drag(
          nested.filter((e) => ["index.html", "README.md"].includes(e.name)),
          files.rootItem(),
        ),
        true,
      );
      assert.equal(vscode.window.tabGroups.all.length, groups);
    },
  );
  await check(
    "Session files: rename preserves content and permanent delete requires explicit confirmation",
    async () => {
      const fixture = path.join(root, "context-actions");
      await fs.mkdir(path.join(fixture, "nested"), { recursive: true });
      await fs.writeFile(
        path.join(fixture, "nested", "keep.md"),
        "# Preserve until confirmed",
      );
      const folder = await item("context-actions");
      const ask = files.askRename,
        confirm = files.confirmDelete;
      try {
        files.askRename = async () => "renamed-actions";
        await vscode.commands.executeCommand(
          "remoteAgentSessions.renameFile",
          folder,
        );
        const renamed = path.join(root, "renamed-actions");
        assert.equal(
          await fs.readFile(path.join(renamed, "nested", "keep.md"), "utf8"),
          "# Preserve until confirmed",
        );
        const renamedItem = await item("renamed-actions");
        let confirmations = 0;
        files.confirmDelete = async (selected) => {
          confirmations++;
          assert.equal(selected.uri.path, renamed);
          assert.ok((await fs.stat(renamed)).isDirectory());
          return false;
        };
        assert.equal(
          await vscode.commands.executeCommand(
            "remoteAgentSessions.deleteFilePermanently",
            renamedItem,
          ),
          false,
        );
        assert.equal(confirmations, 1);
        assert.equal(
          await fs.readFile(path.join(renamed, "nested", "keep.md"), "utf8"),
          "# Preserve until confirmed",
        );
        files.confirmDelete = async () => {
          confirmations++;
          return true;
        };
        assert.equal(
          await vscode.commands.executeCommand(
            "remoteAgentSessions.deleteFilePermanently",
            renamedItem,
          ),
          true,
        );
        assert.equal(confirmations, 2);
        await assert.rejects(fs.stat(renamed), { code: "ENOENT" });
        await assert.rejects(
          files.deleteEntry(files.rootItem()),
          /linked working directory/,
        );
        assert.equal(
          confirmations,
          2,
          "root protection must run before confirmation",
        );
        await assert.rejects(
          files.renameEntry(files.rootItem()),
          /linked working directory/,
        );
      } finally {
        files.askRename = ask;
        files.confirmDelete = confirm;
      }
    },
  );
  await check(
    "Session files: unmanaged legacy sessions browse, link and edit without enabling recovery",
    async () => {
      const name = "legacy-file-only";
      await controller.tmux.create(name, root);
      const choose = files.chooseDirectory;
      try {
        await controller.manager.refresh();
        const entry = controller.manager.entries.find(
          (e) => e.tmuxSession === name,
        );
        assert.ok(entry && !entry.record);
        files.select(controller, entry, true);
        assert.equal(files.current.root, root);
        files.chooseDirectory = async () => path.join(root, "assets");
        await files.link();
        assert.equal(files.current.root, path.join(root, "assets"));
        assert.ok(
          (await files.getChildren(files.rootItem())).some(
            (e) => e.name === "style.css",
          ),
        );
        assert.equal(
          controller.manager.records.some((r) => r.tmuxSession === name),
          false,
        );
        const live = (await controller.tmux.list()).find(
          (e) => e.name === name,
        );
        assert.ok(!live.owner);
        const css = (await files.getChildren(files.rootItem())).find(
          (e) => e.name === "style.css",
        );
        await vscode.workspace.fs.writeFile(
          css.uri,
          Buffer.from("body{color:#fff}"),
        );
        assert.equal(
          await fs.readFile(path.join(root, "assets", "style.css"), "utf8"),
          "body{color:#fff}",
        );
      } finally {
        files.chooseDirectory = choose;
        await controller.tmux.kill(name);
        await controller.manager.refresh();
        files.select(controller, owner, true);
      }
    },
  );
};
