'use strict';

const { randomUUID } = require('node:crypto');
const { sessionKey } = require('./sessionOrder');
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
    return { categories: [], membership: {}, parents: {}, ...latest };
  }

  update(hostId, change) {
    const result = this.pending.then(async () => {
      const hosts = { ...this.storage.get(KEY, {}) };
      for (const id of this.committed.keys()) hosts[id] = this.get(id);
      const state = structuredClone(this.get(hostId));
      change(state);
      state.revision = Math.max(Date.now(), (state.revision || 0) + 1);
      await this.storage.update(KEY, { ...hosts, [hostId]: state });
      this.committed.set(hostId, state);
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

  move(hostId, keys, categoryId, parentKey) {
    return this.update(hostId, state => {
      if (categoryId && !state.categories.some(category => category.id === categoryId)) return;
      for (const key of keys) {
        state.membership[key] = categoryId || null;
        if (parentKey) state.parents[key] = parentKey;
        else delete state.parents[key];
      }
    });
  }
}

// A fork can never hide a live session when its parent stops, is forgotten,
// or belongs to a different status group. Break cycles in imported metadata.
function runningTree(entries, records, state) {
  const liveById = new Map(entries.map(entry => [entry.id, entry]));
  const liveByKey = new Map(entries.flatMap(entry => [[sessionKey(entry), entry],
    ...(entry.live ? [[sessionKey({ live: entry.live }), entry]] : [])]));
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
      const manual = state.parents[key] || state.parents[formerKey];
      id = record?.forkParentId || liveByKey.get(manual)?.id ||
        (recordsById.has(manual) ? manual : undefined);
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
