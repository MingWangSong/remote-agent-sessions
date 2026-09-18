'use strict';

const path = require('node:path');
const os = require('node:os');
const vscode = require('vscode');
const { parseBackup, mergeRecords } = require('./backup');
const { HostRegistry } = require('./hostRegistry');
const { basenameForTitle } = require('./model');
const { GitInspector, SessionManager, checkTmuxName, owns } = require('./sessionManager');
const { SessionStore, validateRecords } = require('./store');
const { SshClient } = require('./ssh');
const { TmuxClient } = require('./tmux');

const terminals = new Map();

class HostController {
  constructor(host, context, configuration) {
    this.host = host;
    this.configuration = configuration;
    this.ssh = new SshClient(host, {
      sshPath: configuration.get('sshPath', 'ssh'),
      connectTimeout: configuration.get('connectTimeout', 10),
      multiplex: configuration.get('multiplexSsh', true),
      controlDirectory: path.join(context.globalStorageUri.fsPath, 'ssh-control')
    });
    const prefix = host.socketName ? ['-L', host.socketName] : [];
    this.tmux = new TmuxClient(host.tmuxPath || 'tmux', this.ssh.run.bind(this.ssh), prefix);
    this.databasePath = path.join(context.globalStorageUri.fsPath, 'hosts', safeFileName(host.id), 'sessions.json');
    this.manager = new SessionManager(
      new SessionStore(this.databasePath),
      this.tmux,
      new GitInspector(this.ssh.run.bind(this.ssh)),
      this.ssh.checkDirectory.bind(this.ssh)
    );
    this.online = false;
    this.error = null;
  }

  async refresh(snapshot = true) {
    try {
      await this.manager.refresh(snapshot);
      this.online = true;
      this.error = null;
    } catch (error) {
      this.online = false;
      this.error = error;
    }
    return this.manager.entries;
  }
}

class HostTreeItem extends vscode.TreeItem {
  constructor(controller) {
    super(controller.host.label, vscode.TreeItemCollapsibleState.Expanded);
    this.kind = 'host';
    this.controller = controller;
    this.id = `host:${controller.host.id}`;
    this.contextValue = controller.online ? 'sshHostOnline' : 'sshHostOffline';
    this.iconPath = new vscode.ThemeIcon(
      controller.online ? 'remote' : 'debug-disconnect',
      new vscode.ThemeColor(controller.online ? 'testing.iconPassed' : 'notificationsErrorIcon.foreground')
    );
    const live = controller.manager.entries.filter((entry) => entry.status === 'live').length;
    const recoverable = controller.manager.entries.filter((entry) => entry.status === 'recoverable').length;
    this.description = controller.online ? `${live} live${recoverable ? ` · ${recoverable} recoverable` : ''}` : 'offline';
    this.tooltip = controller.online
      ? `${controller.host.sshHost} · connected through local SSH`
      : `${controller.host.sshHost}\n${humanError(controller.error)}`;
  }
}

class SessionTreeItem extends vscode.TreeItem {
  constructor(controller, entry) {
    super(entry.title, vscode.TreeItemCollapsibleState.None);
    this.kind = 'session';
    this.controller = controller;
    this.entry = entry;
    this.id = `${controller.host.id}:${entry.id}`;
    this.description = buildDescription(entry);
    this.tooltip = buildTooltip(controller, entry);
    if (entry.status === 'live') {
      this.iconPath = new vscode.ThemeIcon('terminal', new vscode.ThemeColor('testing.iconPassed'));
      this.contextValue = entry.managed ? 'sessionLiveManaged' : 'sessionLiveUnmanaged';
      this.command = { command: 'remoteAgentSessions.attach', title: 'Attach Session', arguments: [this] };
    } else if (entry.status === 'recoverable') {
      this.iconPath = new vscode.ThemeIcon('debug-restart', new vscode.ThemeColor('notificationsWarningIcon.foreground'));
      this.contextValue = 'sessionRecoverable';
      this.command = { command: 'remoteAgentSessions.restore', title: 'Restore Session', arguments: [this] };
    } else {
      this.iconPath = new vscode.ThemeIcon('warning');
      this.contextValue = 'sessionUnavailable';
      this.description = entry.status === 'conflict' ? 'name belongs to another session' : 'host unavailable';
    }
  }
}

class MessageTreeItem extends vscode.TreeItem {
  constructor(controller, label, icon = 'info') {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.id = `message:${controller.host.id}:${label}`;
    this.contextValue = 'hostMessage';
    this.iconPath = new vscode.ThemeIcon(icon);
  }
}

class MultiHostTreeProvider {
  constructor(context, registry, configuration, onCountChanged) {
    this.context = context;
    this.registry = registry;
    this.configuration = configuration;
    this.onCountChanged = onCountChanged;
    this.controllers = [];
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
  }

  getTreeItem(item) { return item; }

  getChildren(item) {
    if (!item) return this.controllers.map((controller) => new HostTreeItem(controller));
    if (item.kind !== 'host') return [];
    const controller = item.controller;
    if (!controller.online && !controller.manager.entries.length) {
      return [new MessageTreeItem(controller, 'Host unavailable — refresh or open SSH terminal', 'debug-disconnect')];
    }
    if (!controller.manager.entries.length) return [new MessageTreeItem(controller, 'No tmux sessions found')];
    return controller.manager.entries.map((entry) => new SessionTreeItem(controller, entry));
  }

  async reloadHosts() {
    this.controllers = this.registry.list().map((host) => new HostController(host, this.context, this.configuration));
    await this.refresh();
  }

  async refresh(controller, snapshot = true) {
    const targets = controller ? [controller] : this.controllers;
    await Promise.all(targets.map((target) => target.refresh(snapshot)));
    this.onCountChanged(this.controllers);
    this.changeEmitter.fire(undefined);
  }

  dispose() { this.changeEmitter.dispose(); }
}

async function activate(context) {
  const configuration = vscode.workspace.getConfiguration('remoteAgentSessions');
  const registry = new HostRegistry(context.globalState);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.name = 'TmuxDock';
  status.command = 'remoteAgentSessions.refresh';
  status.show();

  const updateStatus = (controllers) => {
    const online = controllers.filter((controller) => controller.online).length;
    const live = controllers.reduce((count, controller) => count + controller.manager.entries.filter((entry) => entry.status === 'live').length, 0);
    const recoverable = controllers.reduce((count, controller) => count + controller.manager.entries.filter((entry) => entry.status === 'recoverable').length, 0);
    status.text = `$(remote) ${online}/${controllers.length}  $(terminal) ${live}` + (recoverable ? `  $(debug-restart) ${recoverable}` : '');
    status.tooltip = `${online} of ${controllers.length} SSH hosts online; ${live} live and ${recoverable} recoverable session(s)`;
  };

  const provider = new MultiHostTreeProvider(context, registry, configuration, updateStatus);
  context.subscriptions.push(status, provider, vscode.window.registerTreeDataProvider('remoteAgentSessions.sessions', provider));

  let operation = Promise.resolve();
  const command = (name, handler) => {
    context.subscriptions.push(vscode.commands.registerCommand(name, async (...args) => {
      const task = operation.then(() => handler(...args));
      operation = task.catch((error) => vscode.window.showErrorMessage(humanError(error)));
      return operation;
    }));
  };

  command('remoteAgentSessions.addHost', async () => {
    const sshHost = await vscode.window.showInputBox({
      title: 'Add SSH Host',
      prompt: 'SSH config alias or user@host. Credentials remain in OpenSSH/ssh-agent.',
      placeHolder: 'dev-server',
      validateInput: validateSshHostInput
    });
    if (!sshHost) return;
    const label = await vscode.window.showInputBox({ title: 'Host Display Name', value: sshHost.trim() });
    if (!label) return;
    const provisional = { id: require('node:crypto').randomUUID(), label: label.trim(), sshHost: sshHost.trim(), tmuxPath: 'tmux' };
    const socketName = await vscode.window.showInputBox({
      title: 'tmux Socket Name (Optional)',
      prompt: 'Leave empty for the default tmux server. A named socket isolates a separate set of sessions.',
      value: '',
      validateInput: validateSocketNameInput
    });
    if (socketName === undefined) return;
    provisional.socketName = socketName.trim();
    const ssh = new SshClient(provisional, {
      sshPath: configuration.get('sshPath', 'ssh'),
      connectTimeout: configuration.get('connectTimeout', 10),
      multiplex: configuration.get('multiplexSsh', true),
      controlDirectory: path.join(context.globalStorageUri.fsPath, 'ssh-control')
    });
    const remoteHome = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Connecting to ${label.trim()}…` }, () => ssh.homeDirectory());
    await registry.add({ ...provisional, defaultCwd: remoteHome });
    await provider.reloadHosts();
    vscode.window.showInformationMessage(`Added ${label.trim()}. TmuxDock runs locally; only SSH and tmux are used remotely.`);
  });

  command('remoteAgentSessions.editHost', async (item) => {
    const controller = await resolveHost(item, provider);
    if (!controller) return;
    const sshHost = await vscode.window.showInputBox({
      title: 'Edit SSH Target', value: controller.host.sshHost, validateInput: validateSshHostInput
    });
    if (!sshHost) return;
    const label = await vscode.window.showInputBox({ title: 'Edit Host Display Name', value: controller.host.label });
    if (!label?.trim()) return;
    const tmuxPath = await vscode.window.showInputBox({
      title: 'Remote tmux Executable', value: controller.host.tmuxPath || 'tmux',
      validateInput: validateRemoteExecutableInput
    });
    if (!tmuxPath) return;
    const socketName = await vscode.window.showInputBox({
      title: 'tmux Socket Name (Optional)', value: controller.host.socketName || '',
      prompt: 'Leave empty for the default tmux server.', validateInput: validateSocketNameInput
    });
    if (socketName === undefined) return;
    const candidate = {
      ...controller.host, sshHost: sshHost.trim(), label: label.trim(),
      tmuxPath: tmuxPath.trim(), socketName: socketName.trim()
    };
    const ssh = new SshClient(candidate, {
      sshPath: configuration.get('sshPath', 'ssh'),
      connectTimeout: configuration.get('connectTimeout', 10),
      multiplex: configuration.get('multiplexSsh', true)
    });
    const defaultCwd = await vscode.window.showInputBox({
      title: 'Default Remote Working Directory',
      value: candidate.defaultCwd || await ssh.homeDirectory(),
      validateInput: validateRemoteDirectoryInput
    });
    if (!defaultCwd) return;
    await ssh.checkDirectory(defaultCwd);
    await registry.update({ ...candidate, defaultCwd });
    await provider.reloadHosts();
    vscode.window.showInformationMessage(`Updated ${label.trim()}.`);
  });

  command('remoteAgentSessions.removeHost', async (item) => {
    const controller = await resolveHost(item, provider);
    if (!controller) return;
    const answer = await vscode.window.showWarningMessage(
      `Remove ${controller.host.label} from the local host list? Remote tmux sessions and cached metadata will not be deleted.`,
      { modal: true }, 'Remove Host'
    );
    if (answer !== 'Remove Host') return;
    await registry.remove(controller.host.id);
    await provider.reloadHosts();
  });

  command('remoteAgentSessions.refresh', async (item) => provider.refresh(item?.kind === 'host' ? item.controller : undefined));

  command('remoteAgentSessions.openSshTerminal', async (item) => {
    const controller = await resolveHost(item, provider);
    if (!controller) return;
    vscode.window.createTerminal({
      name: `SSH: ${controller.host.label}`,
      shellPath: controller.ssh.sshPath,
      shellArgs: [...controller.ssh.baseArgs({ interactive: true }), '-tt', controller.host.sshHost],
      isTransient: true
    }).show();
  });

  command('remoteAgentSessions.openWorkspace', async (item) => {
    const controller = await resolveHost(item, provider);
    if (!controller) return;
    const cwd = await vscode.window.showInputBox({
      title: `Open Remote Workspace on ${controller.host.label}`,
      value: controller.host.defaultCwd || await controller.ssh.homeDirectory(),
      validateInput: validateRemoteDirectoryInput
    });
    if (!cwd) return;
    await controller.ssh.checkDirectory(cwd);
    const uri = vscode.Uri.from({ scheme: 'vscode-remote', authority: `ssh-remote+${controller.host.sshHost}`, path: cwd });
    await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow: true });
  });

  command('remoteAgentSessions.create', async (item) => {
    const controller = await resolveHost(item, provider);
    if (!controller) return;
    await controller.refresh();
    if (!controller.online) throw controller.error;
    const cwd = await chooseRemoteWorkingDirectory(controller);
    if (!cwd) return;
    const title = await vscode.window.showInputBox({
      title: `Session Name on ${controller.host.label}`,
      prompt: 'One name is used in TmuxDock and for the real tmux session.',
      value: basenameForTitle(cwd),
      validateInput: validateTmuxNameInput
    });
    if (!title) return;
    const launch = await chooseAgentCommand();
    if (!launch) return;
    const record = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating ${title.trim()} on ${controller.host.label}…` }, () =>
      controller.manager.create({ title: title.trim(), cwd, command: launch.command, agent: launch.agent, host: controller.host.id })
    );
    await provider.refresh(controller, false);
    if (configuration.get('attachOnCreate', true)) {
      const entry = controller.manager.entries.find((candidate) => candidate.record?.id === record.id);
      await attachEntry(controller, entry);
    }
  });

  command('remoteAgentSessions.attach', async (item) => {
    const resolved = await resolveSession(item, provider, (entry) => entry.status === 'live');
    if (!resolved) return;
    await attachEntry(resolved.controller, resolved.entry);
    await provider.refresh(resolved.controller, false);
  });

  command('remoteAgentSessions.adopt', async (item) => {
    const resolved = await resolveSession(item, provider, (entry) => !entry.managed && entry.status === 'live');
    if (!resolved) return;
    await resolved.controller.manager.adopt(resolved.entry, resolved.entry.tmuxSession);
    await provider.refresh(resolved.controller, false);
    vscode.window.showInformationMessage(`Recovery enabled for ${resolved.entry.tmuxSession}.`);
  });

  command('remoteAgentSessions.rename', async (item) => {
    const resolved = await resolveSession(item, provider, (entry) => entry.status === 'live' || entry.status === 'recoverable');
    if (!resolved) return;
    const entry = resolved.entry;
    const tmuxSession = await vscode.window.showInputBox({
      title: 'Rename Session', prompt: 'One name is used in TmuxDock and for the real tmux session.', value: entry.tmuxSession,
      validateInput: validateTmuxNameInput
    });
    if (!tmuxSession) return;
    const oldKey = `${resolved.controller.host.id}:${entry.id}`;
    await resolved.controller.manager.renameSession(entry, tmuxSession.trim(), tmuxSession.trim());
    if (!entry.managed && terminals.has(oldKey)) {
      terminals.set(`${resolved.controller.host.id}:tmux:${tmuxSession.trim()}`, terminals.get(oldKey));
      terminals.delete(oldKey);
    }
    await provider.refresh(resolved.controller, false);
  });

  command('remoteAgentSessions.addNote', async (item) => {
    const resolved = await resolveSession(item, provider, (entry) => entry.managed);
    if (!resolved) return;
    const note = await vscode.window.showInputBox({ title: 'Session Note', value: resolved.entry.record.note || '' });
    if (note === undefined) return;
    await resolved.controller.manager.setNote(resolved.entry.record, note.trim());
    await provider.refresh(resolved.controller, false);
  });

  command('remoteAgentSessions.showDetails', async (item) => {
    const resolved = await resolveSession(item, provider, () => true);
    if (!resolved) return;
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: detailsMarkdown(resolved.controller, resolved.entry) });
    await vscode.window.showTextDocument(document, { preview: true });
  });

  command('remoteAgentSessions.editCommand', async (item) => {
    const resolved = await resolveSession(item, provider, (entry) => entry.managed);
    if (!resolved) return;
    const record = resolved.entry.record;
    const choices = [];
    for (const [wi, window] of (record.windows || []).entries()) {
      for (const [pi, pane] of (window.panes || [window]).entries()) {
        choices.push({ label: `${window.name} · pane ${pi + 1}`, description: pane.cwd, command: pane.command || '', wi, pi });
      }
    }
    const pane = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { title: 'Choose a pane to configure' });
    if (!pane) return;
    const value = await vscode.window.showInputBox({
      title: 'Restore Command', value: pane.command,
      prompt: 'Runs only when explicitly restoring. Do not store credentials.',
      validateInput: (text) => /[\0\r\n]/.test(text) ? 'Use one line' : null
    });
    if (value === undefined) return;
    await resolved.controller.manager.setCommand(record, pane.wi, pane.pi, value.trim());
    await provider.refresh(resolved.controller, false);
  });

  command('remoteAgentSessions.restore', async (item) => {
    const resolved = await resolveSession(item, provider, (entry) => entry.status === 'recoverable');
    if (!resolved) return;
    const execute = await chooseRestoreCommandPolicy(resolved.entry.record, configuration);
    if (execute === undefined) return;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Restoring ${resolved.entry.title} on ${resolved.controller.host.label}…` }, () =>
      resolved.controller.manager.restore(resolved.entry.record, execute)
    );
    await provider.refresh(resolved.controller, false);
    const restored = resolved.controller.manager.entries.find((entry) => entry.record?.id === resolved.entry.record.id);
    await attachEntry(resolved.controller, restored);
  });

  command('remoteAgentSessions.terminate', async (item) => {
    const resolved = await resolveSession(item, provider, (entry) => entry.status === 'live');
    if (!resolved) return;
    const answer = await vscode.window.showWarningMessage(
      `Terminate ${resolved.entry.tmuxSession} on ${resolved.controller.host.label}? All processes inside it will stop.`,
      { modal: true }, 'Terminate'
    );
    if (answer !== 'Terminate') return;
    await resolved.controller.manager.terminate(resolved.entry);
    await provider.refresh(resolved.controller, false);
  });

  command('remoteAgentSessions.delete', async (item) => {
    const resolved = await resolveSession(item, provider,
      (entry) => entry.status === 'live' || (entry.managed && entry.status === 'recoverable'));
    if (!resolved) return;
    const live = resolved.entry.status === 'live';
    const answer = await vscode.window.showWarningMessage(
      live
        ? `Permanently delete ${resolved.entry.tmuxSession} on ${resolved.controller.host.label}? All processes will stop and saved metadata will be removed.`
        : `Delete the saved record for ${resolved.entry.title}? No live tmux session exists.`,
      { modal: true, detail: 'This action cannot be undone.' }, 'Delete Session'
    );
    if (answer !== 'Delete Session') return;
    const key = `${resolved.controller.host.id}:${resolved.entry.id}`;
    const terminal = terminals.get(key);
    if (terminal && terminal.exitStatus === undefined) terminal.dispose();
    terminals.delete(key);
    await resolved.controller.manager.deleteSession(resolved.entry);
    await provider.refresh(resolved.controller, false);
  });

  command('remoteAgentSessions.forget', async (item) => {
    const resolved = await resolveSession(item, provider, (entry) => entry.managed);
    if (!resolved) return;
    const answer = await vscode.window.showWarningMessage(
      `Forget local metadata for ${resolved.entry.title}? A running tmux session will not stop.`,
      { modal: true }, 'Forget'
    );
    if (answer !== 'Forget') return;
    await resolved.controller.manager.forget(resolved.entry.record);
    await provider.refresh(resolved.controller, false);
  });

  command('remoteAgentSessions.importLegacy', async (item) => {
    const controller = await resolveHost(item, provider);
    if (!controller) return;
    const remoteHome = await controller.ssh.homeDirectory();
    const legacyPath = await vscode.window.showInputBox({
      title: `Import 1.x Metadata from ${controller.host.label}`,
      value: path.posix.join(remoteHome, '.vscode-server/data/User/globalStorage/local.remote-agent-sessions/sessions.json'),
      validateInput: validateRemoteDirectoryInput
    });
    if (!legacyPath) return;
    const data = JSON.parse(await controller.ssh.readText(legacyPath));
    if (data.schemaVersion !== 1) throw new Error('Unsupported legacy database format');
    const imported = validateRecords(data.sessions);
    let added = 0;
    await controller.manager.store.transaction((records) => {
      for (const source of imported) {
        if (records.some((record) => record.id === source.id || record.tmuxSession === source.tmuxSession)) continue;
        records.push({ ...structuredClone(source), host: controller.host.id });
        added += 1;
      }
    });
    await provider.refresh(controller);
    vscode.window.showInformationMessage(`Imported ${added} session record(s); the remote 1.x file was left unchanged.`);
  });

  command('remoteAgentSessions.importBackup', async () => {
    const selected = await vscode.window.showOpenDialog({
      title: 'Import TmuxDock Session Backup',
      canSelectMany: false,
      filters: { JSON: ['json'] }
    });
    if (!selected?.length) return;
    const contents = Buffer.from(await vscode.workspace.fs.readFile(selected[0])).toString('utf8');
    const backup = parseBackup(JSON.parse(contents));
    const sessionCount = backup.hosts.reduce((count, entry) => count + entry.sessions.length, 0);
    const answer = await vscode.window.showWarningMessage(
      `Import ${backup.hosts.length} SSH host(s) and ${sessionCount} saved session record(s)?`,
      { modal: true, detail: 'Existing hosts and session records are preserved; matching records are skipped.' },
      'Import Backup'
    );
    if (answer !== 'Import Backup') return;

    let addedHosts = 0;
    let addedSessions = 0;
    let skippedSessions = 0;
    for (const source of backup.hosts) {
      let target = registry.list().find((host) => host.sshHost === source.host.sshHost && host.socketName === source.host.socketName);
      if (!target) {
        const usedIds = new Set(registry.list().map((host) => host.id));
        target = await registry.add(usedIds.has(source.host.id) ? { ...source.host, id: undefined } : source.host);
        addedHosts += 1;
      }
      const databasePath = path.join(context.globalStorageUri.fsPath, 'hosts', safeFileName(target.id), 'sessions.json');
      const store = new SessionStore(databasePath);
      await store.transaction((records) => {
        const result = mergeRecords(records, source.sessions, target.id);
        addedSessions += result.added;
        skippedSessions += result.skipped;
      });
    }
    await provider.reloadHosts();
    vscode.window.showInformationMessage(
      `Imported ${addedHosts} host(s) and ${addedSessions} session record(s)` +
      (skippedSessions ? `; skipped ${skippedSessions} matching record(s).` : '.')
    );
  });

  command('remoteAgentSessions.export', async () => {
    await provider.refresh(undefined, false);
    const destination = await vscode.window.showSaveDialog({
      title: 'Export All TmuxDock Metadata',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'remote-agent-sessions-backup.json')),
      filters: { JSON: ['json'] }
    });
    if (!destination) return;
    const hosts = [];
    for (const controller of provider.controllers) hosts.push({ host: controller.host, sessions: await controller.manager.store.load() });
    await vscode.workspace.fs.writeFile(destination, Buffer.from(JSON.stringify({ schemaVersion: 2, exportedAt: new Date().toISOString(), hosts }, null, 2)));
    if (destination.scheme === 'file') await require('node:fs/promises').chmod(destination.fsPath, 0o600);
  });

  await provider.reloadHosts();
  if (!provider.controllers.length) {
    status.text = '$(remote) Add SSH Host';
    status.tooltip = 'Open TmuxDock and add an SSH host';
  }

  let refreshQueued = false;
  const interval = setInterval(() => {
    if (refreshQueued) return;
    refreshQueued = true;
    operation = operation.then(() => provider.refresh()).catch(() => {}).finally(() => { refreshQueued = false; });
  }, Math.max(10, configuration.get('refreshInterval', 30)) * 1000);
  context.subscriptions.push(
    { dispose: () => clearInterval(interval) },
    vscode.window.onDidCloseTerminal((terminal) => {
      for (const [key, value] of terminals) if (value === terminal) terminals.delete(key);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('remoteAgentSessions.sshPath') || event.affectsConfiguration('remoteAgentSessions.connectTimeout') ||
          event.affectsConfiguration('remoteAgentSessions.multiplexSsh')) {
        vscode.window.showInformationMessage('Reload this VS Code window to apply SSH transport settings.');
      }
    })
  );
  return { registry, provider, get controllers() { return provider.controllers; } };
}

function deactivate() {}

async function resolveHost(item, provider) {
  if (item?.controller) return item.controller;
  if (!provider.controllers.length) {
    vscode.window.showInformationMessage('Add an SSH host first.');
    return null;
  }
  if (provider.controllers.length === 1) return provider.controllers[0];
  const selected = await vscode.window.showQuickPick(provider.controllers.map((controller) => ({
    label: controller.host.label,
    description: `${controller.host.sshHost} · ${controller.online ? 'online' : 'offline'}`,
    controller
  })), { title: 'Choose an SSH host' });
  return selected?.controller || null;
}

async function resolveSession(item, provider, predicate) {
  if (item?.kind === 'session') {
    await item.controller.refresh();
    const entry = item.controller.manager.entries.find((candidate) => candidate.id === item.entry.id);
    if (entry && predicate(entry)) return { controller: item.controller, entry };
    vscode.window.showInformationMessage('This session changed. Refresh and select it again.');
    return null;
  }
  const controller = await resolveHost(item, provider);
  if (!controller) return null;
  await controller.refresh();
  const candidates = controller.manager.entries.filter(predicate);
  if (!candidates.length) { vscode.window.showInformationMessage('No matching sessions found.'); return null; }
  if (candidates.length === 1) return { controller, entry: candidates[0] };
  const selected = await vscode.window.showQuickPick(candidates.map((entry) => ({
    label: entry.title, description: `${entry.status} · ${entry.tmuxSession}`, entry
  })), { title: `Choose a session on ${controller.host.label}` });
  return selected ? { controller, entry: selected.entry } : null;
}

async function chooseRemoteWorkingDirectory(controller) {
  const current = currentRemoteHost();
  const folder = current === controller.host.sshHost
    ? vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === 'vscode-remote')
    : null;
  const fallback = folder?.uri.path || controller.host.defaultCwd || await controller.ssh.homeDirectory();
  return browseRemoteWorkingDirectory(controller, fallback);
}

function browseRemoteWorkingDirectory(controller, initialDirectory) {
  return new Promise((resolve) => {
    const picker = vscode.window.createQuickPick();
    picker.title = `Working Directory on ${controller.host.label}`;
    picker.placeholder = 'Type an absolute path, or choose a child directory';
    picker.matchOnDescription = true;
    picker.value = initialDirectory;
    let generation = 0;
    let timer;
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      picker.hide();
      picker.dispose();
      resolve(value);
    };
    const load = async (input) => {
      const token = ++generation;
      const requested = input.trim();
      if (validateRemoteDirectoryInput(requested)) {
        picker.items = [{ label: '$(warning) Enter an absolute remote path', description: requested }];
        return;
      }
      picker.busy = true;
      try {
        let directory = requested;
        let children;
        let exact = true;
        try { children = await controller.ssh.listDirectories(directory); }
        catch {
          exact = false;
          directory = path.posix.dirname(requested);
          children = await controller.ssh.listDirectories(directory);
        }
        if (token !== generation || settled) return;
        const prefix = exact ? '' : path.posix.basename(requested).toLocaleLowerCase();
        const visible = children.filter((child) => !prefix || path.posix.basename(child).toLocaleLowerCase().startsWith(prefix));
        picker.items = [
          ...(exact ? [{ label: '$(check) Use this directory', description: directory, directory, accept: true }] : []),
          ...(directory === '/' ? [] : [{ label: '$(arrow-up) Parent directory', description: path.posix.dirname(directory), directory: path.posix.dirname(directory) }]),
          ...visible.map((child) => ({ label: `$(folder) ${path.posix.basename(child)}`, description: child, directory: child }))
        ];
        if (!picker.items.length) picker.items = [{ label: '$(info) No matching subdirectories', description: requested }];
      } catch (error) {
        if (token === generation && !settled) picker.items = [{ label: '$(error) Cannot list this directory', description: humanError(error) }];
      } finally {
        if (token === generation && !settled) picker.busy = false;
      }
    };

    picker.onDidChangeValue((value) => {
      clearTimeout(timer);
      timer = setTimeout(() => load(value), 250);
    });
    picker.onDidAccept(async () => {
      const item = picker.activeItems[0];
      if (item?.accept) return finish(item.directory);
      if (item?.directory) {
        picker.value = item.directory;
        await load(item.directory);
        return;
      }
      const directory = picker.value.trim();
      try { await controller.ssh.checkDirectory(directory); finish(directory); }
      catch (error) { picker.items = [{ label: '$(error) Cannot use this directory', description: humanError(error) }]; }
    });
    picker.onDidHide(() => finish(null));
    picker.show();
    load(initialDirectory);
  });
}

async function chooseAgentCommand() {
  const choice = await vscode.window.showQuickPick([
    { label: 'Shell only', description: 'Start an empty persistent shell', agent: null, command: null },
    { label: 'Claude Code CLI', description: 'Run claude inside tmux', agent: { type: 'claude' }, command: 'claude' },
    { label: 'Codex CLI', description: 'Run codex inside tmux', agent: { type: 'codex' }, command: 'codex' },
    { label: 'Custom command…', description: 'Run another terminal Agent', custom: true }
  ], { title: 'What should the remote tmux window start?' });
  if (!choice) return null;
  if (!choice.custom) return choice;
  const command = await vscode.window.showInputBox({
    title: 'Agent Start Command', prompt: 'One line; do not include credentials',
    validateInput: (value) => value.trim() && !/[\0\r\n]/.test(value) ? null : 'Enter one command line'
  });
  return command ? { agent: { type: 'custom' }, command: command.trim() } : null;
}

async function chooseRestoreCommandPolicy(record, configuration) {
  const commands = (record.windows || []).flatMap((window) => (window.panes?.length ? window.panes : [window]).map((pane) => pane.command).filter(Boolean));
  if (!commands.length) return false;
  const policy = configuration.get('restoreCommands', 'ask');
  if (policy === 'always') return true;
  if (policy === 'never') return false;
  const answer = await vscode.window.showWarningMessage(
    `Rebuild ${record.title}. Run its saved startup commands?`,
    { modal: true, detail: commands.join('\n') }, 'Restore and Run Commands', 'Restore Shells Only'
  );
  return answer === 'Restore and Run Commands' ? true : answer === 'Restore Shells Only' ? false : undefined;
}

async function attachEntry(controller, entry) {
  if (!entry) return;
  const live = (await controller.tmux.list()).find((session) => session.name === entry.tmuxSession);
  if (!live || (entry.record && !owns(entry.record, live))) throw new Error('Session is unavailable or its identity changed');
  const key = `${controller.host.id}:${entry.id}`;
  const existing = terminals.get(key);
  if (existing && existing.exitStatus === undefined) { existing.show(); return; }
  const tmuxArgs = ['-u', ...controller.tmux.prefixArgs, 'attach-session', '-t', `=${entry.tmuxSession}`];
  const sameRemote = currentRemoteHost() === controller.host.sshHost;
  const location = controller.configuration.get('sessionTerminalLocation', 'editor') === 'panel'
    ? vscode.TerminalLocation.Panel
    : { viewColumn: vscode.ViewColumn.Active, preserveFocus: false };
  const terminal = vscode.window.createTerminal({
    name: `${controller.host.label}: ${entry.title}`,
    shellPath: sameRemote ? controller.host.tmuxPath : controller.ssh.sshPath,
    shellArgs: sameRemote ? tmuxArgs : controller.ssh.terminalArgs(controller.host.tmuxPath, tmuxArgs),
    env: { TMUX: null },
    location,
    isTransient: true,
    message: 'Closing this terminal detaches from tmux; it does not terminate the remote task.\r\n'
  });
  terminals.set(key, terminal);
  terminal.show();
  if (entry.record) await controller.manager.markAttached(entry.record);
}

function currentRemoteHost() {
  const folder = vscode.workspace.workspaceFolders?.find((candidate) => candidate.uri.scheme === 'vscode-remote');
  const prefix = 'ssh-remote+';
  if (!folder?.uri.authority.startsWith(prefix)) return null;
  const value = folder.uri.authority.slice(prefix.length);
  try { return decodeURIComponent(value); } catch { return value; }
}

function buildDescription(entry) {
  const parts = [];
  if (entry.record?.gitBranch) parts.push(entry.record.gitBranch);
  if (entry.status === 'recoverable') parts.push('rebuild available');
  return parts.join(' · ');
}

function buildTooltip(controller, entry) {
  const markdown = new vscode.MarkdownString();
  markdown.appendMarkdown(`**${escapeMarkdown(entry.title)}** on **${escapeMarkdown(controller.host.label)}**\n\n`);
  markdown.appendMarkdown(`Status: ${entry.status}  \nSSH host: \`${escapeInline(controller.host.sshHost)}\`  \ntmux: \`${escapeInline(entry.tmuxSession)}\`  \n`);
  if (entry.cwd) markdown.appendMarkdown(`Directory: \`${escapeInline(entry.cwd)}\`  \n`);
  if (entry.record?.note) markdown.appendMarkdown(`\n${escapeMarkdown(entry.record.note)}`);
  return markdown;
}

function detailsMarkdown(controller, entry) {
  const record = entry.record;
  const lines = [
    `# ${entry.title}`, '',
    `- Host: **${controller.host.label}** (\`${controller.host.sshHost}\`)`,
    `- Status: **${entry.status}**`, `- tmux session: \`${entry.tmuxSession}\``,
    `- Recovery metadata: ${entry.managed ? 'enabled' : 'not enabled'}`
  ];
  if (entry.cwd) lines.push(`- Working directory: \`${entry.cwd}\``);
  if (record?.repoRoot) lines.push(`- Repository: \`${record.repoRoot}\``);
  if (record?.gitBranch) lines.push(`- Git branch: \`${record.gitBranch}\``);
  if (record?.agent?.type) lines.push(`- Agent: \`${record.agent.type}\``);
  if (record?.note) lines.push('', '## Note', '', record.note);
  if (record?.windows?.length) {
    lines.push('', '## Restore manifest', '');
    for (const window of record.windows) {
      lines.push(`- **${window.name}** — \`${window.cwd || record.cwd}\``);
      for (const [index, pane] of (window.panes || []).entries()) {
        lines.push(`  - Pane ${index + 1}: \`${pane.cwd}\` — restore: \`${pane.command || 'shell only'}\``);
      }
    }
  }
  if (record?.events?.length) {
    lines.push('', '## Recent history', '');
    for (const event of [...record.events].reverse()) lines.push(`- ${event.at}: **${event.type}** — ${event.message}`);
  }
  lines.push('', '---', '', `Local metadata: \`${controller.databasePath}\``);
  lines.push('', '> The controller runs locally. SSH credentials stay with OpenSSH. Agent conversation history belongs to the Agent CLI, not this extension.');
  return lines.join('\n');
}

function validateSshHostInput(value) {
  const text = value.trim();
  if (!text) return 'An SSH host is required';
  if (text.startsWith('-') || /[\s\0\r\n]/.test(text)) return 'Use an SSH alias or user@host without spaces';
  return null;
}

function validateRemoteDirectoryInput(value) {
  if (!value.startsWith('/') || /[\0\r\n]/.test(value)) return 'Use an absolute remote path';
  return null;
}

function validateSocketNameInput(value) {
  return value && !/^[A-Za-z0-9_.-]+$/.test(value) ? 'Use only letters, digits, dot, underscore and dash' : null;
}

function validateTmuxNameInput(value) {
  try { checkTmuxName(value.trim()); return null; }
  catch (error) { return error.message; }
}

function validateRemoteExecutableInput(value) {
  if (!value.trim() || value.trim().startsWith('-') || /[\0\r\n]/.test(value)) return 'Enter a remote executable name or path';
  return null;
}

function safeFileName(value) { return Buffer.from(String(value)).toString('hex').slice(0, 128); }
function escapeMarkdown(value) { return String(value).replace(/[\\`*_{}[\]()#+\-.!]/g, '\\$&'); }
function escapeInline(value) { return String(value).replace(/`/g, '\\`'); }
function humanError(error) {
  if (!error) return 'Not connected';
  const message = error instanceof Error ? error.message : String(error);
  if (/permission denied|publickey|password/i.test(message)) return `${message}. Verify the host once in a normal SSH terminal and load its key into ssh-agent.`;
  if (/host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(message)) return `${message}. Review the host key manually; TmuxDock will not bypass SSH verification.`;
  return `TmuxDock: ${message}`;
}

module.exports = {
  HostController, MultiHostTreeProvider, activate, attachEntry, currentRemoteHost, deactivate,
  browseRemoteWorkingDirectory, detailsMarkdown, validateRemoteDirectoryInput, validateRemoteExecutableInput, validateSocketNameInput,
  validateSshHostInput, validateTmuxNameInput
};
