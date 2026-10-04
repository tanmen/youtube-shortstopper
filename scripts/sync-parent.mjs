/*
 * Chrome が読み込んでいる「本体の checkout」（worktree ではなく親ディレクトリ）を
 * origin/main に進め、そこで scripts/check.mjs を走らせる。
 *
 *   node scripts/sync-parent.mjs          手で叩く（どの worktree から叩いても本体が対象）
 *   node scripts/sync-parent.mjs --hook   .claude/settings.json の PostToolUse / PostToolUseFailure から
 *
 * worktree で直してマージしても、Chrome が見ている本体は pull するまで古いまま。
 * --hook のときは `gh pr merge` を打った呼び出しのあとだけ動き、結果を Claude に返す
 * （そのあと chrome://extensions の再読み込みを本人に頼むため）。
 * PostToolUseFailure にも置くのは、リモートのマージは通ったのにローカルの後処理で落ちる場合
 * （worktree では main が本体に checkout 済みで切り替えられない、など）も拾うため。
 * どちらで鳴っても、進めるかどうかは fetch した origin の実際の状態で決まる。
 *
 * 本体を書き換えるのは、main にいて、追跡ファイルに変更が無く、fast-forward で済むときだけ。
 * どれかが外れたら触らずに理由を返す。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const BRANCH = 'main';
const hookMode = process.argv.includes('--hook');

const git = (cwd, ...args) =>
  execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// ---- --hook: `gh pr merge` を打った呼び出しかどうか ---------------------------

let payload = null;
if (hookMode) {
  try {
    payload = JSON.parse(readFileSync(0, 'utf8'));
  } catch (e) {
    // 黙って抜けると「鳴らなかった」と見分けがつかないので、読めなかったことは返す
    emit(`sync-parent: hook の入力が読めなかった（${e.message}）。本体は触っていない。`);
    process.exit(0);
  }
  const command = String(payload?.tool_input?.command ?? '');
  // コマンドの位置（行頭・; & | ( { の直後）にある gh pr merge だけを拾う
  if (!/(?:^|[;&|({])\s*gh(?:\.exe)?\s+pr\s+merge\b/m.test(command)) process.exit(0);
}

// ---- 本体の checkout を進める ----------------------------------------------

const lines = [];
let ok = false;
try {
  ok = sync(lines);
} catch (e) {
  lines.push(`失敗: ${(e.stderr || e.message || String(e)).toString().trim()}`);
}

if (hookMode) {
  const command = String(payload?.tool_input?.command ?? '');
  if (/--auto\b/.test(command)) {
    lines.push('`--auto` で打っているので、まだマージされていないかもしれない。入ったら `node scripts/sync-parent.mjs` を手で叩く。');
  }
  emit(lines.join('\n'));
  process.exit(0);
}
console.log(lines.join('\n'));
process.exit(ok ? 0 : 1);

function sync(out) {
  const here = dirname(dirname(fileURLToPath(import.meta.url)));
  // 一覧の先頭が本体（.git を持つ checkout）。worktree から叩いても本体に解決される
  const first = git(here, 'worktree', 'list', '--porcelain').split('\n')[0];
  if (!first.startsWith('worktree ')) throw new Error(`git worktree list の先頭が読めない: ${first}`);
  const main = first.slice('worktree '.length);
  out.push(`sync-parent: 本体 = ${main}`);

  const branch = spawnSync('git', ['-C', main, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { encoding: 'utf8' });
  const current = branch.status === 0 ? branch.stdout.trim() : '(detached HEAD)';
  if (current !== BRANCH) {
    out.push(`触っていない: 本体が ${BRANCH} ではなく ${current} にいる。Chrome はいまその版を読んでいる。`);
    return false;
  }

  const dirty = git(main, 'status', '--porcelain', '--untracked-files=no');
  if (dirty) {
    const files = dirty.split('\n');
    out.push(`触っていない: 本体の追跡ファイルに変更がある（${files.length} 件）:`);
    out.push(...files.slice(0, 5).map((f) => `  ${f}`));
    return false;
  }

  git(main, 'fetch', '--quiet', 'origin', BRANCH);
  const before = git(main, 'rev-parse', 'HEAD');
  const target = git(main, 'rev-parse', `origin/${BRANCH}`);

  if (before === target) {
    out.push(`変化なし: 本体はすでに origin/${BRANCH}（${before.slice(0, 7)}）と一致している。`);
  } else {
    const ff = spawnSync('git', ['-C', main, 'merge-base', '--is-ancestor', before, target]);
    if (ff.status !== 0) {
      out.push(`触っていない: 本体の ${BRANCH} に origin に無いコミットがあり、fast-forward できない。`);
      return false;
    }
    git(main, 'merge', '--ff-only', '--quiet', `origin/${BRANCH}`);
    const incoming = git(main, 'log', '--oneline', '--no-decorate', `${before}..${target}`);
    out.push(`進めた: ${before.slice(0, 7)} → ${target.slice(0, 7)}`);
    out.push(...incoming.split('\n').map((l) => `  ${l}`));
  }

  // 本体側の check.mjs で本体を検査する（worktree の check.mjs だと worktree を読む）
  const check = spawnSync(process.execPath, [join(main, 'scripts', 'check.mjs')], { encoding: 'utf8' });
  const result = `${check.stdout}${check.stderr}`
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 4)
    .join(' / ');
  if (check.status !== 0) {
    out.push(`本体での check.mjs が落ちた（exit ${check.status}）: ${result}`);
    out.push('本体はもう進んでいるので、このまま Chrome で再読み込みすると壊れた版を読む。直す PR を先に出す。');
    return false;
  }
  out.push(`本体での check.mjs: ${result}`);
  if (before !== target) {
    out.push('Chrome に反映するには、chrome://extensions で ShortStopper の再読み込み（↻）→ YouTube のタブを再読み込み。');
  }
  return true;
}

function emit(text) {
  const event = payload?.hook_event_name ?? 'PostToolUse';
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
}
