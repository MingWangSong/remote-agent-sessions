"use strict";
const vscode = require("vscode"), assert = require("node:assert/strict"), fs = require("node:fs/promises"), path = require("node:path");
const { MAX_FILE } = require("../../src/remoteFiles");
exports.run = async (files, controller, root, check) => {
  const service = files.service(controller);
  const resource = name => vscode.Uri.from({ scheme: "tmuxdock-remote", authority: controller.host.id, path: path.join(root, name) });
  const item = name => ({ name, type: "file", uri: resource(name), context: files.current });
  const close = async uri => {
    const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri.toString());
    if (tabs.length) await vscode.window.tabGroups.close(tabs);
  };
  await check("Session files: >2 MiB native opens share one read, preserve dirty edits and use the current group", async () => {
    const target = item("large-open.txt");
    const content = "ordinary text\n".repeat(170000);
    await fs.writeFile(target.uri.path, content);
    const original = service.readSnapshot;
    let reads = 0;
    service.readSnapshot = function (file, ...args) {
      if (file === target.uri.path) reads++;
      return original.call(this, file, ...args);
    };
    const groups = vscode.window.tabGroups.all.length;
    try {
      await Promise.all([files.openFile(target), files.openFile(target), files.openFile(target)]);
      const doc = vscode.window.activeTextEditor.document;
      assert.equal(doc.uri.toString(), target.uri.toString());
      assert.equal(doc.getText(), content);
      assert.equal(reads, 1, "Progress preloading must be reused by the native file provider");
      assert.equal(vscode.window.tabGroups.all.length, groups);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(0, 0), "unsaved edit\n");
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(doc.isDirty, true);
      await files.openFile(target);
      assert.ok(doc.getText().startsWith("unsaved edit\n"));
      assert.equal(reads, 1);
      await vscode.commands.executeCommand("workbench.action.files.revert");
    } finally {
      service.readSnapshot = original;
      await close(target.uri);
      await fs.rm(target.uri.path, { force: true });
    }
  });
  await check("Session files: cancelling an actual chunked read opens no editor and preserves the shared channel", async () => {
    const target = item("cancel-open.txt");
    await fs.writeFile(target.uri.path, Buffer.alloc(3 * 1024 * 1024, 65));
    const original = service.readSnapshot, channel = service.channel.child;
    let cancelled = false;
    service.readSnapshot = function (file, limit, options) {
      if (file !== target.uri.path) return original.call(this, file, limit, options);
      return original.call(this, file, limit, { ...options, onProgress(update) {
        options.onProgress(update);
        files.openingFiles.get(target.uri.toString()).abort.abort();
        cancelled = true;
      } });
    };
    try {
      await files.openFile(target);
      assert.ok(cancelled);
      assert.equal(files.openingFiles.size, 0);
      assert.ok(!vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.uri?.toString() === target.uri.toString()));
      assert.ok((await service.read(path.join(root, "report.txt"))).length > 0);
      assert.equal(service.channel.child, channel);
    } finally {
      service.readSnapshot = original;
      await fs.rm(target.uri.path, { force: true });
    }
  });
  await check("Session files: oversize preflight offers download without reading content", async () => {
    const target = item("oversize-open.txt");
    const file = await fs.open(target.uri.path, "w");
    await file.truncate(MAX_FILE + 1);
    await file.close();
    const offer = files.offerFileDownload, chunk = service.chunk;
    let offered = false, chunks = 0;
    files.offerFileDownload = async (selected, size) => {
      assert.equal(selected.uri.toString(), target.uri.toString());
      assert.equal(size, MAX_FILE + 1);
      offered = true;
    };
    service.chunk = function (file, ...args) { if (file === target.uri.path) chunks++; return chunk.call(this, file, ...args); };
    try {
      await files.openFile(target);
      assert.ok(offered);
      assert.equal(chunks, 0);
    } finally {
      files.offerFileDownload = offer;
      service.chunk = chunk;
      await fs.rm(target.uri.path, { force: true });
    }
  });
  await check("Session files: native image editors still open without creating a split", async () => {
    const target = item("native-open.png"), groups = vscode.window.tabGroups.all.length;
    await fs.writeFile(target.uri.path, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=", "base64"));
    try {
      await files.openFile(target);
      assert.ok(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.uri.toString() === target.uri.toString()));
      assert.equal(vscode.window.tabGroups.all.length, groups);
    } finally {
      await close(target.uri);
      await fs.rm(target.uri.path, { force: true });
    }
  });
};
