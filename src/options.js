'use strict';

const DEFAULTS = {
  blockScroll: true,
  breakLoop: true,
  cooldownSec: 5,
  noticeCorner: 'br',
  nudgeEvery: 10,
};

const $ = (id) => document.getElementById(id);

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

let savedTimer = null;

function flashSaved() {
  $('saved').hidden = false;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => {
    $('saved').hidden = true;
  }, 1200);
}

function paintSliders() {
  const c = Number($('cooldownSec').value);
  $('cooldownOut').textContent = c === 0 ? '待ちなし' : `${c} 秒`;
  const n = Number($('nudgeEvery').value);
  $('nudgeOut').textContent = n === 0 ? '出さない' : `${n} 本ごと`;
}

function save() {
  const values = {
    blockScroll: $('blockScroll').checked,
    breakLoop: $('breakLoop').checked,
    cooldownSec: Number($('cooldownSec').value),
    noticeCorner: $('noticeCorner').value === 'tr' ? 'tr' : 'br',
    nudgeEvery: Number($('nudgeEvery').value),
  };
  chrome.storage.sync.set(values, flashSaved);
}

chrome.storage.sync.get(DEFAULTS, (v) => {
  $('blockScroll').checked = v.blockScroll;
  $('breakLoop').checked = v.breakLoop;
  $('cooldownSec').value = String(v.cooldownSec);
  $('noticeCorner').value = v.noticeCorner === 'tr' ? 'tr' : 'br';
  $('nudgeEvery').value = String(v.nudgeEvery);
  paintSliders();
});

for (const id of ['blockScroll', 'breakLoop', 'noticeCorner']) {
  $(id).addEventListener('change', save);
}
for (const id of ['cooldownSec', 'nudgeEvery']) {
  $(id).addEventListener('input', paintSliders);
  $(id).addEventListener('change', save);
}

function paintStats() {
  chrome.storage.local.get({ today: null }, ({ today }) => {
    const n = today && today.day === dayKey() ? today.count : 0;
    $('statsLine').textContent = `今日見た Shorts: ${n} 本`;
  });
}

$('resetCount').addEventListener('click', () => {
  chrome.storage.local.set({ today: { day: dayKey(), count: 0 } }, paintStats);
});

paintStats();
