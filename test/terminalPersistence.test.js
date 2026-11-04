'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TERMINAL_CONTEXT, TerminalConnections, terminalMetadata, restoredTerminalContext, guardedAttachScript } = require('../src/terminalPersistence');

function fixture() {
  const host = { id: 'host-1', sshHost: 'dev', label: 'Dev', tmuxPath: 'tmux', socketName: 'isolated' };
  const live = { id: '$1', created: '2026-11-04T00:00:00.000Z', owner: 'record-1', name: 'Task' };
  const entry = { id: 'record-1', title: 'Task', tmuxSession: 'Task', status: 'live', live };
  const controller = { host, online: true, manager: { entries: [entry] } };
  const terminal = { creationOptions: { env: { [TERMINAL_CONTEXT]: terminalMetadata(host, entry, live) } } };
  return { host, live, entry, controller, terminal };
}

test('native terminal recovery uses host and live identity, never a colliding display title', () => {
  const { terminal, controller, entry } = fixture();
  const other = { ...controller, host: { ...controller.host, id: 'host-2' } };
  assert.deepEqual(restoredTerminalContext(terminal, [other, controller]), { controller, entry });
  assert.equal(restoredTerminalContext(terminal, [other]), undefined);
  for (const key of ['sshHost', 'socketName', 'tmuxPath']) {
    assert.equal(restoredTerminalContext(terminal, [{ ...controller, host: { ...controller.host, [key]: 'changed' } }]), undefined);
  }
  for (const [key, value] of [['id', '$2'], ['created', '2026-11-04T00:00:01.000Z'], ['owner', 'replacement']]) {
    assert.equal(restoredTerminalContext(terminal, [{ ...controller, manager: { entries: [{ ...entry, live: { ...entry.live, [key]: value } }] } }]), undefined);
  }
});

test('offline native terminal recovery retains host context without starting or rebuilding anything', () => {
  const { terminal, controller, entry } = fixture();
  controller.online = false;
  controller.manager.entries = [{ ...entry, live: null, status: 'unavailable' }];
  assert.equal(restoredTerminalContext(terminal, [controller]).entry.status, 'unavailable');
  controller.manager.entries = [];
  const restored = restoredTerminalContext(terminal, [controller]);
  assert.equal(restored.entry.tmuxSession, entry.tmuxSession);
  assert.equal(restored.entry.record, null);
});

test('ordinary, exited and malformed terminals cannot be claimed as recovered sessions', () => {
  const { terminal, controller } = fixture();
  assert.equal(restoredTerminalContext({ creationOptions: {} }, [controller]), undefined);
  assert.equal(restoredTerminalContext({ ...terminal, exitStatus: { code: 0 } }, [controller]), undefined);
  for (const value of ['{broken', 'null', '{}', '{"version":1,"host":[]}']) {
    assert.equal(restoredTerminalContext({ creationOptions: { env: { [TERMINAL_CONTEXT]: value } } }, [controller]), undefined);
  }
});

test('saved attach process checks identity before attach and contains no restore or agent command', () => {
  const { live } = fixture();
  const script = guardedAttachScript({ executable: 'tmux', prefixArgs: ['-L', 'isolated'] }, live);
  assert.ok(script.indexOf('list-sessions') < script.indexOf('attach-session'));
  assert.ok(!script.includes('display-message'), 'never resolve a vanished target on tmux 3.2a');
  assert.ok(script.includes('grep -F -x --'), 'match the complete identity line literally');
  assert.ok(script.includes('exit 1'));
  assert.ok(!/new-session|send-keys|claude|codex/.test(script));
  assert.throws(() => guardedAttachScript({ executable: 'tmux', prefixArgs: [] }, { ...live, id: null }), /verified tmux identity/);
});

function memoryStorage() {
  const data = new Map();
  return { get: (key, fallback) => structuredClone(data.get(key) ?? fallback),
    update: async (key, value) => { data.set(key, structuredClone(value)); } };
}

test('native reconnection with missing env matches the saved process ID and name across extension reload', async () => {
  const { terminal, controller, entry } = fixture();
  const storage = memoryStorage();
  terminal.name = entry.title; terminal.processId = Promise.resolve(123);
  await new TerminalConnections(storage).remember(terminal);
  const reloaded = new TerminalConnections(storage);
  const native = { name: entry.title, creationOptions: { shellPath: '/bin/zsh' }, processId: Promise.resolve(123) };
  assert.equal(reloaded.matches(native, controller, entry), true);
  assert.deepEqual(await reloaded.restore(native, [controller]), { controller, entry });
  assert.equal(await reloaded.restore({ ...native, processId: Promise.resolve(124) }, [controller]), undefined, 'same title is insufficient');
  assert.equal(await reloaded.restore({ ...native, name: 'Other' }, [controller]), undefined);
  await reloaded.forget(native);
  assert.equal(await new TerminalConnections(storage).restore(native, [controller]), undefined, 'a closed tab is not retained');
});

test('closing a terminal before its PID resolves cannot leave a saved connection', async () => {
  const { terminal, controller, entry } = fixture();
  const storage = memoryStorage(); const connections = new TerminalConnections(storage);
  let ready; terminal.name = entry.title; terminal.processId = new Promise(resolve => { ready = resolve; });
  const writing = connections.remember(terminal);
  await connections.forget(terminal); ready(456); await writing;
  const native = { name: entry.title, creationOptions: {}, processId: Promise.resolve(456) };
  assert.equal(await new TerminalConnections(storage).restore(native, [controller]), undefined);
});

test('concurrent same-name connections retain independent process and host identities', async () => {
  const first = fixture(), second = fixture();
  second.host.id = 'host-2'; second.controller.host = second.host;
  second.terminal.creationOptions.env[TERMINAL_CONTEXT] = terminalMetadata(second.host, second.entry, second.live);
  const storage = memoryStorage(); const connections = new TerminalConnections(storage);
  first.terminal.name = first.entry.title; first.terminal.processId = Promise.resolve(100);
  second.terminal.name = first.entry.title + ' · 2'; second.terminal.processId = Promise.resolve(101);
  await Promise.all([connections.remember(first.terminal), connections.remember(second.terminal)]);
  const reloaded = new TerminalConnections(storage);
  for (const [source, expected] of [[first.terminal, first.controller], [second.terminal, second.controller]]) {
    const native = { ...source, creationOptions: {} };
    assert.equal((await reloaded.restore(native, [first.controller, second.controller])).controller, expected);
  }
});
