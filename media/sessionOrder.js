/* global acquireVsCodeApi */
'use strict';

const vscode = acquireVsCodeApi();
const sections = document.querySelector('#sections');
const status = document.querySelector('#status');
let drag;
let moving;
let marker;
let deferredLayout;
let saving = false;
let restoreFocus;
const selectedRows = new Set();

function showSelection() {
  for (const row of sections.querySelectorAll('.session-row[data-kind]')) {
    const selected = selectedRows.has(row.dataset.key);
    row.setAttribute('aria-selected', String(selected));
  }
}

function make(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

function draggable(node, kind, key) {
  Object.assign(node.dataset, { kind, key });
  node.draggable = true;
  node.tabIndex = 0;
  node.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
  node.title = 'Drag to reorder or press Alt+↑ / Alt+↓';
  const grip = make('span', 'grip', '⠿');
  grip.setAttribute('aria-hidden', 'true');
  node.prepend(grip);
}

function render(layout) {
  sections.replaceChildren();
  status.textContent = layout.message;
  for (const group of layout.sections) {
    const section = make('section', 'order-section');
    section.dataset.group = group.group;
    if (group.categoryId !== null) section.dataset.category = group.categoryId;
    const heading = make('h2', 'section-title', group.title);
    if (group.categoryId !== null) draggable(heading, 'category', group.categoryId);
    const list = make('div', 'session-list');
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', group.title);
    list.setAttribute('aria-multiselectable', 'true');
    for (const item of group.rows) {
      const row = make('div', 'session-row', item.title);
      row.setAttribute('role', 'option');
      row.dataset.session = item.key;
      if (!item.fixed) draggable(row, 'session', item.key);
      if (item.forks) row.append(make('span', 'forks', `${item.forks} fork${item.forks === 1 ? '' : 's'}`));
      if (item.fixed) {
        row.setAttribute('aria-disabled', 'true');
        row.append(make('span', 'forks', 'Fork'));
      }
      list.append(row);
    }
    if (!group.rows.length) list.append(make('div', 'empty', 'No sessions'));
    section.append(heading, list);
    sections.append(section);
  }
  const available = new Set([...sections.querySelectorAll('.session-row[data-kind]')].map(row => row.dataset.key));
  for (const key of selectedRows) if (!available.has(key)) selectedRows.delete(key);
  showSelection();
  if (restoreFocus) {
    [...sections.querySelectorAll('[data-kind]')].find(node =>
      node.dataset.kind === restoreFocus.kind && node.dataset.key === restoreFocus.key)?.focus();
    restoreFocus = undefined;
  }
}

function mark(node, side) {
  const cls = side && 'insert-' + side;
  if (marker?.node === node && marker?.cls === cls) return;
  if (marker) marker.node.classList.remove(marker.cls);
  marker = node && { node, cls };
  if (marker) node.classList.add(cls);
}

function send(source, before, section, keys = [source.dataset.key]) {
  saving = true;
  status.textContent = '';
  vscode.postMessage({ type: 'move', kind: source.dataset.kind, entry: source.dataset.key, keys, before,
    group: section.dataset.group, categoryId: section.dataset.category ?? null });
}

function locate(event) {
  const section = event.target.closest('.order-section');
  if (!drag || !section) return;
  const kind = drag.dataset.kind;
  if (kind === 'category') {
    const heading = event.target.closest('.section-title[data-kind="category"]');
    if (!heading || heading === drag) return;
    const rect = heading.getBoundingClientRect();
    const after = event.clientY >= (rect.top + rect.bottom) / 2;
    const before = (after ? section.nextElementSibling : section)?.dataset.category ?? null;
    return { section, node: section, side: after ? 'after' : 'before', before };
  }
  if (section.dataset.group !== drag.closest('.order-section').dataset.group) return;
  const row = event.target.closest('.session-row, .empty');
  if (!row || row === drag) return;
  const rect = row.getBoundingClientRect();
  const after = row.classList.contains('empty') || event.clientY >= (rect.top + rect.bottom) / 2;
  let anchor = after ? row.nextElementSibling : row;
  while (anchor && moving.has(anchor.dataset.session)) anchor = anchor.nextElementSibling;
  const before = anchor?.dataset.session ?? null;
  return { section, node: row, side: after ? 'after' : 'before', before };
}

function stopDrag() {
  drag?.classList.remove('drag-source');
  drag = undefined;
  moving = undefined;
  mark();
  if (!saving && deferredLayout) {
    const layout = deferredLayout;
    deferredLayout = undefined;
    render(layout);
  }
}

sections.addEventListener('dragstart', event => {
  const source = event.target.closest('[data-kind][draggable="true"]');
  if (!source || saving) return event.preventDefault();
  drag = source;
  moving = new Set([source.dataset.key]);
  if (source.dataset.kind === 'session' && selectedRows.has(source.dataset.key)) {
    const group = source.closest('.order-section').dataset.group;
    for (const row of sections.querySelectorAll('.session-row[aria-selected="true"]')) {
      if (row.closest('.order-section').dataset.group === group) moving.add(row.dataset.key);
    }
  }
  drag.classList.add('drag-source');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', source.dataset.key);
});

sections.addEventListener('dragover', event => {
  const drop = locate(event);
  if (!drop) return mark();
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  mark(drop.node, drop.side);
});

sections.addEventListener('dragleave', event => {
  if (!sections.contains(event.relatedTarget)) mark();
});
sections.addEventListener('dragend', stopDrag);
sections.addEventListener('drop', event => {
  const drop = locate(event);
  if (!drop) return stopDrag();
  event.preventDefault();
  // A drop immediately after the preceding item can point back at the source.
  if (drop.before !== drag.dataset.key) send(drag, drop.before, drop.section, [...moving]);
  stopDrag();
});

sections.addEventListener('click', event => {
  const row = event.target.closest('.session-row[data-kind]');
  if (!row || saving) return;
  if (event.metaKey || event.ctrlKey) {
    const group = row.closest('.order-section').dataset.group;
    for (const item of sections.querySelectorAll('.session-row[aria-selected="true"]')) {
      if (item.closest('.order-section').dataset.group !== group) selectedRows.delete(item.dataset.key);
    }
    if (selectedRows.has(row.dataset.key)) selectedRows.delete(row.dataset.key);
    else selectedRows.add(row.dataset.key);
  } else {
    selectedRows.clear();
    selectedRows.add(row.dataset.key);
  }
  showSelection();
});

sections.addEventListener('keydown', event => {
  const source = event.target.closest('[data-kind]');
  if (!source || saving || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
  const section = source.closest('.order-section');
  const category = source.dataset.kind === 'category';
  const items = category ? [...sections.querySelectorAll('.order-section[data-category]')]
    : [...source.parentElement.querySelectorAll('.session-row')];
  const index = items.indexOf(category ? section : source);
  const up = event.key === 'ArrowUp';
  if (up ? index <= 0 : index >= items.length - 1) return;
  event.preventDefault();
  const before = items[index + (up ? -1 : 2)]?.dataset;
  restoreFocus = { kind: source.dataset.kind, key: source.dataset.key };
  send(source, (category ? before?.category : before?.session) ?? null, section);
});

window.addEventListener('message', ({ data }) => {
  if (data?.type !== 'layout') return;
  if (data.done) saving = false;
  if (drag || saving) {
    deferredLayout = data;
  } else {
    deferredLayout = undefined;
    render(data);
  }
});

vscode.postMessage({ type: 'ready' });
