#!/usr/bin/env node
'use strict';
/**
 * parse.js —— DSH 会话日志解析器（第 2 步）
 * =========================================
 *
 * 把压缩的会话日志还原成人可读、程序可用的结构化对话。
 *
 * 用法：
 *   node parse.js list                         列出所有会话
 *   node parse.js show <sessionId|前缀>        显示某个会话的对话（默认只显示真人轮次）
 *   node parse.js show <id> --full             含推理过程与工具调用
 *   node parse.js show <id> --json             输出 JSON
 *   node parse.js surface <id> [--at <seq>]    查看某时刻模型实际看到的上下文
 *   node parse.js compact <id>                 查看该会话的压缩记录与自动摘要
 *   node parse.js stats                        全部会话统计
 */

const path = require('path');
const {
  listSessions,
  readSession,
  extractCompactions,
} = require('./lib/session-log');
const { rebuildContext, groupIntoTurns } = require('./lib/messages');

const args = process.argv.slice(2);
const cmd = args[0];

function fmtTime(ms) {
  if (!ms) return '-';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 会话 id 支持前缀匹配，避免每次都敲全 uuid */
function resolveSession(idOrPrefix, sessions) {
  if (!idOrPrefix) return null;
  const exact = sessions.find((s) => s.sessionId === idOrPrefix);
  if (exact) return exact;
  const matches = sessions.filter((s) => s.sessionId.includes(idOrPrefix));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.error(`[错误] "${idOrPrefix}" 匹配到 ${matches.length} 个会话，请给更长的前缀：`);
    for (const m of matches.slice(0, 10)) console.error(`   ${m.sessionId}`);
    return null;
  }
  return null;
}

function loadSessionOrDie(idOrPrefix) {
  const sessions = listSessions();
  const target = resolveSession(idOrPrefix, sessions);
  if (!target) {
    console.error(`[错误] 找不到会话 "${idOrPrefix}"。用 list 查看全部。`);
    process.exit(1);
  }
  return readSession(target.filePath);
}

function clip(s, n) {
  if (!s) return '';
  const one = String(s).replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n) + ` …(+${one.length - n}字)` : one;
}

// ---------------------------------------------------------------- list

function cmdList() {
  const sessions = listSessions();
  if (!sessions.length) {
    console.log('(没有找到会话)');
    return;
  }
  console.log(`共 ${sessions.length} 个会话：\n`);
  for (const s of sessions) {
    let title = '';
    try {
      const { events } = readSession(s.filePath);
      const t = events.find((e) => e.type === 'session/title');
      const meta = events.find((e) => e.type === 'session');
      title = t?.data?.title || '';
      const ws = meta?.cwd || '';
      const size = (s.bytes / 1024).toFixed(0);
      console.log(`${s.sessionId}`);
      console.log(`   ${fmtTime(s.mtimeMs)}  ${size.padStart(6)}KB  ${ws}`);
      if (title) console.log(`   标题: ${title}`);
      console.log();
    } catch (err) {
      console.log(`${s.sessionId}\n   [读取失败] ${err.message}\n`);
    }
  }
}

// ---------------------------------------------------------------- show

function cmdShow() {
  const id = args[1];
  const full = args.includes('--full');
  const asJson = args.includes('--json');
  if (!id) { console.error('用法: node parse.js show <sessionId|前缀> [--full] [--json]'); process.exit(1); }

  const { meta, events, stats } = loadSessionOrDie(id);
  const nodes = rebuildContext(events);
  const turns = groupIntoTurns(nodes);

  if (asJson) {
    console.log(JSON.stringify({
      session: meta,
      stats,
      turnCount: turns.length,
      turns: turns.map((t) => ({
        turn: t.turn,
        time: t.time,
        user: t.userText,
        nodes: full ? t.nodes : undefined,
        assistant: t.nodes.filter((n) => n.role === 'assistant').map((n) => n.text).filter(Boolean),
        toolCalls: t.nodes.filter((n) => n.role === 'tool-call')
          .map((n) => n.toolCalls.map((c) => c.name)).flat().filter(Boolean),
      })),
    }, null, 1));
    return;
  }

  console.log(`会话: ${meta?.id || '(未知)'}`);
  console.log(`目录: ${meta?.cwd || '-'}`);
  console.log(`创建: ${fmtTime(meta?.createdAt)}   事件: ${stats.eventCount}   轮次: ${turns.length}`);
  console.log('='.repeat(70));

  for (const t of turns) {
    console.log(`\n【第 ${t.turn ?? '?'} 轮】 ${fmtTime(t.time)}`);
    console.log(`👤 ${full ? t.userText : clip(t.userText, 300)}`);

    for (const n of t.nodes) {
      if (n.role === 'assistant') {
        if (full && n.reasoning) {
          console.log(`\n🧠 [推理] ${clip(n.reasoning, 1500)}`);
        }
        if (n.text) console.log(`\n🤖 ${full ? n.text : clip(n.text, 800)}`);
        for (const c of n.toolCalls || []) {
          const a = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments);
          console.log(`   🔧 ${c.name}(${clip(a, full ? 300 : 120)})`);
        }
      } else if (n.role === 'tool-result' && full) {
        console.log(`   ↩️  [结果 ${n.toolCallId ? n.toolCallId.slice(0, 16) : ''}] ${clip(n.text, 400)}`);
      }
    }
  }
}

// ---------------------------------------------------------------- surface

function cmdSurface() {
  const id = args[1];
  const atIdx = args.indexOf('--at');
  if (!id) { console.error('用法: node parse.js surface <sessionId|前缀> [--at <seq>]'); process.exit(1); }

  const { events } = loadSessionOrDie(id);

  // 指定了 --at：显示该时刻的上下文
  if (atIdx !== -1) {
    const at = Number(args[atIdx + 1]);
    const upto = rebuildContext(events, at);
    console.log(`seq <= ${at} 时，模型实际看到的上下文节点数: ${upto.length}`);
    console.log('='.repeat(70));
    const counts = {};
    for (const n of upto) counts[n.role] = (counts[n.role] || 0) + 1;
    console.log('节点构成:', JSON.stringify(counts));
    console.log('\n前 15 个节点：');
    for (const n of upto.slice(0, 15)) {
      console.log(`  seq=${String(n.seq).padStart(5)} ${n.role.padEnd(12)} ${clip(n.text, 70)}`);
    }
    return;
  }

  // 默认：显示每个压缩事件前后的上下文规模变化
  const comps = extractCompactions(events);
  const finalNodes = rebuildContext(events, Infinity);

  console.log(`会话上下文节点总数（应用全部压缩后，即当前实际状态）: ${finalNodes.length}`);
  const finalCounts = {};
  for (const n of finalNodes) finalCounts[n.role] = (finalCounts[n.role] || 0) + 1;
  console.log('节点构成:', JSON.stringify(finalCounts));

  // 找出真正改变了 surface 的压缩事件（带 replace 的）
  const replaceSeqs = events
    .filter((e) => e.surfaceOp && typeof e.surfaceOp === 'object' && e.surfaceOp.op === 'replace')
    .map((e) => e.seq)
    .sort((a, b) => a - b);

  if (!replaceSeqs.length) {
    console.log('\n(该会话没有发生上下文折叠)');
    return;
  }

  console.log(`\n共 ${replaceSeqs.length} 次上下文折叠，逐个显示前后规模变化：`);
  console.log('-'.repeat(78));
  console.log('  说明：prune 是「内容截断」——节点数不变，但内容变短（原文仍在日志中）；');
  console.log('        compaction 是「整体折叠」——大批节点被摘要替换，节点数骤降。');
  console.log('-'.repeat(78));

  const sizeOf = (nodes) => nodes.reduce((sum, n) => sum + (n.text ? n.text.length : 0), 0);

  for (const s of replaceSeqs) {
    const before = rebuildContext(events, s - 1);
    const after = rebuildContext(events, s);
    const ev = events.find((e) => e.seq === s);
    const op = ev.surfaceOp;
    const span = op.endSeq - op.startSeq + 1;
    const kind = span === 1 ? 'prune ' : '折叠  ';
    const dNodes = before.length - after.length;
    const dChars = sizeOf(before) - sizeOf(after);
    const dCharsStr = dChars >= 0 ? `-${dChars}` : `+${-dChars}`;
    console.log(
      `seq=${String(s).padStart(5)} ${kind} ${op.startSeq}..${op.endSeq}  ` +
      `节点 ${before.length} → ${after.length} (${dNodes >= 0 ? '-' : '+'}${Math.abs(dNodes)})  ` +
      `文本 ${dCharsStr} 字`
    );
  }
  console.log('-'.repeat(78));

  const first = rebuildContext(events, replaceSeqs[0] - 1);
  const firstChars = sizeOf(first);
  const finalChars = sizeOf(finalNodes);
  console.log(`压缩前: ${first.length} 个节点 / ${firstChars} 字`);
  console.log(`压缩后: ${finalNodes.length} 个节点 / ${finalChars} 字`);
  console.log(`上下文体积减少: ${((1 - finalChars / firstChars) * 100).toFixed(1)}%`);
  console.log(`\n⚠️ 以上只是「模型看到的上下文」被缩小。被折叠/截断的原文全部完整保留在日志中，`);
  console.log(`   用 parse.js show <id> --full 仍可读到完整内容。`);
}

// ---------------------------------------------------------------- compact

function cmdCompact() {
  const id = args[1];
  if (!id) { console.error('用法: node parse.js compact <sessionId|前缀>'); process.exit(1); }
  const { events } = loadSessionOrDie(id);
  const comps = extractCompactions(events);

  if (!comps.length) { console.log('(该会话没有压缩记录)'); return; }
  console.log(`共 ${comps.length} 条压缩事件：\n`);

  for (const c of comps) {
    const d = c.data || {};
    if (c.type === 'compaction/summary') {
      const txt = Array.isArray(d.summary)
        ? d.summary.map((b) => b.text || '').join('')
        : String(d.summary || '');
      console.log(`--- seq=${c.seq} 自动摘要 ---`);
      console.log(`遮蔽范围: ${JSON.stringify(d.shadowedRange)}  遮蔽事件: ${d.shadowedSeqs?.length ?? '-'}  遮蔽token: ${d.shadowedTokenCount ?? '-'}`);
      console.log(`模型: ${d.model || '-'}  用量: ${JSON.stringify(d.usage || {})}`);
      console.log(`摘要长度: ${txt.length} 字`);
      console.log(txt.slice(0, 1200) + (txt.length > 1200 ? '\n…' : ''));
      console.log();
    } else if (c.type === 'compaction/prune') {
      console.log(`  seq=${c.seq} prune  遮蔽 ${d.shadowedSeqs?.length ?? '-'} 个事件, ${d.shadowedTokenCount ?? '-'} token`);
    } else {
      console.log(`  seq=${c.seq} ${c.type}  ${JSON.stringify(d).slice(0, 150)}`);
    }
  }
}

// ---------------------------------------------------------------- stats

function cmdStats() {
  const sessions = listSessions();
  let totalEvents = 0, totalBytes = 0, totalTurns = 0, totalCompactions = 0;
  const rows = [];

  for (const s of sessions) {
    try {
      const { meta, events, stats } = readSession(s.filePath);
      const nodes = rebuildContext(events);
      const turns = groupIntoTurns(nodes);
      const comps = extractCompactions(events);
      const title = events.find((e) => e.type === 'session/title')?.data?.title || '';
      totalEvents += stats.eventCount;
      totalBytes += stats.bytes;
      totalTurns += turns.length;
      totalCompactions += comps.length;
      rows.push({
        id: s.sessionId.slice(0, 20),
        cwd: meta?.cwd || '',
        turns: turns.length,
        events: stats.eventCount,
        comps: comps.length,
        title: clip(title, 30),
      });
    } catch (err) {
      rows.push({ id: s.sessionId.slice(0, 20), cwd: '[读取失败]', turns: 0, events: 0, comps: 0, title: err.message.slice(0, 30) });
    }
  }

  console.log('会话'.padEnd(22) + '轮次'.padStart(5) + '事件'.padStart(8) + '压缩'.padStart(5) + '  标题');
  console.log('-'.repeat(90));
  for (const r of rows) {
    console.log(
      r.id.padEnd(22) + String(r.turns).padStart(5) + String(r.events).padStart(8) +
      String(r.comps).padStart(5) + '  ' + r.title
    );
  }
  console.log('-'.repeat(90));
  console.log(`合计: ${sessions.length} 个会话, ${totalTurns} 轮对话, ${totalEvents} 个事件, ${(totalBytes / 1024 / 1024).toFixed(1)} MB, ${totalCompactions} 条压缩记录`);
}

// ---------------------------------------------------------------- main

switch (cmd) {
  case 'list': cmdList(); break;
  case 'show': cmdShow(); break;
  case 'surface': cmdSurface(); break;
  case 'compact': cmdCompact(); break;
  case 'stats': cmdStats(); break;
  default:
    console.log(`DSH 会话日志解析器

用法:
  node parse.js list                        列出所有会话
  node parse.js show <id|前缀> [--full] [--json]   显示对话
  node parse.js surface <id> [--at <seq>]   查看某时刻模型看到的上下文
  node parse.js compact <id>                查看压缩记录与自动摘要
  node parse.js stats                       全部会话统计
`);
    process.exit(cmd ? 1 : 0);
}
