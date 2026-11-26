'use strict';

const STORAGE_KEY = 'remoteAgentSessions.sessionOrder.v1';
function sessionKey(entry) {
  return entry.record?.id || (entry.live?.id
    ? `live:${entry.live.id}:${entry.live.created || ''}` : entry.id);
}
function creationTime(entry) {
  return entry.record?.createdAt || entry.live?.created || '';
}
function byCreation(a, b) {
  return creationTime(a).localeCompare(creationTime(b)) || sessionKey(a).localeCompare(sessionKey(b));
}

function sortSessionEntries(entries, saved) {
  const ranks = new Map(saved.map((key, index) => [key, index]));
  return [...entries].sort((a, b) =>
    (ranks.get(sessionKey(a)) ?? Infinity) - (ranks.get(sessionKey(b)) ?? Infinity) || byCreation(a, b));
}

function moveSessionKeys(ordered, saved, movingKeys, beforeKey) {
  const selected = new Set(movingKeys);
  const moving = ordered.filter(key => selected.has(key));
  if (!moving.length || selected.has(beforeKey)) return;
  const remaining = ordered.filter(key => !selected.has(key));
  const index = beforeKey == null ? remaining.length : remaining.indexOf(beforeKey);
  if (index < 0) return;
  remaining.splice(index, 0, ...moving);
  // Retain temporarily unavailable sessions' positions in the stored sequence.
  const visible = new Set(ordered);
  let next = 0;
  const result = saved.map(key => visible.has(key) ? remaining[next++] : key);
  return [...result, ...remaining.slice(next)];
}

class SessionOrder {
  constructor(storage) { this.storage = storage; }
  saved(hostId) { return this.storage.get(STORAGE_KEY, {})[hostId] || []; }
  sort(hostId, entries, saved = this.saved(hostId)) {
    return sortSessionEntries(entries, saved);
  }
  async move(hostId, entries, movingKeys, beforeKey) {
    const ordered = this.sort(hostId, entries).map(sessionKey);
    const result = moveSessionKeys(ordered, this.saved(hostId), movingKeys, beforeKey);
    if (!result) return;
    await this.storage.update(STORAGE_KEY, { ...this.storage.get(STORAGE_KEY, {}), [hostId]: result });
  }
  async reset(hostId) {
    const orders = { ...this.storage.get(STORAGE_KEY, {}) };
    delete orders[hostId];
    await this.storage.update(STORAGE_KEY, orders);
  }
}
module.exports = { SessionOrder, sessionKey, byCreation, moveSessionKeys, sortSessionEntries };
