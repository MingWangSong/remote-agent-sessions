"use strict";
// Explicit file transfers reuse the installed OpenSSH client and SSH config.
// Transfers reuse OpenSSH; HTTP preview endpoints remain read-only.
const { spawn } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

function scp(ssh, source, destination, signal, launch = spawn) {
  signal?.throwIfAborted();
  const program = path.join(
    path.dirname(ssh.sshPath),
    process.platform === "win32" ? "scp.exe" : "scp",
  );
  return new Promise((resolve, reject) => {
    const child = launch(
      program,
      ["-B", "-S", ssh.sshPath, ...ssh.baseArgs(), "--", source, destination],
      { stdio: ["ignore", "ignore", "pipe"], signal },
    );
    let detail = "";
    child.stderr.on("data", (data) => {
      detail = (detail + data).slice(-2000);
    });
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(detail.trim() || "OpenSSH file transfer failed")),
    );
  });
}
function remote(ssh, file, glob = false) {
  if (!file.startsWith("/") || /[\0\r\n]/.test(file))
    throw new Error(
      "File transfer requires an absolute path without line breaks",
    );
  // scp's SFTP download source is a glob. Escape metacharacters for a literal file.
  return (
    ssh.host.sshHost +
    ":" +
    (glob ? file.replace(/[\\*?\[\]{}]/g, "\\$&") : file)
  );
}
async function upload(ssh, local, destination, signal, copy = scp) {
  remote(ssh, destination);
  const temporary = path.posix.join(
    path.posix.dirname(destination),
    ".tmuxdock-upload-" + randomUUID(),
  );
  let committed = false;
  try {
    await copy(ssh, local, remote(ssh, temporary), signal);
    signal?.throwIfAborted();
    await ssh.run("mv", ["-f", "--", temporary, destination]);
    committed = true;
  } finally {
    if (!committed)
      await ssh.run("rm", ["-f", "--", temporary]).catch(() => {});
  }
}
async function download(ssh, source, destination, signal, copy = scp) {
  const temporary = path.join(
    path.dirname(destination),
    ".tmuxdock-download-" + randomUUID(),
  );
  try {
    await copy(ssh, remote(ssh, source, true), temporary, signal);
    signal?.throwIfAborted();
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
module.exports = { upload, download, scp, remote };
