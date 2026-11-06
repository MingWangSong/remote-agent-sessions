"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict");
const fs = require("node:fs"),
  os = require("node:os"),
  path = require("node:path");
const { SessionFileRoots } = require("../src/sessionFileRoots");
const storage = () => ({
  data: new Map(),
  get(key, fallback) {
    return this.data.get(key) ?? fallback;
  },
  async update(key, value) {
    this.data.set(key, value);
  },
});
const controller = () => ({
  host: { id: "one", sshHost: "alias" },
  manager: { records: [], entries: [] },
});
test("legacy file roots freeze the original cwd without enabling recovery and managed explicit links take priority", async () => {
  const state = storage(),
    c = controller(),
    roots = new SessionFileRoots(state);
  const record = { id: "legacy", cwd: "/work/old" };
  c.manager.records.push(record);
  assert.equal(roots.context(c, { id: record.id, record }).root, "/work/old");
  await roots.pending;
  record.cwd = "/work/changed";
  assert.equal(roots.context(c, { id: record.id, record }).root, "/work/old");
  record.workspaceRoot = "/explicit";
  assert.equal(roots.find(c, record.id).root, "/explicit");
  c.manager.records = [];
  assert.equal(roots.find(c, record.id), undefined);
});
test("unmanaged links persist without adopting tmux, and replacement sessions and changed hosts do not inherit roots", async () => {
  const state = storage(),
    c = controller(),
    roots = new SessionFileRoots(state);
  const entry = {
    id: "tmux:$1:123",
    title: "agent",
    live: {
      snapshotWindows: [
        { active: true, panes: [{ active: true, cwd: "/agent/work" }] },
      ],
    },
  };
  c.manager.entries.push(entry);
  assert.equal(roots.context(c, entry).root, "/agent/work");
  await roots.pending;
  assert.equal(c.manager.records.length, 0);
  c.manager.entries = [];
  const restored = new SessionFileRoots(state);
  assert.equal(restored.find(c, entry.id).root, "/agent/work");
  assert.equal(restored.find(c, "tmux:$1:124"), undefined);
  c.host.tmuxPath = "/custom/tmux";
  assert.equal(restored.find(c, entry.id), undefined);
});
test("batch seed links are loaded with the same host fingerprint; workspace overrides win", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tmuxdock-root-seed-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "roots.json"),
    c = controller(),
    state = storage();
  const host = JSON.stringify(["one", "alias", "tmux", ""]),
    id = "tmux:$2:234";
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        key: JSON.stringify([host, id]),
        host,
        sessionId: id,
        title: "old",
        managed: false,
        root: "/batch",
      },
    ]),
  );
  const roots = new SessionFileRoots(state, file);
  assert.equal(roots.find(c, id).root, "/batch");
  await roots.save(c, { id, title: "old" }, "/chosen");
  assert.equal(new SessionFileRoots(state, file).find(c, id).root, "/chosen");
});
