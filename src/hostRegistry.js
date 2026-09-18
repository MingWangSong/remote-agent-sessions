'use strict';

const crypto = require('node:crypto');
const { validateHost } = require('./ssh');

const STORAGE_KEY = 'remoteAgentSessions.hosts.v2';

function normalizeHost(input) {
  const sshHost = String(input.sshHost || '').trim();
  const host = {
    id: String(input.id || crypto.randomUUID()),
    label: String(input.label || sshHost).trim(),
    sshHost,
    tmuxPath: String(input.tmuxPath || 'tmux'),
    socketName: String(input.socketName || ''),
    defaultCwd: String(input.defaultCwd || '')
  };
  validateHost(host);
  return host;
}

class HostRegistry {
  constructor(memento) { this.memento = memento; }

  list() {
    const raw = this.memento.get(STORAGE_KEY, []);
    if (!Array.isArray(raw)) throw new Error('Saved SSH host registry is invalid');
    return raw.map(normalizeHost);
  }

  async add(input) {
    const host = normalizeHost(input);
    const hosts = this.list();
    const existing = hosts.find((candidate) => candidate.sshHost === host.sshHost && candidate.socketName === host.socketName);
    if (existing) return existing;
    hosts.push(host);
    await this.memento.update(STORAGE_KEY, hosts);
    return host;
  }

  async update(input) {
    const host = normalizeHost(input);
    const hosts = this.list();
    const index = hosts.findIndex((candidate) => candidate.id === host.id);
    if (index < 0) throw new Error('SSH host no longer exists');
    if (hosts.some((candidate, candidateIndex) => candidateIndex !== index && candidate.sshHost === host.sshHost && candidate.socketName === host.socketName)) {
      throw new Error('That SSH host and tmux socket are already configured');
    }
    hosts[index] = host;
    await this.memento.update(STORAGE_KEY, hosts);
    return host;
  }

  async remove(id) {
    const hosts = this.list();
    const next = hosts.filter((host) => host.id !== id);
    if (next.length === hosts.length) return false;
    await this.memento.update(STORAGE_KEY, next);
    return true;
  }
}

module.exports = { HostRegistry, STORAGE_KEY, normalizeHost };
