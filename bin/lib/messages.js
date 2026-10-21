'use strict';
/**
 * 事件 → 对话轮次 的归一化层
 * ==========================
 *
 * 日志里消息事件有两套不同的结构，解析时必须分别处理（实测确认）：
 *
 *   user/message      → data.content            是 content block 数组
 *   assistant/message → data.message.content    且带 data.turn / data.step / data.usage
 *   system/message    → data.message.content
 *   tool/result       → data.message.content
 *   tool/call         → data.name + data.arguments(JSON 字符串) + data.callId
 *
 * content block 的类型实测有四种：text / reasoning / tool-call / image
 *
 * 归一化后统一成：
 *   { seq, time, kind, role, text, reasoning, toolCalls, toolCallId, usage, meta }
 */

const { buildSurface } = require('./session-log');

/** 把 content block 数组拍平成可读文本 */
function flattenContent(content) {
  if (typeof content === 'string') return { text: content, reasoning: '', blocks: [] };
  if (!Array.isArray(content)) return { text: '', reasoning: '', blocks: [] };

  const texts = [];
  const reasonings = [];
  const toolCalls = [];
  const images = [];
  const other = [];

  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    switch (b.type) {
      case 'text':
        if (b.text) texts.push(b.text);
        break;
      case 'reasoning':
        if (b.text) reasonings.push(b.text);
        break;
      case 'tool-call':
        toolCalls.push({
          callId: b.callId || b.id || null,
          name: b.name || null,
          arguments: b.arguments ?? b.input ?? null,
        });
        break;
      case 'image':
        images.push({ mediaType: b.mediaType || b.mimeType || null, bytes: b.data ? b.data.length : null });
        break;
      default:
        other.push(b.type || 'unknown');
    }
  }

  return {
    text: texts.join('\n'),
    reasoning: reasonings.join('\n'),
    toolCalls,
    images,
    otherTypes: other,
  };
}

/** 从事件里取出「消息对象」——两种结构在这里统一 */
function messageOf(event) {
  const d = event.data || {};
  // user/message 把 content 直接放在 data 上；其余放在 data.message 里
  if (event.type === 'user/message') {
    return { role: d.role || 'user', content: d.content, source: d.source, id: d.id };
  }
  return d.message || null;
}

/**
 * 把一个 surface 事件归一化成统一节点。
 * 返回 null 表示该事件不是对话内容（如纯配置事件）。
 */
function normalizeEvent(event) {
  const d = event.data || {};
  const base = {
    seq: event.seq,
    time: event.time,
    turn: d.turn ?? null,
    step: d.step ?? null,
    kind: event.type,
  };

  switch (event.type) {
    case 'user/message': {
      const msg = messageOf(event);
      const f = flattenContent(msg?.content);
      return {
        ...base,
        role: 'user',
        text: f.text,
        reasoning: '',
        toolCalls: [],
        source: msg?.source?.kind || null,
        images: f.images || [],
      };
    }
    case 'assistant/message': {
      const msg = messageOf(event);
      const f = flattenContent(msg?.content);
      return {
        ...base,
        role: 'assistant',
        text: f.text,
        reasoning: f.reasoning,
        toolCalls: f.toolCalls,
        usage: d.usage || null,
        model: msg?.source?.model || null,
        interrupted: d.interrupted || false,
      };
    }
    case 'system/message':
    case 'developer/message': {
      const msg = messageOf(event);
      const f = flattenContent(msg?.content);
      return {
        ...base,
        role: event.type === 'system/message' ? 'system' : 'developer',
        text: f.text,
        reasoning: '',
        toolCalls: [],
        source: msg?.source?.kind || null,
      };
    }
    case 'tool/call': {
      let args = d.arguments;
      if (typeof args === 'string') {
        try { args = JSON.parse(args); } catch { /* 保留原始字符串 */ }
      }
      return {
        ...base,
        role: 'tool-call',
        text: '',
        reasoning: '',
        toolCalls: [{ callId: d.callId || null, name: d.name || null, arguments: args }],
      };
    }
    case 'tool/result': {
      const msg = messageOf(event);
      const f = flattenContent(msg?.content);
      return {
        ...base,
        role: 'tool-result',
        text: f.text,
        reasoning: '',
        toolCalls: [],
        toolCallId: msg?.toolCallId || d.message?.toolCallId || null,
        isError: Boolean(d.error),
        meta: d.meta || null,
      };
    }
    default:
      return null;
  }
}

/**
 * user/message 的 source.kind 实测有 10 种，只有 'user' 是真人输入：
 *
 *   user              真人打字（唯一真正的用户消息）
 *   agent-instructions  AGENTS.md 等指令注入
 *   runtime-context     运行时环境快照
 *   skill-catalog       可用技能清单
 *   model-selection     模型切换通知
 *   tool-jobs           后台任务完成通知
 *   user-approval       审批策略变更通知
 *   compact-checkpoint  压缩后的检查点摘要（由 compaction/summary 生成）
 *   goal / tool-goal    目标轮次驱动
 */
const HUMAN_SOURCE = 'user';

/** 是否真人输入的消息 */
function isHumanMessage(node) {
  return node.role === 'user' && node.source === HUMAN_SOURCE;
}

/**
 * 还原「模型实际看到的上下文序列」——按 seq 顺序，已应用 surfaceOp 折叠。
 * 这是回答「压缩前模型看到了什么」的唯一正确方式。
 *
 * 轮次号的处理：user/message 事件本身没有 turn 字段（实测），
 * 必须从 turn/start 事件推导 —— 某条消息属于它之前最近的那个 turn/start。
 */
function rebuildContext(events, uptoSeq = Infinity) {
  // 第一遍：建立 seq → turn 的映射
  const turnStarts = [];
  for (const e of events) {
    if (e.type === 'turn/start' && typeof e.seq === 'number') {
      turnStarts.push({ seq: e.seq, turn: e.data?.turn ?? null });
    }
  }
  const turnAt = (seq) => {
    let cur = null;
    for (const t of turnStarts) {
      if (t.seq <= seq) cur = t.turn;
      else break;
    }
    return cur;
  };

  // 第二遍：应用 surfaceOp 折叠，并按 seq 输出
  const surface = buildSurface(events, uptoSeq);
  const seqs = [...surface.keys()].sort((a, b) => a - b);
  const nodes = [];
  for (const s of seqs) {
    const n = normalizeEvent(surface.get(s));
    if (!n) continue;
    if (n.turn == null) n.turn = turnAt(s);   // 补上推导出的轮次号
    nodes.push(n);
  }
  return nodes;
}

/**
 * 把上下文节点按 turn 聚合成「轮次」。
 * 一轮 = 一条真人提问 + 之后模型的所有回复/工具调用，直到下一条真人提问。
 * 系统注入的 user 消息（AGENTS.md、环境快照等）不开启新轮次，归入当前轮。
 */
function groupIntoTurns(nodes) {
  const turns = [];
  let current = null;

  for (const n of nodes) {
    if (isHumanMessage(n)) {
      if (current) turns.push(current);
      current = {
        turn: n.turn,
        userText: n.text,
        userSeq: n.seq,
        time: n.time,
        nodes: [n],
      };
    } else if (current) {
      current.nodes.push(n);
    }
    // 首条真人消息之前的内容属于会话开头的系统注入，忽略
  }
  if (current) turns.push(current);
  return turns;
}

/** 会话开头注入的系统上下文（AGENTS.md、环境快照、技能清单等），单独取出备用 */
function extractInjectedContext(nodes) {
  const firstHuman = nodes.findIndex(isHumanMessage);
  const head = firstHuman === -1 ? nodes : nodes.slice(0, firstHuman);
  return head.map((n) => ({ seq: n.seq, source: n.source, text: n.text }));
}

module.exports = {
  HUMAN_SOURCE,
  isHumanMessage,
  flattenContent,
  messageOf,
  normalizeEvent,
  rebuildContext,
  groupIntoTurns,
  extractInjectedContext,
};
