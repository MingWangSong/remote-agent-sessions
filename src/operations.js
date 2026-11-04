'use strict';

// Foreground actions serialize only within one host; repeated clicks share a task.
// Polling is deliberately not part of this queue.
class Operations {
  constructor() { this.hosts = new Map(); this.pending = new Map(); }
  isBusy(hostId) { return this.hosts.has(hostId); }
  run(hostId, key, handler, onStart = () => {}) {
    if (this.pending.has(key)) return this.pending.get(key);
    const previous = this.hosts.get(hostId);
    const task = Promise.resolve(previous).catch(() => {}).then(() => { onStart(); return handler(); });
    this.hosts.set(hostId, task);
    this.pending.set(key, task);
    const cleanup = () => {
      this.pending.delete(key);
      if (this.hosts.get(hostId) === task) this.hosts.delete(hostId);
    };
    task.then(cleanup, cleanup);
    return task;
  }
}
module.exports = { Operations };
