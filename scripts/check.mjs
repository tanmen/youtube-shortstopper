/*
 * 読み込む前の最低限の検査。
 *   - manifest.json が JSON として読めるか
 *   - manifest / HTML が参照しているファイルが実在するか
 *   - HTML の id と JS の getElementById が食い違っていないか
 *
 *   node scripts/check.mjs
 *
 * 「0 件だから OK」と読めてしまう検査にしないため、確認した件数を必ず出し、
 * 期待する最低件数に届かなければ異常として落とす。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), 'utf8');

let checked = 0;
const problems = [];

function must(cond, message) {
  checked += 1;
  if (!cond) problems.push(message);
}

// ---- manifest -------------------------------------------------------------

const manifest = JSON.parse(read('manifest.json'));
must(manifest.manifest_version === 3, 'manifest_version が 3 ではない');

const manifestRefs = [
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...(manifest.content_scripts ?? []).flatMap((cs) => [...(cs.js ?? []), ...(cs.css ?? [])]),
].filter(Boolean);

for (const ref of manifestRefs) {
  must(existsSync(join(root, ref)), `manifest が参照する ${ref} が無い`);
}

// music.youtube.com を巻き込んでいないこと（ここが本体の前提）
const matches = (manifest.content_scripts ?? []).flatMap((cs) => cs.matches ?? []);
must(matches.length > 0, 'content_scripts の matches が空');
must(
  !matches.some((m) => m.includes('music.youtube.com')),
  'matches に music.youtube.com が入っている'
);

// ---- HTML が参照するファイル ----------------------------------------------

for (const page of ['src/popup.html', 'src/options.html']) {
  const html = read(page);
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  must(refs.length >= 2, `${page} の src/href が ${refs.length} 件しか無い（検査が空振り）`);
  for (const ref of refs) {
    const target = resolve(join(root, dirname(page)), ref);
    must(existsSync(target), `${page} が参照する ${ref} が無い`);
  }

  // id と getElementById の対応
  const script = read(page.replace('.html', '.js'));
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const used = new Set([...script.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
  must(ids.size >= 3, `${page} の id が ${ids.size} 件しか無い（検査が空振り）`);
  must(used.size >= 3, `${page} 用スクリプトの $() が ${used.size} 件しか無い（検査が空振り）`);
  for (const id of used) {
    must(ids.has(id), `${page.replace('.html', '.js')} が参照する #${id} が HTML に無い`);
  }
}

// ---- content script の CSS クラス -----------------------------------------

const contentJs = read('src/content.js');
const contentCss = read('src/content.css');
const classes = new Set([...contentJs.matchAll(/class="(yss-[^"]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
must(classes.size >= 5, `content.js の yss- クラスが ${classes.size} 件しか無い（検査が空振り）`);
for (const cls of classes) {
  must(contentCss.includes(`.${cls}`), `content.css に .${cls} の定義が無い`);
}

// ---- 結果 -----------------------------------------------------------------

console.log(`checked ${checked} assertions`);
if (checked < 20) {
  console.error('検査の件数が少なすぎる。検査そのものが成立していない可能性がある。');
  process.exit(2);
}
if (problems.length) {
  for (const p of problems) console.error(`NG: ${p}`);
  process.exit(1);
}
console.log('OK');
