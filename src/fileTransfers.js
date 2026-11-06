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
    let failure;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) =>
      failure
        ? reject(failure)
        : code === 0
          ? resolve()
          : reject(new Error(detail.trim() || "OpenSSH file transfer failed")),
    );
  });
}
function batchPath(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value))
    throw new Error("File transfer paths cannot contain control characters");
  // OpenSSH's quoted argument parser also makes glob characters literal.
  return '"' + value.replace(/[\\"]/g, "\\$&") + '"';
}
function put(ssh, source, destination, options = {}, launch = spawn) {
  options.signal?.throwIfAborted();
  remote(ssh, destination);
  const batch = `@put ${options.directory ? "-R " : ""}${batchPath(source)} ${batchPath(destination)}\n`;
  const program = path.join(
    path.dirname(ssh.sshPath),
    process.platform === "win32" ? "sftp.exe" : "sftp",
  );
  return new Promise((resolve, reject) => {
    const child = launch(
      program,
      ["-b", "-", "-S", ssh.sshPath, ...ssh.baseArgs(), "--", ssh.host.sshHost],
      { stdio: ["pipe", "ignore", "pipe"], signal: options.signal },
    );
    let detail = "",
      failure;
    child.stderr.on("data", (data) => {
      detail = (detail + data).slice(-2000);
    });
    child.stdin.on("error", (error) => {
      failure ||= error;
    });
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) =>
      failure
        ? reject(failure)
        : code === 0
          ? resolve()
          : reject(new Error(detail.trim() || "OpenSSH upload failed")),
    );
    child.stdin.end(batch);
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
module.exports = { upload, download, scp, remote, put, batchPath };
