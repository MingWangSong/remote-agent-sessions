'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { terminalTitle, bannerText } = require('../src/terminalTitle');

test('terminal titles stay short and only add a number when there is a collision', () => {
  assert.equal(terminalTitle('修复任务', new Set()), '修复任务');
  assert.equal(terminalTitle('task', new Set(['task', 'task · 2', 'other'])), 'task · 3');
  assert.equal(terminalTitle('task', new Set(['other task'])), 'task');
});

test('terminal identification banner cannot inject terminal control characters', () => {
  assert.equal(bannerText('host\u001b[31m\nname'), 'host[31mname');
});
