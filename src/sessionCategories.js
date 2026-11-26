'use strict';

const { randomUUID } = require('node:crypto');
const { sessionKey, moveSessionKeys, sortSessionEntries } = require('./sessionOrder');
const KEY = 'remoteAgentSessions.sessionCategories.v1';

function categoryNameError(value) {
  return !value?.trim() || value.trim().length > 60 || /[\x00-\x1f\x7f]/.test(value)
    ? 'Enter a category name of 1–60 characters without control characters' : undefined;
}

class SessionCategories {
  constructor(storage) {
    this.storage = storage;
    this.pending = Promise.resolve();
    this.committed = new Map();
  }

  get(hostId) {
    const saved = this.storage.get(KEY, {})[hostId];
    const local = this.committed.get(hostId);
    // VS Code delivers whole-extension storage snapshots asynchronously.
    // Ignore an older snapshot arriving after a successful category edit.
    const latest = local && local.revision > (saved?.revision || 0) ? local : saved;
    return { categories: [], membership: {}, ...latest };
  }

  update(hostId, change) {
    const result = this.pending.then(async () => {
      const hosts = { ...this.storage.get(KEY, {}) };
      for (const id of this.committed.keys()) hosts[id] = this.get(id);
      const state = structuredClone(this.get(hostId));
      if (change(state) === false) return false;
      state.revision = Math.max(Date.now(), (state.revision || 0) + 1);
      await this.storage.update(KEY, { ...hosts, [hostId]: state });
      this.committed.set(hostId, state);
      return true;
    });
    this.pending = result.catch(() => {});
    return result;
  }

  name(state, input, id) {
    const error = categoryNameError(input);
    if (error) throw new Error(error);
    const name = input.trim();
    if (state.categories.some(category => category.id !== id && category.name.toLowerCase() === name.toLowerCase()))
      throw new Error('A category already has this name');
    return name;
  }

  create(hostId, input) {
    return this.update(hostId, state => state.categories.push({ id: randomUUID(), name: this.name(state, input) }));
  }

  rename(hostId, id, input) {
    return this.update(hostId, state => {
      const category = state.categories.find(item => item.id === id);
      if (category) category.name = this.name(state, input, id);
    });
  }

  remove(hostId, id) {
    return this.update(hostId, state => {
      state.categories = state.categories.filter(item => item.id !== id);
      for (const [key, category] of Object.entries(state.membership))
        if (category === id) delete state.membership[key];
    });
  }

  resetOrder(hostId) {
    return this.update(hostId, state => { state.order = []; });
  }

  reorderCategory(hostId, id, before) {
    return this.update(hostId, state => {
      const category = state.categories.find(item => item.id === id);
      const remaining = state.categories.filter(item => item.id !== id);
      const index = before === null ? remaining.length : remaining.findIndex(item => item.id === before);
      if (!category || index < 0) return false;
      remaining.splice(index, 0, category);
      state.categories = remaining;
    });
  }

  reorderSession(hostId, { keys, before, group, categoryId }, readGroup, legacyOrder) {
    return this.update(hostId, state => {
      const saved = state.order ?? legacyOrder;
      const latest = readGroup(group);
      const entries = sortSessionEntries(latest.entries, saved);
      const movable = new Set(entries.filter(item => !item.record?.forkParentId).map(sessionKey));
      if (keys.includes(before) || !keys.every(key => movable.has(key))) return false;
      if (group === 'running') {
        if (categoryId !== null && !state.categories.some(category => category.id === categoryId)) return false;
        const tree = runningTree(entries, latest.records, state);
        const anchor = entries.find(item => sessionKey(item) === before);
        const location = anchor && tree.locations.get(anchor.id);
        if (before !== null && (!location || location.parent || location.categoryId !== categoryId)) return false;
        // Membership and order change together, so a move can't land in the wrong group if saving fails.
        for (const key of keys) state.membership[key] = categoryId;
      }
      const next = moveSessionKeys(entries.map(sessionKey), saved, keys, before);
      if (!next) return false;
      state.order = next;
    });
  }
}

// A fork can never hide a live session when its parent stops, is forgotten,
// or belongs to a different status group. Break cycles in imported metadata.
function runningTree(entries, records, state) {
  const liveById = new Map(entries.map(entry => [entry.id, entry]));
  const recordsById = new Map(records.map(record => [record.id, record]));
  const categoryIds = new Set(state.categories.map(category => category.id));
  const children = new Map();
  const locations = new Map();
  for (const entry of entries) {
    let parent;
    let categoryId;
    let id = entry.id;
    const seen = new Set();
    while (id && !seen.has(id)) {
      seen.add(id);
      const record = id === entry.id ? entry.record : recordsById.get(id);
      const candidate = liveById.get(id);
      if (id !== entry.id && candidate && !parent) parent = candidate;
      const key = sessionKey(candidate || { id, record });
      const formerKey = candidate?.live && sessionKey({ live: candidate.live });
      if (categoryId === undefined) {
        if (Object.hasOwn(state.membership, key)) categoryId = state.membership[key];
        else if (formerKey && Object.hasOwn(state.membership, formerKey)) categoryId = state.membership[formerKey];
      }
      id = record?.forkParentId;
    }
    if (seen.has(id)) parent = undefined;
    const location = parent ? { parent } : { categoryId: categoryIds.has(categoryId) ? categoryId : null };
    locations.set(entry.id, location);
    const key = parent ? `parent:${parent.id}` : `category:${location.categoryId || ''}`;
    if (!children.has(key)) children.set(key, []);
    children.get(key).push(entry);
  }
  return { children, locations };
}

module.exports = { SessionCategories, categoryNameError, runningTree };
