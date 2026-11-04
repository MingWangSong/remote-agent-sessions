'use strict';

function commandType(command) {
  if (typeof command !== 'string') return null;
  const text = command.trim().replace(/^(?:(?:env|exec|command)\s+|[A-Za-z_]\w*=[^\s]+\s+)*/, '');
  const token = text.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  const executable = (token?.[1] || token?.[2] || token?.[3] || '').split(/[\\/]/).pop().replace(/\.(exe|cmd)$/i, '').toLowerCase();
  return executable === 'codex' || executable === 'claude' ? executable : null;
}

function sessionType(entry) {
  const active = commandType(entry.live?.currentCommand);
  if (active) return active;
  const declared = entry.record?.agent?.type;
  const liveTypes = (entry.live?.commands || []).map(commandType).filter(Boolean);
  if (liveTypes.length) return liveTypes.includes(declared) ? declared : liveTypes[0];
  if (declared === 'codex' || declared === 'claude') return declared;
  const panes = (entry.record?.windows || []).flatMap(window => window.panes?.length ? window.panes : [window]);
  for (const pane of panes) {
    const type = commandType(pane.currentCommand) || commandType(pane.command);
    if (type) return type;
  }
  return 'shell';
}

const TYPE_ICONS = {
  codex: { light: 'brands/codex-light.svg', dark: 'brands/codex-dark.svg' },
  claude: { light: 'brands/claude.svg', dark: 'brands/claude.svg' },
  shell: 'terminal'
};
const TYPE_LABELS = { codex: 'Codex', claude: 'Claude', shell: 'Shell / custom command' };
module.exports = { commandType, sessionType, TYPE_ICONS, TYPE_LABELS };
