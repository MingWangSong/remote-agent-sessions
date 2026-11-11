"use strict";
const vscode = require("vscode"), assert = require("node:assert/strict"),
  fs = require("node:fs/promises"), path = require("node:path");
const { browser } = require("./clipboard");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

exports.run = async (files, controller, root, check) => {
  const directory = path.join(root, "article-image-acceptance");
  const target = path.join(directory, "article.md");
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const names = Array.from({ length: 15 }, (_, i) => `images/fig${String(i + 1).padStart(2, "0")}.png`);
  await fs.mkdir(path.join(directory, "images"), { recursive: true });
  for (const name of names) await fs.writeFile(path.join(directory, name), pixel);
  const original = "# Native Markdown image acceptance\n\n" + names.map(name => `![${name}](${name})`).join("\n\n");
  await fs.writeFile(target, original);
  const resource = vscode.Uri.from({ scheme: "tmuxdock-remote", authority: controller.host.id, path: target });
  let previewUri, client;
  const report = { images: [], reads: [] };
  const service = files.service(controller), read = service.read;
  service.read = function (file, ...args) {
    if (file.startsWith(directory)) report.reads.push(path.relative(directory, file));
    return read.call(this, file, ...args);
  };
  try {
    await check("Markdown images: all 15 relative remote PNGs decode inside VS Code's native preview", async () => {
      // Establish that the registered file provider can read the same binary asset.
      assert.deepEqual(Buffer.from(await vscode.workspace.fs.readFile(resource.with({ path: path.join(directory, names[0]) }))), pixel);
      report.reads.length = 0;
      await vscode.commands.executeCommand("remoteAgentSessions.previewMarkdown", { uri: resource, context: files.current });
      previewUri = vscode.workspace.textDocuments.find(d => d.uri.path === target && d.uri.query.startsWith("tmuxdockPreview="))?.uri;
      assert.ok(previewUri);
      client = await browser();
      for (let i = 0; i < 100; i++) {
        try {
          const context = await client.findDocument(`(()=>{try{return JSON.parse(document.getElementById('vscode-markdown-preview-data')?.getAttribute('data-settings')||'{}').source===${JSON.stringify(previewUri.toString())};}catch{return false;}})()`, "native Markdown image preview");
          report.images = await client.evaluate(context, "Array.from(document.images, img => ({src:img.src,original:img.getAttribute('data-src'),complete:img.complete,width:img.naturalWidth,height:img.naturalHeight}))");
        } catch (error) { if (i === 99) throw error; }
        if (report.images.length === names.length && report.images.every(img => img.complete && img.width > 0)) break;
        await pause(100);
      }
      assert.equal(report.images.length, 15);
      assert.ok(report.images.every(img => img.complete && img.width > 0), JSON.stringify(report));
      assert.ok(report.images.every(img => new URL(img.src).hostname.startsWith("tmuxdock-remote+")), JSON.stringify(report));
      assert.equal(await fs.readFile(target, "utf8"), original, "Preview must leave the remote Markdown untouched");
    });
  } finally {
    const out = path.join(path.dirname(process.env.RAS_TEST_REPORT), "markdown-image-results.json");
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(report, null, 2));
    service.read = read;
    client?.close();
    if (previewUri) {
      const tabs = vscode.window.tabGroups.all.flatMap(g => g.tabs).filter(t => t.input?.uri?.toString() === previewUri.toString());
      if (tabs.length) await vscode.window.tabGroups.close(tabs, true);
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
};
