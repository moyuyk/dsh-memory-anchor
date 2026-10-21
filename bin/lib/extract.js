'use strict';
/**
 * 原文提取与定位层
 * ==================
 *
 * 两个用途：
 *
 * 1. renderOriginalText —— 把会话日志里某个 seq 范围渲染成**完整可读原文**
 *    （不截断、不摘要）。记忆库用它把原文真正存进自己的库，
 *    不再只依赖 DSH 会话日志。
 *
 * 2. locateOriginal —— 给一条已有记忆在会话里定位「它来自哪一轮对话」，
 *    用关键词命中率打分，供历史条目回填原文。
 *
 * 角色标签、消息结构统一走 messages.js 的 normalizeEvent，避免重复解析逻辑。
 */

const { normalizeEvent, isHumanMessage } = require('./messages');

const ROLE_LABEL = {
  user: '👤 用户',
  assistant: '🤖 模型',
  system: '⚙️ 系统',
  developer: '⚙️ 开发者',
  'tool-call': '🔧 工具调用',
  'tool-result': '↩️ 工具结果',
};

/** 把归一化节点还原成文本（工具调用渲染成 name(args) 全文） */
function renderNodeText(n) {
  if (n.role === 'tool-call') {
    return (n.toolCalls || []).map((tc) => {
      const args = typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments);
      return `${tc.name || 'tool'}(${args ?? ''})`;
    }).join('\n');
  }
  return n.text || '';
}

/**
 * 把 [lo, hi] 范围内的会话事件渲染成完整原文。
 * 不设长度上限 —— 原文就是原文；截断由调用方决定。
 */
function renderOriginalText(events, { lo = 0, hi = Infinity, includeReasoning = false, withHeader = true } = {}) {
  const out = [];
  for (const e of events) {
    if (typeof e.seq !== 'number' || e.seq < lo || e.seq > hi) continue;
    const n = normalizeEvent(e);
    if (!n) continue;
    const body = renderNodeText(n);
    const reasoning = includeReasoning && n.reasoning ? '[思考]\n' + n.reasoning : '';
    const piece = [body, reasoning].filter(Boolean).join('\n\n');
    if (!piece.trim()) continue;
    if (withHeader) out.push(`[seq=${n.seq}] ${ROLE_LABEL[n.role] || n.role}`);
    out.push(piece.trimEnd());
    out.push('');
  }
  return out.join('\n').replace(/\n+$/, '\n');
}

/** 中文停用片段（避免 2-gram 全是虚词导致误匹配） */
const STOP_GRAMS = new Set([
  '的', '了', '是', '在', '和', '与', '就', '都', '也', '有', '我', '你', '他', '它', '这', '那',
  '一个', '没有', '可以', '需要', '如果', '因为', '所以', '但是', '然后', '这个', '那个', '什么',
  '怎么', '已经', '还是', '不是', '我们', '他们', '自己', '时候', '问题', '现在', '应该', '而且',
  '就是', '这样', '那样', '一下', '一次', '之后', '之前', '上面', '下面', '里面', '出来', '起来',
]);

/** 从标题+摘要里抽关键词（英文单词 + 中文 2/3-gram），用于定位原文 */
function keywordsOf(text, max = 30) {
  const s = String(text || '');
  const grams = new Set();
  for (const w of s.match(/[A-Za-z][A-Za-z0-9_.\-]{2,}/g) || []) grams.add(w.toLowerCase());
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    for (let i = 0; i < seg.length - 1; i++) {
      grams.add(seg.slice(i, i + 2));
      if (i + 3 <= seg.length) grams.add(seg.slice(i, i + 3));
    }
  }
  const list = [...grams].filter((g) => !STOP_GRAMS.has(g) && g.length >= 2);
  // 长片段（更具体）优先
  list.sort((a, b) => b.length - a.length);
  return list.slice(0, max);
}

/** 按真人消息把会话切成「轮次块」（分别累积提问/模型/工具文本，便于加权与时间约束） */
function buildTurnBlocks(events) {
  const nodes = [];
  for (const e of events) {
    if (typeof e.seq !== 'number') continue;
    const n = normalizeEvent(e);
    if (!n) continue;
    n._text = renderNodeText(n);
    nodes.push(n);
  }
  nodes.sort((a, b) => a.seq - b.seq);

  const blocks = [];
  let cur = null;
  for (const n of nodes) {
    if (isHumanMessage(n)) {
      if (cur) blocks.push(cur);
      cur = {
        startSeq: n.seq, endSeq: n.seq, time: n.time || null,
        userText: n.text || '', asstText: '', toolText: '', nodes: [n],
      };
    } else if (cur) {
      cur.endSeq = n.seq;
      cur.nodes.push(n);
      if (n.role === 'tool-call' || n.role === 'tool-result') cur.toolText += '\n' + n._text;
      else cur.asstText += '\n' + n._text;
    }
  }
  if (cur) blocks.push(cur);
  // 兼容字段：整轮全文
  for (const b of blocks) b.text = [b.userText, b.asstText, b.toolText].filter(Boolean).join('\n');
  return blocks;
}

/** 关键词命中率（0~1） */
function scoreAgainst(text, keywords) {
  if (!text || !keywords.length) return 0;
  const t = String(text).slice(0, 40000).toLowerCase();
  let hit = 0;
  for (const k of keywords) if (t.includes(k.toLowerCase())) hit++;
  return hit / keywords.length;
}

/** 时间接近度：目标时间落在会话区间内记 1，否则按距离指数衰减 */
function timeFactorFor(createdAt, lastTime, targetTime, halfLifeMs = 6 * 3600 * 1000) {
  if (!targetTime || !createdAt) return 1;
  if (targetTime >= createdAt && (!lastTime || targetTime <= lastTime)) return 1;
  const d = targetTime < createdAt ? createdAt - targetTime : targetTime - lastTime;
  return Math.exp(-d / halfLifeMs);
}

/**
 * 在一批轮次块里定位与关键词最匹配的一轮，返回 { lo, hi, score, userSeq }。
 *
 * 打分 = 关键词命中（提问 0.45 / 模型 0.40 / 工具 0.15，工具权重低是因为
 * 会话开头的注入与工具回显会「碰巧」包含大量关键词）× 时间接近度。
 * 时间约束是必须的：否则早先会话里读到的 HANDOFF 摘要会把定位带偏。
 */
function locateInBlocks(blocks, keywords, { targetTime = null, halfLifeMs = 6 * 3600 * 1000 } = {}) {
  let best = null;
  for (const b of blocks) {
    const kw = 0.45 * scoreAgainst(b.userText, keywords)
      + 0.40 * scoreAgainst(b.asstText, keywords)
      + 0.15 * scoreAgainst(b.toolText, keywords);
    const tf = (targetTime && b.time) ? Math.exp(-Math.abs(b.time - targetTime) / halfLifeMs) : 1;
    const score = kw * (0.4 + 0.6 * tf);
    if (!best || score > best.score) {
      best = { lo: b.startSeq, hi: b.endSeq, score, kw, timeFactor: tf, time: b.time, userSeq: b.startSeq, userText: b.userText, block: b };
    }
  }
  return best;
}

/**
 * 轮内再聚焦：长轮（几十万字）整轮存下来没用，取与该条记忆最相关的那条消息
 * 前后各 span 个节点作为原文范围，让「原文」是可读的一段而不是一整轮。
 */
function refineRange(block, keywords, { span = 8 } = {}) {
  const nodes = block?.nodes || [];
  if (nodes.length <= span * 2 + 1) return { lo: block.startSeq, hi: block.endSeq, refined: false };
  let bi = -1, bs = -1;
  for (let i = 0; i < nodes.length; i++) {
    const s = scoreAgainst(nodes[i]._text || '', keywords);
    if (s > bs) { bs = s; bi = i; }
  }
  if (bi === -1 || bs <= 0) return { lo: block.startSeq, hi: block.endSeq, refined: false };
  return {
    lo: nodes[Math.max(0, bi - span)].seq,
    hi: nodes[Math.min(nodes.length - 1, bi + span)].seq,
    refined: true,
  };
}

/** 在会话事件里定位原轮次（先切块再匹配） */
function locateOriginal(events, keywords, opts) {
  return locateInBlocks(buildTurnBlocks(events), keywords, opts);
}

/**
 * 校验「一条记忆的原文是否真的对得上它自己」。
 *
 * 背景（2026-10-16 实测踩坑）：backfill 靠「写入时间 + 关键词」猜原文，
 * **猜错不报错**——两条不同主题的记忆曾被配成同一段原文，匹配分 0.22 也照写。
 * 所以写入后必须回头核对，不能只看它打了 ✓。
 *
 * 判据：用摘要关键词在原文里的命中率。
 *
 * 阈值校准（2026-10-16 实测）：先设 0.12/0.25，结果 5 条报警里 3 条是误报
 * （如「ComfyUI 按需拉起」原文命中 comfyui/main.py/--listen/venv 等 8 个词，
 * 相关度 23% 却报可疑）。原因是摘要经我提炼，用词与原文口语表述天然对不上。
 * 真正配错的那两条相关度是 3% 和 8%。故下调到 0.06/0.12：
 * 只抓「几乎完全不搭」这一档，宁少报不误报。
 *
 * @returns {{score:number, hit:number, total:number, verdict:'ok'|'weak'|'mismatch', sample:string[]}}
 */
function verifyRawMatch(rawText, title, summary, { mismatchBelow = 0.06, weakBelow = 0.12 } = {}) {
  const kws = keywordsOf(`${title || ''} ${summary || ''}`, 40);
  const text = String(rawText || '').toLowerCase();
  const hitWords = [];
  for (const k of kws) {
    if (text.includes(k.toLowerCase())) hitWords.push(k);
  }
  const score = kws.length ? hitWords.length / kws.length : 0;
  const verdict = score < mismatchBelow ? 'mismatch' : (score < weakBelow ? 'weak' : 'ok');
  // 命中词里挑最长的几个当「证据样本」，便于人眼快速判断
  const sample = hitWords.slice().sort((a, b) => b.length - a.length).slice(0, 8);
  return { score, hit: hitWords.length, total: kws.length, verdict, sample };
}

module.exports = {
  ROLE_LABEL,
  renderNodeText,
  renderOriginalText,
  keywordsOf,
  buildTurnBlocks,
  scoreAgainst,
  timeFactorFor,
  locateInBlocks,
  refineRange,
  locateOriginal,
  verifyRawMatch,
};
