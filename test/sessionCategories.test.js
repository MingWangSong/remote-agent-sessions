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
  await groups.move('host', ['parent'], category.id);
  const old = saved;
  await groups.remove('host', category.id);
  saved = old; // Simulate a late whole-extension update from VS Code.
  const state = groups.get('host');
  assert.deepEqual(state.categories, []);
  const parent = { id: 'parent', record: { id: 'parent' } };
  const result = runningTree([parent], [parent.record], state);
  assert.deepEqual(result.children.get('category:'), [parent]);
  await groups.create('host', 'Next');
  const reopened = new SessionCategories(storage).get('host');
  assert.deepEqual(reopened.categories.map(group => group.name), ['Next']);
  assert.equal(reopened.membership.parent, undefined);
});
