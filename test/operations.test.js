'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Operations } = require('../src/operations');

test('slow host does not block another host; duplicate clicks coalesce; same-host actions wait', async () => {
  const operations = new Operations();
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const events = [];
  const first = operations.run('slow', 'attach-1', async () => { events.push('first'); await gate; });
  const duplicate = operations.run('slow', 'attach-1', () => { throw new Error('must not run'); });
  assert.equal(duplicate, first);
  const second = operations.run('slow', 'attach-2', () => events.push('second'));
  await operations.run('fast', 'refresh', () => events.push('fast'));
  assert.deepEqual(events, ['first', 'fast']);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ['first', 'fast', 'second']);
  assert.equal(operations.isBusy('slow'), false);
});

test('a rejected action releases the queue for retries', async () => {
  const operations = new Operations();
  await assert.rejects(operations.run('host', 'fail', () => { throw new Error('offline'); }), /offline/);
  assert.equal(await operations.run('host', 'fail', () => 'retried'), 'retried');
});
