"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { upload, download, scp, remote } = require("../src/fileTransfers");
const { SshClient } = require("../src/ssh");
const ssh = () =>
  new SshClient({
    id: "fixture",
    label: "Fixture host",
    sshHost: "fixture-alias",
  });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "tmuxdock-transfer-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
test("upload stages the complete file before replacing the destination and cleans failed transfers", async () => {
  const client = ssh(),
    calls = [];
  client.run = async (command, args) => calls.push([command, args]);
  await upload(
    client,
    "/local/report.txt",
    "/remote/report.txt",
    undefined,
    async (_ssh, local, target) => {
      assert.equal(local, "/local/report.txt");
      assert.match(
        target,
        /^fixture-alias:\/remote\/\.tmuxdock-upload-[a-f0-9-]+$/,
      );
      assert.equal(calls.length, 0);
    },
  );
  assert.equal(calls[0][0], "mv");
  assert.equal(calls[0][1].at(-1), "/remote/report.txt");
  calls.length = 0;
  await assert.rejects(
    upload(client, "/local/x", "/remote/x", undefined, async () => {
      throw Error("Transfer failed");
    }),
    /Transfer failed/,
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["rm"],
  );
  assert.match(calls[0][1].at(-1), /^\/remote\/\.tmuxdock-upload-[a-f0-9-]+$/);
  const abort = new AbortController();
  calls.length = 0;
  await assert.rejects(
    upload(client, "/local/x", "/remote/x", abort.signal, async () =>
      abort.abort(),
    ),
    /abort/i,
  );
  assert.deepEqual(
    calls.map((c) => c[0]),
    ["rm"],
  );
});
test("download preserves an existing local file after failure and atomically commits successful binary data", async (t) => {
  const dir = await fixture(t),
    target = path.join(dir, "report.txt"),
    client = ssh();
  await fs.writeFile(target, "original");
  await assert.rejects(
    download(
      client,
      "/remote/report.txt",
      target,
      undefined,
      async (_s, _r, temporary) => {
        await fs.writeFile(temporary, "incomplete");
        throw Error("Offline");
      },
    ),
    /Offline/,
  );
  assert.equal(await fs.readFile(target, "utf8"), "original");
  assert.deepEqual(await fs.readdir(dir), ["report.txt"]);
  const bytes = Buffer.from([0, 255, 128, 1]);
  await download(
    client,
    "/remote/report.txt",
    target,
    undefined,
    async (_s, _r, temporary) => fs.writeFile(temporary, bytes),
  );
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.deepEqual(await fs.readdir(dir), ["report.txt"]);
});
test("OpenSSH transfer reuses connection options, keeps paths out of a shell and cancels its owned child", async () => {
  const client = ssh(),
    abort = new AbortController();
  let argumentsSeen;
  const promise = scp(
    client,
    "/local/a ' $(echo unsafe)",
    "fixture-alias:/remote/file",
    abort.signal,
    (program, args, options) => {
      assert.equal(program, "scp");
      argumentsSeen = args;
      return spawn(
        process.execPath,
        ["-e", "setInterval(()=>{},1000)"],
        options,
      );
    },
  );
  abort.abort();
  await assert.rejects(promise, /abort/i);
  assert.ok(
    argumentsSeen.includes("ControlMaster=auto") ||
      process.platform === "win32",
  );
  assert.equal(argumentsSeen.at(-2), "/local/a ' $(echo unsafe)");
  assert.equal(argumentsSeen.includes("-O"), false);
  assert.equal(
    remote(client, "/remote/[a]*?.md", true),
    "fixture-alias:/remote/\\[a\\]\\*\\?.md",
  );
  assert.throws(() => remote(client, "/remote/a\nput unsafe"), /line breaks/);
});
test(
  "SFTP recursively uploads literal paths, empty folders and binary files without following links",
  { skip: process.platform === "win32" },
  async (t) => {
    const server = [
      "/usr/libexec/sftp-server",
      "/usr/lib/openssh/sftp-server",
    ].find((file) => require("node:fs").existsSync(file));
    if (!server) return t.skip("Local OpenSSH SFTP server is not installed");
    const dir = await fixture(t),
      source = path.join(dir, '文档 [a]*? \\ " #'),
      target = path.join(dir, 'uploaded [x]*? \\ " #');
    await fs.mkdir(path.join(source, "empty"), { recursive: true });
    await fs.writeFile(
      path.join(source, "binary.dat"),
      Buffer.from([0, 255, 128, 1]),
    );
    await fs.writeFile(path.join(dir, "private"), "must not upload");
    await fs.symlink(path.join(dir, "private"), path.join(source, "link"));
    const { put, batchPath } = require("../src/fileTransfers");
    const launch = (_program, args, options) => {
      assert.ok(args.includes("-b"));
      assert.ok(args.includes("ControlMaster=auto"));
      return spawn("sftp", ["-D", server, "-b", "-", "fixture"], options);
    };
    await put(ssh(), source, target, { directory: true }, launch);
    assert.ok((await fs.stat(path.join(target, "empty"))).isDirectory());
    assert.deepEqual(
      await fs.readFile(path.join(target, "binary.dat")),
      Buffer.from([0, 255, 128, 1]),
    );
    await assert.rejects(fs.stat(path.join(target, "link")), {
      code: "ENOENT",
    });
    const fileTarget = path.join(dir, 'one [x]*? \\ " #.dat');
    await put(ssh(), path.join(source, "binary.dat"), fileTarget, {}, launch);
    assert.deepEqual(
      await fs.readFile(fileTarget),
      Buffer.from([0, 255, 128, 1]),
    );
    assert.throws(() => batchPath("file\n!touch /tmp/unsafe"), /control/);
  },
);
