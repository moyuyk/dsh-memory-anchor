#!/usr/bin/env node
'use strict';
/**
 * mem.js —— 本地长期记忆库（记忆总库）主入口
 * ==========================================
 *
 * 三层结构：
 *   global          全局永久记忆（长期不变的偏好/规则/事实，手动维护）
 *   chat            未归类缓冲区（闲聊里值得记的，定期归档）
 *   proj:<项目名>    项目记忆（每个项目一个独立物理文件）
 *
 * 两层存储（2026-10-20 瘦身后）：
 *   结论层   nodes 表：标题 + 摘要（≤500 字，超长部分写进 body）+ 标签 + 权重 + 双时间轴
 *   索引层   nodes_tok + nodes_tok_fts（CJK 2-gram），旧 trigram 索引保留作降级
 *   原文层   node_raw 只存锚点（session_id + seq 范围）；原文真源是 DSH 会话日志，
 *            用 `raw` 现取、用 `grep` 直接搜日志全文。
 *
 * 用法：
 *   node mem.js add --scope <scope> --title "..." [--summary "..."] [--tags a,b]
 *                   [--kind note|fact|decision|pitfall|pref|todo|state|session]
 *                   [--weight 1-5] [--body "..."]
 *                   [--raw-session <会话id|current> --raw-seq 8-1567]  指定原文锚点
 *                   [--no-auto-raw]                                   关闭「自动抓当前会话原文」
 *                   [--force]                                         跳过查重阻断
 *   注：默认自动抓当前会话一段当锚点；写入前做 2-gram Jaccard 查重（≥0.8 阻断）。
 *   node mem.js search <关键词> [--scope a,b] [--limit 3] [--json]   搜结构化记忆
 *   node mem.js grep <关键词> [--session <id>] [--limit 20]           直接搜会话日志原文
 *   node mem.js list [--scope x] [--kind y] [--limit 20]
 *   node mem.js show <scope>#<id>              查看单条（含原文状态）
 *   node mem.js raw <scope>#<id>               调取原文（优先库内，回退会话日志）
 *   node mem.js raw-fetch <scope>#<id>         按 raw_ref 从日志提取原文并入库
 *   node mem.js backfill [--scope x] [--apply] [--min-score 0.35]   批量回填原文
 *   node mem.js doctor [--scope x]             全库体检（缺原文/原文可疑/锚点失效）
 *   node mem.js tidy [--scope x] [--apply]     整理同主题 state（默认 dry-run）
 *   node mem.js scopes                         列出所有记忆库
 *   node mem.js stats                          统计
 *   node mem.js update <scope>#<id> [--summary "..."] [--weight 5] [--status done]
 *   node mem.js supersede <旧ref> --by <新ref> [--reason "..."]  旧结论失效（记下被谁取代、为什么）
 *   node mem.js rm <scope>#<id>                软删除（status=deleted，原文保留，可 restore）
 *   node mem.js rm <scope>#<id> --hard         物理删除（连原文一起，不可恢复）
 *   node mem.js restore <scope>#<id>           从软删除恢复
 *   node mem.js newproject <项目名>             创建项目记忆库
 *   node mem.js dropproject <项目名>            删除项目记忆库（危险）
 *   node mem.js handoff                        生成 HANDOFF.md（兼容旧流程）
 *   node mem.js config [--top-k 3] [--half-life 30]
 *   node mem.js migrate <旧memory.db路径>       迁移旧的 mem.py 记录
 */

const path = require('path');
const fs = require('fs');
const store = require('./lib/store');

// 启动时确保所有库都有最新表结构（老库补建 node_raw 原文表；失败就跳过）
try { for (const s of store.listScopes()) store.ensureScope(s); } catch { /* 并发锁等情况忽略 */ }

/**
 * 说明：曾经在这里维护一份「dsh聊天记录」txt 分卷快照（DSH_TXT_AUTOBUILD）。
 * 2026-10-21 整条删除——它的内容全部派生自记忆库，原文真源是 DSH 会话日志，
 * 人读/备份交给 `mem.js raw` 和插件页导出，不再维护第二份会过期的副本。
 */

const argv = process.argv.slice(2);
const cmd = argv[0];

// ---------------------------------------------------------------- 参数解析

function parseFlags(args) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { rest.push(...args.slice(i + 1)); break; }   // 之后的全部当字面值
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      rest.push(a);
    }
  }
  return { flags, rest };
}

const KINDS = ['note', 'fact', 'decision', 'pitfall', 'pref', 'todo', 'state', 'session'];
const KIND_LABEL = {
  fact: '环境事实', decision: '决策', todo: '待办', pref: '偏好',
  pitfall: '坑', state: '状态', session: '会话小结', note: '笔记',
};

function die(msg) { console.error(`[错误] ${msg}`); process.exit(1); }

/**
 * 从 stdin 读 JSON —— 解决 PowerShell 5.1 吞双引号的问题。
 *
 * ⚠️ 实测（Windows PowerShell 5.1）：向外部程序传参时，参数里的双引号会被吞掉。
 *    以下四种写法全部失败，`他说"这样不行"` 一律变成 `他说这样不行`：
 *      '单引号包裹"双引号"'
 *      "双引号包裹`"转义`""
 *      '双写""双引号""'
 *      --% stop-parsing 模式
 *    根因在 PowerShell 的参数编码层，与被调程序无关（Python 版 mem.py 同样中招）。
 *
 *    可靠通道是管道传 JSON：双引号完整保留。
 *    用法：'{"title":"...","summary":"含\"引号\""}' | node mem.js add --scope x --json-stdin
 */
function readJsonStdin() {
  const fs = require('fs');
  try {
    const raw = fs.readFileSync(0, 'utf8');   // fd 0 = stdin
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    die('从 stdin 读 JSON 失败: ' + e.message);
  }
}

/** 解析 "scope#id" 或 "scope id" */
function parseRef(s) {
  if (!s) die('需要引用，格式：<scope>#<id>，例如 proj:记忆插件#3');
  const i = s.lastIndexOf('#');
  if (i === -1) die(`引用格式不对："${s}"，应为 <scope>#<id>`);
  return { scope: s.slice(0, i), id: Number(s.slice(i + 1)) };
}

function clip(s, n) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + '…' : one;
}

/** 默认检索范围：global + chat + 所有项目（由调用方按需收窄） */
function defaultScopes() {
  const all = store.listScopes();
  return all.length ? all : ['global'];
}

// ---------------------------------------------------------------- add

/** 未显式给 scope 时：在 projects/<name> 下自动用 proj:<name>，否则 chat */
function autoScope() {
  try {
    const cfg = store.loadConfig();
    if (!cfg.autoScopeFromCwd) return 'chat';
    const m = String(process.cwd()).match(/[\\/]projects[\\/]([^\\/]+)(?:[\\/]|$)/i);
    if (m) return 'proj:' + m[1];
  } catch { /* ignore */ }
  return 'chat';
}

// 疑似密钥/令牌：命中就拒绝写入（--allow-secret 可跳过）
const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|AKID[A-Za-z0-9]{13,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/

function cmdAdd() {
  const { flags } = parseFlags(argv.slice(1));

  // --json-stdin：从管道读完整节点（绕开 PowerShell 吞双引号的问题）
  let payload = null;
  if (flags['json-stdin']) {
    payload = readJsonStdin();
    if (!payload) die('--json-stdin 需要从管道传入 JSON');
  }

  const scope = payload?.scope || flags.scope || autoScope();
  const title = String(payload?.title ?? flags.title ?? '').trim();
  if (!title) die('缺少 --title（标题不能为空）');

  // ---- 摘要分级（2026-10-20 v9）--------------------------------------------
  // 旧逻辑把摘要硬切 500 字且不留痕迹（实测 28 条里 10 条被截，细节直接丢失）。
  // 现在：截断时留省略号，完整文本写进 body —— body 参与 CJK 检索，show 也能看到。
  const cfg = store.loadConfig();
  const fullSummary = String(payload?.summary || flags.summary || title);
  const maxSummary = Number(cfg.maxSummaryChars) || 500;
  const truncated = fullSummary.length > maxSummary;
  const summary = truncated ? fullSummary.slice(0, maxSummary - 1) + '…' : fullSummary;
  let body = String(payload?.body || flags.body || '');
  if (truncated && !body.trim()) body = fullSummary;

  // 写守卫：疑似密钥/令牌一律拒绝（2026-10-21 加）
  if (!flags['allow-secret'] && !payload?.allowSecret) {
    const blob = `${title}\n${summary}\n${body}`;
    if (SECRET_RE.test(blob)) {
      die('内容疑似包含密钥/令牌，已拒绝写入；确认要存请加 --allow-secret');
    }
  }

  const tagsRaw = payload?.tags ?? flags.tags;
  const tagArr = Array.isArray(tagsRaw)
    ? tagsRaw
    : (tagsRaw ? String(tagsRaw).split(',').map((t) => t.trim()).filter(Boolean) : []);
  const kind = payload?.kind || flags.kind || 'note';

  // ---- 去重（2026-10-20 v9）------------------------------------------------
  // 以前只在「同 kind + 标签有交集」时打印候选，靠人判断；tag 早发散到 71 个。
  // 现在算 CJK 2-gram Jaccard：≥0.8 视为重复并阻断（--force 可强写），0.5–0.8 只提示。
  const force = Boolean(flags.force || payload?.force);
  let similar = [];
  try {
    similar = store.findSimilar(scope, { title, summary: fullSummary, tags: tagArr.join(' '), kind }, { threshold: 0.5, limit: 5 });
  } catch { /* 查重失败不阻断写入 */ }
  const dup = similar.filter((s) => s.score >= 0.8);
  if (dup.length && !force) {
    console.log('[去重] 已有高度相似条目（Jaccard ≥0.8），未写入：');
    for (const d of dup) console.log(`   ${scope}#${d.id}  相似度 ${(d.score * 100).toFixed(0)}%  「${clip(d.title, 50)}」`);
    console.log(`   确认要新增请加 --force；要改旧条目用 \`mem.js update ${scope}#${dup[0].id} ...\``);
    process.exit(1);
  }
  if (dup.length && force) {
    console.log(`[去重] 已按 --force 跳过 ${dup.length} 条 ≥0.8 的重复检查。`);
  }
  const near = similar.filter((s) => s.score < 0.8);
  if (near.length) {
    console.log(`[相似] 已有 ${near.length} 条相近条目（0.5–0.8，仅提示，不阻断）：`);
    for (const s of near.slice(0, 5)) console.log(`   ${scope}#${s.id}  ${(s.score * 100).toFixed(0)}%  「${clip(s.title, 50)}」`);
  }

  let rawRef = '';
  let raw = null;
  const rawSession = payload?.rawSession || flags['raw-session'] || flags.session;
  const rawSeq = payload?.rawSeq || flags['raw-seq'];

  if (payload?.rawRef) {
    rawRef = typeof payload.rawRef === 'string' ? payload.rawRef : JSON.stringify(payload.rawRef);
  } else if (rawSession) {
    rawRef = JSON.stringify({
      sessionId: rawSession,
      seqStart: rawSeq ? Number(String(rawSeq).split('-')[0]) : null,
      seqEnd: rawSeq ? Number(String(rawSeq).split('-')[1]) : null,
    });
  }

  // 原文落库：记忆库自己存一份完整原文（不再只依赖 DSH 会话日志）
  if (payload?.rawText || flags['raw-text']) {
    raw = { text: String(payload?.rawText ?? flags['raw-text']), source: 'inline' };
  } else if (payload?.rawFile || flags['raw-file']) {
    const p = String(payload?.rawFile ?? flags['raw-file']);
    if (!fs.existsSync(p)) die('原文文件不存在: ' + p);
    raw = { text: fs.readFileSync(p, 'utf8'), source: 'file' };
  } else if (rawSession) {
    const ex = extractFromSession(rawSession, rawSeq);
    raw = {
      text: ex.text, source: 'dsh-session', sessionId: ex.sessionId,
      seqStart: rawSeq ? ex.lo : null, seqEnd: rawSeq ? ex.hi : null,
    };
    if (!ex.text.trim()) { console.log('[提示] 提取到的原文为空，只记了 raw_ref'); raw = null; }
  }

  // ---- 自动补原文（2026-10-16 起）------------------------------------------
  // 背景：此前 add 只写摘要，原文靠事后 backfill「猜」，猜错不报错、漏跑就没原文，
  // 导致记忆条目长期没有原文可回源（用户实测发现）。现在默认自动抓。
  //
  // 策略：没显式给原文时，若在 DSH 会话内（有 DSH_SESSION_ID），
  // 自动取「当前会话最后 N 条对话事件」作为原文——记忆总是写在会话进行中，
  // 这段必然覆盖刚刚发生的事情，比事后猜准得多。
  // 可用 --no-auto-raw 关闭；显式给了 --raw-* 时以显式为准。
  const autoRawOff = Boolean(flags['no-auto-raw']) || Boolean(payload?.noAutoRaw);
  if (!raw && !rawSession && !rawRef && !autoRawOff) {
    try {
      const summaryForRaw = String(payload?.summary || flags.summary || title || '');
      const auto = autoExtractRelevant({
        title,
        summary: summaryForRaw,
        maxEvents: Number(flags['auto-raw-events'] || 40),
        span: Number(flags['auto-raw-span'] || 3),
      });
      if (auto && auto.text.trim()) {
        raw = { text: auto.text, source: 'dsh-session', sessionId: auto.sessionId, seqStart: auto.lo, seqEnd: auto.hi };
        rawRef = JSON.stringify({ sessionId: auto.sessionId, seqStart: auto.lo, seqEnd: auto.hi });
        console.log(`[原文] 自动抓取 seq ${auto.lo}-${auto.hi}（${auto.text.length} 字，${auto.mode}）`);
      }
    } catch (e) {
      console.log(`[原文] 自动抓取失败：${e.message}（可稍后 backfill 补）`);
    }
  }

  // 会话归属：显式 --session 优先；否则从原文层 / raw_ref 里取真实会话 id。
  // 2026-10-19 修：此前只取 flags.session，用 --raw-session current 时 nodes.session_id 会写空。
  let sessionIdForNode = payload?.sessionId || flags.session || raw?.sessionId || '';
  if (!sessionIdForNode && rawRef) {
    try { sessionIdForNode = JSON.parse(rawRef).sessionId || ''; } catch { /* ignore */ }
  }

  const res = store.addNode(scope, {
    kind,
    title,
    summary,
    body,
    tags: tagArr,
    weight: payload?.weight ?? (flags.weight ? Number(flags.weight) : 3),
    sessionId: sessionIdForNode,
    rawRef,
    raw,
    source: payload?.source || flags.source || 'manual',
    corrected: payload?.corrected !== undefined
      ? Boolean(payload.corrected)
      : (flags.corrected !== undefined ? Boolean(Number(flags.corrected) || flags.corrected === true) : false),
  });
  // 2026-10-20 瘦身后：原文不再入库，只存锚点。提示语同步改掉，避免误以为存了副本。
  const rawNote = raw && (raw.sessionId || raw.seqStart != null)
    ? `  锚点 seq ${raw.seqStart ?? '?'}-${raw.seqEnd ?? '?'}（原文在会话日志，raw 时按需取）`
    : (rawRef ? '  仅 raw_ref' : '  无锚点（raw 需 --all）');
  console.log(`[已记录] ${scope}#${res.id}  ${title}${rawNote}`);
  if (truncated) {
    console.log(`[摘要] 超过 ${maxSummary} 字已截断；完整 ${fullSummary.length} 字写进 body（检索和 show 都能看到）`);
  }

  // ---- 元记忆占比提醒（2026-10-20 v9）--------------------------------------
  // 实测 28 条里 19 条是关于记忆系统自身的（68%），长期会把工作记忆挤出去。
  // 只提醒不拦截：判重靠启发式，挡错代价更大。
  try {
    const st = store.stats().find((x) => x.scope === scope);
    if (st && st.active && store.isMetaNode({ title, tags: tagArr.join(',') })) {
      const ratio = st.meta / st.active;
      if (ratio > 0.3) {
        console.log(`[膨胀] 本库元记忆 ${st.meta}/${st.active}（${Math.round(ratio * 100)}%）> 30%，这条又属于元记忆。`);
        console.log('       考虑：写进 HANDOFF.md / AGENTS.md，或跑 `mem.js tidy --apply` 合并同主题 state。');
      }
    }
  } catch { /* 统计失败不影响写入 */ }

  // ---- 存完自校验（2026-10-16 起）------------------------------------------
  // 教训：backfill 曾把两条不同主题的记忆配成同一段原文、匹配分 0.22 也照写，
  // 还打了 ✓。所以「写进去」不等于「写对了」——这里当场核一遍并明说结论。
  if (raw && raw.text) {
    try {
      const { verifyRawMatch } = require('./lib/extract');
      const v = verifyRawMatch(raw.text, title, String(summary));
      if (v.verdict === 'mismatch') {
        console.log(`[⚠️ 原文可疑] 与摘要相关度仅 ${(v.score * 100).toFixed(0)}%（${v.hit}/${v.total} 关键词命中）`);
        console.log(`             命中样本: ${v.sample.join(' / ') || '（无）'}`);
        console.log(`             请用 \`mem.js raw ${scope}#${res.id}\` 核对，必要时用 tools/_fix_raw.js 按 seq 区间覆盖。`);
      } else if (v.verdict === 'weak') {
        console.log(`[原文偏弱] 相关度 ${(v.score * 100).toFixed(0)}%，建议抽查：mem.js raw ${scope}#${res.id}`);
      } else {
        console.log(`[原文校验] 相关度 ${(v.score * 100).toFixed(0)}% ✓`);
      }
    } catch { /* 校验失败不影响写入 */ }
  } else if (!raw && !rawRef) {
    console.log(`[⚠️ 无原文] 这条只有摘要，raw 取不到原文。补法：mem.js backfill --scope ${scope} --apply`);
  }

  // 自动合并：state 是快照，同主题的旧快照应该失效（只动 state，可 restore）
  if (kind === 'state') autoTidyState(scope, res.id);
}

/**
 * state 类自动合并（2026-10-21 加）
 * ==================================
 * 为什么只动 state：state 是「当前状态」的快照，同主题旧快照天然该被新的取代；
 * decision/pitfall 是长期结论，自动合并的误伤代价太大，留给 tidy 手动确认。
 * 只做软失效（valid_until + superseded_by），随时可以 restore。
 */
function autoTidyState(scope, newId) {
  try {
    const cur = store.getNode(scope, newId);
    if (!cur) return;
    const target = new Set(store.cjkTokens(`${cur.title || ''} ${cur.summary || ''}`));
    if (target.size < 2) return;
    const olds = store.listNodes(scope, { limit: 1000 })
      .filter((n) => n.kind === 'state' && n.id !== newId && !String(n.valid_until || '').trim());
    for (const n of olds) {
      const toks = new Set(store.cjkTokens(`${n.title || ''} ${n.summary || ''}`));
      const inter = [...target].filter((t) => toks.has(t)).length;
      const small = Math.min(target.size, toks.size);
      const ratio = small ? inter / small : 0;
      // 同主题的判定：至少共享 3 个 bigram，且占较短一侧的 30% 以上。
      // 纯 Jaccard 太严（「关闭状态无工具」vs「开启状态工具与注入」只有 0.3），会永远合不上。
      if (inter < 3 || ratio < 0.3) continue;
      store.updateNode(scope, n.id, {
        valid_until: store.nowIso(),
        superseded_by: `${scope}#${newId}`,
        body: `${n.body || ''}\n\n[自动失效] 同主题 state 被 ${scope}#${newId} 取代（关键词重合 ${(ratio * 100).toFixed(0)}%）`,
      });
      console.log(`[自动合并] ${scope}#${n.id}「${String(n.title || '').slice(0, 28)}」→ #${newId}（重合 ${(ratio * 100).toFixed(0)}%）`);
    }
  } catch (e) { /* 自动整理失败不影响写入 */ if (process.env.DSH_DEBUG_TIDY) console.error('[自动合并] 跳过：' + (e && e.message || e)) }
}

/** tidy：规则化整理（只改 state，默认 dry-run） */
function cmdTidy() {
  const { flags } = parseFlags(argv.slice(1));
  const apply = Boolean(flags.apply);
  const scopes = flags.scope ? String(flags.scope).split(',').map((s) => s.trim()) : store.listScopes();
  let candidates = 0;
  let done = 0;
  const sim = (a, b) => {
    const A = new Set(store.cjkTokens(a));
    const B = new Set(store.cjkTokens(b));
    const inter = [...A].filter((t) => B.has(t)).length;
    const small = Math.min(A.size, B.size) || 1;
    const ratio = inter / small;
    return inter >= 3 && ratio >= 0.3 ? ratio : 0;
  };
  for (const scope of scopes) {
    const active = store.listNodes(scope, { limit: 5000 })
      .filter((n) => !String(n.valid_until || '').trim());
    const states = active.filter((n) => n.kind === 'state')
      .sort((a, b) => b.id - a.id);
    const keep = [];
    for (const n of states) {
      const text = `${n.title || ''} ${n.summary || ''}`;
      const dup = keep.find((k) => sim(text, `${k.title || ''} ${k.summary || ''}`) >= 0.5);
      if (!dup) { keep.push(n); continue; }
      candidates += 1;
      console.log(`  ${apply ? '合并' : '可合并'} ${scope}#${n.id}「${String(n.title || '').slice(0, 30)}」→ #${dup.id}`);
      if (apply) {
        store.updateNode(scope, n.id, {
          valid_until: store.nowIso(),
          superseded_by: `${scope}#${dup.id}`,
          body: `${n.body || ''}\n\n[整理] 同主题 state 合并到 ${scope}#${dup.id}`,
        });
        done += 1;
      }
    }
    if (active.length) {
      const meta = active.filter((n) => store.isMetaNode(n)).length;
      if (meta / active.length > 0.3) {
        console.log(`  ${scope}: 元记忆 ${meta}/${active.length}（${Math.round(meta / active.length * 100)}% > 30%）`);
      }
    }
  }
  console.log(`[tidy] ${apply ? `已合并 ${done} 条` : `发现 ${candidates} 条可合并（加 --apply 执行）`}`);
}

// ---------------------------------------------------------------- search

function cmdSearch() {
  const { flags, rest } = parseFlags(argv.slice(1));
  const query = rest.join(' ').trim();
  if (!query) die('缺少关键词');

  const cfg = store.loadConfig();
  const scopes = flags.scope ? String(flags.scope).split(',').map((s) => s.trim()) : defaultScopes();
  const limit = flags.limit ? Number(flags.limit) : cfg.topK;
  const validOnly = !flags.all;          // 默认只看当前有效；--all 连历史一起看
  const results = store.search(scopes, query, { limit, validOnly });

  if (flags.json) { console.log(JSON.stringify(results, null, 1)); return; }

  console.log(`检索范围: ${scopes.join(', ')}   关键词: "${query}"   命中: ${results.length}/${limit}${validOnly ? '' : '   [含历史]'}`);
  console.log('='.repeat(70));
  if (!results.length) {
    console.log('(无命中)');
    if (validOnly) console.log('提示：可能只存在于已失效的旧条目里，用 --all 再查一次。');
    return;
  }

  for (const r of results) {
    const raw = r.has_raw ? '  📖可回源' : (r.raw_ref ? '  📎有锚点' : '');
    const when = String(r.created_at || '').slice(0, 16);
    const dead = String(r.valid_until || '').trim()
      ? `  ⛔ 失效于 ${String(r.valid_until).slice(0, 10)}${r.superseded_by ? '，被 ' + r.superseded_by + ' 取代' : ''}`
      : '';
    console.log(`\n${r.scope}#${r.id}  [${KIND_LABEL[r.kind] || r.kind}]  权重${r.weight}  相关度${r._score}  ${when}${raw}${r.corrected ? '  ✎已纠正' : ''}`);
    console.log(`  ${r.title}${dead}`);
    if (r.summary && r.summary !== r.title) console.log(`  ${r.summary}`);
    if (r.tags) console.log(`  tags: ${r.tags}`);
  }
  console.log('\n' + '-'.repeat(70));
  console.log('提示：摘要不够时用 `mem.js raw <scope>#<id>` 从会话日志取细节；看历史用 --all。');
}

// ---------------------------------------------------------------- grep（日志原文）

/**
 * 直接搜会话日志原文（2026-10-20 v9 加）。
 *
 * 为什么单独一条命令：
 *   `search` 只搜结构化记忆（标题/摘要/标签/正文）。瘦身后原文只在 DSH 日志里，
 *   所以「只出现在原文里的词」搜不到——这层是断的。这里补上，不建索引、不写库。
 */
function cmdGrep() {
  const { flags, rest } = parseFlags(argv.slice(1));
  const query = rest.join(' ').trim();
  if (!query) die('缺少关键词');
  const { grepLogs } = require('./lib/logsearch');
  const r = grepLogs(query, {
    limit: flags.limit ? Number(flags.limit) : 20,
    session: flags.session || null,
    ignoreCase: !flags['case-sensitive'],
  });
  console.log(`日志检索: "${query}"   扫描 ${r.sessionsScanned} 个会话，命中 ${r.sessionsMatched} 个，显示 ${r.hits.length} 处（${r.ms}ms）`);
  console.log('='.repeat(70));
  if (!r.hits.length) {
    console.log('(无命中)');
    return;
  }
  for (const h of r.hits) {
    console.log(`\n${String(h.sessionId).slice(0, 20)}…  seq=${h.seq}  [${h.role}]  ${String(h.time || '').slice(0, 16)}`);
    console.log(`  ${h.snippet}`);
  }
  console.log('\n' + '-'.repeat(70));
  console.log('这里搜的是会话日志原文；搜结构化记忆用 `mem.js search`。');
}

// ---------------------------------------------------------------- list

function cmdList() {
  const { flags } = parseFlags(argv.slice(1));
  const scopes = flags.scope ? String(flags.scope).split(',').map((s) => s.trim()) : store.listScopes();
  const limit = flags.limit ? Number(flags.limit) : 20;
  const kinds = flags.kind ? [flags.kind] : null;

  for (const scope of scopes) {
    const nodes = store.listNodes(scope, { limit, kinds, status: flags.all ? null : 'open', validOnly: !flags.all });
    if (!nodes.length) continue;
    console.log(`\n### ${scope}  (${nodes.length} 条)`);
    for (const n of nodes) {
      console.log(`  #${String(n.id).padStart(3)} [${(KIND_LABEL[n.kind] || n.kind).padEnd(4)}] ${'!'.repeat(Math.max(1, Math.min(5, n.weight)))} ${n.title}${n.corrected ? '  ✎已纠正' : ''}${n.valid_until ? '  ⛔失效' : ''}`);
      if (n.summary && n.summary !== n.title) console.log(`        ${clip(n.summary, 100)}`);
    }
  }
}

// ---------------------------------------------------------------- show / raw

function cmdShow() {
  const { rest } = parseFlags(argv.slice(1));
  const { scope, id } = parseRef(rest[0]);
  const n = store.getNode(scope, id);
  if (!n) die(`找不到 ${scope}#${id}`);
  console.log(`节点: ${scope}#${n.id}`);
  console.log(`类型: ${KIND_LABEL[n.kind] || n.kind}   权重: ${n.weight}   状态: ${n.status}${n.corrected ? '   ✎已纠正' : ''}`);
  console.log(`创建: ${n.created_at}   更新: ${n.updated_at}`);
  console.log(`时效: ${n.valid_from || n.created_at} → ${n.valid_until ? n.valid_until : '现在'}${n.superseded_by ? `（被 ${n.superseded_by} 取代）` : ''}`);
  if (n.tags) console.log(`标签: ${n.tags}`);
  if (n.session_id) console.log(`会话: ${n.session_id}`);
  console.log('-'.repeat(70));
  console.log(`标题: ${n.title}`);
  const truncatedSummary = /…$/.test(String(n.summary || ''));
  console.log(`摘要: ${n.summary}`);
  if (n.body) {
    console.log(truncatedSummary ? '\n正文（摘要被截断，完整内容如下）:' : '\n正文:');
    console.log(n.body);
  }
  const storedRaw = store.getNodeRaw(scope, id);
  if (storedRaw && storedRaw.text) {
    console.log(`\n原文: 库内已存 ${storedRaw.chars} 字（${storedRaw.source}${storedRaw.session_id ? ' / ' + storedRaw.session_id : ''}，${storedRaw.created_at}）`);
    console.log(`用 \`mem.js raw ${scope}#${id}\` 调取完整原文。`);
  } else if (n.raw_ref) {
    console.log('\n原文引用: ' + n.raw_ref + '   ⚠ 尚未入库');
    console.log(`用 \`mem.js raw-fetch ${scope}#${id}\` 从日志提取并入库。`);
  } else {
    console.log('\n原文: 无（补录可用 `mem.js update` 之外的 add/backfill，或 raw-fetch）');
  }
}

function cmdRaw() {
  const { flags, rest } = parseFlags(argv.slice(1));
  const { scope, id } = parseRef(rest[0]);
  const n = store.getNode(scope, id);
  if (!n) die(`找不到 ${scope}#${id}`);

  // 2026-10-20 瘦身后：原文真源是 DSH 会话日志，默认从日志现取（16-101ms）。
  // --stored 才读老库里遗留的 node_raw.text 副本（瘦身前的存量数据）。
  const useStored = Boolean(flags.stored);
  if (useStored) {
    const stored = store.getNodeRaw(scope, id);
    if (stored && stored.text) {
      console.log(`原文来源: 库内旧副本（${stored.source}${stored.session_id ? ' / ' + stored.session_id : ''}）`);
      console.log(`长度: ${stored.chars} 字   入库: ${stored.created_at}`);
      console.log('='.repeat(70));
      console.log(stored.text);
      return;
    }
    console.log('[提示] 库里没有旧副本，改从会话日志取。');
  }

  if (!n.raw_ref) die(`${scope}#${id} 没有 raw_ref 锚点，无法定位到会话日志`);

  let ref;
  try { ref = JSON.parse(n.raw_ref); } catch { die('raw_ref 格式损坏: ' + n.raw_ref); }

  const { listSessions, readSession, readSessionRange } = require('./lib/session-log');
  const { normalizeEvent } = require('./lib/messages');

  const sessions = listSessions();
  const target = sessions.find((s) => s.sessionId === ref.sessionId || s.sessionId.includes(ref.sessionId));
  if (!target) {
    die(`找不到会话 ${ref.sessionId}\n`
      + `  日志可能已被删除。备份在 D:\\dsdata\\memory\\sessions-backup\\ 下，可手动还原到 ${require('node:path').join(require('node:os').homedir(), '.dsh', 'sessions')}`);
  }

  const lo = ref.seqStart ?? 0;
  const hi = ref.seqEnd ?? Infinity;

  // 没有 seq 范围（老条目的 raw_ref 可能是 {sessionId, seqStart:null, seqEnd:null}）时
  // 直接吐整个会话毫无用处——实测 #16 会打出 10886 行。
  // 兜底：只取尾部 120 个事件（记忆是会话进行中写的，最近的上下文最相关），
  // 想看全量加 --all。
  let noAnchor = false;
  let effLo = lo;
  let effHi = hi;
  if (ref.seqStart == null && ref.seqEnd == null && !flags.all) {
    noAnchor = true;
    const frames = require('./lib/session-log').getFrameIndex(target.filePath, target.sessionId).frames;
    const maxSeq = frames.length ? Math.max(...frames.filter((f) => f.hi !== null).map((f) => f.hi)) : 0;
    effLo = Math.max(0, maxSeq - 120);
    effHi = Infinity;
  }

  // --context N：在锚点前后各多取 N 条，看更完整的来龙去脉
  const pad = flags.context ? Number(flags.context) : 0;
  const from = Math.max(0, effLo - pad);
  const to = effHi === Infinity ? Infinity : effHi + pad;

  // 帧级索引（2026-10-20 加）：只解压命中 [from, to] 的 zstd 帧。
  // 实测 2.47MB 会话取 8 个事件：全量 133ms → 热索引 2ms。
  const t0 = Date.now();
  const range = readSessionRange(target.filePath, from, to);
  const events = range.events;
  const elapsed = Date.now() - t0;

  console.log(`原文来源: 会话日志 ${ref.sessionId.slice(0, 24)}`);
  if (noAnchor) {
    console.log(`锚点: 无 seq 范围（老条目）→ 只显示尾部 120 个事件，全量加 --all`);
    console.log(`seq 范围: ${from}..末尾`);
  } else {
    console.log(`seq 范围: ${lo}..${hi === Infinity ? '末尾' : hi}${pad ? `（上下各扩 ${pad} 条 → ${from}..${to === Infinity ? '末尾' : to}）` : ''}`);
  }
  const frameNote = range.frameCount
    ? `${range.usedFrames}/${range.frameCount} 帧${range.fromCache ? '，索引命中' : `，索引新建 ${range.buildMs}ms`}`
    : '全量解压';
  console.log(`读取: ${elapsed} ms（${frameNote}）`);
  console.log('='.repeat(70));

  let shown = 0;
  for (const e of events) {
    if (typeof e.seq !== 'number' || e.seq < from || e.seq > to) continue;
    const node = normalizeEvent(e);
    if (!node) continue;
    const label = { user: '👤 用户', assistant: '🤖 模型', 'tool-call': '🔧 工具调用', 'tool-result': '↩️ 工具结果', system: '⚙️ 系统' }[node.role] || node.role;
    const text = node.text || (node.toolCalls?.[0] ? `${node.toolCalls[0].name}(${JSON.stringify(node.toolCalls[0].arguments).slice(0, 200)})` : '');
    if (!text) continue;
    console.log(`\n[seq=${e.seq}] ${label}`);
    console.log(text);
    shown++;
  }
  if (!shown) console.log('(该范围内没有可读内容)');
  else console.log('\n' + '-'.repeat(70));
  console.log(`提示：看更完整的上下文加 --context 20；看瘦身前遗留的库内副本加 --stored。`);
}

// ---------------------------------------------------------------- raw-fetch / backfill

/**
 * 自动抓「当前会话最近的一段对话」当原文。
 *
 * 为什么取最近而不是整会话：记忆是随手写的，刚发生的事就在会话尾部；
 * 取尾部 N 条既覆盖了这条记忆的来龙去脉，又不会把几百万字的会话全塞进库。
 * 只挑对话类事件（用户/模型/工具），跳过注入的 system-reminder 噪声。
 */
function autoExtractRecent({ maxEvents = 40 } = {}) {
  const { listSessions, readSession } = require('./lib/session-log');
  const { renderOriginalText } = require('./lib/extract');
  const sid = process.env.DSH_SESSION_ID || '';
  if (!sid) throw new Error('不在 DSH 会话内（无 DSH_SESSION_ID）');
  const sessions = listSessions();
  const target = sessions.find((s) => s.sessionId === sid) || sessions.find((s) => s.sessionId.includes(sid));
  if (!target) throw new Error(`找不到当前会话 ${sid}`);
  const { events } = readSession(target.filePath);
  // 取尾部 maxEvents 条「有内容」的事件（跳过注入噪声）
  const talk = events.filter((e) => {
    if (typeof e.seq !== 'number') return false;
    if (!['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(e.type)) return false;
    if (e.type === 'user/message') {
      const t = (e.data?.content || []).map((c) => c.text || '').join(' ');
      if (/system-reminder|Current runtime context/.test(t)) return false;
    }
    return true;
  });
  if (!talk.length) throw new Error('当前会话还没有可用的对话事件');
  const slice = talk.slice(-maxEvents);
  const lo = slice[0].seq, hi = slice[slice.length - 1].seq;
  const text = renderOriginalText(events, { lo, hi });
  return { text, lo, hi, sessionId: target.sessionId };
}

/**
 * 自动抓「与这条记忆相关的那几轮」当原文（2026-10-19 起）。
 *
 * 为什么改：旧做法（autoExtractRecent）取会话尾部 N 条事件，抓的是「写记忆那一刻
 * 之前发生了什么」，不是「这条记忆在说的事」。实测一条 241 字摘要配了 29266 字原文
 * （121 倍），里面大部分是无关的工具回显与文件清单。
 *
 * 现在的策略（三级降级）：
 *   1. 用 title+summary 抽关键词 → locateOriginal 定位最相关轮次 → refineRange 聚焦前后 span 条
 *   2. 定位分过低（关键词几乎不命中）→ 退回尾部 maxEvents 条
 *   3. 任何异常 → 抛给调用方，由 add 打印提示
 *
 * 注意：只改「抓哪一段」，不改「抓的是什么」——原文仍是原始对话，只是范围变准。
 * 定位函数 locateOriginal / refineRange 原本只服务 backfill，这里复用，逻辑已验证过。
 */
function autoExtractRelevant({ title = '', summary = '', maxEvents = 40, span = 3 } = {}) {
  const { listSessions, readSession } = require('./lib/session-log');
  const { renderOriginalText, keywordsOf, locateOriginal, refineRange } = require('./lib/extract');
  const sid = process.env.DSH_SESSION_ID || '';
  if (!sid) throw new Error('不在 DSH 会话内（无 DSH_SESSION_ID）');
  const sessions = listSessions();
  const target = sessions.find((s) => s.sessionId === sid) || sessions.find((s) => s.sessionId.includes(sid));
  if (!target) throw new Error(`找不到当前会话 ${sid}`);
  const { events } = readSession(target.filePath);

  // ---- 第一级：关键词定位 ----------------------------------------------------
  const kws = keywordsOf(`${title} ${summary}`, 40);
  if (kws.length) {
    try {
      const hit = locateOriginal(events, kws, { targetTime: Date.now() });
      // 定位分门槛：低于 0.15 说明关键词几乎没命中，宁可退回尾部也不写错证据
      if (hit && hit.score >= 0.15 && hit.block) {
        // 注意：refineRange 要的是「轮次块」（含 nodes/startSeq/endSeq），
        // 不是 locateInBlocks 的返回壳 {lo,hi,score,block}。传错会拿到 undefined 范围，
        // 而 renderOriginalText 里 `seq < undefined` 恒为 false，会把整个会话都抓进来。
        const range = refineRange(hit.block, kws, { span });
        const lo = Number.isFinite(range.lo) ? range.lo : hit.block.startSeq;
        const hi = Number.isFinite(range.hi) ? range.hi : hit.block.endSeq;
        if (Number.isFinite(lo) && Number.isFinite(hi)) {
          const text = renderOriginalText(events, { lo, hi });
          if (text.trim()) {
            return {
              text, lo, hi, sessionId: target.sessionId,
              mode: `关键词定位 ${(hit.score * 100).toFixed(0)}%${range.refined ? '·已聚焦' : ''}`,
            };
          }
        }
      }
    } catch { /* 定位失败就走兜底 */ }
  }

  // ---- 第二级：退回尾部窗口（原行为）----------------------------------------
  const recent = autoExtractRecent({ maxEvents });
  return { ...recent, mode: '尾部窗口（关键词定位未命中）' };
}

/** 从 DSH 会话日志按 (会话id, seq) 提取完整原文 */
function extractFromSession(sessionId, seqSpec) {  const { listSessions, readSession } = require('./lib/session-log');
  const { renderOriginalText } = require('./lib/extract');
  const sid = sessionId === 'current' ? (process.env.DSH_SESSION_ID || '') : String(sessionId);
  if (!sid) die('--raw-session current 需要环境变量 DSH_SESSION_ID（在 DSH 会话里执行才有）');
  const sessions = listSessions();
  const target = sessions.find((s) => s.sessionId === sid) || sessions.find((s) => s.sessionId.includes(sid));
  if (!target) die(`找不到会话 ${sid}`);
  const { events } = readSession(target.filePath);
  let lo = 0, hi = Infinity;
  const m = String(seqSpec || '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (m) { lo = Number(m[1]); hi = Number(m[2]); }
  const text = renderOriginalText(events, { lo, hi });
  return { text, lo, hi, sessionId: target.sessionId, file: target.filePath, events };
}

/** 把某条记忆的原文（按 raw_ref 从会话日志）提取并入库 */
function cmdRawFetch() {
  const { rest } = parseFlags(argv.slice(1));
  const { scope, id } = parseRef(rest[0]);
  const n = store.getNode(scope, id);
  if (!n) die(`找不到 ${scope}#${id}`);
  let ref = null;
  if (n.raw_ref) {
    try { ref = JSON.parse(n.raw_ref); } catch { ref = { sessionId: String(n.raw_ref) }; }
  }
  const sid = ref?.sessionId || n.session_id;
  if (!sid) die(`${scope}#${id} 没有会话信息，无法从日志提取（可用 add --raw-text 手工补）`);
  const seqSpec = ref && ref.seqStart != null && ref.seqEnd != null ? `${ref.seqStart}-${ref.seqEnd}` : null;
  const ex = extractFromSession(sid, seqSpec);
  if (!ex.text.trim()) die('提取到的原文为空');
  store.setNodeRaw(scope, id, {
    text: ex.text, source: 'dsh-session', sessionId: ex.sessionId,
    seqStart: seqSpec ? ex.lo : null, seqEnd: seqSpec ? ex.hi : null,
  });
  console.log(`[已入库] ${scope}#${id}  原文 ${ex.text.length} 字  来源 ${ex.sessionId}  seq ${ex.lo}..${ex.hi === Infinity ? '末尾' : ex.hi}`);
}

/**
 * 批量回填历史条目的原文。
 * 定位方式：先用关键词在候选会话全文里粗筛（有 session_id 就限定该会话），
 * 再在候选会话的「轮次块」里精定位，取命中率最高的一轮作为原文。
 * 默认 dry-run，--apply 才写入。
 */
function cmdBackfill() {
  const { flags, rest } = parseFlags(argv.slice(1));
  const apply = Boolean(flags.apply);
  const minScore = flags['min-score'] !== undefined ? Number(flags['min-score']) : 0.35;
  const scopes = flags.scope ? String(flags.scope).split(',').map((s) => s.trim()) : (rest[0] ? [rest[0]] : store.listScopes());

  const { listSessions, readSession } = require('./lib/session-log');
  const { keywordsOf, locateInBlocks, buildTurnBlocks, renderOriginalText, scoreAgainst, timeFactorFor, refineRange } = require('./lib/extract');

  console.log(`回填原文${apply ? '（写入模式）' : '（预览，加 --apply 才写入）'}   阈值 score>=${minScore}`);
  const allSessions = listSessions();
  const evCache = new Map(), blkCache = new Map(), fullCache = new Map(), spanCache = new Map();
  const eventsOf = (s) => { if (!evCache.has(s.sessionId)) evCache.set(s.sessionId, readSession(s.filePath).events); return evCache.get(s.sessionId); };
  // 记忆是主会话里写的：子代理会话不参与定位，否则「研究类子会话」会把匹配抢走
  const sessions = allSessions.filter((s) => (eventsOf(s).find((e) => e.type === 'session')?.origin) !== 'subagent');
  const blocksOf = (s) => { if (!blkCache.has(s.sessionId)) blkCache.set(s.sessionId, buildTurnBlocks(eventsOf(s))); return blkCache.get(s.sessionId); };
  const fullOf = (s) => {
    if (!fullCache.has(s.sessionId)) fullCache.set(s.sessionId, blocksOf(s).map((b) => b.text).join('\n').slice(0, 300000));
    return fullCache.get(s.sessionId);
  };
  // 会话的对话时间区间（排除今早补写的 end-seed / model-selection，它们会把区间拉到今天）
  const spanOf = (s) => {
    if (!spanCache.has(s.sessionId)) {
      const evs = eventsOf(s);
      const head = evs.find((e) => e.type === 'session');
      const talk = evs.filter((e) => e.time && e.type !== 'session/end-seed' && e.type !== 'model/selection');
      spanCache.set(s.sessionId, {
        createdAt: head?.createdAt || (talk.length ? talk[0].time : null),
        lastTime: talk.length ? talk.reduce((m, e) => Math.max(m, e.time), 0) : null,
      });
    }
    return spanCache.get(s.sessionId);
  };

  let stored = 0, low = 0;
  const lowList = [];
  for (const scope of scopes) {
    store.ensureScope(scope);
    const rows = store.listNodesMissingRaw(scope, { limit: 2000 });
    if (!rows.length) continue;
    console.log(`\n### ${scope}   待回填 ${rows.length} 条`);
    for (const n of rows) {
      const kws = keywordsOf(`${n.title} ${n.summary} ${n.body || ''}`);
      // 条目写入时间是强约束：原文应来自「写这条记忆时正在进行的那次对话」
      const targetTime = n.created_at ? new Date(String(n.created_at).replace(' ', 'T')).getTime() : null;
      let pool = sessions;
      if (n.session_id) {
        const c = sessions.filter((s) => s.sessionId === n.session_id || s.sessionId.includes(String(n.session_id).slice(0, 20)));
        if (c.length) pool = c;
      } else {
        // 先用「会话时间区间是否覆盖条目写入时间」筛候选（记忆总是写在某个会话进行中），
        // 只有多个候选重叠时才用关键词排序 —— 避免被会话开头的注入内容带偏。
        const spans = sessions.map((s) => ({ s, sp: spanOf(s) }));
        let cands = spans.filter((x) => targetTime && x.sp.createdAt
          && targetTime >= x.sp.createdAt && (!x.sp.lastTime || targetTime <= x.sp.lastTime));
        if (!cands.length) {
          cands = spans.map((x) => {
            const d = !x.sp.createdAt ? Infinity
              : (targetTime < x.sp.createdAt ? x.sp.createdAt - targetTime : targetTime - (x.sp.lastTime || x.sp.createdAt));
            return { ...x, d };
          }).sort((a, b) => a.d - b.d).slice(0, 3);
        }
        if (cands.length > 3) {
          cands = cands.map((x) => ({ ...x, sc: scoreAgainst(fullOf(x.s), kws) })).sort((a, b) => b.sc - a.sc).slice(0, 3);
        }
        pool = cands.map((x) => x.s);
      }
      let best = null;
      for (const s of pool) {
        const loc = locateInBlocks(blocksOf(s), kws, { targetTime });
        if (loc && (!best || loc.score > best.score)) best = { ...loc, session: s };
      }
      // 有锚点（条目自己记了会话，或时间区间唯一确定会话）就放宽阈值：
      // 记忆是提炼过的，关键词命中率天然偏低，此时靠锚点保证会话正确，轮次取最相关的一个。
      // 2026-10-19 调整：0.05 → 0.10。旧值等于「只要有锚点就几乎不设防」，
      // 实测出现过两条不同主题的记忆被配成同一段原文（匹配分 0.22 也照写并打 ✓）。
      const anchored = Boolean(n.session_id) || pool.length === 1;
      const threshold = anchored ? Math.min(minScore, 0.10) : minScore;
      if (!best || best.score < threshold) {
        low++;
        lowList.push(`${scope}#${n.id}  最高分 ${best ? best.score.toFixed(2) : '0.00'}  「${clip(n.title, 40)}」`);
        continue;
      }
      // 长轮整轮存下来没用（可能几十万字），默认聚焦到最相关的那条消息前后
      let lo = best.lo, hi = best.hi, refined = false;
      if (!flags['full-turn'] && best.block) {
        const r = refineRange(best.block, kws, { span: Number(flags.span || 8) });
        lo = r.lo; hi = r.hi; refined = r.refined;
      }
      const text = renderOriginalText(eventsOf(best.session), { lo, hi });
      if (!text.trim()) { low++; lowList.push(`${scope}#${n.id}  定位到空内容`); continue; }
      // 写入前校验相关度（2026-10-19 加）：定位分高 ≠ 内容对得上。
      // 之前只报「打 ✓」，配错了也看不出来。现在用 verifyRawMatch 复核，
      // mismatch 直接跳过不写，weak 写但明确标注。
      let verify = null;
      try {
        const { verifyRawMatch } = require('./lib/extract');
        verify = verifyRawMatch(text, n.title || '', n.summary || '');
      } catch { /* 校验失败不阻断 */ }
      if (verify && verify.verdict === 'mismatch') {
        low++;
        lowList.push(`${scope}#${n.id}  原文校验不通过（相关度 ${(verify.score * 100).toFixed(0)}%，疑似配错，已跳过）「${clip(n.title, 40)}」`);
        continue;
      }
      if (apply) {
        store.setNodeRaw(scope, n.id, {
          text, source: 'dsh-session', sessionId: best.session.sessionId,
          seqStart: lo, seqEnd: hi,
        });
        if (!n.raw_ref) {
          store.updateNode(scope, n.id, {
            raw_ref: JSON.stringify({ sessionId: best.session.sessionId, seqStart: lo, seqEnd: hi }),
          });
        }
      }
      stored++;
      const vTag = verify ? (verify.verdict === 'weak' ? ` ⚠️相关度${(verify.score * 100).toFixed(0)}%` : ` ✓${(verify.score * 100).toFixed(0)}%`) : '';
      console.log(`  ${apply ? '✓' : '·'} ${scope}#${n.id} ${String(text.length).padStart(7)}字 score=${best.score.toFixed(2)}${refined ? '(聚焦)' : ''}${vTag} ${best.session.sessionId.slice(0, 22)} seq=${lo}-${hi}`);
    }
  }
  console.log(`\n${apply ? '已入库' : '可回填'} ${stored} 条；未达阈值 ${low} 条`);
  if (lowList.length) {
    console.log('未回填清单（最多列 25 条，这些需要手工给原文）：');
    for (const l of lowList.slice(0, 25)) console.log('  - ' + l);
  }
  if (!apply) console.log('\n[dry-run] 未改任何数据。加 --apply 执行。');
}

// ---------------------------------------------------------------- doctor

/**
 * 一条命令做完全库体检（2026-10-16 新增）。
 *
 * 起因：用户发现记忆条目一整天没有原文可回源——根因是 add 漏跑 backfill，
 * 以及 backfill 会「配错原文但打 ✓」。所以把检查固化成命令，不靠人记得。
 *
 * 检查项：
 *   ① 缺原文的条目（raw 取不到原文的原因）
 *   ② 原文与摘要相关度可疑的条目（配错的）
 *   ③ 各库原文覆盖与总字数
 */
function cmdDoctor() {
  const { flags } = parseFlags(argv.slice(1));
  const { verifyRawMatch } = require('./lib/extract');
  const { listSessions } = require('./lib/session-log');
  const scopes = flags.scope ? String(flags.scope).split(',').map((s) => s.trim()) : store.listScopes();
  const sessIds = new Set(listSessions().map((s) => s.sessionId));

  console.log('记忆库体检');
  console.log('='.repeat(70));
  let totalNodes = 0, totalRaw = 0, totalChars = 0, missingAll = [], suspectAll = [], staleAll = [];

  for (const scope of scopes) {
    store.ensureScope(scope);
    const cov = store.rawCoverage(scope);
    totalNodes += cov.total; totalRaw += cov.withRaw; totalChars += cov.chars;

    // 导入条目本来就没有锚点，不计入「缺锚点」误报
    const missing = store.listNodesMissingRaw(scope, { limit: 2000 }).filter((n) => n.source !== 'import');
    const withRaw = store.listNodesWithRaw(scope, { limit: 5000 });
    const suspect = [];
    const stale = [];
    for (const n of withRaw) {
      // 锚点模式：node_raw.text 为空，原文在会话日志里，先检查日志还在不在
      const sid = n.raw_session || n.session_id;
      if (sid && !sessIds.has(sid)) stale.push(n);
      if (!String(n.raw_text || '').trim()) continue;   // 没有副本可校验
      const v = verifyRawMatch(n.raw_text || '', n.title, n.summary || '');
      if (v.verdict !== 'ok') suspect.push({ ...n, _v: v });
    }
    missingAll.push(...missing.map((n) => ({ scope, id: n.id, title: n.title, created: n.created_at })));
    suspectAll.push(...suspect);
    staleAll.push(...stale.map((n) => ({ scope, id: n.id, title: n.title, sid: n.raw_session || n.session_id })));

    const flag = (missing.length || suspect.length || stale.length) ? '⚠️' : '✓';
    console.log(`${flag} ${scope.padEnd(20)} ${String(cov.total).padStart(3)} 条 | 有锚点 ${String(cov.withRaw).padStart(3)} | 缺 ${String(missing.length).padStart(2)} | 可疑 ${suspect.length}`);
  }

  console.log('\n' + '-'.repeat(70));
  console.log(`合计 ${totalNodes} 条记忆，其中 ${totalRaw} 条有锚点（原文在会话日志，不存副本）`);

  if (missingAll.length) {
    console.log(`\n【缺原文】${missingAll.length} 条（这些 raw 取不到原文）：`);
    for (const m of missingAll.slice(0, 30)) console.log(`  - ${m.scope}#${m.id}  「${clip(m.title, 46)}」  ${m.created || ''}`);
    if (missingAll.length > 30) console.log(`  …另有 ${missingAll.length - 30} 条`);
    console.log(`  补法：mem.js backfill --scope <库> --apply   （补完务必用 raw 抽查）`);
  } else {
    console.log('\n【缺原文】无 ✓');
  }

  if (suspectAll.length) {
    console.log(`\n【原文可疑】${suspectAll.length} 条（相关度低，可能是 backfill 配错的）：`);
    for (const s of suspectAll.slice(0, 30)) {
      console.log(`  - ${s.scope}#${s.id}  相关度 ${(s._v.score * 100).toFixed(0)}%  「${clip(s.title, 40)}」`);
      console.log(`      原文来源 ${String(s.raw_session || '').slice(0, 30)} seq=${s.seq_start}-${s.seq_end}`);
      console.log(`      命中样本: ${s._v.sample.join(' / ') || '（无）'}`);
    }
    console.log(`  修法：用 tools/_fix_raw.js <scope> <id> <会话jsonl> <起seq> <止seq> 精确覆盖`);
  } else {
    console.log('\n【原文可疑】无 ✓');
  }

  if (staleAll.length) {
    console.log(`\n【锚点失效】${staleAll.length} 条（会话日志已不存在，raw 取不到原文）：`);
    for (const s of staleAll.slice(0, 30)) {
      console.log(`  - ${s.scope}#${s.id}  「${clip(s.title, 40)}」  会话 ${String(s.sid || '').slice(0, 24)}`);
    }
    if (staleAll.length > 30) console.log(`  …另有 ${staleAll.length - 30} 条`);
    console.log('  修法：确认会话是否被清理；必要时 backfill 重新定位，或 --raw-text 手工补');
  } else {
    console.log('\n【锚点失效】无 ✓');
  }
}

// ---------------------------------------------------------------- export / import

/** 导出记忆（JSON 或 Markdown），默认 stdout */
function cmdExport() {
  const { flags, rest } = parseFlags(argv.slice(1));
  const scopes = flags.scope
    ? String(flags.scope).split(',').map((s) => s.trim())
    : (rest[0] ? [rest[0]] : store.listScopes());
  const format = flags.format || 'json';
  const all = [];
  for (const scope of scopes) {
    for (const n of store.listNodes(scope, { limit: 100000, includeDeleted: false })) all.push({ ...n, scope });
  }
  if (format === 'md') {
    const lines = ['# Memory export', ''];
    for (const n of all) {
      lines.push(`## ${n.title}  (${n.scope}#${n.id})`);
      lines.push(`- kind: ${n.kind} / weight: ${n.weight} / created: ${n.created_at}`);
      if (n.tags) lines.push(`- tags: ${n.tags}`);
      lines.push('');
      lines.push(n.summary || '');
      if (n.body) { lines.push(''); lines.push(n.body); }
      lines.push('');
    }
    process.stdout.write(lines.join('\n'));
  } else {
    process.stdout.write(JSON.stringify(all, null, 2) + '\n');
  }
}

/** 从 JSON 导入（跳过查重，信任输入；重复导入会重复） */
/** 取一段文本的首句/前 60 字，用作导入时的标题兜底 */
function firstLine(text, max = 60) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  const m = t.match(/^.{1,60}?[。！？.!?]/);
  return (m ? m[0] : t.slice(0, max)).trim();
}

const IMPORT_KIND_MAP = {
  lesson: 'pitfall', mistake: 'pitfall', error: 'pitfall',
  project: 'decision', decision: 'decision', user: 'pref', rules: 'pref', rule: 'pref',
  knowledge: 'fact', fact: 'fact', preference: 'pref',
};

/**
 * 宽松导入：兼容其他记忆插件的常见字段。
 *   dsh-memory / dsh-ltm: { text, tags, pinned }
 *   meow-memory:         { title, content, level, importance }
 *   本包导出:            { title, summary, body, kind, tags, weight, scope }
 */
function normalizeImportItem(it, scopeArg) {
  if (!it || typeof it !== 'object') return null;
  const pick = (v) => (typeof v === 'string' ? v : '');
  const rawText = (pick(it.text) || pick(it.content) || pick(it.body)).trim();
  const title = String(it.title || it.name || firstLine(rawText) || '').trim().slice(0, 200);
  if (!title) return null;

  let summary = String(it.summary || rawText || title).trim();
  let body = pick(it.body).trim() || (rawText.length > 500 ? rawText : '');
  if (summary.length > 500) {
    if (!body) body = summary;
    summary = summary.slice(0, 499) + '…';
  }

  const kindRaw = String(it.kind || it.level || it.type || '').toLowerCase();
  const valid = ['fact', 'decision', 'pitfall', 'pref', 'state', 'todo', 'note', 'session'];
  const kind = valid.includes(kindRaw)
    ? kindRaw
    : (IMPORT_KIND_MAP[kindRaw] || (it.pinned ? 'fact' : 'note'));

  const tags = Array.isArray(it.tags)
    ? it.tags.map(String)
    : String(it.tags || '').split(',').map((s) => s.trim()).filter(Boolean);

  return {
    scope: scopeArg || it.scope || (it.project ? 'proj:' + it.project : 'global'),
    kind,
    title,
    summary,
    body,
    tags,
    weight: Math.min(5, Math.max(1, Math.round(Number(it.weight || it.importance || (it.pinned ? 5 : 3)) || 3))),
    sessionId: it.session_id || it.sessionId || '',
    rawRef: it.raw_ref || it.rawRef || '',
  };
}

function cmdImport() {
  const { flags, rest } = parseFlags(argv.slice(1));
  const file = flags.file || rest[0];
  if (!file) die('缺少 JSON 文件：mem.js import <file.json> 或 --file');
  if (!fs.existsSync(file)) die('文件不存在: ' + file);
  const items = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(items)) die('JSON 应为数组');
  const scopeArg = flags.scope || null;
  let ok = 0, skipped = 0;
  for (const it of items) {
    const n = normalizeImportItem(it, scopeArg);
    if (!n) { skipped++; continue; }
    store.addNode(n.scope, {
      kind: n.kind,
      title: n.title,
      summary: n.summary,
      body: n.body,
      tags: n.tags,
      weight: n.weight,
      sessionId: n.sessionId,
      rawRef: n.rawRef,
      source: 'import',
    });
    ok++;
  }
  console.log(`[已导入] ${ok} 条${skipped ? `，跳过 ${skipped} 条（无标题/空内容）` : ''} -> ${scopeArg || '原 scope'}`);
}

// ---------------------------------------------------------------- scopes / stats

function cmdScopes() {
  const scopes = store.listScopes();
  console.log(`共 ${scopes.length} 个记忆库：\n`);
  for (const s of scopes) {
    const f = store.scopeFile(s);
    const exists = fs.existsSync(f);
    let count = 0;
    if (exists) {
      try {
        const db = new (require('node:sqlite').DatabaseSync)(f, { readOnly: true });
        count = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
        db.close();
      } catch { /* ignore */ }
    }
    const size = exists ? (fs.statSync(f).size / 1024).toFixed(0) + 'KB' : '-';
    console.log(`  ${s.padEnd(24)} ${String(count).padStart(4)} 条  ${size.padStart(8)}  ${path.basename(f)}`);
  }
}

function cmdStats() {
  const st = store.stats();
  if (!st.length) { console.log('(记忆库为空)'); return; }
  let total = 0, activeTotal = 0, metaTotal = 0;
  console.log('记忆库统计');
  console.log('='.repeat(70));
  for (const s of st) {
    total += s.total || 0;
    activeTotal += s.active || 0;
    metaTotal += s.meta || 0;
    console.log(`\n${s.scope}   ${s.total} 条   ${(s.bytes / 1024).toFixed(0)}KB`);
    if (s.byKind) {
      console.log('   ' + s.byKind.map((k) => `${KIND_LABEL[k.kind] || k.kind}:${k.c}`).join('  '));
    }
    if (s.active) {
      const pct = s.active ? Math.round((s.meta / s.active) * 100) : 0;
      const flag = pct > 30 ? '  ⚠️ 超过 30%' : '';
      console.log(`   元记忆: ${s.meta}/${s.active}（${pct}%）${flag}`);
    }
    if (s.error) console.log('   错误: ' + s.error);
  }
  console.log('\n' + '='.repeat(70));
  console.log(`合计 ${total} 条记忆，分布在 ${st.length} 个库`);
  if (activeTotal) {
    console.log(`元记忆 ${metaTotal}/${activeTotal}（${Math.round((metaTotal / activeTotal) * 100)}%）—— 这些是「关于记忆系统自身」的条目，过多会挤占工作记忆`);
  }
}

// ---------------------------------------------------------------- update / rm

function cmdUpdate() {
  const { flags, rest } = parseFlags(argv.slice(1));
  const { scope, id } = parseRef(rest[0]);
  const fields = {};
  const map = {
    title: 'title', summary: 'summary', body: 'body', tags: 'tags', kind: 'kind',
    weight: 'weight', status: 'status',
    'valid-from': 'valid_from', 'valid-until': 'valid_until', 'superseded-by': 'superseded_by',
  };
  for (const [flagName, field] of Object.entries(map)) {
    if (flags[flagName] !== undefined) fields[field] = flags[flagName];
  }
  if (flags.corrected !== undefined) fields.corrected = Number(flags.corrected) ? 1 : 0;
  // 版本保护：--rev 必须与当前 revision 一致，防并发覆盖（2026-10-21 加）
  // 注意：预检只是给个早错误；真正的防覆盖靠 updateNode 的 CAS（WHERE revision = ?）。
  let expectRev;
  if (flags.rev !== undefined) {
    const cur = store.getNode(scope, id);
    if (!cur) die(`找不到 ${scope}#${id}`);
    if (Number(flags.rev) !== Number(cur.revision)) {
      die(`版本冲突：当前 revision=${cur.revision}，你给的是 ${flags.rev}；先 show 再改`);
    }
    expectRev = Number(flags.rev);
  }
  if (!Object.keys(fields).length) die('没有指定要改的字段');
  let ok;
  try {
    ok = store.updateNode(scope, id, fields, expectRev === undefined ? {} : { expectRev });
  } catch (e) {
    die(String((e && e.message) || e));
  }
  console.log(ok ? `[已更新] ${scope}#${id} -> ${Object.keys(fields).join(', ')}` : `[错误] 找不到 ${scope}#${id}`);
  if (!ok) return;

  // ---- update 的原文处理（2026-10-16 补）----------------------------------
  // 起因：`update` 原先完全不碰原文，所以「修订一条已有记忆」后原文还是旧的，
  // 甚至从来没有原文也不会提醒（#3 就是这样，改完还得手工补）。
  // 策略（保守，避免破坏已有正确原文）：
  //   · 该条**没有**原文 → 自动抓当前会话补上（同 add）
  //   · 该条**已有**原文 → 只在显式给了 --refresh-raw 时才覆盖
  const wantRefresh = Boolean(flags['refresh-raw']);
  const existing = store.getNodeRaw(scope, id);
  const autoRawOff = Boolean(flags['no-auto-raw']);
  if ((!existing || wantRefresh) && !autoRawOff) {
    try {
      const auto = autoExtractRecent({ maxEvents: Number(flags['auto-raw-events'] || 40) });
      if (auto && auto.text.trim()) {
        store.setNodeRaw(scope, id, {
          text: auto.text, source: 'dsh-session', sessionId: auto.sessionId,
          seqStart: auto.lo, seqEnd: auto.hi,
        });
        console.log(`[原文] ${existing ? '已刷新' : '自动补上'}当前会话 seq ${auto.lo}-${auto.hi}（${auto.text.length} 字）`);
        const n = store.getNode(scope, id);
        const { verifyRawMatch } = require('./lib/extract');
        const v = verifyRawMatch(auto.text, n?.title || '', n?.summary || '');
        const tag = v.verdict === 'mismatch' ? '⚠️ 原文可疑' : (v.verdict === 'weak' ? '原文偏弱' : '原文校验');
        console.log(`[${tag}] 相关度 ${(v.score * 100).toFixed(0)}%${v.verdict === 'ok' ? ' ✓' : `（命中样本: ${v.sample.join(' / ') || '无'}）`}`);
      }
    } catch (e) {
      console.log(`[原文] 自动抓取失败：${e.message}（可用 backfill 或 tools/_fix_raw.js 补）`);
    }
  } else if (existing && !wantRefresh) {
    console.log(`[原文] 保持原有（${existing.chars} 字）；要换成当前会话的，加 --refresh-raw`);
  }
}

function cmdRm() {
  const { rest, flags } = parseFlags(argv.slice(1));
  const { scope, id } = parseRef(rest[0]);
  const hard = Boolean(flags.hard);
  const ok = store.deleteNode(scope, id, { hard });
  if (!ok) { console.log(`[错误] 找不到 ${scope}#${id}`); return; }
  if (hard) {
    console.log(`[已物理删除] ${scope}#${id}（连原文一起，不可恢复）`);
  } else {
    console.log(`[已软删除] ${scope}#${id}  —— 默认检索不再返回，原文保留`);
    console.log(`            恢复用: mem.js restore "${scope}#${id}"   彻底删用: mem.js rm "${scope}#${id}" --hard`);
  }
}

/** 从软删除恢复 */
function cmdRestore() {
  const { rest } = parseFlags(argv.slice(1));
  const { scope, id } = parseRef(rest[0]);
  const ok = store.restoreNode(scope, id);
  console.log(ok ? `[已恢复] ${scope}#${id}` : `[未恢复] ${scope}#${id} 不存在或未被软删除`);
}

/**
 * 一条命令完成「旧结论失效 + 记录被谁取代 + 写明原因」。
 * 之前要手敲 update --valid-until --superseded-by 两个参数，容易漏、也记不下原因。
 */
function cmdSupersede() {
  const { flags, rest } = parseFlags(argv.slice(1));
  const { scope, id } = parseRef(rest[0]);
  const old = store.getNode(scope, id);
  if (!old) die(`找不到 ${scope}#${id}`);

  const byRef = flags.by || flags.superseded_by || flags['superseded-by'];
  if (!byRef) die('缺少 --by <新条目ref>，例如 --by "proj:XX#12"');

  const byScope = byRef.includes('#') ? byRef.split('#')[0] : scope;
  const byId = Number(String(byRef).split('#').pop());
  if (!Number.isFinite(byId)) die(`--by 格式应为 <scope>#<id>，收到 ${byRef}`);
  const newer = store.getNode(byScope, byId);
  if (!newer) die(`--by 指向的条目不存在：${byScope}#${byId}`);

  const reason = flags.reason ? String(flags.reason) : '';
  const when = store.nowIso();

  const fields = {
    valid_until: when,
    superseded_by: `${byScope}#${byId}`,
  };
  // 失效原因写进 body，别只留在 superseded_by 里——原文是旧的，看不出为什么失效
  if (reason) {
    const note = `\n\n[失效原因 ${when}] ${reason}（被 ${byScope}#${byId} 取代）`;
    fields.body = `${old.body || ''}${note}`;
  }

  const ok = store.updateNode(scope, id, fields);
  if (!ok) die(`更新失败：${scope}#${id}`);

  console.log(`[已取代] ${scope}#${id}「${old.title}」`);
  console.log(`         失效于 ${when}，被 ${byScope}#${byId}「${newer.title}」取代`);
  if (reason) console.log(`         原因: ${reason}`);
  console.log(`         默认检索不再返回这条；看历史用 search --all，看原文用 raw "${scope}#${id}"`);
}

// ---------------------------------------------------------------- 项目

function cmdNewProject() {
  const { rest } = parseFlags(argv.slice(1));
  const name = rest.join(' ').trim();
  if (!name) die('缺少项目名');
  const scope = 'proj:' + name;
  const f = store.scopeFile(scope);
  if (fs.existsSync(f)) { console.log(`[已存在] 项目「${name}」`); return; }

  // 直接建库并登记显示名，不写占位记录（避免浪费 id=1）
  const { db } = store.openScope(scope);
  try {
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('display_name',?)").run(name);
    db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('created_at',?)").run(store.nowIso());
  } finally {
    db.close();
  }
  console.log(`[已创建] 项目「${name}」 -> ${f}`);
}

function cmdDropProject() {
  const { rest, flags } = parseFlags(argv.slice(1));
  const name = rest.join(' ').trim();
  if (!name) die('缺少项目名');
  if (!flags.yes) die(`删除项目「${name}」会丢失其全部记忆，确认请加 --yes`);
  const ok = store.dropScope('proj:' + name);
  console.log(ok ? `[已删除] 项目「${name}」` : `[错误] 项目「${name}」不存在`);
}

// ---------------------------------------------------------------- wrapup

/**
 * 会话收尾：把本轮会话压成一条 session 记忆。
 * 只存简报（几百字），完整对话留在会话日志里，需要时 `raw <ref> --log` 回源。
 * 水位记录在 <MEM_ROOT>/wrapup-state.json，同一次会话只处理新增部分。
 */
function cmdWrapup() {
  const { flags } = parseFlags(argv.slice(1));
  const scope = flags.scope ? String(flags.scope) : 'chat';
  const dry = Boolean(flags.dry);
  const { buildBrief, markDone } = require('./lib/wrapup');

  let r;
  try { r = buildBrief(); } catch (e) { die(e.message); }
  if (r.empty) {
    console.log(`[wrapup] 没有新内容（上次已处理到 seq ${r.lastSeq}）`);
    return;
  }

  let summary = r.brief;
  if (flags.note) {
    summary = summary.replace('【结论 / 下一步】（待补：由写记忆的人填）', '【结论 / 下一步】\n' + String(flags.note));
  }

  console.log(summary);
  console.log('-'.repeat(70));
  console.log(`会话: ${r.sessionId}   seq: ${r.lo}-${r.hi}   事件: ${r.eventCount}   轮次: ${r.turnCount}`);

  if (dry) { console.log('[dry] 未写入。去掉 --dry 即写入。'); return; }

  const date = new Date().toISOString().slice(0, 10);
  const title = `${date} 会话小结：${(r.firstUser || '（无用户消息）').slice(0, 30)}`;
  const res = store.addNode(scope, {
    kind: 'session',
    title,
    summary,
    tags: ['会话小结', 'wrapup'],
    weight: 3,
    sessionId: r.sessionId,
    rawRef: JSON.stringify({ sessionId: r.sessionId, seqStart: r.lo, seqEnd: r.hi }),
    raw: { text: summary, source: 'wrapup', sessionId: r.sessionId, seqStart: r.lo, seqEnd: r.hi },
    source: 'wrapup',
  });
  markDone(r.sessionId, r.hi);
  console.log(`[已记录] ${scope}#${res.id}  原文存的是本条简报（${r.brief.length} 字）`);
  console.log(`         完整对话用: mem.js raw ${scope}#${res.id} --log`);
}

// ---------------------------------------------------------------- handoff

/**
 * 2026-10-19 改造（用户要求：项目会结束，旧的该丢掉；且每会话改 AGENTS.md 会打断前缀缓存）：
 *  - HANDOFF.md 只保留「当前活跃项目的最新状态」，旧状态丢弃（历史仍在记忆库，可 search/raw）。
 *  - 不再自动改写工作区 AGENTS.md —— 它现在是一份稳定文件，只留一行指针；
 *    新会话开局主动读 HANDOFF.md。
 */
const ACTIVE_DAYS = 3;         // 超过这么多天没有新节点的项目不再进接力摘要（2026-10-19 从 14 下调，用户认为两周太长）
const MAX_ACTIVE_PROJECTS = 3; // 最多同时列几个活跃项目

/** 把一段文本压成一行，超长截断 */
function clipText(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function scopeLabel(scope) {
  if (scope === 'global') return '全局';
  if (scope === 'chat') return '暂存区';
  return scope.replace(/^proj:/, '');
}

/**
 * 从某个 scope 的节点里挑出某类的最新 N 条。
 *
 * 配额按时间排（保证不吃进太旧的东西），但可以用 sortByWeight 让**展示顺序**按权重。
 *
 * 2026-10-20 修（用户发现 decision 配额 3 把最重要的那条挤掉了）：
 *   原来的排序是「时间优先、权重次之」，于是「早 9 秒但 weight=5」会输给
 *   「晚 9 秒但 weight=4」。实测本轮 #23（记忆库瘦身，w5）就是这样被挤掉，
 *   而它是这次最大的改动。
 *   现在：配额从 3 提到 5（覆盖同一批次写入的多条决策），
 *   展示顺序按 weight 倒序（重要的排前面）。
 */
function latestOf(nodes, kind, n, minWeight = 0, { sortByWeight = false } = {}) {
  const picked = nodes
    .filter((r) => r.kind === kind && r.weight >= minWeight)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || b.weight - a.weight)
    .slice(0, n);
  if (sortByWeight) {
    picked.sort((a, b) => b.weight - a.weight || String(b.created_at).localeCompare(String(a.created_at)));
  }
  return picked;
}

/** 生成 HANDOFF.md：按项目分组，每个项目只留最新状态 + 未完成待办 + 最近会话 + 高权重决策 */
function buildHandoffBody(scopeData) {
  const L = [];
  L.push('# 交接摘要（自动生成，勿手改）', '');
  L.push(`> 生成时间：${store.nowIso()}`);
  L.push('> 只保留**当前活跃项目的最新状态**；旧状态已丢弃，历史用 `mem.js search` / `raw` 查。');
  L.push('> 只在用户说「接着做」时才读本文件，不主动读；状态有变化就重跑 `mem.js handoff`。', '');

  for (const { scope, nodes, doneCount = 0 } of scopeData) {
    const state = latestOf(nodes, 'state', 1);
    const todos = latestOf(nodes, 'todo', 5);
    const sessions = latestOf(nodes, 'session', 1);
    // 决策：配额 5、weight>=4、展示按权重排序（2026-10-20 从 3 提到 5）
    const decisions = latestOf(nodes, 'decision', 5, 4, { sortByWeight: true });
    if (!state.length && !todos.length && !sessions.length && !decisions.length) continue;

    L.push(`## ${scopeLabel(scope)}　\`${scope}\``, '');
    // 进度行（2026-10-19 加）：交接时能一眼看出这个项目做了多少、还剩多少
    if (scope.startsWith('proj:')) {
      const openTodos = nodes.filter((n) => n.kind === 'todo').length;
      L.push(`> 进度：已完成 ${doneCount} 项 · 待办 ${openTodos} 项`, '');
    }
    for (const r of state) {
      L.push(`- **状态**　${r.title}　\`${scope}#${r.id}\``);
      if (r.summary && r.summary !== r.title) L.push(`  - ${clipText(r.summary, 320)}`);
    }
    for (const r of todos) {
      L.push(`- **待办**　${r.title}　\`${scope}#${r.id}\``);
      if (r.summary && r.summary !== r.title) L.push(`  - ${clipText(r.summary, 160)}`);
    }
    for (const r of sessions) {
      L.push(`- **最近会话**　${r.title}　\`${scope}#${r.id}\``);
      if (r.summary && r.summary !== r.title) L.push(`  - ${clipText(r.summary, 220)}`);
    }
    for (const r of decisions) {
      L.push(`- **决策(权重${r.weight})**　${r.title}　\`${scope}#${r.id}\``);
      if (r.summary && r.summary !== r.title) L.push(`  - ${clipText(r.summary, 180)}`);
    }
    L.push('');
  }
  return L.join('\n');
}

function cmdHandoff() {
  const scopes = store.listScopes();
  const nowMs = Date.now();
  const all = [];
  for (const scope of scopes) {
    const nodes = store.listNodes(scope, { limit: 200, status: scope === 'global' ? null : 'open', validOnly: true });
    if (!nodes.length) continue;
    let last = '';
    for (const n of nodes) { const t = String(n.created_at || ''); if (t > last) last = t; }
    const lastMs = last ? new Date(last.replace(' ', 'T')).getTime() : 0;
    // 已完成数（2026-10-19 加）：交接时显示项目进度。单独查一次 done 的 todo 条数，
    // 因为上面的 listNodes 只取 status='open'，done 的根本不在 nodes 里。
    let doneCount = 0;
    if (scope.startsWith('proj:')) {
      try {
        doneCount = store.listNodes(scope, { limit: 500, kinds: ['todo'], status: 'done', validOnly: false }).length;
      } catch { /* 查询失败就显示 0，不影响交接生成 */ }
    }
    all.push({ scope, nodes, last, ageDays: lastMs ? (nowMs - lastMs) / 86400000 : 1e9, doneCount });
  }

  const base = all.filter((x) => x.scope === 'global' || x.scope === 'chat')
    .sort((a, b) => b.last.localeCompare(a.last));
  const active = all.filter((x) => x.scope.startsWith('proj:') && x.ageDays <= ACTIVE_DAYS);
  // 有未完成待办的项目强制保留（否则会被"最近活跃"挤掉），其余按最近活跃排序
  const withTodo = active.filter((x) => x.nodes.some((n) => n.kind === 'todo'));
  const recent = active.slice().sort((a, b) => b.last.localeCompare(a.last));
  const picked = [];
  for (const x of [...withTodo, ...recent]) {
    if (!picked.some((y) => y.scope === x.scope)) picked.push(x);
    if (picked.length >= MAX_ACTIVE_PROJECTS + 2) break;
  }
  const projects = picked.sort((a, b) => b.last.localeCompare(a.last));

  const out = path.join(store.MEM_ROOT, 'HANDOFF.md');
  fs.writeFileSync(out, buildHandoffBody([...base, ...projects]).replace(/\n+$/, '') + '\n', 'utf8');
  console.log(`[已生成] ${out}（活跃项目 ${projects.length} 个，${ACTIVE_DAYS} 天没更新的已淡出）`);
  console.log('         工作区 AGENTS.md 不被改写。本文件只在用户说「接着做」时才读，不主动读。');
}

// ---------------------------------------------------------------- init

/**
 * 初始化空库：只建表和目录，不写任何记忆。
 * 用途：换电脑 / 新环境时，让框架先能跑起来（数据各自从头开始）。
 */
function cmdInit() {
  const scopes = ['global', 'chat'];
  for (const s of scopes) {
    const f = store.ensureScope(s);
    console.log(`[已就绪] ${s}  ${f}`);
  }
  console.log(`\n数据根: ${store.MEM_ROOT}`);
  console.log('空库已建好，可以开始 add。');
}

// ---------------------------------------------------------------- config

function cmdConfig() {
  const { flags } = parseFlags(argv.slice(1));
  const cfg = store.loadConfig();
  let changed = false;
  if (flags['top-k'] !== undefined) { cfg.topK = Number(flags['top-k']); changed = true; }
  if (flags['half-life'] !== undefined) { cfg.recencyHalfLifeDays = Number(flags['half-life']); changed = true; }
  if (flags['max-summary'] !== undefined) { cfg.maxSummaryChars = Number(flags['max-summary']); changed = true; }
  if (changed) { store.saveConfig(cfg); console.log('[已保存] ' + store.CONFIG_PATH); }
  console.log(JSON.stringify(cfg, null, 2));
}

// ---------------------------------------------------------------- main

const CMDS = {
  add: cmdAdd, search: cmdSearch, grep: cmdGrep, list: cmdList, show: cmdShow, raw: cmdRaw,
  'raw-fetch': cmdRawFetch, backfill: cmdBackfill, doctor: cmdDoctor,
  export: cmdExport, import: cmdImport,
  scopes: cmdScopes, stats: cmdStats, update: cmdUpdate, rm: cmdRm,
  restore: cmdRestore, supersede: cmdSupersede,
  newproject: cmdNewProject, dropproject: cmdDropProject,
  wrapup: cmdWrapup, handoff: cmdHandoff, config: cmdConfig,
  tidy: cmdTidy,
  init: cmdInit,
};

if (CMDS[cmd]) {
  try {
    CMDS[cmd]();
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/not a database|database disk image is malformed|file is encrypted/i.test(msg)) {
      die(`数据库文件损坏或不是 SQLite（${msg}）；先备份，再用 export 或备份恢复`);
    }
    die(msg);
  }
} else {
  const help = fs.readFileSync(__filename, 'utf8').split('*/')[0].split('/**')[1];
  console.log(help.replace(/^\s*\*n?/gm, '').replace(/^\s*\* ?/gm, ''));
  process.exit(cmd ? 1 : 0);
}
