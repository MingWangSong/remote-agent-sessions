'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionCategories, runningTree } = require('../src/sessionCategories');

test('late storage snapshots cannot bring back a removed category or hide its session', async () => {
  let saved;
  const storage = {
    get: (_key, fallback) => saved ?? fallback,
    update: async (_key, value) => { saved = structuredClone(value); }
  };
  const groups = new SessionCategories(storage);
  await groups.create('host', 'Reports');
  const category = groups.get('host').categories[0];
  const parent = { id: 'parent', record: { id: 'parent' } };
  await groups.reorderSession('host', { keys: ['parent'], before: null, group: 'running', categoryId: category.id },
    () => ({ entries: [parent], records: [parent.record] }), []);
  const old = saved;
  await groups.remove('host', category.id);
  saved = old; // Simulate a late whole-extension update from VS Code.
  const state = groups.get('host');
  assert.deepEqual(state.categories, []);
  const result = runningTree([parent], [parent.record], state);
  assert.deepEqual(result.children.get('category:'), [parent]);
  await groups.create('host', 'Next');
  const reopened = new SessionCategories(storage).get('host');
  assert.deepEqual(reopened.categories.map(group => group.name), ['Next']);
  assert.equal(reopened.membership.parent, undefined);
});

test('category order persists and old manual nesting is flattened while Fork lineage is retained', async () => {
  let saved;
  const storage = {
    get: (_key, fallback) => saved ?? fallback,
    update: async (_key, value) => { saved = structuredClone(value); }
  };
  const groups = new SessionCategories(storage);
  await groups.create('host', 'Reports');
  await groups.create('host', 'Sandbox');
  const [reports, sandbox] = groups.get('host').categories;
  await groups.reorderCategory('host', sandbox.id, reports.id);
  const parent = { id: 'parent', record: { id: 'parent' } };
  const oldNested = { id: 'old', record: { id: 'old' } };
  const fork = { id: 'fork', record: { id: 'fork', forkParentId: 'parent' } };
  const entries = [parent, oldNested, fork];
  await groups.update('host', state => {
    state.parents = { old: 'parent' };
    state.membership = { parent: reports.id, old: reports.id };
  });
  const state = new SessionCategories(storage).get('host');
  assert.deepEqual(state.categories.map(category => category.name), ['Sandbox', 'Reports']);
  const tree = runningTree(entries, entries.map(entry => entry.record), state);
  assert.deepEqual(tree.children.get('category:' + reports.id), [parent, oldNested]);
  assert.deepEqual(tree.children.get('parent:parent'), [fork]);
  const records = entries.map(entry => entry.record);
  await groups.reorderSession('host', { keys: ['parent', 'old'], before: null, group: 'running', categoryId: sandbox.id },
    () => ({ entries, records }), ['parent', 'old', 'fork']);
  const moved = new SessionCategories(storage).get('host');
  assert.deepEqual(moved.order, ['fork', 'parent', 'old']);
  assert.deepEqual(runningTree(entries, records, moved).children.get('category:' + sandbox.id), [parent, oldNested]);
});
