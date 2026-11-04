'use strict';

const { randomUUID } = require('node:crypto');
const readline = require('node:readline');
const { shellQuote } = require('./ssh');

const AGENT_PATH = 'PATH="$PATH:$HOME/.local/bin:$HOME/.npm-global/bin:/opt/homebrew/bin:/usr/local/bin"; export PATH; ';
const AGENT_EXEC = AGENT_PATH + 'exec "$@"';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function builtinAgent(type) { return type === 'claude' || type === 'codex'; }
function validateBinding(agent) {
  if (!builtinAgent(agent?.type) || !UUID.test(agent.sessionId || '') ||
      typeof agent.name !== 'string' || !agent.name || /[\x00-\x1f\x7f]/.test(agent.name)) {
    throw new Error('Invalid Agent conversation binding');
  }
  return agent;
}
function agentCommand(agent, fresh = false, cwd) {
  validateBinding(agent);
  const args = agent.type === 'claude'
    ? ['claude', fresh ? '--session-id' : '--resume', fresh ? agent.sessionId : (agent.transcriptPath || agent.sessionId), '--name', agent.name]
    : ['codex', 'resume', agent.sessionId, ...(cwd ? ['--cd', cwd] : [])];
  return ['sh', '-c', AGENT_EXEC, 'tmuxdock-agent', ...args].map(shellQuote).join(' ');
}
function needsAgentBinding(record) {
  return builtinAgent(record.agent?.type) && !record.agent.manualRestore && record.agent.recoveryVersion !== 1;
}

class RpcClient {
  constructor(child, timeout = 25000) {
    this.child = child; this.timeout = timeout; this.sequence = 0; this.pending = new Map();
    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id != null) {
        child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601,
          message: 'TmuxDock only initializes conversation metadata; interactive requests must be handled in the CLI.' } }) + '\n');
        return;
      }
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message || 'Codex metadata request failed'));
      else request.resolve(message.result);
    });
    child.stderr?.resume(); // Do not retain CLI logs or conversation contents.
    const fail = () => {
      for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Codex metadata connection closed')); }
      this.pending.clear();
    };
    child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
  }
  notify(method, params = {}) { this.child.stdin.write(JSON.stringify({ method, params }) + '\n'); }
  request(method, params) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Timed out while initializing Agent conversation (${method})`)); }, this.timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async close() {
    this.lines.close();
    this.child.stdin.end();
    if (this.child.exitCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => { this.child.kill(); resolve(); }, 1500);
      this.child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

class AgentSessions {
  constructor(transport) { this.transport = transport; this.claudeSupportExpires = 0; }
  async ensureClaudeSupport() {
    if (this.claudeSupportExpires > Date.now()) return;
    if (!this.claudeSupportPromise) this.claudeSupportPromise = (async () => {
      const result = await this.transport.run('sh', ['-c', AGENT_EXEC, 'tmuxdock-agent', 'claude', '--help']);
      const help = String(result.stdout || '');
      if (!help.includes('--session-id') || !help.includes('--name')) {
        throw new Error('Update Claude Code: automatic conversation recovery requires --session-id and --name');
      }
      this.claudeSupportExpires = Date.now() + 5 * 60 * 1000;
    })().finally(() => { this.claudeSupportPromise = null; });
    return this.claudeSupportPromise;
  }
  async codex(callback) {
    const rpc = new RpcClient(this.transport.openProcess('sh', ['-c', AGENT_EXEC, 'tmuxdock-agent', 'codex', 'app-server']));
    try {
      await rpc.request('initialize', { clientInfo: { name: 'tmuxdock', title: 'TmuxDock', version: '2.5.1' } });
      rpc.notify('initialized');
      return await callback(rpc);
    } finally { await rpc.close(); }
  }
  async prepare(type, name, cwd) {
    if (!builtinAgent(type)) throw new Error('Only Claude and Codex support automatic conversation recovery');
    let sessionId;
    if (type === 'claude') {
      await this.ensureClaudeSupport();
      sessionId = randomUUID();
    } else {
      sessionId = await this.codex(async rpc => {
        const result = await rpc.request('thread/start', { cwd });
        const id = result.thread?.id;
        if (!UUID.test(id || '')) throw new Error('Codex did not return a valid conversation ID');
        await rpc.request('thread/name/set', { threadId: id, name });
        // Metadata-only read confirms the named conversation is persisted; no turn is sent.
        await rpc.request('thread/read', { threadId: id, includeTurns: false });
        return id;
      });
    }
    return { type, name, sessionId, recoveryVersion: 1, launchState: 'new' };
  }
  async verify(agent) {
    validateBinding(agent);
    if (agent.type === 'codex') {
      await this.codex(rpc => rpc.request('thread/read', { threadId: agent.sessionId, includeTurns: false }));
    } else {
      const script = 'root=${CLAUDE_CONFIG_DIR:-$HOME/.claude}; ' +
        'if test -d "$root/projects"; then find "$root/projects" -type f -name "$1.jsonl" -print -quit; fi';
      const result = await this.transport.run('sh', ['-c', script, 'tmuxdock-agent', agent.sessionId]);
      const transcriptPath = result.stdout.trim();
      if (!transcriptPath) throw new Error('Original Claude conversation history was not found. It may not have been saved yet or may have been removed. No new conversation was created.');
      if (!transcriptPath.startsWith('/') || /[\x00\r\n]/.test(transcriptPath) || !transcriptPath.endsWith('/' + agent.sessionId + '.jsonl')) throw new Error('Invalid Claude transcript path');
      return { ...agent, transcriptPath };
    }
    return agent;
  }
  async listCodexConversations({ cwd, cursor, archived = false } = {}) {
    const params = { limit: 50, sortKey: 'updated_at', modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'], archived: Boolean(archived) };
    if (cwd) params.cwd = cwd;
    if (cursor) params.cursor = cursor;
    return this.codex(async rpc => {
      const result = await rpc.request('thread/list', params);
      if (!Array.isArray(result?.data)) throw new Error('Codex returned an invalid history list');
      const seen = new Set();
      const conversations = result.data.filter(thread => UUID.test(thread?.id || '') && !thread.ephemeral &&
        !seen.has(thread.id) && seen.add(thread.id)).map(thread => ({
        id: thread.id, name: typeof thread.name === 'string' ? thread.name : '',
        preview: typeof thread.preview === 'string' ? thread.preview : '',
        cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
        createdAt: Number.isFinite(thread.createdAt) ? thread.createdAt : null,
        updatedAt: Number.isFinite(thread.updatedAt) ? thread.updatedAt : null,
        archived: Boolean(archived)
      }));
      return { conversations, nextCursor: typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : null };
    });
  }
  async bind(type, sessionId, name, { archived = false } = {}) {
    const agent = validateBinding({ type, sessionId, name, recoveryVersion: 1, launchState: 'started' });
    if (type === 'codex') await this.codex(async rpc => {
      if (archived) await rpc.request('thread/unarchive', { threadId: sessionId });
      await rpc.request('thread/read', { threadId: sessionId, includeTurns: false });
      await rpc.request('thread/name/set', { threadId: sessionId, name });
    });
    else await this.verify(agent);
    return agent;
  }
  async rename(agent, name) {
    validateBinding({ ...agent, name });
    if (agent.type === 'codex') await this.codex(rpc => rpc.request('thread/name/set', { threadId: agent.sessionId, name }));
    return { ...agent, name };
  }
}

module.exports = { AgentSessions, RpcClient, builtinAgent, needsAgentBinding, agentCommand, validateBinding, UUID };
