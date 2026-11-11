"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { setImmediate: tick } = require("node:timers/promises");
const { MAX_FILE } = require("../src/remoteFiles");

function fixture() {
  const logs = { checks: [], reads: [], opens: [], warnings: [], errors: [], progress: [], downloads: [] };
  const group = { viewColumn: 1, activeTab: {}, tabs: [] };
  const listeners = new Set();
  const resource = (name) => ({ authority: "host", path: "/work/" + name, toString() { return "tmuxdock-remote://host" + this.path; } });
  const item = (name = "report.txt") => ({ uri: resource(name), type: "file", name, context: { root: "/work", controller: { host: { label: "Demo" } } } });
  let workspace;
  const files = {
    roots: new Set(["/work"]), rootFor: () => "/work",
    async stat(file) { logs.checks.push(file); return { type: "file", size: 3 * 1024 * 1024, signature: "one" }; },
    async readSnapshot(file, _limit, options) {
      logs.reads.push(file);
      options.onProgress({ loaded: 3 * 1024 * 1024, total: 3 * 1024 * 1024, attempt: 0 });
      return { data: Buffer.from(file), stat: { type: "file", size: file.length, signature: "one" } };
    },
    async read() { throw Error("Native open downloaded the same file twice"); },
  };
  const vscode = {
    FileType: { File: 1, Directory: 2, SymbolicLink: 64 },
    ProgressLocation: { Notification: 15 }, ViewColumn: { Active: -1 },
    TabInputCustom: class {},
    FileSystemError: { Unavailable: message => new Error(message) },
    workspace: { textDocuments: [] },
    window: {
      tabGroups: { activeTabGroup: group, all: [group] },
      withProgress(options, task) {
        logs.progress.push(options);
        return task({ report: update => logs.progress.push(update) }, {
          isCancellationRequested: false,
          onCancellationRequested(callback) { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; },
        });
      },
      async showWarningMessage(message, ...actions) { logs.warnings.push({ message, actions }); return logs.warningAnswer; },
      async showErrorMessage(message, ...actions) { logs.errors.push({ message, actions }); return logs.errorAnswers?.shift(); },
    },
    commands: {
      async executeCommand(command, uri, options) {
        if (command !== "vscode.open") return;
        logs.opens.push({ uri, options });
        const existing = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
        if (!existing) {
          const provider = workspace.fileProvider();
          await provider.stat(uri);
          const data = await provider.readFile(uri);
          vscode.workspace.textDocuments.push({ uri, data });
        }
        if (!options.preserveFocus) group.activeTab = { uri };
      },
    },
  };
  const module = { exports: {} };
  const filename = require.resolve("../src/sessionWorkspace");
  vm.runInThisContext("(function(require,module,exports){" + fs.readFileSync(filename, "utf8") + "\n})", { filename })(
    name => name === "vscode" ? vscode :
      name === "./remoteFiles" ? require("../src/remoteFiles") :
      name.startsWith("./") ? {} : require(name), module, module.exports,
  );
  workspace = Object.assign(Object.create(module.exports.SessionWorkspace.prototype), {
    ready: Promise.resolve(), enabled: true, openingFiles: new Map(), preparedFiles: new Map(), openSequence: 0,
    fileEmitter: { event() {} }, fromUri() {}, access: () => files,
    downloadFile: async selected => logs.downloads.push(selected),
  });
  return { workspace, files, vscode, group, item, logs, cancel: () => { for (const fn of listeners) fn(); }, listeners };
}

test("file opening: >2 MiB opens directly; duplicate clicks share one progress/read/native open", async () => {
  const f = fixture(), item = f.item();
  const first = f.workspace.openFile(item);
  assert.equal(f.workspace.openFile(item), first);
  await first;
  assert.equal(f.logs.warnings.length, 0);
  assert.equal(f.logs.checks.length, 1);
  assert.equal(f.logs.reads.length, 1);
  assert.equal(f.logs.opens.length, 1);
  assert.equal(f.logs.progress.filter(update => update.cancellable).length, 1);
  assert.ok(f.logs.progress.some(update => /Reading .*MiB/.test(update.message)));
  assert.equal(f.workspace.openingFiles.size, 0);
  assert.equal(f.workspace.preparedFiles.size, 0);
  assert.equal(f.listeners.size, 0);
});

test("file opening: delayed native image reads consume a bounded handoff even with a version query", async () => {
  const f = fixture(), item = f.item("image.png");
  // A custom editor can finish opening its tab before requesting its bytes.
  f.vscode.commands.executeCommand = async () => {};
  await f.workspace.openFile(item);
  assert.equal(f.workspace.openingFiles.size, 0);
  assert.equal(f.workspace.preparedFiles.size, 1);
  const alias = { ...item.uri, toString: () => item.uri.toString() + "?version=123" };
  const provider = f.workspace.fileProvider();
  await provider.stat(alias);
  assert.equal((await provider.readFile(alias)).toString(), item.uri.path);
  assert.equal(f.logs.reads.length, 1);
  assert.equal(f.workspace.preparedFiles.size, 0);
  for (let i = 0; i < 5; i++) await f.workspace.openFile(f.item(`image-${i}.png`));
  assert.equal(f.workspace.preparedFiles.size, 4);
  assert.equal(f.workspace.openingSnapshot(f.item("image-0.png").uri, f.files), undefined);
  // A revoked root cannot consume prepared content.
  f.files.roots.clear();
  assert.equal(f.workspace.openingSnapshot(f.item("image-4.png").uri, f.files, true), undefined);
  for (const key of f.workspace.preparedFiles.keys()) f.workspace.clearPreparedFile(key);
});

test("file opening: oversize preflight offers Download before any content transfer or editor", async () => {
  const f = fixture();
  f.files.stat = async () => ({ size: MAX_FILE + 1 });
  f.logs.warningAnswer = "Download";
  await f.workspace.openFile(f.item());
  assert.equal(f.logs.reads.length, 0);
  assert.equal(f.logs.opens.length, 0);
  assert.match(f.logs.warnings[0].message, /16\.01 MiB.*up to 16 MiB/);
  assert.deepEqual(f.logs.warnings[0].actions, ["Download"]);
  assert.equal(f.logs.downloads.length, 1);
  assert.equal(f.workspace.openingFiles.size, 0);
});

test("file opening: cancellation releases the task without an editor or error, and retry is fresh", async () => {
  const f = fixture(), read = f.files.readSnapshot;
  f.files.readSnapshot = (_file, _limit, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(Object.assign(Error("cancelled"), { name: "AbortError" })), { once: true });
  });
  const pending = f.workspace.openFile(f.item());
  await tick();
  f.cancel();
  await pending;
  assert.equal(f.logs.opens.length, 0);
  assert.equal(f.logs.errors.length, 0);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.workspace.openingFiles.size, 0);
  f.files.readSnapshot = read;
  await f.workspace.openFile(f.item());
  assert.equal(f.logs.opens.length, 1);
});

test("file opening: already loaded dirty documents focus immediately without SSH", async () => {
  const f = fixture(), item = f.item();
  const doc = { uri: item.uri, isDirty: true, data: Buffer.from("unsaved edits") };
  f.vscode.workspace.textDocuments.push(doc);
  await f.workspace.openFile(item);
  assert.equal(f.logs.checks.length, 0);
  assert.equal(f.logs.reads.length, 0);
  assert.equal(f.logs.progress.length, 0);
  assert.equal(doc.data.toString(), "unsaved edits");
});

test("file opening: slow earlier reads retain their group and cannot replace a newer preview", async () => {
  const f = fixture(), read = f.files.readSnapshot;
  let release;
  f.files.readSnapshot = async (...args) => {
    if (args[0].endsWith("slow.txt")) await new Promise(resolve => { release = resolve; });
    return read(...args);
  };
  const slow = f.workspace.openFile(f.item("slow.txt"));
  await tick();
  await f.workspace.openFile(f.item("newer.txt"));
  release();
  await slow;
  assert.equal(f.logs.opens[0].uri.path, "/work/newer.txt");
  assert.equal(f.logs.opens[1].options.preserveFocus, true);
  assert.equal(f.logs.opens[1].options.preview, false);
  assert.equal(f.logs.opens[1].options.viewColumn, 1);
  assert.equal(f.group.activeTab.uri.path, "/work/newer.txt");
  assert.equal(f.vscode.window.tabGroups.all.length, 1);
});

test("file opening: connection failures offer working Retry; missing and denied files get specific guidance", async () => {
  const f = fixture(), read = f.files.readSnapshot;
  let attempts = 0;
  f.files.readSnapshot = async (...args) => {
    if (++attempts === 1) throw Error("Remote files disconnected");
    return read(...args);
  };
  f.logs.errorAnswers = ["Retry"];
  await f.workspace.openFile(f.item());
  assert.equal(f.logs.opens.length, 1);
  assert.match(f.logs.errors[0].message, /Connection interrupted/);
  assert.deepEqual(f.logs.errors[0].actions, ["Retry"]);
  f.files.stat = async () => { throw Object.assign(Error("missing"), { code: "NotFound" }); };
  await f.workspace.openFile(f.item("missing.txt"));
  assert.match(f.logs.errors[1].message, /no longer exists/);
  assert.deepEqual(f.logs.errors[1].actions, ["Refresh Files"]);
  f.files.stat = async () => { throw Object.assign(Error("Permission denied"), { code: "NoPermissions" }); };
  await f.workspace.openFile(f.item("denied.txt"));
  assert.match(f.logs.errors[2].message, /Check remote permissions/);
  assert.equal(f.logs.opens.length, 1);
});

test("file opening: a silent transfer timeout offers Retry and Download without misclassifying a progressing read", async () => {
  const f = fixture();
  f.files.readSnapshot = async () => { throw Object.assign(Error("Remote file request timed out"), { code: "RemoteFileTimeout" }); };
  f.logs.errorAnswers = ["Download"];
  await f.workspace.openFile(f.item("report.pdf"));
  assert.match(f.logs.errors[0].message, /Reading report\.pdf timed out/);
  assert.deepEqual(f.logs.errors[0].actions, ["Retry", "Download"]);
  assert.equal(f.logs.downloads.length, 1);
  assert.equal(f.logs.opens.length, 0);
  assert.equal(f.workspace.openingFiles.size, 0);
});
