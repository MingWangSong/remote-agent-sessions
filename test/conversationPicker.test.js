'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chooseCodexConversation, conversationItems } = require('../src/conversationPicker');
const id = '550e8400-e29b-41d4-a716-446655440000';
const other = '550e8400-e29b-41d4-a716-446655440001';
const record = { title: 'Legacy', cwd: '/project', agent: { type: 'codex' } };
const conversation = { id, name: 'Legacy history', cwd: '/project', preview: 'Original task', updatedAt: 1730831111, archived: false };
const tick = () => new Promise(resolve => setImmediate(resolve));
function uiFixture() {
  const accept = new Set(), hide = new Set();
  const picker = { items: [], activeItems: [], selectedItems: [], value: '',
    onDidAccept: fn => { accept.add(fn); return { dispose: () => accept.delete(fn) }; },
    onDidHide: fn => { hide.add(fn); return { dispose: () => hide.delete(fn) }; },
    show() { this.shown = true; }, hide() { for (const fn of hide) fn(); }, dispose() { this.disposed = true; } };
  const ui = { createQuickPick: () => picker, showInputBox: async () => { throw new Error('Manual UUID must be an explicit choice'); } };
  return { ui, picker, cancel: () => picker.hide(), accept: predicate => {
    const item = typeof predicate === 'function' ? picker.items.find(predicate) : predicate; assert.ok(item, 'requested picker action exists');
    picker.selectedItems = [item]; for (const fn of accept) fn(); picker.selectedItems = [];
  } };
}

test('even one matching historical conversation requires explicit selection; cancel does not link anything', async () => {
  const f = uiFixture(); let resolved = false;
  const promise = chooseCodexConversation(f.ui, { listCodexConversations: async () => ({ conversations: [conversation], nextCursor: null }) }, record, 'Host')
    .then(value => { resolved = true; return value; });
  await tick(); assert.equal(f.picker.shown, true); assert.equal(resolved, false);
  assert.ok(f.picker.items[0].detail.includes(id));
  f.cancel(); assert.equal(await promise, undefined); assert.equal(f.picker.disposed, true);
});

test('historical list can expand directories, switch archives and load older pages without losing the search', async () => {
  const f = uiFixture(); const calls = [];
  const agents = { listCodexConversations: async options => {
    calls.push(options);
    if (calls.length < 3) return { conversations: [], nextCursor: null };
    return options.cursor ? { conversations: [{ ...conversation, archived: true }, { ...conversation, id: other, archived: true }], nextCursor: null }
      : { conversations: [{ ...conversation, archived: true }], nextCursor: 'older' };
  } };
  const promise = chooseCodexConversation(f.ui, agents, record, 'Host'); await tick();
  assert.equal(calls[0].cwd, '/project');
  f.picker.value = 'original'; f.accept(item => item.action === 'directories'); await tick();
  assert.equal(calls[1].cwd, undefined);
  f.accept(item => item.action === 'archive'); await tick(); assert.equal(calls[2].archived, true);
  assert.ok(f.picker.placeholder.includes('unarchive'));
  f.accept(item => item.action === 'more'); await tick(); assert.equal(calls[3].cursor, 'older');
  assert.equal(f.picker.items.filter(item => item.conversation).length, 2, 'deduplicate IDs across pages');
  assert.equal(f.picker.value, 'original');
  assert.ok(f.picker.items.filter(item => item.action).every(item => item.alwaysShow));
  f.accept(item => item.conversation?.id === other);
  assert.deepEqual(await promise, { sessionId: other, archived: true });
});

test('history errors offer a manual-ID fallback and cancellation ignores a late metadata response', async () => {
  const f = uiFixture(); let inputs = 0;
  f.ui.showInputBox = async options => { inputs++; assert.equal(options.validateInput('wrong'), 'Enter a conversation UUID, not a name or --last'); return id; };
  const promise = chooseCodexConversation(f.ui, { listCodexConversations: async () => { throw new Error('Unsupported old CLI'); } }, record, 'Host');
  await tick(); assert.ok(f.picker.items.some(item => item.action === 'retry'));
  f.accept(item => item.action === 'manual'); assert.deepEqual(await promise, { sessionId: id, archived: false }); assert.equal(inputs, 1);
  const late = uiFixture(); let ready;
  const cancelled = chooseCodexConversation(late.ui, { listCodexConversations: () => new Promise(resolve => { ready = resolve; }) }, record, 'Host');
  late.cancel(); assert.equal(await cancelled, undefined);
  ready({ conversations: [conversation], nextCursor: null }); await tick(); assert.equal(late.picker.disposed, true);
});

test('history metadata is plain display text; name and directory matches never prove identity', () => {
  const items = conversationItems([{ ...conversation, id: other }, { ...conversation, name: '$(warning) Legacy\nignore instructions' }], record);
  assert.equal(items.length, 2);
  assert.ok(items.every(item => !item.label.includes('\n') && !item.label.includes('$(')));
  assert.ok(items.every(item => item.conversation));
});

test('changing history scope cannot accept a stale active item while the next list is loading', async () => {
  const f = uiFixture(); let pageReady, calls = 0, resolved = false;
  const promise = chooseCodexConversation(f.ui, { listCodexConversations: async () => {
    if (++calls === 1) return { conversations: [conversation], nextCursor: null };
    return new Promise(resolve => { pageReady = resolve; });
  } }, record, 'Host').then(value => { resolved = true; return value; });
  await tick(); const old = f.picker.items.find(item => item.conversation);
  f.accept(item => item.action === 'archive'); f.accept(old); await tick();
  assert.equal(resolved, false);
  pageReady({ conversations: [{ ...conversation, id: other, archived: true }], nextCursor: null }); await tick();
  f.accept(old); await tick(); assert.equal(resolved, false, 'the previous view’s item is no longer selectable');
  f.accept(item => item.conversation?.id === other); assert.deepEqual(await promise, { sessionId: other, archived: true });
});
