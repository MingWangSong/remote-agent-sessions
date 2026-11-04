'use strict';

const { remoteCommand, shellQuote } = require('./ssh');

const TERMINAL_CONTEXT = 'TMUXDOCK_TERMINAL_CONTEXT';
const CONNECTIONS_KEY = 'terminalConnections.v1';

class TerminalConnections {
  constructor(storage) {
    this.storage = storage;
    const saved = storage.get(CONNECTIONS_KEY, []);
    this.saved = Array.isArray(saved) ? saved.filter(item => Number.isInteger(item.pid) && typeof item.name === 'string' && typeof item.metadata === 'string') : [];
    this.closed = new WeakSet();
    this.pending = Promise.resolve();
  }
  write(change) {
    const result = this.pending.then(async () => {
      change();
      this.saved = this.saved.slice(-128);
      await this.storage.update(CONNECTIONS_KEY, this.saved);
    });
    this.pending = result.catch(() => {});
    return result;
  }
  async remember(terminal) {
    const metadata = terminal.creationOptions.env?.[TERMINAL_CONTEXT];
    if (!metadata) return;
    const pid = await terminal.processId;
    if (!Number.isInteger(pid) || this.closed.has(terminal) || terminal.exitStatus !== undefined) return;
    return this.write(() => {
      this.saved = this.saved.filter(item => item.pid !== pid);
      if (!this.closed.has(terminal)) this.saved.push({ pid, name: terminal.name, metadata });
    });
  }
  async forget(terminal) {
    this.closed.add(terminal);
    if (!this.saved.some(item => item.name === terminal.name)) return;
    const pid = await terminal.processId;
    return this.write(() => { this.saved = this.saved.filter(item => item.pid !== pid); });
  }
  async restore(terminal, controllers) {
    if (terminal.creationOptions.env?.[TERMINAL_CONTEXT]) return restoredTerminalContext(terminal, controllers);
    // Reconnected terminals on some VS Code versions expose default shell
    // creationOptions instead of their original env. The native process ID is
    // retained; use our workspace-local association, never the title alone.
    if (!this.saved.some(item => item.name === terminal.name)) return;
    const pid = await terminal.processId;
    const saved = this.saved.find(item => item.pid === pid && item.name === terminal.name);
    if (!saved || this.closed.has(terminal)) return;
    return restoredTerminalContext({ exitStatus: terminal.exitStatus,
      creationOptions: { env: { [TERMINAL_CONTEXT]: saved.metadata } } }, controllers);
  }
  matches(terminal, controller, entry) {
    const metadata = terminal.creationOptions.env?.[TERMINAL_CONTEXT];
    const candidates = metadata ? [metadata] : this.saved.filter(item => item.name === terminal.name).map(item => item.metadata);
    return candidates.some(value => {
      try {
        const saved = JSON.parse(value);
        return saved?.entryId === entry.id && JSON.stringify(saved.host) === JSON.stringify(hostIdentity(controller.host));
      } catch { return false; }
    });
  }
}

function hostIdentity(host) {
  return [host.id, host.sshHost, host.tmuxPath || 'tmux', host.socketName || ''];
}

function terminalMetadata(host, entry, live) {
  return JSON.stringify({ version: 1, host: hostIdentity(host), entryId: entry.id,
    title: entry.title, tmuxSession: entry.tmuxSession,
    live: { id: live.id, created: live.created, owner: live.owner || null, currentCommand: live.currentCommand } });
}

function restoredTerminalContext(terminal, controllers) {
  if (terminal.exitStatus !== undefined) return;
  let saved;
  try { saved = JSON.parse(terminal.creationOptions.env?.[TERMINAL_CONTEXT]); } catch { return; }
  if (saved?.version !== 1 || !Array.isArray(saved.host) || typeof saved.entryId !== 'string' ||
      typeof saved.title !== 'string' || typeof saved.tmuxSession !== 'string' ||
      !/^\$\d+$/.test(saved.live?.id) || !Number.isFinite(Date.parse(saved.live?.created))) return;
  const controller = controllers.find(candidate => JSON.stringify(hostIdentity(candidate.host)) === JSON.stringify(saved.host));
  if (!controller) return;
  const entry = controller.manager.entries.find(candidate => candidate.live?.id === saved.live.id &&
    candidate.live.created === saved.live.created && (!saved.live.owner || candidate.live.owner === saved.live.owner) &&
    candidate.status === 'live');
  if (entry) return { controller, entry };
  // Reconnecting an already-running native terminal needs no new SSH request.
  // An offline host still has a host identity; never rebuild a remote session here.
  if (!controller.online) {
    const cached = controller.manager.entries.find(candidate => candidate.id === saved.entryId);
    return { controller, entry: cached || { id: saved.entryId, title: saved.title, tmuxSession: saved.tmuxSession,
      status: 'unavailable', managed: false, record: null, live: { ...saved.live, name: saved.tmuxSession } } };
  }
}

function guardedAttachScript(tmux, live) {
  const created = Date.parse(live.created) / 1000;
  if (!/^\$\d+$/.test(live.id) || !Number.isInteger(created)) throw new Error('Cannot persist a terminal without a verified tmux identity');
  const command = args => remoteCommand(tmux.executable, ['-u', ...tmux.prefixArgs, ...args]);
  const identity = `${live.id}|${created}|${live.owner || ''}`;
  // VS Code may revive the saved process after a full app restart too. Check the
  // original server identity before attach, rather than trusting a reused $ID.
  // tmux 3.2a can terminate its server when display-message targets a vanished
  // session. Enumerate identities without resolving a possibly stale target.
  return `identities=$(${command(['list-sessions', '-F', '#{session_id}|#{session_created}|#{@ras_id}'])}) || exit $?; ` +
    `printf '%s\\n' "$identities" | grep -F -x -- ${shellQuote(identity)} >/dev/null || { printf '%s\\n' 'TmuxDock: original session is unavailable or its identity changed. Refresh and reconnect from the sidebar.' >&2; exit 1; }; ` +
    `exec ${command(['attach-session', '-t', live.id])}`;
}

module.exports = { TERMINAL_CONTEXT, TerminalConnections, terminalMetadata, restoredTerminalContext, guardedAttachScript };
