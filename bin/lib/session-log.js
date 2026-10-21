'use strict';
/**
 * DSH 会话日志读取层
 * ====================
 *
 * DSH 把每个会话的完整事件流写入：
 *   <root>/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
 *
 * 三个必须知道的格式事实（均已实测验证）：
 *
 * 1. 多 frame zstd 流
 *    文件是「追加写」的多个 zstd frame 拼接而成，不是单个 frame。
 *    Node 的 zlib.zstdDecompressSync 一次只能解一个 frame，
 *    因此必须按 zstd magic (28 B5 2F FD) 切分后逐段解压。
 *    ⚠️ Python 端没有 zstandard 库，解不开这个格式，所以这一层只能用 Node。
 *
 * 2. 每行一个 JSON 事件，seq 单调递增（0 起，无断点）
 *
 * 3. 压缩(compaction) 不删除任何数据
 *    压缩时只追加一条 surfaceOp = {op:'replace', startSeq, endSeq} 事件，
 *    表示「组装上下文时把这段折叠掉」。被遮蔽事件的原文仍然完整保留在日志中。
 *    实测：某会话压缩遮蔽 541 个事件，原文 541/541 全部可读，seq 无断点。
 *
 *    这意味着：本日志就是天然的「完整原文库」，无需另行存档原文。
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const os = require('os');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const DEFAULT_ROOT = path.join(os.homedir(), '.dsh', 'sessions');

/** 会进入「模型可见上下文」的事件类型（即带 surfaceOp 的那些） */
const SURFACE_TYPES = new Set([
  'user/message',
  'assistant/message',
  'system/message',
  'developer/message',
  'tool/result',
]);

/**
 * 解压多 frame zstd 缓冲。
 * 末尾 frame 可能因文件正在写入而不完整，此时解压失败属正常，记入 failures 后跳过。
 */
function decompressZstdFrames(buf) {
  const offsets = [];
  let cursor = 0;
  for (;;) {
    const found = buf.indexOf(ZSTD_MAGIC, cursor);
    if (found === -1) break;
    offsets.push(found);
    cursor = found + ZSTD_MAGIC.length;
  }

  const chunks = [];
  const failures = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8'));
    } catch (err) {
      failures.push({ frameIndex: i, offset: start, error: err.message });
    }
  }

  return { text: chunks.join(''), frameCount: offsets.length, failures };
}

/** 把解压后的文本切成事件数组；容忍坏行（frame 边界处可能出现半行） */
function parseEventLines(text) {
  const events = [];
  const badLines = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      badLines.push(trimmed.slice(0, 120));
    }
  }
  return { events, badLines };
}

/** 读取单个会话文件 → { meta, events, stats } */
function readSession(filePath) {
  const raw = fs.readFileSync(filePath);
  const { text, frameCount, failures } = decompressZstdFrames(raw);
  const { events, badLines } = parseEventLines(text);
  const meta = events.find((e) => e.type === 'session') || null;

  return {
    filePath,
    meta,
    events,
    stats: {
      bytes: raw.length,
      frameCount,
      failedFrames: failures.length,
      failures: failures.slice(0, 5),
      badLines: badLines.length,
      eventCount: events.length,
    },
  };
}

/** 列出所有会话（跨 workspace） */
function listSessions(root = DEFAULT_ROOT) {
  const out = [];
  if (!fs.existsSync(root)) return out;

  for (const wsSlug of fs.readdirSync(root)) {
    const wsDir = path.join(root, wsSlug);
    let wsStat;
    try { wsStat = fs.statSync(wsDir); } catch { continue; }
    if (!wsStat.isDirectory()) continue;

    for (const sessionId of fs.readdirSync(wsDir)) {
      const sessionDir = path.join(wsDir, sessionId);
      let sStat;
      try { sStat = fs.statSync(sessionDir); } catch { continue; }
      if (!sStat.isDirectory()) continue;

      const filePath = path.join(sessionDir, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(filePath)) continue;

      const st = fs.statSync(filePath);
      out.push({
        workspaceSlug: wsSlug,
        sessionId,
        filePath,
        bytes: st.size,
        mtimeMs: st.mtimeMs,
      });
    }
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * 折叠 surfaceOp，还原「某一时刻模型实际看到的上下文」。
 *
 * - surfaceOp = "append"            → 追加节点
 * - surfaceOp = {op:'replace',...}  → 先删除 [startSeq, endSeq] 再追加（压缩时用）
 *
 * @param {object[]} events
 * @param {number} uptoSeq  只考虑到该 seq（含），默认全部
 * @returns {Map<number, object>} seq → 事件
 */
function buildSurface(events, uptoSeq = Infinity) {
  const surface = new Map();

  for (const e of events) {
    if (typeof e.seq === 'number' && e.seq > uptoSeq) break;
    if (!SURFACE_TYPES.has(e.type)) continue;

    const op = e.surfaceOp;
    if (op && typeof op === 'object' && op.op === 'replace') {
      for (let s = op.startSeq; s <= op.endSeq; s++) surface.delete(s);
    }
    surface.set(e.seq, e);
  }

  return surface;
}

/** 取出该会话中所有压缩事件（含 DSH 自动生成的高质量摘要） */
function extractCompactions(events) {
  return events
    .filter((e) => typeof e.type === 'string' && e.type.startsWith('compaction/'))
    .map((e) => ({ seq: e.seq, time: e.time, type: e.type, data: e.data }));
}

/**
 * 帧级索引（2026-10-20 加）
 * =========================
 *
 * 背景：一个会话日志是「多 frame zstd」append-only 流，一个事件批次一帧。
 * 实测最大的会话 2.47 MB 有 2227 个帧、4027 个事件。
 * 原来 readSession() 每次都要解压全部 2227 帧（约 100ms），
 * 但 mem.js raw 只取 seq 922-929 这种几事件的小窗口。
 *
 * 做法：建一份「seq 范围 → 帧字节偏移」的索引，落到磁盘（<MEM_ROOT>/sessions-index/）。
 * 读取时只读需要的帧的字节区间再解压。实测：
 *   seq 922-929（8 事件）  102ms → 1ms   （102x）
 *   seq 385-486（102 事件）102ms → 3ms   （34x）
 *
 * 索引按 (size, mtimeMs) 失效：文件一旦增长就重建（一次 130ms）。
 * 会话日志是只追加的，已结束的会话 size 不再变，索引可长期复用。
 *
 * 索引放 <MEM_ROOT>/sessions-index/（D 盘），不放 ~/.dsh，避免 DSH 重装带走。
 */
/**
 * 索引目录：跟记忆库同一个根（`<MEM_ROOT>/sessions-index/`），不放进包目录。
 * 插件装进 node_modules 后包目录是只读的、升级还会整个重建，索引放那里会丢，
 * 每次 raw 都要全量重建帧索引。
 *
 * 解析顺序与 store.js 的 defaultMemRoot 保持一致：
 *   $DSH_MEM_ROOT > 老布局（包根下有 db/）> <DSH_HOME>/memory
 */
function resolveIndexDir() {
  const fromEnv = process.env.DSH_MEM_ROOT;
  if (fromEnv) return path.join(path.resolve(fromEnv), 'sessions-index');
  const pkgRoot = path.resolve(__dirname, '..', '..');
  try { if (fs.existsSync(path.join(pkgRoot, 'db'))) return path.join(pkgRoot, 'sessions-index'); } catch { /* ignore */ }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'memory', 'sessions-index');
}

/** 会话 id 用作文件名时做安全化处理 */
function safeId(s) {
  return String(s || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80) || 'unknown';
}

function indexPathFor(filePath, sessionId) {
  // 用 .json.gz：2.47MB 会话的索引是 129KB 明文，gzip 后约 10-20KB
  return path.join(resolveIndexDir(), `${safeId(sessionId)}.json.gz`);
}

/**
 * 扫描整个文件，建立 {i, start, end, lo, hi} 帧索引。
 * lo/hi 是该帧内事件的最小/最大 seq；纯 header 帧（无 seq）记为 null。
 */
function buildFrameIndex(buf) {
  const offsets = [];
  let cursor = 0;
  for (;;) {
    const found = buf.indexOf(ZSTD_MAGIC, cursor);
    if (found === -1) break;
    offsets.push(found);
    cursor = found + ZSTD_MAGIC.length;
  }

  const frames = [];
  for (let i = 0; i < offsets.length; i++) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    let seqs = null;
    try {
      const text = zlib.zstdDecompressSync(buf.subarray(start, end)).toString('utf8');
      const list = [];
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t);
          if (typeof o.seq === 'number') list.push(o.seq);
        } catch { /* 帧边界上的坏行，忽略 */ }
      }
      seqs = list;
    } catch {
      seqs = null;   // 撕裂帧/损坏帧，跳过
    }
    if (!seqs) continue;
    frames.push({
      i, start, end,
      lo: seqs.length ? Math.min(...seqs) : null,
      hi: seqs.length ? Math.max(...seqs) : null,
    });
  }
  return frames;
}

/**
 * 取帧索引（优先读磁盘缓存）。
 * @returns {{frames:Array, fromCache:boolean, buildMs:number}}
 */
function getFrameIndex(filePath, sessionId) {
  let st;
  try { st = fs.statSync(filePath); } catch { return { frames: [], fromCache: false, buildMs: 0 }; }
  const ip = indexPathFor(filePath, sessionId);

  // 命中缓存：大小和 mtime 都没变
  try {
    const cached = JSON.parse(zlib.gunzipSync(fs.readFileSync(ip)).toString('utf8'));
    if (cached && cached.size === st.size
      && Math.abs(Number(cached.mtimeMs) - st.mtimeMs) < 1
      && Array.isArray(cached.frames)) {
      return { frames: cached.frames, fromCache: true, buildMs: 0 };
    }
  } catch { /* 没有缓存或损坏，重建 */ }

  const t0 = Date.now();
  let frames = [];
  try {
    frames = buildFrameIndex(fs.readFileSync(filePath));
  } catch { frames = []; }
  const buildMs = Date.now() - t0;

  try {
    fs.mkdirSync(resolveIndexDir(), { recursive: true });
    const payload = JSON.stringify({
      sessionId, size: st.size, mtimeMs: st.mtimeMs,
      count: frames.length, builtAt: nowStamp(), frames,
    });
    fs.writeFileSync(ip, zlib.gzipSync(Buffer.from(payload, 'utf8')), { mode: 0o600 });
  } catch { /* 写不了索引不影响读取，只是下次要重建 */ }

  return { frames, fromCache: false, buildMs };
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 只解压命中 [lo, hi] 的帧，返回该范围内的事件。
 *
 * 对比 readSession()：后者解压全部帧再过滤，本函数按字节偏移只读需要的帧。
 * lo=0 / hi=Infinity 时等价于全量读取（但走的还是同一套索引）。
 *
 * @returns {{events:Array, frameCount:number, usedFrames:number, usedBytes:number, fromCache:boolean, buildMs:number}}
 */
function readSessionRange(filePath, lo = 0, hi = Infinity) {
  const sessionId = path.basename(path.dirname(filePath));
  const { frames, fromCache, buildMs } = getFrameIndex(filePath, sessionId);
  if (!frames.length) {
    // 索引不可用时退回全量读取，保证功能不丢
    const { events } = readSession(filePath);
    return {
      events: events.filter((e) => typeof e.seq !== 'number' || (e.seq >= lo && e.seq <= hi)),
      frameCount: 0, usedFrames: 0, usedBytes: 0, fromCache: false, buildMs, fallback: true,
    };
  }

  const need = frames.filter((f) => (f.lo === null
    ? lo <= 0                                   // 无 seq 的 header 帧只在从头读时带上
    : (f.hi >= lo && f.lo <= hi)));

  const events = [];
  let usedBytes = 0;
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    for (const f of need) {
      const len = f.end - f.start;
      if (len <= 0) continue;
      const chunk = Buffer.allocUnsafe(len);
      fs.readSync(fd, chunk, 0, len, f.start);
      usedBytes += len;
      let text;
      try { text = zlib.zstdDecompressSync(chunk).toString('utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t);
          if (typeof o.seq === 'number') {
            if (o.seq >= lo && o.seq <= hi) events.push(o);
          } else if (lo <= 0) {
            // 没有 seq 的事件（如 session header）只在从头读时带上，
            // 与 readSession + 调用方过滤的语义保持一致。
            events.push(o);
          }
        } catch { /* 跳过坏行 */ }
      }
    }
  } catch {
    const { events: all } = readSession(filePath);
    return {
      events: all.filter((e) => typeof e.seq !== 'number' || (e.seq >= lo && e.seq <= hi)),
      frameCount: frames.length, usedFrames: 0, usedBytes: 0, fromCache, buildMs, fallback: true,
    };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }

  return {
    events, frameCount: frames.length, usedFrames: need.length,
    usedBytes, fromCache, buildMs, fallback: false,
  };
}

module.exports = {
  DEFAULT_ROOT,
  SURFACE_TYPES,
  decompressZstdFrames,
  parseEventLines,
  readSession,
  listSessions,
  buildSurface,
  extractCompactions,
  // 帧级索引（2026-10-20 加）
  get INDEX_DIR() { return resolveIndexDir() },
  buildFrameIndex,
  getFrameIndex,
  readSessionRange,
};
