"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { spawn } = require("node:child_process");
const { pathToFileURL, fileURLToPath } = require("node:url");
const { RemoteFiles } = require("../src/remoteFiles");
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDakAAAAASUVORK5CYII=",
  "base64",
);

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tmuxdock-drop-"));
  const root = path.join(dir, "remote"), local = path.join(dir, "图片 #.png");
  await fs.mkdir(root);
  await fs.writeFile(local, image);
  const service = new RemoteFiles({
    openProcess: (exe, args) => spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] }),
  });
  service.allow(root);
  t.after(async () => {
    service.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const errors = [], listeners = new Set();
  const vscode = {
    Uri: {
      from: value => value,
      parse: value => ({ scheme: "file", fsPath: fileURLToPath(value) }),
    },
    ProgressLocation: { Notification: 15 },
    window: {
      showErrorMessage: message => errors.push(message),
      showWarningMessage: () => { throw Error("Unexpected overwrite or cleanup warning"); },
    },
  };
  const filename = require.resolve("../src/sessionFileActions");
  const module = { exports: {} };
  vm.runInThisContext("(function(require,module,exports){" + await fs.readFile(filename, "utf8") + "\n})", { filename })(
    name => name === "vscode" ? vscode : name.startsWith("./") ? require("../src/" + name.slice(2)) : require(name),
    module, module.exports,
  );
  const c = { root, controller: { host: { id: "fixture", label: "Fixture" } } };
  const workspace = {
    enabled: true, current: c, transferAborts: new Set(), cache: new Map(),
    treeEmitter: { fire() {} }, service: () => service,
    // Mirror the native progress cancellation controller without opening any UI.
    async transfer(_title, action) {
      const abort = new AbortController();
      workspace.transferAborts.add(abort);
      try { await action(abort.signal); return true; }
      catch (error) { if (!abort.signal.aborted) throw error; return false; }
      finally { workspace.transferAborts.delete(abort); }
    },
  };
  const actions = new module.exports.SessionFileActions(workspace);
  actions.putLocal = async (_controller, source, destination, { signal }) => {
    signal.throwIfAborted();
    await fs.cp(source, destination, { recursive: true });
  };
  const token = {
    isCancellationRequested: false,
    onCancellationRequested(fn) {
      listeners.add(fn);
      return { dispose: () => listeners.delete(fn) };
    },
  };
  return {
    root, local, c, workspace, actions, service, token, listeners, errors,
    cancel() {
      token.isCancellationRequested = true;
      for (const fn of listeners) fn();
    },
    drop(target, cancellation) {
      const transfer = new Map([["text/uri-list", {
        asString: async () => pathToFileURL(local).toString(), asFile: () => undefined,
      }]]);
      return actions.handleDrop(target, transfer, cancellation);
    },
  };
}

test("desktop image uploads tolerate serialized cancellation snapshots and missing events", async t => {
  const f = await fixture(t);
  // Tree DnD RPC may serialize the token as plain data instead of an Event.
  for (const [i, token] of [undefined, {}, { isCancellationRequested: false },
    { isCancellationRequested: false, onCancellationRequested: {} }].entries()) {
    const directory = i === 0 ? f.root : path.join(f.root, "nested-" + i);
    if (i) await fs.mkdir(directory);
    const target = i ? { context: f.c, type: "directory", uri: { path: directory } } : undefined;
    assert.equal(await f.drop(target, token), true, f.errors.join("\n"));
    assert.deepEqual(await fs.readFile(path.join(directory, path.basename(f.local))), image);
    assert.equal((await fs.readdir(directory)).some(name => name.startsWith(".tmuxdock-upload-")), false);
  }
  assert.deepEqual(f.errors, []);
  assert.equal(f.workspace.transferAborts.size, 0);
});

test("real drop cancellation aborts only its upload and removes partial staging", async t => {
  const f = await fixture(t);
  const unrelated = new AbortController();
  f.workspace.transferAborts.add(unrelated);
  f.actions.putLocal = async (_controller, _source, destination, { signal }) => {
    await fs.writeFile(destination, image.subarray(0, 20));
    assert.equal(f.listeners.size, 1);
    f.cancel();
    signal.throwIfAborted();
  };
  assert.equal(await f.drop(undefined, f.token), false);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.deepEqual(f.errors, []);
  assert.equal(unrelated.signal.aborted, false);
  assert.equal(f.listeners.size, 0);
  assert.equal(f.workspace.transferAborts.size, 1);
});

test("progress cancellation still stops uploads when the drop token has no Event", async t => {
  const f = await fixture(t);
  f.actions.putLocal = async (_controller, _source, destination, { signal }) => {
    await fs.writeFile(destination, image.subarray(0, 20));
    for (const abort of f.workspace.transferAborts) abort.abort();
    signal.throwIfAborted();
  };
  assert.equal(await f.drop(undefined, {}), false);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.workspace.transferAborts.size, 0);
});

test("cancellation during destination preflight cannot commit an upload", async t => {
  const f = await fixture(t);
  const stat = f.service.stat.bind(f.service);
  f.service.stat = async (...args) => {
    try { return await stat(...args); }
    finally { f.token.isCancellationRequested = true; }
  };
  f.actions.putLocal = async () => { throw Error("Cancelled upload reached file transfer"); };
  assert.equal(await f.drop(undefined, f.token), false);
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.deepEqual(f.errors, []);
  assert.equal(f.listeners.size, 0);
});
