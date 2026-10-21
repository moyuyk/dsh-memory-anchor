'use strict';
/**
 * 会话收尾简报（wrapup）
 * ========================
 *
 * 目的：会话结束时，把「这一轮到底干了什么」压成一条几百字的记忆，
 * 而不是把几万字对话原样塞进库。
 *
 * 设计取舍：
 * 1. 只做「事实提取」，不做「结论提炼」——结论由写的人补。
 *    脚本能可靠拿到的是：用户说了什么、调了哪些工具、改了哪些文件；
 *    拿不到的是「所以呢」。所以简报里留空位，不假装会总结。
 * 2. 按水位增量处理：记住每个会话已处理到哪个 seq，下次只处理新增部分。
 * 3. 原文存的就是这份简报（不是整段对话）；完整对话留在会话日志里，
 *    用 `mem.js raw <ref> --log` 按 seq 回源取。
 */

const fs = require('fs');
const path = require('path');
const { listSessions, readSession } = require('./session-log');
const { normalizeEvent, isHumanMessage } = require('./messages');

const STATE_FILE = path.join(__dirname, '..', '..', 'wrapup-state.json');
const NOISE_RE = /system-reminder|Current runtime context|^<system|AUTO-HANDOFF:BEGIN/i;
/** 临时/依赖目录里的文件不算「本轮改动」 */
const IGNORE_PATH_RE = /[\\/]Temp[\\/]|[\\/]temp[\\/]|[\\/]node_modules[\\/]|\.tmp$/i;

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function saveState(s) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function markDone(sessionId, seq) {
  const s = loadState();
  s[sessionId] = { lastSeq: seq, at: new Date().toISOString() };
  saveState(s);
}

function findCurrentSession() {
  const sid = process.env.DSH_SESSION_ID || '';
  const sessions = listSessions();
  if (sid) {
    const hit = sessions.find((x) => x.sessionId === sid) || sessions.find((x) => x.sessionId.includes(sid));
    if (hit) return hit;
  }
  return sessions[0] || null;
}

/** 从工具调用参数里抠出文件路径 */
function filesFromArgs(args) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  for (const k of ['file_path', 'filePath', 'path', 'target']) {
    if (typeof args[k] === 'string' && args[k].trim()) out.push(args[k].trim());
  }
  return out;
}

/**
 * 生成简报。
 * @returns {object} 空时为 { empty:true }；否则含 brief / lo / hi / sessionId 等
 */
function buildBrief({ maxUserChars = 260, maxAsst = 6, maxFiles = 15, maxChars = 1600 } = {}) {
  const target = findCurrentSession();
  if (!target) throw new Error('找不到当前会话（DSH_SESSION_ID 未设置且无历史会话）');

  const state = loadState();
  const lastSeq = state[target.sessionId]?.lastSeq ?? -1;
  const { events } = readSession(target.filePath);

  const fresh = events.filter((e) => typeof e.seq === 'number' && e.seq > lastSeq);
  const talk = fresh.filter((e) => {
    if (!['user/message', 'assistant/message', 'tool/call', 'tool/result'].includes(e.type)) return false;
    if (e.type === 'user/message') {
      const t = (e.data?.content || []).map((c) => c.text || '').join(' ');
      if (NOISE_RE.test(t)) return false;
    }
    return true;
  });

  if (!talk.length) {
    return { empty: true, sessionId: target.sessionId, lastSeq };
  }

  const lo = talk[0].seq;
  const hi = talk[talk.length - 1].seq;

  const userMsgs = [];
  const asstSnips = [];
  const files = new Set();
  const toolCount = new Map();
  let turnCount = 0;

  for (const e of talk) {
    const n = normalizeEvent(e);
    if (!n) continue;
    if (isHumanMessage(n)) {
      turnCount++;
      const t = String(n.text || '').replace(/\s+/g, ' ').trim();
      if (t) userMsgs.push(t.slice(0, maxUserChars));
    } else if (n.role === 'assistant') {
      const t = String(n.text || '').replace(/\s+/g, ' ').trim();
      if (t) asstSnips.push(t.split(/[。！？\n]/)[0].slice(0, 80));
    } else if (n.role === 'tool-call') {
      for (const tc of n.toolCalls || []) {
        const name = tc.name || 'tool';
        toolCount.set(name, (toolCount.get(name) || 0) + 1);
        const a = typeof tc.arguments === 'string'
          ? (() => { try { return JSON.parse(tc.arguments); } catch { return null; } })()
          : tc.arguments;
        for (const f of filesFromArgs(a)) {
          if (!IGNORE_PATH_RE.test(f)) files.add(f);
        }
      }
    }
  }

  const L = [];
  L.push(`本轮会话 seq ${lo}-${hi}（${talk.length} 个事件，${turnCount} 轮对话）`);
  if (userMsgs.length) {
    L.push('');
    L.push('【用户诉求】');
    for (const m of userMsgs.slice(-8)) L.push(`- ${m}`);
  }
  if (toolCount.size) {
    const parts = [...toolCount.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`);
    L.push('');
    L.push('【做了什么】');
    L.push('- 工具调用：' + parts.join('，'));
  }
  if (files.size) {
    L.push('');
    L.push('【涉及文件】');
    for (const f of [...files].slice(0, maxFiles)) L.push(`- ${f}`);
    if (files.size > maxFiles) L.push(`- …共 ${files.size} 个`);
  }
  if (asstSnips.length) {
    L.push('');
    L.push('【回复要点】（每轮首句，供衔接）');
    for (const s of asstSnips.slice(-maxAsst)) L.push(`- ${s}`);
  }
  L.push('');
  L.push('【结论 / 下一步】（待补：由写记忆的人填）');

  let brief = L.join('\n');
  if (brief.length > maxChars) brief = brief.slice(0, maxChars) + '\n…（已截断）';

  return {
    brief, lo, hi,
    sessionId: target.sessionId,
    eventCount: talk.length,
    turnCount,
    files: [...files],
    firstUser: userMsgs[0] || '',
    lastSeq,
  };
}

module.exports = { buildBrief, loadState, saveState, markDone, findCurrentSession, STATE_FILE };
