'use strict';

const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const execFileAsync = promisify(execFile);

function shellQuote(value) {
  const text = String(value);
  if (/\0|\r|\n/.test(text)) throw new Error('Remote command arguments cannot contain line breaks or NUL bytes');
  return `'${text.replace(/'/g, `'"'"'`)}'`;
}

function validateHost(host) {
  if (!host || typeof host !== 'object') throw new Error('SSH host configuration is required');
  for (const key of ['id', 'label', 'sshHost']) {
    if (typeof host[key] !== 'string' || !host[key].trim() || /[\0\r\n]/.test(host[key])) {
      throw new Error(`Invalid SSH host ${key}`);
    }
  }
  if (host.sshHost.startsWith('-') || /\s/.test(host.sshHost)) {
    throw new Error('SSH host must be an alias or user@host without spaces and cannot start with a dash');
  }
  for (const key of ['tmuxPath', 'defaultCwd']) {
    if (host[key] != null && (typeof host[key] !== 'string' || /[\0\r\n]/.test(host[key]))) {
      throw new Error(`Invalid SSH host ${key}`);
    }
  }
  if (host.socketName && !/^[A-Za-z0-9_.-]+$/.test(host.socketName)) {
    throw new Error('tmux socket name may contain only letters, digits, dot, underscore and dash');
  }
  return host;
}

function remoteCommand(executable, args = []) {
  if (typeof executable !== 'string' || !executable || executable.startsWith('-') || /[\0\r\n]/.test(executable)) {
    throw new Error('Invalid remote executable');
  }
  return ['env', 'LC_MESSAGES=C', executable, ...args].map(shellQuote).join(' ');
}

class SshClient {
  constructor(host, options = {}) {
    this.host = validateHost(host);
    this.sshPath = options.sshPath || 'ssh';
    this.runner = options.runner || execFileAsync;
    this.connectTimeout = options.connectTimeout || 10;
    this.multiplex = options.multiplex !== false && process.platform !== 'win32';
    if (this.multiplex) {
      // Unix-domain socket paths are commonly limited to about 104 bytes on macOS.
      // %C is OpenSSH's connection hash; the uid prevents cross-user collisions in /tmp.
      this.controlPath = options.controlPath || path.join('/tmp', `ras-${typeof process.getuid === 'function' ? process.getuid() : 'user'}-%C`);
    }
  }

  baseArgs({ interactive = false } = {}) {
    const args = [
      '-o', `ConnectTimeout=${this.connectTimeout}`,
      '-o', 'ServerAliveInterval=15',
      '-o', 'ServerAliveCountMax=2'
    ];
    if (this.multiplex) {
      args.push('-o', 'ControlMaster=auto', '-o', 'ControlPersist=120', '-o', `ControlPath=${this.controlPath}`);
    }
    if (!interactive) args.push('-o', 'BatchMode=yes');
    return args;
  }

  async run(executable, args = [], options = {}) {
    const command = remoteCommand(executable, args);
    try {
      return await this.runner(this.sshPath, [...this.baseArgs(), this.host.sshHost, command], {
        encoding: options.encoding || 'utf8',
        timeout: options.timeout || 20000,
        maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
        env: process.env
      });
    } catch (error) {
      const detail = String(error.stderr || error.message || '').trim();
      throw new Error(`SSH ${this.host.label} failed: ${detail || 'connection failed'}`, { cause: error });
    }
  }

  terminalArgs(executable, args = []) {
    return [...this.baseArgs({ interactive: true }), '-tt', this.host.sshHost, remoteCommand(executable, args)];
  }

  openProcess(executable, args = []) {
    return spawn(this.sshPath, [...this.baseArgs(), this.host.sshHost, remoteCommand(executable, args)], {
      stdio: ['pipe', 'pipe', 'pipe'], env: process.env
    });
  }

  async homeDirectory() {
    const result = await this.run('pwd');
    const value = String(result.stdout || '').trim();
    if (!value.startsWith('/')) throw new Error(`SSH ${this.host.label} returned an invalid home directory`);
    return value;
  }

  async checkDirectory(directory) {
    if (typeof directory !== 'string' || !directory.startsWith('/') || /[\0\r\n]/.test(directory)) {
      throw new Error('Remote working directory must be an absolute path');
    }
    try {
      await this.run('test', ['-d', directory]);
    } catch {
      throw new Error(`Working directory does not exist on ${this.host.label}: ${directory}`);
    }
  }

  async listDirectories(directory) {
    if (typeof directory !== 'string' || !directory.startsWith('/') || /[\0\r\n]/.test(directory)) {
      throw new Error('Remote working directory must be an absolute path');
    }
    const result = await this.run('find', [directory, '-mindepth', '1', '-maxdepth', '1', '-type', 'd', '-print0']);
    return String(result.stdout || '').split('\0').filter(Boolean).sort((a, b) => a.localeCompare(b));
  }

  async readText(filePath) {
    if (typeof filePath !== 'string' || !filePath.startsWith('/') || /[\0\r\n]/.test(filePath)) {
      throw new Error('Remote file path must be absolute');
    }
    const result = await this.run('cat', ['--', filePath]);
    return String(result.stdout || '');
  }
}

module.exports = { SshClient, remoteCommand, shellQuote, validateHost };
