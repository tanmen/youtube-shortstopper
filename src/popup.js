'use strict';

const SNOOZE_MS = 15 * 60 * 1000;

const $ = (id) => document.getElementById(id);

function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function render(state) {
  const count = state.today && state.today.day === dayKey() ? state.today.count : 0;
  $('count').textContent = String(count);
  $('countNote').textContent =
    count === 0 ? '今日はまだ見ていません' : count >= 20 ? 'そろそろ区切りどきかもしれません' : '';

  const left = (state.snoozeUntil || 0) - Date.now();
  const on = left > 0;
  $('snoozeState').textContent = on
    ? `一時解除中 — あと ${Math.ceil(left / 60000)} 分で自動で戻ります`
    : '制御は有効です';
  $('snoozeState').classList.toggle('is-off', on);
  $('snooze15').hidden = on;
  $('unsnooze').hidden = !on;
}

function refresh() {
  chrome.storage.local.get({ snoozeUntil: 0, today: null }, render);
}

$('snooze15').addEventListener('click', () => {
  chrome.storage.local.set({ snoozeUntil: Date.now() + SNOOZE_MS }, refresh);
});

$('unsnooze').addEventListener('click', () => {
  chrome.storage.local.set({ snoozeUntil: 0 }, refresh);
});

$('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

refresh();
setInterval(refresh, 1000);
