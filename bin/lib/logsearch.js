'use strict';
/**
 * 会话日志全文检索（2026-10-20 v9 加）
 * ==================================
 * 为什么需要它：
 *   瘦身后原文只存在 DSH 的会话日志里（node_raw 只剩锚点），而 mem.js search
 *   只搜 nodes 的标题/摘要/标签/正文。于是「只出现在原文里的词」（某条报错原文、
 *   某个命令参数）根本搜不到——这层检索是断的。
 *
 * 做法（刻意不建索引）：
 *   ① 读每个会话文件，先解压成整段文本，用子串预筛（不命中就直接跳过，不解析 JSON）；
 *   ② 命中的会话再按行解析成事件，逐条归一化成「角色 + 文本 + 工具参数」；
 *   ③ 返回 会话 id / seq / 角色 / 时间 / 前后文片段。
 *   不写库、不改库、不产生 token。当前日志总量 8 MB 级，实测在百毫秒级。
 *
 * 为什么不建倒排索引：
 *   索引会随日志增长无限膨胀，且日志本身由 DSH 管理、会被压缩/归档；
 *   这个命令是「低频人工排查」，全量扫描足够，还少一套要维护的东西。
 */

const fs = require('fs');
const { listSessions, decompressZstdFrames, parseEventLines } = require('./session-log');
const { normalizeEvent } = require('./messages');

const ROLE_LABEL = {
  user: '用户',
  assistant: '模型',
  system: '系统',
  developer: '开发者',
  'tool-call': '工具调用',
  'tool-result': '工具结果',
};

/** 压成一行，避免片段里带换行把输出撑乱 */
function oneLine(s, max = 240) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** 事件 → 可搜索文本（正文 + 推理 + 工具参数） */
function eventText(n) {
  const parts = [];
  if (n.text) parts.push(n.text);
  if (n.reasoning) parts.push(n.reasoning);
  if (Array.isArray(n.toolCalls)) {
    for (const tc of n.toolCalls) {
      const args = typeof tc.arguments === 'string'
        ? tc.arguments
        : JSON.stringify(tc.arguments ?? '');
      parts.push(`${tc.name || ''} ${args}`.trim());
    }
  }
  return parts.join('\n');
}

/**
 * 在全部会话日志里搜一个词。
 * @param {string} query
 * @param {{limit?:number, session?:string, ignoreCase?:boolean}} opts
 * @returns {{hits:Array, sessionsScanned:number, sessionsMatched:number, ms:number}}
 */
function grepLogs(query, opts = {}) {
  const q = String(query || '').trim();
  const limit = Math.max(1, Number(opts.limit) || 20);
  const ignoreCase = opts.ignoreCase !== false;
  const t0 = Date.now();
  if (!q) return { hits: [], sessionsScanned: 0, sessionsMatched: 0, ms: 0 };

  const ql = ignoreCase ? q.toLowerCase() : q;
  const sessions = listSessions().sort((a, b) => (b.mtimeMs || 0) - (a.mtimeMs || 0));
  const hits = [];
  let scanned = 0, matched = 0;

  for (const s of sessions) {
    if (opts.session && !s.sessionId.includes(opts.session)) continue;
    scanned++;
    let text;
    try {
      const buf = fs.readFileSync(s.filePath);
      text = decompressZstdFrames(buf).text;
    } catch {
      continue;
    }
    const hay = ignoreCase ? text.toLowerCase() : text;
    if (!hay.includes(ql)) continue;   // 整段预筛：不命中连 JSON 都不解析
    matched++;

    let events;
    try { events = parseEventLines(text).events; } catch { continue; }
    for (const ev of events) {
      const n = normalizeEvent(ev);
      if (!n) continue;
      const t = eventText(n);
      if (!t) continue;
      const tl = ignoreCase ? t.toLowerCase() : t;
      const idx = tl.indexOf(ql);
      if (idx < 0) continue;
      const start = Math.max(0, idx - 60);
      const end = Math.min(t.length, idx + q.length + 100);
      hits.push({
        sessionId: s.sessionId,
        seq: n.seq,
        role: ROLE_LABEL[n.role] || n.role,
        time: n.time || '',
        snippet: (start > 0 ? '…' : '') + oneLine(t.slice(start, end)) + (end < t.length ? '…' : ''),
      });
      if (hits.length >= limit * 5) break;   // 单会话上限，避免一个大会话吃掉全部名额
    }
    if (hits.length >= limit * 5) break;
  }

  return { hits: hits.slice(0, limit), sessionsScanned: scanned, sessionsMatched: matched, ms: Date.now() - t0 };
}

module.exports = { grepLogs, ROLE_LABEL };
