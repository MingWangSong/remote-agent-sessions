"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { RemoteFiles, entryNameError } = require("../src/remoteFiles");
async function fixture(t, prefix = "") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tmuxdock-write-"));
  let launches = 0;
  const files = new RemoteFiles({
    openProcess: (exe, args) => {
      launches++;
      args = [...args];
      args[2] = prefix + args[2];
      return spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] });
    },
  });
  files.allow(root);
  t.after(async () => {
    files.dispose();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, files, launches: () => launches };
}
test("creation validates names and atomically rejects collisions, including concurrent creates", async (t) => {
  const f = await fixture(t);
  for (const name of [
    "",
    " ",
    ".",
    "..",
    "a/b",
    "a\\b",
    "a\nb",
    "x\0y",
    "x".repeat(256),
  ])
    assert.ok(entryNameError(name));
  assert.equal(entryNameError("报告 ' $(literal).md"), undefined);
  const folder = path.join(f.root, "文档 ' #");
  await f.files.create(folder, "directory");
  const file = path.join(folder, "报告 $(literal).md");
  const results = await Promise.allSettled([
    f.files.create(file, "file"),
    f.files.create(file, "file"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(
    results.find((r) => r.status === "rejected").reason.code,
    "FileExists",
  );
  assert.equal((await fs.stat(file)).size, 0);
  await assert.rejects(
    f.files.create(folder, "directory"),
    (e) => e.code === "FileExists",
  );
  assert.equal(f.launches(), 1, "creation must reuse the file channel");
});
test("atomic save preserves binary bytes and permissions and honors create/overwrite options", async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, "report.txt");
  const changes = [];
  f.files.on("change", (file, event) => changes.push(event.type));
  const bytes = Buffer.alloc(2 * 1024 * 1024 + 17);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await assert.rejects(
    f.files.write(file, bytes, { create: false, overwrite: true }),
    (e) => e.code === "NotFound",
  );
  await f.files.write(file, bytes, { create: true, overwrite: false });
  assert.deepEqual(await fs.readFile(file), bytes);
  await fs.chmod(file, 0o751);
  await assert.rejects(
    f.files.write(file, Buffer.from("unsafe"), {
      create: true,
      overwrite: false,
    }),
    (e) => e.code === "FileExists",
  );
  assert.deepEqual(await fs.readFile(file), bytes);
  await f.files.write(file, Buffer.from("saved 中文"), {
    create: false,
    overwrite: true,
  });
  assert.equal(await fs.readFile(file, "utf8"), "saved 中文");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o751);
  assert.deepEqual(changes, ["created", "changed"]);
  assert.deepEqual(await fs.readdir(f.root), ["report.txt"]);
  await assert.rejects(
    f.files.write(file, Buffer.alloc(16 * 1024 * 1024 + 1), {
      create: true,
      overwrite: true,
    }),
    /16 MiB/,
  );
});
test("file writes and directory creation reject symlinks, traversal, replaced roots and revoked roots", async (t) => {
  const f = await fixture(t),
    outside = path.join(f.root, "outside"),
    root = path.join(f.root, "root");
  await fs.mkdir(root);
  await fs.writeFile(outside, "original");
  f.files.setRoots([root]);
  await fs.symlink(outside, path.join(root, "link"));
  await fs.symlink(f.root, path.join(root, "directory-link"));
  await assert.rejects(
    f.files.write(path.join(root, "link"), Buffer.from("unsafe"), {
      create: true,
      overwrite: true,
    }),
  );
  await assert.rejects(
    f.files.create(path.join(root, "directory-link", "escape"), "file"),
  );
  await assert.rejects(
    f.files.channel.at(root, "create", { path: "../escape", kind: "file" }),
    /traversal/,
  );
  await assert.rejects(f.files.create(root, "file"), /root/);
  await assert.rejects(
    f.files.write(root, Buffer.from("unsafe"), {
      create: true,
      overwrite: true,
    }),
    /root/,
  );
  assert.equal(await fs.readFile(outside, "utf8"), "original");
  await fs.rename(root, root + "-old");
  await fs.mkdir(root);
  await assert.rejects(
    f.files.create(path.join(root, "new"), "file"),
    /root changed/,
  );
  f.files.setRoots([]);
  await assert.rejects(
    f.files.create(path.join(root, "new"), "directory", root),
    /no longer linked/,
  );
  assert.deepEqual(await fs.readdir(root), []);
});
test("native createDirectory semantics are recursive and idempotent without following child links", async (t) => {
  const f = await fixture(t);
  const folder = path.join(f.root, "nested", "child");
  await f.files.mkdir(folder);
  await f.files.mkdir(folder);
  assert.equal((await fs.stat(folder)).isDirectory(), true);
  await fs.writeFile(path.join(f.root, "file"), "keep");
  await assert.rejects(f.files.mkdir(path.join(f.root, "file", "child")));
  await fs.symlink(folder, path.join(f.root, "link"));
  await assert.rejects(f.files.mkdir(path.join(f.root, "link", "escape")));
});
test("a failed atomic commit preserves the original and removes its temporary file", async (t) => {
  const prefix =
    "import os\ndef fail_replace(*a, **kw): raise OSError('fixture commit failure')\nos.replace=fail_replace\n";
  const f = await fixture(t, prefix),
    file = path.join(f.root, "keep.txt");
  await fs.writeFile(file, "original");
  await assert.rejects(
    f.files.write(file, Buffer.from("incomplete"), {
      create: false,
      overwrite: true,
    }),
    /fixture commit failure/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "original");
  assert.deepEqual(await fs.readdir(f.root), ["keep.txt"]);
});
test("an Agent change during a save is preserved and reported instead of overwritten", async (t) => {
  const f = await fixture(t),
    file = path.join(f.root, "report.txt");
  f.files.channel.transport.openProcess = (exe, args) => {
    args = [...args];
    args[2] =
      "import os\noriginal_fsync=os.fsync\ndef change_during_save(fd):\n original_fsync(fd)\n with open(" +
      JSON.stringify(file) +
      ",'w') as f: f.write('new Agent contents')\nos.fsync=change_during_save\n" +
      args[2];
    return spawn(exe, args, { stdio: ["pipe", "pipe", "pipe"] });
  };
  await fs.writeFile(file, "original");
  await assert.rejects(
    f.files.write(file, Buffer.from("editor save"), {
      create: false,
      overwrite: true,
    }),
    /changed while saving/,
  );
  assert.equal(await fs.readFile(file, "utf8"), "new Agent contents");
  assert.deepEqual(await fs.readdir(f.root), ["report.txt"]);
});
