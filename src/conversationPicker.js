'use strict';

const { UUID } = require('./agentSessions');

// History is user-controlled text, not Markdown or QuickPick icon markup.
function plain(value, limit = 240) {
  return String(value || '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\$\(/g, '＄(').slice(0, limit);
}
function timestamp(seconds) {
  if (!Number.isFinite(seconds)) return '';
  const date = new Date(seconds * 1000);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : '';
}
function conversationItems(conversations, record) {
  return [...conversations].sort((a, b) =>
    Number(b.id === record.agent?.sessionId) - Number(a.id === record.agent?.sessionId) ||
    Number(b.name === record.title) - Number(a.name === record.title) ||
    Number(b.cwd === record.cwd) - Number(a.cwd === record.cwd) || (b.updatedAt || 0) - (a.updatedAt || 0)
  ).map(thread => ({
    label: plain(thread.name || thread.preview || 'Untitled Codex conversation'),
    description: [thread.cwd === record.cwd ? 'Same directory' : '', thread.name === record.title ? 'Same name' : '',
      thread.archived ? 'Archived' : '', timestamp(thread.updatedAt || thread.createdAt)].filter(Boolean).join(' · '),
    detail: [plain(thread.preview, 300), plain(thread.cwd, 1024), thread.id].filter(Boolean).join(' · '),
    conversation: thread
  }));
}

async function chooseCodexConversation(ui, agents, record, hostLabel) {
  const selection = await new Promise(resolve => {
    const picker = ui.createQuickPick();
    picker.matchOnDescription = true; picker.matchOnDetail = true; picker.ignoreFocusOut = true;
    let settled = false, busy = false, archived = false, allDirectories = !record.cwd;
    let conversations = [], nextCursor = null, error = null;
    const subscriptions = [];
    const finish = value => {
      if (settled) return;
      settled = true;
      for (const subscription of subscriptions) subscription.dispose();
      picker.hide(); picker.dispose(); resolve(value);
    };
    const action = (label, value, detail) => ({ label, action: value, detail, alwaysShow: true });
    const render = () => {
      picker.title = `Choose ${archived ? 'Archived ' : ''}Original Codex Conversation · ${plain(record.title, 80)} · ${plain(hostLabel, 60)}`;
      picker.placeholder = archived ? 'Choose a history to unarchive and link; search title, date or directory.'
        : 'Choose the original history to link; search title, date or directory.';
      picker.items = [
        ...(error ? [action('$(warning) Could not load history — retry', 'retry', plain(error.message, 300))] : []),
        ...conversationItems(conversations, record),
        ...(!error && !busy && !conversations.length ? [action('No history found in this view', 'none',
          'Try all directories, archived histories, or enter a known conversation ID.')] : []),
        ...(nextCursor ? [action('$(history) Load older conversations', 'more')] : []),
        ...(record.cwd ? [action(allDirectories ? '$(folder) Show this session’s directory only' : '$(folder) Show all directories', 'directories')] : []),
        action(archived ? '$(history) Show active histories' : '$(archive) Show archived histories', 'archive'),
        action('$(edit) Enter conversation ID manually…', 'manual')
      ];
    };
    const load = async reset => {
      if (busy || settled) return;
      busy = true; picker.busy = true; error = null;
      if (reset) { conversations = []; nextCursor = null; }
      render();
      try {
        const page = await agents.listCodexConversations({ cwd: allDirectories ? undefined : record.cwd,
          archived, cursor: nextCursor });
        if (settled) return;
        const known = new Set(conversations.map(thread => thread.id));
        conversations.push(...page.conversations.filter(thread => !known.has(thread.id) && known.add(thread.id)));
        nextCursor = page.nextCursor !== nextCursor ? page.nextCursor : null;
      } catch (cause) { if (!settled) error = cause; }
      finally {
        busy = false;
        if (!settled) {
          picker.busy = false; render();
          if (reset && conversations.length) picker.activeItems = [picker.items.find(item => item.conversation)];
        }
      }
    };
    subscriptions.push(picker.onDidHide(() => finish(undefined)));
    subscriptions.push(picker.onDidAccept(() => {
      if (settled) return;
      const selected = picker.selectedItems[0] || picker.activeItems[0];
      if (selected?.action === 'manual') return finish({ manual: true });
      if (busy) return;
      if (selected?.conversation) {
        const current = conversations.find(thread => thread.id === selected.conversation.id);
        if (current) finish({ sessionId: current.id, archived: current.archived });
        return;
      }
      if (selected?.action === 'directories') { allDirectories = !allDirectories; return void load(true); }
      if (selected?.action === 'archive') { archived = !archived; return void load(true); }
      if (selected?.action === 'more') return void load(false);
      if (selected?.action === 'retry') return void load(false);
    }));
    render(); picker.show(); void load(true);
  });
  if (!selection?.manual) return selection;
  const id = await ui.showInputBox({ title: 'Bind Original Codex Conversation',
    prompt: 'Enter the original conversation UUID. It will be verified before linking.', value: record.agent?.sessionId || '',
    validateInput: value => UUID.test(value.trim()) ? null : 'Enter a conversation UUID, not a name or --last' });
  return id?.trim() ? { sessionId: id.trim(), archived: false } : undefined;
}

module.exports = { chooseCodexConversation, conversationItems };
