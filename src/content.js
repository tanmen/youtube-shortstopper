/*
 * YouTube ShortStopper - content script
 *
 * 方針:
 *   - Shorts を「見れなくする」ことはしない。惰性で次に流れる経路だけを塞ぐ。
 *   - 触るのは https://www.youtube.com/shorts/* だけ。watch ページ・ホーム・
 *     music.youtube.com（別ホストなので manifest の matches にも入っていない）は素通り。
 *
 * 止めるもの:
 *   1. ループ再生            … 終端の手前で pause する（デスクトップの player は
 *                              video.loop を使わず内部で巻き戻すため、属性を外すだけでは効かない）
 *   2. 自動送り              … 同上。'ended' を発火させなければ次に進まない
 *   3. ホイール/スワイプ/矢印キーでの移動 … capture 段で握りつぶす
 *
 * 残すもの: 再生・一時停止・シーク・音量・コメント欄のスクロール・
 *           意図的なクリックによる「次へ」
 */
(() => {
  'use strict';

  const DEFAULTS = {
    blockScroll: true, // ホイール/スワイプ/矢印キーでの移動を止める
    breakLoop: true, // ループと自動送りを止める
    cooldownSec: 5, // 「次へ」が押せるようになるまでの秒数
    noticeCorner: 'br', // 制限中ポップアップの位置: 'br' = 右下 / 'tr' = 右上
    nudgeEvery: 10, // 何本ごとに強めの声かけを出すか (0 で無効)
  };

  // ---------------------------------------------------------------- 状態

  const settings = { ...DEFAULTS };
  let snoozeUntil = 0; // 一時解除の期限 (epoch ms)
  let today = { day: dayKey(), count: 0 }; // 今日見た本数
  let sessionCount = 0; // このタブで開いてから見た本数

  let video = null; // いま見ている <video>
  let currentId = ''; // いま見ている shorts の ID
  let countedId = ''; // 本数に数え終わった shorts の ID
  let stoppedId = ''; // 終端で止めた shorts の ID
  let cooldownStartedAt = 0;
  let lastTime = 0; // 直前の tick での currentTime（巻き戻しの検知用）
  let blockedCount = 0; // この short で操作を止めた回数

  const onShorts = () => location.pathname.startsWith('/shorts/');
  const shortsId = () => (location.pathname.match(/^\/shorts\/([^/?#]+)/) || [, ''])[1];
  const snoozing = () => Date.now() < snoozeUntil;
  /** いま制御を効かせてよいか */
  const active = () => !snoozing() && onShorts();

  function dayKey(d = new Date()) {
    // ローカル時間の YYYY-MM-DD。UTC にすると日付の変わり目が体感とずれる。
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  // ---------------------------------------------------------------- 設定の読み書き

  chrome.storage.sync.get(DEFAULTS, (v) => {
    if (chrome.runtime.lastError) return;
    Object.assign(settings, v);
    apply();
  });

  chrome.storage.local.get({ snoozeUntil: 0, today: null }, (v) => {
    if (chrome.runtime.lastError) return;
    snoozeUntil = v.snoozeUntil || 0;
    if (v.today && v.today.day === dayKey()) today = v.today;
    apply();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync') {
      for (const [k, { newValue }] of Object.entries(changes)) {
        if (k in settings) settings[k] = newValue;
      }
    } else if (area === 'local') {
      if (changes.snoozeUntil) snoozeUntil = changes.snoozeUntil.newValue || 0;
      if (changes.today && changes.today.newValue) {
        const t = changes.today.newValue;
        // 別タブが同じ日のカウントを進めていたら大きい方を採用する
        if (t.day === today.day) today.count = Math.max(today.count, t.count);
        else today = t;
      }
    }
    apply();
  });

  function bumpCount() {
    const d = dayKey();
    if (today.day !== d) today = { day: d, count: 0 };
    today.count += 1;
    sessionCount += 1;
    chrome.storage.local.set({ today });
  }

  // ---------------------------------------------------------------- 入力の遮断

  // コメント欄・各種パネル・ダイアログの中は素通しする。ここを塞ぐと
  // 「コメントが読めない」という別の壊れ方になる。
  const SCROLLABLE = [
    '#comments',
    '#panel-container',
    '#shorts-panel-container',
    'ytd-engagement-panel-section-list-renderer',
    'ytd-comments',
    'tp-yt-paper-dialog',
    'tp-yt-iron-dropdown',
    'ytd-popup-container',
    'ytd-multi-page-menu-renderer',
    '[role="dialog"]',
    '.ytp-panel',
  ].join(',');

  function passThrough(event) {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
    for (const node of path) {
      if (node && node.nodeType === 1 && node.matches && node.matches(SCROLLABLE)) return true;
    }
    return false;
  }

  function isTyping(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || node.isContentEditable === true;
  }

  const blockNav = () => active() && settings.blockScroll;

  function swallow(event, kind) {
    event.preventDefault();
    event.stopImmediatePropagation();
    notice(kind);
  }

  window.addEventListener(
    'wheel',
    (e) => {
      if (!blockNav() || passThrough(e)) return;
      swallow(e, 'ホイール');
    },
    { capture: true, passive: false }
  );

  // タッチ（トラックパッドのスワイプは wheel 側に来る）
  let touchStartY = null;
  window.addEventListener(
    'touchstart',
    (e) => {
      touchStartY = blockNav() && !passThrough(e) && e.touches[0] ? e.touches[0].clientY : null;
    },
    { capture: true, passive: true }
  );
  window.addEventListener(
    'touchmove',
    (e) => {
      if (touchStartY === null || !blockNav() || passThrough(e)) return;
      const y = e.touches[0] ? e.touches[0].clientY : touchStartY;
      if (Math.abs(y - touchStartY) < 12) return; // 微動は無視（タップ判定を壊さない）
      swallow(e, 'スワイプ');
    },
    { capture: true, passive: false }
  );

  // Shorts では上下キーが「前/次の動画」。左右・スペース・m/f などは触らない。
  const NAV_KEYS = new Set(['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End']);
  window.addEventListener(
    'keydown',
    (e) => {
      if (!blockNav()) return;
      if (e.__yss) return; // 「次へ進む」ボタンが自分で投げたキー
      if (!NAV_KEYS.has(e.key)) return;
      if (isTyping(e.target) || isTyping(document.activeElement)) return;
      if (passThrough(e)) return;
      swallow(e, '上下キー');
    },
    { capture: true }
  );

  // 終端に届いてしまった場合の保険。'ended' はバブルしないが、document の
  // capture 段には届くので、video 自身に付いた YouTube のハンドラより先に走る。
  document.addEventListener(
    'ended',
    (e) => {
      if (!active() || !settings.breakLoop) return;
      if (!(e.target instanceof HTMLVideoElement)) return;
      e.stopImmediatePropagation();
      stopHere(e.target);
    },
    true
  );

  // ---------------------------------------------------------------- 再生の監視

  function pickVideo() {
    const vids = [...document.querySelectorAll('video')].filter(
      (v) => v.currentSrc && Number.isFinite(v.duration) && v.duration > 0
    );
    if (vids.length <= 1) return vids[0] || null;

    // 前後の short の video も DOM に残ることがあるので、画面の中央に一番近い
    // ものを「いま見ている 1 本」とみなす。
    // ytd-reel-video-renderer の is-active のような属性は当てにしない ——
    // 2026-09-01 に実際の Shorts ページを見たところ、その属性は付いていなかった。
    // 属性が消えても位置で選べば壊れない。
    const centerY = window.innerHeight / 2;
    let best = null;
    let bestDist = Infinity;
    for (const v of vids) {
      const r = v.getBoundingClientRect();
      if (r.width < 40 || r.height < 40) continue;
      const dist = Math.abs(r.top + r.height / 2 - centerY);
      if (dist < bestDist) {
        bestDist = dist;
        best = v;
      }
    }
    return best || vids.find((v) => !v.paused) || vids[0];
  }

  // 50ms 間隔。timeupdate は 4回/秒 程度しか来ないので、終端の 0.15 秒手前で
  // 止めるにはこちらが要る（間に合わないと 'ended' → 自動送りが走る）。
  setInterval(tick, 50);

  function tick() {
    if (!onShorts()) {
      teardown();
      return;
    }
    const id = shortsId();
    if (id !== currentId) {
      currentId = id;
      stoppedId = '';
      cooldownStartedAt = 0;
      lastTime = 0;
      blockedCount = 0;
      hideOverlay();
    }

    const v = pickVideo();
    if (v !== video) {
      video = v;
      lastTime = 0;
    }
    if (!video) return;

    if (!active()) {
      lastTime = video.currentTime;
      updateBadge();
      return;
    }

    if (settings.breakLoop) {
      // モバイル版などは video の loop 属性でループする。デスクトップの player は
      // 使っていない（2026-09-01 実測: 再生中も loop は false）ので、これは保険。
      if (video.loop) video.loop = false;

      const d = video.duration;
      const t = video.currentTime;
      if (Number.isFinite(d) && d > 0) {
        // 本命。終端の手前で止めれば、ループも自動送りも 'ended' も起こらない。
        if (!video.paused && d - t <= 0.15) {
          stopHere(video);
        } else if (lastTime >= d - 1.5 && t < 1 && lastTime - t > 1) {
          // 取りこぼして player 内部のループで巻き戻された場合の受け止め。
          stopHere(video);
        }
      }
      lastTime = t;
    } else {
      lastTime = video.currentTime;
    }

    // 3 秒以上見たら「1 本見た」として数える
    if (currentId && countedId !== currentId && video.currentTime >= 3) {
      countedId = currentId;
      bumpCount();
    }

    updateBadge();
  }

  function stopHere(v) {
    try {
      v.pause();
    } catch (_) {
      /* 再生権限が無い等。止められなくても overlay は出す */
    }
    if (stoppedId === currentId) return;
    stoppedId = currentId;
    cooldownStartedAt = Date.now();
    if (currentId && countedId !== currentId) {
      countedId = currentId;
      bumpCount();
    }
    showOverlay();
  }

  function teardown() {
    video = null;
    currentId = '';
    stoppedId = '';
    hideOverlay();
    hideBadge();
  }

  // ---------------------------------------------------------------- 画面

  let ui = null;

  function ensureUi() {
    // document_start で走るので body がまだ無いことがある。その間は UI を作らない。
    if (!document.body) return null;
    if (ui && document.body.contains(ui.root)) return ui;
    const root = document.createElement('div');
    root.className = 'yss-root';
    root.innerHTML = `
      <div class="yss-badge" hidden>
        <span class="yss-badge-count"></span>
        <span class="yss-badge-label">本目</span>
      </div>
      <div class="yss-notice" hidden>
        <span class="yss-notice-mark" aria-hidden="true"></span>
        <span class="yss-notice-text">
          <span class="yss-notice-title">スクロール制限中</span>
          <span class="yss-notice-body">次の Shorts へは進みません。最後まで見ると、進むボタンが出ます。</span>
          <span class="yss-notice-meta"></span>
        </span>
      </div>
      <div class="yss-card" hidden>
        <p class="yss-title">ここで止めました</p>
        <p class="yss-sub"></p>
        <div class="yss-actions">
          <button type="button" class="yss-btn yss-again">もう一度見る</button>
          <button type="button" class="yss-btn yss-next"></button>
        </div>
        <button type="button" class="yss-link yss-leave">YouTube のホームに戻る</button>
      </div>
    `;
    document.body.appendChild(root);

    ui = {
      root,
      badge: root.querySelector('.yss-badge'),
      badgeCount: root.querySelector('.yss-badge-count'),
      notice: root.querySelector('.yss-notice'),
      noticeMeta: root.querySelector('.yss-notice-meta'),
      card: root.querySelector('.yss-card'),
      sub: root.querySelector('.yss-sub'),
      title: root.querySelector('.yss-title'),
      again: root.querySelector('.yss-again'),
      next: root.querySelector('.yss-next'),
      leave: root.querySelector('.yss-leave'),
    };

    ui.again.addEventListener('click', () => {
      hideOverlay();
      stoppedId = '';
      if (video) {
        video.currentTime = 0;
        video.play().catch(() => {});
      }
    });

    ui.next.addEventListener('click', () => {
      if (remainingCooldown() > 0) return;
      hideOverlay();
      goNext();
    });

    ui.leave.addEventListener('click', () => {
      location.assign('https://www.youtube.com/');
    });

    return ui;
  }

  function remainingCooldown() {
    if (!cooldownStartedAt) return 0;
    const left = settings.cooldownSec * 1000 - (Date.now() - cooldownStartedAt);
    return Math.max(0, Math.ceil(left / 1000));
  }

  /** YouTube 自身の「次の動画」ボタンを押す。無ければ矢印キーを合成して送る。 */
  function goNext() {
    const btn =
      document.querySelector('#navigation-button-down button') ||
      document.querySelector('#navigation-button-down .yt-spec-touch-feedback-shape') ||
      document.querySelector('#navigation-button-down');
    if (btn) {
      btn.click();
      return;
    }
    const ev = new KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', bubbles: true });
    ev.__yss = true;
    document.body.dispatchEvent(ev);
  }

  let cardTimer = null;

  function showOverlay() {
    const u = ensureUi();
    if (!u) return;
    const n = today.count;
    const hard = settings.nudgeEvery > 0 && n > 0 && n % settings.nudgeEvery === 0;
    u.title.textContent = hard ? `今日 ${n} 本目です` : 'ここで止めました';
    u.sub.textContent = hard
      ? 'ここで閉じるなら、ちょうどいい区切りです。'
      : `今日 ${n} 本 / このタブで ${sessionCount} 本`;
    u.card.classList.toggle('yss-hard', hard);
    u.card.hidden = false;
    placeCard();
    clearInterval(cardTimer);
    cardTimer = setInterval(paintCooldown, 200);
    paintCooldown();
  }

  function paintCooldown() {
    if (!ui || ui.card.hidden) {
      clearInterval(cardTimer);
      return;
    }
    const left = remainingCooldown();
    ui.next.disabled = left > 0;
    ui.next.textContent = left > 0 ? `次へ進む (${left})` : '次へ進む';
    placeCard();
  }

  /** カードを再生中の video の上に重ねる。位置が取れなければ画面中央に置く。 */
  function placeCard() {
    if (!ui || ui.card.hidden) return;
    const r = video && video.getBoundingClientRect();
    if (r && r.width > 40 && r.height > 40) {
      ui.card.style.left = `${r.left + r.width / 2}px`;
      ui.card.style.top = `${r.top + r.height / 2}px`;
    } else {
      ui.card.style.left = '50%';
      ui.card.style.top = '50%';
    }
  }

  function hideOverlay() {
    if (!ui) return;
    ui.card.hidden = true;
    clearInterval(cardTimer);
  }

  let noticeTimer = null;

  /** 操作を止めたことを、画面の隅で大きく知らせる。kind は止めた入力の種類。 */
  function notice(kind) {
    const u = ensureUi();
    if (!u) return;
    blockedCount += 1;

    const corner = settings.noticeCorner === 'tr' ? 'tr' : 'br';
    u.notice.classList.toggle('yss-tr', corner === 'tr');
    u.notice.classList.toggle('yss-br', corner === 'br');
    u.noticeMeta.textContent =
      blockedCount > 1 ? `${kind} — この動画で ${blockedCount} 回目` : kind;

    // 出っぱなしのときに連打されても分かるよう、アニメーションを掛け直す
    u.notice.hidden = false;
    u.notice.classList.remove('yss-shake');
    void u.notice.offsetWidth; // reflow を挟まないと再生されない
    u.notice.classList.add('yss-shake');

    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
      u.notice.hidden = true;
    }, 2600);
  }

  function updateBadge() {
    const u = ensureUi();
    if (!u) return;
    if (!onShorts() || today.count === 0) {
      u.badge.hidden = true;
      return;
    }
    u.badgeCount.textContent = String(today.count);
    u.badge.hidden = false;
    u.badge.classList.toggle('yss-off', !active());
  }

  function hideBadge() {
    if (ui) ui.badge.hidden = true;
  }

  function apply() {
    if (!onShorts()) return;
    if (!active() && ui) hideOverlay();
    if (settings.breakLoop && video && video.loop) video.loop = false;
  }

  window.addEventListener('resize', placeCard, { passive: true });
  document.addEventListener('yt-navigate-finish', () => setTimeout(tick, 0));
})();
