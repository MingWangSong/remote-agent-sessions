'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { AgentSessions, agentCommand, needsAgentBinding } = require('../src/agentSessions');
const id = '550e8400-e29b-41d4-a716-446655440000';

function rpcTransport() {
  const calls = [];
  return { calls, openProcess() {
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
    child.stdin = new Writable({ write(chunk, encoding, done) {
      const message = JSON.parse(chunk.toString()); calls.push(message);
      if (message.id != null) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: message.id,
        result: message.method === 'thread/start' ? { thread: { id } } : {} }) + '\n'));
      done();
    } });
    child.stdin.on('finish', () => { child.exitCode = 0; child.emit('exit', 0); });
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); };
    return child;
  } };
}

test('Codex creates and names a persisted conversation without sending a model turn', async () => {
  const transport = rpcTransport(); const agents = new AgentSessions(transport);
  const binding = await agents.prepare('codex', "任务 ' A", '/project');
  assert.equal(binding.sessionId, id);
  assert.equal(binding.name, "任务 ' A");
  assert.deepEqual(transport.calls.filter(call => call.id).map(call => call.method),
    ['initialize', 'thread/start', 'thread/name/set', 'thread/read']);
  assert.deepEqual(transport.calls.find(call => call.method === 'thread/start').params, { cwd: '/project' });
  assert.equal(transport.calls.find(call => call.method === 'thread/read').params.includeTurns, false);
  assert.ok(!transport.calls.some(call => call.method.startsWith('turn/')));
});

test('Claude initial launch names a fixed UUID; subsequent launches resume exactly that ID', async () => {
  const agents = new AgentSessions({ run: async () => ({ stdout: '--session-id --name' }) });
  const binding = await agents.prepare('claude', "name ' quoted", '/project');
  assert.match(agentCommand(binding, true), /'--session-id'/);
  assert.match(agentCommand(binding), /'--resume'/);
  assert.ok(agentCommand(binding).includes(binding.sessionId));
  assert.ok(!agentCommand(binding).includes('--last'));
  assert.ok(agentCommand(binding).includes("name '\"'\"' quoted"));
});

test('missing history and invalid IDs never fall back to a fresh conversation', async () => {
  const agents = new AgentSessions({ run: async () => ({ stdout: '' }) });
  await assert.rejects(agents.verify({ type: 'claude', name: 'task', sessionId: id }), /No new conversation was created/);
  assert.throws(() => agentCommand({ type: 'claude', name: 'task', sessionId: '$(bad)' }), /Invalid Agent/);
  assert.equal(needsAgentBinding({ agent: { type: 'codex' } }), true);
  assert.equal(needsAgentBinding({ agent: { type: 'codex', manualRestore: true } }), false);
});

test('Claude capability checks are shared and briefly cached; conversation IDs stay distinct', async () => {
  let calls = 0;
  const agents = new AgentSessions({ run: async () => { calls++; return { stdout: '--session-id --name' }; } });
  const bindings = await Promise.all([agents.prepare('claude', 'one', '/p'), agents.prepare('claude', 'two', '/p')]);
  assert.equal(calls, 1);
  assert.notEqual(bindings[0].sessionId, bindings[1].sessionId);
  await agents.prepare('claude', 'three', '/p'); assert.equal(calls, 1);
  agents.claudeSupportExpires = 0;
  await agents.prepare('claude', 'four', '/p'); assert.equal(calls, 2);
});

test('Codex binding verifies and renames on a single metadata connection', async () => {
  const transport = rpcTransport(); let connections = 0;
  const open = transport.openProcess; transport.openProcess = (...args) => { connections++; return open(...args); };
  const agents = new AgentSessions(transport);
  await agents.bind('codex', id, 'existing');
  assert.equal(connections, 1);
  assert.deepEqual(transport.calls.filter(call => call.id).map(call => call.method), ['initialize', 'thread/read', 'thread/name/set']);
});
