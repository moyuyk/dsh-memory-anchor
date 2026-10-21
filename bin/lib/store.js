'use strict';
/**
 * 记忆库存储层
 * ============
 *
 * 设计要点（全部经过实测验证，不是推测）：
 *
 * 1. 按 scope 分物理文件
 *    db/global.db           全局永久记忆（只读，手动维护）
 *    db/chat.db             未归类缓冲区
 *    db/projects/<slug>.db  每个项目一个独立库
 *    物理隔离 → 删项目 = 删文件，无残留、无误伤。
 *
 * 2. 双层存储
 *    summary  精简摘要 —— 参与检索、默认召回
 *    node_raw 完整原文 —— 记忆库自己保存一份（不压缩、不截断），随库搬移
 *    raw_ref  原文引用   —— 指向 DSH 会话日志的 (sessionId, seq范围)，便于回源核对
 *    注：早期版本只引用日志、不复制原文；2026-10-16 起改为入库自存，
 *        因为日志由 DSH 内核管理，会被清理或随会话删除，库内得独立留一份。
 *
 * 3. 检索必须处理 trigram 的 3 字符下限
 *    ⚠️ 实测：FTS5 trigram 分词器要求查询 ≥3 个字符。
 *       「记忆」「中文」「简洁」这类两字中文词会静默返回 0 条（不报错）。
 *    因此：查询 ≥3 字符走 FTS5（带 bm25 排序），<3 字符走 LIKE 兜底。
 *
 * 4. 跨库检索在 JS 层合并
 *    ⚠️ 实测：ATTACH 之后无法查询被附加库的 FTS5 虚拟表（no such column）。
 *    所以逐库独立打开查询再合并 —— 这反而正好实现「未激活的库不加载」。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * 记忆库根目录解析（自定位，不写死路径）
 * ======================================
 * 本文件位于 <MEM_ROOT>/bin/lib/store.js，所以向上两级就是根目录。
 * 这样整个目录可以随意搬移（C 盘 / D 盘 / U 盘），无需改任何代码。
 *
 * 优先级：$DSH_MEM_ROOT（测试或临时覆盖） > 脚本自身位置推导
 *
 * 注：DSH 的会话日志仍在 ~/.dsh/sessions（由 DSH 内核管理，不随本库搬移），
 *     见 session-log.js。
 */
/**
 * 默认根目录：
 *   1) $DSH_MEM_ROOT（测试 / 自定义）
 *   2) 老布局：包根下已有 db/ → 用包根（本机 D:\dsdata\memory）
 *   3) 新装：<DSH_HOME>/memory（DSH_HOME 默认 ~/.dsh）
 */
function defaultMemRoot() {
  const pkgRoot = path.resolve(__dirname, '..', '..');
  try { if (fs.existsSync(path.join(pkgRoot, 'db'))) return pkgRoot; } catch { /* ignore */ }
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'memory');
}
const MEM_ROOT = process.env.DSH_MEM_ROOT || defaultMemRoot();
const DB_DIR = path.join(MEM_ROOT, 'db');
const PROJECT_DIR = path.join(DB_DIR, 'projects');
const CONFIG_PATH = path.join(MEM_ROOT, 'config.json');

const DEFAULT_CONFIG = {
  topK: 3,
  minScore: 0,
  recencyHalfLifeDays: 30,
  weightBoost: 0.15,
  maxSummaryChars: 500,
  autoScopeFromCwd: true,
  projectAliases: {},
  synonyms: {},
};

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
    }
  } catch { /* 配置坏了就用默认值，不能让检索挂掉 */ }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  ensureDirs();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), 'utf8');
}

function ensureDirs() {
  for (const d of [DB_DIR, PROJECT_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * 项目显示名 → 安全的文件名 slug。
 *
 * 中文直接保留（Windows NTFS 原生支持，Node 读写无问题），只过滤掉
 * 文件系统非法字符，这样库文件在资源管理器里一眼能认出来。
 * 例：proj:记忆插件 → 记忆插件.db
 */
function slugify(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')   // 文件系统非法字符
    .replace(/\.+$/, '')                       // 结尾的点（Windows 不允许）
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned && cleaned !== '.' && cleaned !== '..') {
    // 防止超长文件名
    return cleaned.length > 60 ? cleaned.slice(0, 60) : cleaned;
  }
  // 极端兜底：名字全被过滤掉时用哈希
  const hash = [...String(name)].reduce((h, c) => ((h << 5) - h + c.charCodeAt(0)) | 0, 0);
  return 'p_' + (hash >>> 0).toString(36).slice(0, 6);
}

/** scope 名 → 数据库文件路径 */
function scopeFile(scope) {
  if (scope === 'global') return path.join(DB_DIR, 'global.db');
  if (scope === 'chat') return path.join(DB_DIR, 'chat.db');
  const name = scope.startsWith('proj:') ? scope.slice(5) : scope;
  return path.join(PROJECT_DIR, `${slugify(name)}.db`);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  TEXT    NOT NULL,
  updated_at  TEXT    NOT NULL,
  scope       TEXT    NOT NULL,
  kind        TEXT    NOT NULL DEFAULT 'note',
  title       TEXT    NOT NULL,
  summary     TEXT    NOT NULL DEFAULT '',
  body        TEXT    NOT NULL DEFAULT '',
  tags        TEXT    NOT NULL DEFAULT '',
  weight      INTEGER NOT NULL DEFAULT 3,
  pinned      INTEGER NOT NULL DEFAULT 0,
  status      TEXT    NOT NULL DEFAULT 'open',
  valid_from  TEXT    DEFAULT '',
  valid_until TEXT    DEFAULT NULL,
  superseded_by TEXT  DEFAULT '',
  session_id  TEXT    DEFAULT '',
  raw_ref     TEXT    DEFAULT '',
  source      TEXT    DEFAULT 'manual',
  corrected   INTEGER NOT NULL DEFAULT 0,
  revision    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_nodes_scope  ON nodes(scope);
CREATE INDEX IF NOT EXISTS idx_nodes_kind   ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_status ON nodes(status);
CREATE INDEX IF NOT EXISTS idx_nodes_ts     ON nodes(created_at);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  title, summary, body, tags,
  content='nodes', content_rowid='id',
  tokenize='trigram'
);

-- CJK 检索层（2026-10-20 加）
-- ========================
-- 为什么需要第二套索引：
--   trigram 要求查询串 >= 3 字符，2 字中文词（「记忆」「插件」）被静默丢弃；
--   而代码按「整串长度」判断走 FTS 还是 LIKE，于是「3字+2字」这类混合查询
--   走 FTS 后匹配为空，且 MATCH 返回 0 行不抛异常 → 不会回落 LIKE → 静默 0 命中。
-- 实测（21 条真实数据）：
--   「安装 路径」「原文 抓取」「交接 规则」「插件安装路径」在 trigram 下全 0，
--   改用 CJK 2-gram + OR + bm25 后全部有结果；索引体积 106KB → 64KB（更小）。
-- 做法：
--   入库时把 title/summary/tags 预分词成空格分隔的 token 串，存进 nodes_tok；
--   FTS 表用 content=''（外部内容模式，不存副本，只存索引）。
--   旧 nodes_fts 保留不动，出问题可一行切回。
-- body_tok（2026-10-20 v9 加）：摘要被 500 字截断时，完整文本写进 body。
-- 不把 body 一起索引的话，被截掉的那半段只能靠 LIKE 兜底命中，bm25 排不上。
CREATE TABLE IF NOT EXISTS nodes_tok (
  node_id     INTEGER PRIMARY KEY,
  title_tok   TEXT NOT NULL DEFAULT '',
  summary_tok TEXT NOT NULL DEFAULT '',
  tags_tok    TEXT NOT NULL DEFAULT '',
  body_tok    TEXT NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS nodes_tok_fts USING fts5(
  title_tok, summary_tok, tags_tok, body_tok,
  content='nodes_tok', content_rowid='node_id', tokenize='unicode61'
);

-- 触发器：nodes_tok 变动时自动同步 FTS（外部内容表的标准做法）
CREATE TRIGGER IF NOT EXISTS nodes_tok_ai AFTER INSERT ON nodes_tok BEGIN
  INSERT INTO nodes_tok_fts(rowid, title_tok, summary_tok, tags_tok, body_tok)
  VALUES (new.node_id, new.title_tok, new.summary_tok, new.tags_tok, new.body_tok);
END;
CREATE TRIGGER IF NOT EXISTS nodes_tok_ad AFTER DELETE ON nodes_tok BEGIN
  INSERT INTO nodes_tok_fts(nodes_tok_fts, rowid, title_tok, summary_tok, tags_tok, body_tok)
  VALUES ('delete', old.node_id, old.title_tok, old.summary_tok, old.tags_tok, old.body_tok);
END;
CREATE TRIGGER IF NOT EXISTS nodes_tok_au AFTER UPDATE ON nodes_tok BEGIN
  INSERT INTO nodes_tok_fts(nodes_tok_fts, rowid, title_tok, summary_tok, tags_tok, body_tok)
  VALUES ('delete', old.node_id, old.title_tok, old.summary_tok, old.tags_tok, old.body_tok);
  INSERT INTO nodes_tok_fts(rowid, title_tok, summary_tok, tags_tok, body_tok)
  VALUES (new.node_id, new.title_tok, new.summary_tok, new.tags_tok, new.body_tok);
END;

-- 保持 FTS 与主表同步
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, title, summary, body, tags)
  VALUES (new.id, new.title, new.summary, new.body, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, summary, body, tags)
  VALUES ('delete', old.id, old.title, old.summary, old.body, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, summary, body, tags)
  VALUES ('delete', old.id, old.title, old.summary, old.body, old.tags);
  INSERT INTO nodes_fts(rowid, title, summary, body, tags)
  VALUES (new.id, new.title, new.summary, new.body, new.tags);
END;

-- 原文层：只保留「定位锚点」，不再存原文副本（2026-10-20 瘦身）
-- ============================================================
-- 曾经 node_raw.text 存了一份「原文片段」，实测后确认是多余的：
--   1. DSH 官方明确「不删除会话文件，日志在 root 下累积，直到外部移除；
--      seam 无删除接口」（dsh-session-persistence-jsonl README 原文）。
--      → 「防日志被清理」这个理由不成立。
--   2. 它存的是 autoExtractRelevant 关键词定位到的那几轮，不是完整原文；
--      实测 21 条里 7 条内容 100% 是工具调用日志，没有一句对话。
--   3. 按需解压日志取一段只要 16-101ms，与一次命令启动同量级。
-- 因此：原文真源 = DSH 会话日志（已备份到 sessions-backup）；这里只存锚点。
-- 老库的 text 列保留不删（向后兼容），但新写入不再填。
CREATE TABLE IF NOT EXISTS node_raw (
  node_id    INTEGER PRIMARY KEY,
  text       TEXT    NOT NULL DEFAULT '',
  source     TEXT    NOT NULL DEFAULT 'dsh-session',
  session_id TEXT    DEFAULT '',
  seq_start  INTEGER,
  seq_end    INTEGER,
  chars      INTEGER NOT NULL DEFAULT 0,
  created_at TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_node_raw_session ON node_raw(session_id);

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

/**
 * 老库迁移：补时效三列（借鉴 graphiti 的双时间轴，做了简化）。
 * 只加列、不回改已有内容；valid_from 用 created_at 回填，等于「一直有效」。
 * 注意：只在写模式调用，只读打开不能 ALTER。
 */
function migrateSchema(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(nodes)').all().map((c) => c.name));
  const need = [
    ['valid_from', "TEXT DEFAULT ''"],
    ['valid_until', 'TEXT DEFAULT NULL'],
    ['superseded_by', "TEXT DEFAULT ''"],
    ['pinned', 'INTEGER NOT NULL DEFAULT 0'],
    ['corrected', 'INTEGER NOT NULL DEFAULT 0'],
    ['revision', 'INTEGER NOT NULL DEFAULT 1'],
  ];
  let changed = false;
  for (const [name, type] of need) {
    if (!cols.has(name)) {
      db.exec(`ALTER TABLE nodes ADD COLUMN ${name} ${type}`);
      changed = true;
    }
  }
  // 回填只在刚加列时做一次，避免每次写操作都全表 UPDATE
  if (changed) {
    db.exec("UPDATE nodes SET valid_from = created_at WHERE valid_from IS NULL OR valid_from = ''");
  }
}

/**
 * CJK 索引表结构升级（2026-10-20 v9：nodes_tok 加 body_tok）
 * =========================================================
 * 老库的 nodes_tok / nodes_tok_fts 都没有 body_tok 列，CREATE TABLE IF NOT EXISTS 不会补列，
 * 所以这里显式迁移：ALTER 补列 → 重建 FTS 外部内容表 → 换掉三个触发器 → rebuild 索引。
 * 只做一次（升级完列就在了）；失败不阻断主流程，检索会自动回退到旧路径。
 */
function migrateTokenSchema(db) {
  try {
    const cols = db.prepare('PRAGMA table_info(nodes_tok)').all().map((c) => c.name);
    if (!cols.length) return;
    if (!cols.includes('body_tok')) {
      db.exec("ALTER TABLE nodes_tok ADD COLUMN body_tok TEXT NOT NULL DEFAULT ''");
    }
    const ftsCols = db.prepare('PRAGMA table_info(nodes_tok_fts)').all().map((c) => c.name);
    if (ftsCols.length && !ftsCols.includes('body_tok')) {
      db.exec('DROP TRIGGER IF EXISTS nodes_tok_ai');
      db.exec('DROP TRIGGER IF EXISTS nodes_tok_ad');
      db.exec('DROP TRIGGER IF EXISTS nodes_tok_au');
      db.exec('DROP TABLE IF EXISTS nodes_tok_fts');
      db.exec(`CREATE VIRTUAL TABLE nodes_tok_fts USING fts5(
        title_tok, summary_tok, tags_tok, body_tok,
        content='nodes_tok', content_rowid='node_id', tokenize='unicode61'
      )`);
      db.exec(`CREATE TRIGGER nodes_tok_ai AFTER INSERT ON nodes_tok BEGIN
        INSERT INTO nodes_tok_fts(rowid, title_tok, summary_tok, tags_tok, body_tok)
        VALUES (new.node_id, new.title_tok, new.summary_tok, new.tags_tok, new.body_tok);
      END`);
      db.exec(`CREATE TRIGGER nodes_tok_ad AFTER DELETE ON nodes_tok BEGIN
        INSERT INTO nodes_tok_fts(nodes_tok_fts, rowid, title_tok, summary_tok, tags_tok, body_tok)
        VALUES ('delete', old.node_id, old.title_tok, old.summary_tok, old.tags_tok, old.body_tok);
      END`);
      db.exec(`CREATE TRIGGER nodes_tok_au AFTER UPDATE ON nodes_tok BEGIN
        INSERT INTO nodes_tok_fts(nodes_tok_fts, rowid, title_tok, summary_tok, tags_tok, body_tok)
        VALUES ('delete', old.node_id, old.title_tok, old.summary_tok, old.tags_tok, old.body_tok);
        INSERT INTO nodes_tok_fts(rowid, title_tok, summary_tok, tags_tok, body_tok)
        VALUES (new.node_id, new.title_tok, new.summary_tok, new.tags_tok, new.body_tok);
      END`);
      db.exec("INSERT INTO nodes_tok_fts(nodes_tok_fts) VALUES('rebuild')");
    }
  } catch { /* 升级失败不影响主数据；检索走 LIKE 兜底 */ }
}

/** 撞锁时等待的毫秒数（2026-10-20 加） */
const BUSY_TIMEOUT_MS = 5000;
/** WAL 切换失败只提示一次，避免每条写命令都刷屏 */
let walWarned = false;

function openScope(scope, { readOnly = false } = {}) {
  ensureDirs();
  const file = scopeFile(scope);
  const db = new DatabaseSync(file, readOnly ? { readOnly: true } : {});
  // 并发控制（2026-10-20 加，实测见交接-20261020.md）
  //   journal_mode=delete：写事务提交要拿 EXCLUSIVE 锁，别的进程连读都读到 "database is locked"；
  //   busy_timeout=0（默认）：一撞锁立刻抛错，不重试。
  //   WAL：读不阻塞写、写不阻塞读（仍是单写者）；busy_timeout：撞锁时先等，而不是直接失败。
  //   journal_mode 是写进文件头的持久设置，设一次即可，之后每次打开读到 'wal' 即无操作。
  //   注意：WAL 下备份不能只拷 .db 单文件（还有 -wal/-shm），要用 VACUUM INTO 或三件套一起拷。
  try { db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`); } catch { /* 老 SQLite 不支持则退回默认行为 */ }
  if (!readOnly) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      const mode = db.prepare('PRAGMA journal_mode').get()?.journal_mode;
      if (mode !== 'wal' && !walWarned) {
        walWarned = true;
        console.error(`[memory] 警告：${file} 未能切到 WAL（当前 ${mode}），可能被其他连接占用；下次写入时会重试。`);
      }
    } catch { /* 切换失败不阻断读写，下次打开再试 */ }
    db.exec(SCHEMA);
    migrateSchema(db);
    migrateTokenSchema(db);
    // CJK 索引层回填（2026-10-20 加）：老库第一次打开时把存量条目补上。
    // 只处理「nodes_tok 里还没有行」或「body_tok 还是空但 body 有内容」的条目，
    // 已回填的库这次查询是空集，开销可忽略。
    try { backfillTokens(db); } catch { /* 索引失败不影响读写 */ }
  }
  return { db, file };
}

/** 列出所有已存在的 scope */
function listScopes() {
  ensureDirs();
  const scopes = [];
  if (fs.existsSync(path.join(DB_DIR, 'global.db'))) scopes.push('global');
  if (fs.existsSync(path.join(DB_DIR, 'chat.db'))) scopes.push('chat');
  if (fs.existsSync(PROJECT_DIR)) {
    for (const f of fs.readdirSync(PROJECT_DIR)) {
      if (!f.endsWith('.db')) continue;
      // 从库里读回真实项目名
      const p = path.join(PROJECT_DIR, f);
      try {
        const db = new DatabaseSync(p, { readOnly: true });
        const row = db.prepare("SELECT value FROM meta WHERE key='display_name'").get();
        db.close();
        scopes.push('proj:' + (row?.value || f.replace(/\.db$/, '')));
      } catch {
        scopes.push('proj:' + f.replace(/\.db$/, ''));
      }
    }
  }
  return scopes;
}

function nowIso() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * CJK 检索分词（2026-10-20 加）
 * ==========================
 *
 * 为什么不能用 unicode61 直接吃中文：
 *   实测 —— 原文「知识库与记忆库分开：语义不同，但检索层已整合」，
 *   用 unicode61 建索引后探测：「记忆库」✗「语义」✗「整合」✗，
 *   只有整句「知识库与记忆库分开」✓。
 *   即 unicode61 把一整段连续中文当成**一个 token**，等于不可检索。
 *   （官方 dsh-session-query-sqlite 用的就是这个分词器，所以它对中文也不可用。）
 *
 * 为什么不用 trigram：
 *   要求查询串 >= 3 字符，2 字词被丢弃；且体积更大（106KB vs 64KB）。
 *
 * 采用 2-gram：
 *   「知识库」→ 知识 识库 + 单字兜底。
 *   查询侧同样切 2-gram，用 OR 连接 + bm25 排序。
 *   实测 12 个查询从「7 个 0 命中」变成「全部有结果」。
 *
 * 英文/数字/路径整词保留（小写），这样 `output-guard`、`AGENTS.md` 能整体命中。
 *
 * @param {string} text
 * @returns {string[]} 去重后的 token 数组
 */
function cjkTokens(text) {
  const s = String(text || '');
  const out = new Set();
  // 英文 / 数字 / 路径 / 版本号：整词保留（小写），允许中间有点、连字符、下划线
  for (const w of s.match(/[A-Za-z][A-Za-z0-9_.\-]*/g) || []) {
    if (w.length >= 2) out.add(w.toLowerCase());
  }
  // 中文：连续汉字段只切 2-gram。
  // ⚠️ 刻意不保留单字（2026-10-20 实测教训）：
  //    单字 token 噪声极大——「记」出现在 13/21 条、「库」14/21 条，
  //    导致几乎任何查询都命中一大片，且 bm25 排序被拉平（#2 在 11 个查询里都排第一）。
  //    单字查询（「库」「坑」）走 LIKE 兜底，够用且不污染索引。
  for (const seg of s.match(/[\u4e00-\u9fa5]+/g) || []) {
    if (seg.length === 1) continue;          // 单字段不单独成 token
    for (let i = 0; i < seg.length - 1; i++) out.add(seg.slice(i, i + 2));
  }
  return [...out];
}

/** 把分词结果拼成 FTS 索引用的空格分隔串 */
function tokenizeForIndex(text) {
  return cjkTokens(text).join(' ');
}

/**
 * 把用户查询转成 FTS5 表达式。
 *
 * 规则（都是实测结论）：
 *   1. 每个 token 用双引号包裹 —— 否则 `output-guard` 的连字符会被 FTS5 当列名，
 *      直接抛 `no such column: guard`。
 *   2. 用 OR 而非 AND —— AND 太严，长句（「记忆库怎么检索」）0 命中；
 *      OR + bm25 排序既有召回又有相关性（实测 3/5 相关）。
 *   3. 长 token 优先并限 8 个 —— 2-gram 会让长查询产生大量 token，
 *      截断防止查询串过长；长 token 更具体，排前面优先保留。
 *
 * @param {string} query
 * @returns {string|null} FTS5 MATCH 表达式；无法分词时返回 null
 */
function buildFtsExpr(query) {
  const toks = cjkTokens(query);
  // 纯单字中文查询（「库」「坑」）分词后为空 → 返回 null，调用方走 LIKE 兜底。
  if (!toks.length) return null;
  toks.sort((a, b) => b.length - a.length);
  const use = toks.slice(0, 8);
  return use.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
}

/**
 * 维护 CJK 索引层（nodes_tok + nodes_tok_fts）。
 *
 * 注意：nodes_tok_fts 用 content='nodes_tok'（普通外部内容表，不是 contentless），
 * 因为 contentless 表（content=''）下 bm25() 返回 null —— 实测过，
 * 等于排序完全失效，只会按插入顺序返回。改成外部内容表后 bm25 正常，
 * 且可以用触发器自动同步，不必在 JS 里手动维护 FTS 行。
 */
function syncTokens(db, id, node) {
  db.prepare(`
    INSERT INTO nodes_tok(node_id, title_tok, summary_tok, tags_tok, body_tok)
    VALUES (?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET
      title_tok = excluded.title_tok,
      summary_tok = excluded.summary_tok,
      tags_tok = excluded.tags_tok,
      body_tok = excluded.body_tok
  `).run(
    id,
    tokenizeForIndex(node.title || ''),
    tokenizeForIndex(node.summary || ''),
    tokenizeForIndex(Array.isArray(node.tags) ? node.tags.join(' ') : (node.tags || '')),
    tokenizeForIndex(node.body || ''),
  );
}

/** 从 CJK 索引层删除一行（FTS 行由触发器处理） */
function removeTokens(db, id) {
  try { db.prepare('DELETE FROM nodes_tok WHERE node_id = ?').run(id); } catch { /* 表不存在 */ }
}

/**
 * 回填 CJK 索引：把还没有 nodes_tok 行的条目补上。
 * 老库升级后第一次打开时自动跑一次；也可手动调用。
 * @returns {{total:number, filled:number}}
 */
function backfillTokens(db) {
  let total = 0, filled = 0;
  try {
    total = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
    // 两种情况要补：①整行索引不存在；②v9 加了 body_tok，老行该列为空但 body 有内容
    const rows = db.prepare(`
      SELECT n.id, n.title, n.summary, n.tags, n.body FROM nodes n
      LEFT JOIN nodes_tok t ON t.node_id = n.id
      WHERE t.node_id IS NULL
         OR (COALESCE(t.body_tok, '') = '' AND COALESCE(n.body, '') <> '')
    `).all();
    for (const r of rows) {
      syncTokens(db, r.id, r);
      filled++;
    }
  } catch { /* 表结构异常时不影响主流程 */ }
  return { total, filled };
}

/**
 * 从原文里截取命中词附近的片段。
 *
 * ⚠️ 实测教训（2026-10-20）：
 *   原文里含大量「工具调用参数」和「工具结果回显」，直接找第一个命中的位置，
 *   往往命中的是「我调用命令时的字符串」而不是实际内容。
 *   例如搜 workbuddy 会命中 `mem.js search "workbuddy 模型"` 这行命令本身。
 *
 * 原文格式（renderOriginalText 产出）：
 *   [seq=1356] 🔧 工具调用
 *   pwsh({"command":"..."})
 *   [seq=1363] 👤 用户
 *   用户说的话
 *
 * 块头是 `[seq=N] <角色>`，后续行都属于该块，直到下一个块头。
 * 策略：优先在「用户 / 模型」块里找命中；都在工具块里时才退回任意位置。
 *
 * 注：本函数不依赖索引，只是纯文本处理，供 mem.js 从日志现取原文后截片段用。
 */
function rawSnippet(text, tokens, radius = 120) {
  const s = String(text || '');
  if (!s) return '';

  // 切成块：{ role, start, text }
  const blocks = [];
  let cur = null;
  let offset = 0;
  for (const line of s.split('\n')) {
    const m = line.trim().match(/^\[seq=\d+\]\s*(.+)$/);
    if (m) {
      if (cur) blocks.push(cur);
      cur = { role: m[1].trim(), start: offset, text: line + '\n' };
    } else if (cur) {
      cur.text += line + '\n';
    }
    offset += line.length + 1;
  }
  if (cur) blocks.push(cur);

  const isToolBlock = (b) => /^(🔧|↩️)/.test(b.role);

  const findIn = (predicate) => {
    let best = -1;
    for (const b of blocks) {
      if (!predicate(b)) continue;
      const lower = b.text.toLowerCase();
      for (const t of tokens) {
        if (!t || t.length < 2) continue;
        const i = lower.indexOf(t.toLowerCase());
        if (i >= 0) {
          const abs = b.start + i;
          if (best < 0 || abs < best) best = abs;
        }
      }
    }
    return best;
  };

  let best = findIn((b) => !isToolBlock(b));   // 先只找对话块
  if (best < 0) best = findIn(() => true);     // 都在工具块里才放开

  if (best < 0) return s.slice(0, radius * 2) + (s.length > radius * 2 ? '…' : '');
  const start = Math.max(0, best - radius);
  const end = Math.min(s.length, best + radius);
  return (start > 0 ? '…' : '') + s.slice(start, end) + (end < s.length ? '…' : '');
}

/**
 * 写操作标记：外层（mem.js）在进程退出时据此重建「dsh聊天记录」文本库。
 * 只在**真正的数据变更**时标记；ensureScope 的建表探测不算，
 * 否则每条只读命令都会白白触发一次重建。
 */
let __dirty = false;
function markDirty() { __dirty = true; }
function isDirty() { return __dirty; }

/** 写入一个记忆节点 */
function addNode(scope, node) {
  const { db, file } = openScope(scope);
  try {
    const ts = nowIso();
    const stmt = db.prepare(`
      INSERT INTO nodes(created_at, updated_at, valid_from, scope, kind, title, summary, body, tags,
                        weight, pinned, status, session_id, raw_ref, source, corrected)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `);
    const info = stmt.run(
      ts, ts, node.validFrom || ts, scope,
      node.kind || 'note',
      node.title || '(无标题)',
      node.summary || '',
      node.body || '',
      Array.isArray(node.tags) ? node.tags.join(',') : (node.tags || ''),
      node.weight ?? 3,
      node.pinned ? 1 : 0,
      node.status || 'open',
      node.sessionId || '',
      node.rawRef ? (typeof node.rawRef === 'string' ? node.rawRef : JSON.stringify(node.rawRef)) : '',
      node.source || 'manual',
      node.corrected ? 1 : 0,
    );

    // 项目库记录显示名，便于 listScopes 还原
    if (scope.startsWith('proj:')) {
      db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('display_name',?)").run(scope.slice(5));
    }
    const id = Number(info.lastInsertRowid);
    // CJK 索引层同步（2026-10-20 加）
    try { syncTokens(db, id, node); } catch { /* 索引失败不影响主数据写入 */ }
    // 原文一并入库（记忆库自存，不再只靠 DSH 日志）
    if (node.raw && String(node.raw.text || '').trim()) {
      writeRaw(db, id, node.raw, ts);
    }
    markDirty();
    return { id, file };
  } finally {
    db.close();
  }
}

/**
 * 把「原文锚点」写进 node_raw（2026-10-20 瘦身后：只存锚点，不存文本）。
 *
 * 背景：瘦身前的做法是把 autoExtractRelevant 定位到的那几轮渲染出来一起入库。
 * 实测证明这层是冗余的——
 *   · DSH 官方明确不删除会话文件，「防日志被清理」不成立；
 *   · 存的是片段不是原文，21 条里 7 条内容 100% 是工具调用日志；
 *   · 解压日志按需取一段只要 4ms（帧索引后），当作缓存也没必要。
 * 所以现在只保留 (session_id, seq_start, seq_end) 作为回源锚点，
 * 原文真源 = DSH 会话日志（已备份到 sessions-backup）。
 *
 * 调用方仍可传 raw.text，但内容不会入库，只为兼容旧签名。
 */
function writeRaw(db, id, raw, ts = nowIso()) {
  const hasAnchor = raw && (raw.sessionId || raw.seqStart != null || raw.seqEnd != null);
  if (!hasAnchor) return false;
  db.prepare(`
    INSERT INTO node_raw(node_id, text, source, session_id, seq_start, seq_end, chars, created_at)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(node_id) DO UPDATE SET
      text = '', source = excluded.source, session_id = excluded.session_id,
      seq_start = excluded.seq_start, seq_end = excluded.seq_end,
      chars = 0, created_at = excluded.created_at
  `).run(
    id, '', raw.source || 'dsh-session', raw.sessionId || '',
    raw.seqStart ?? null, raw.seqEnd ?? null, 0, ts,
  );
  return true;
}

/** 确保库文件存在且表结构是最新的（老库补建 node_raw 表） */
function ensureScope(scope) {
  const { db, file } = openScope(scope);
  db.close();
  return file;
}

/** 写入/替换某条记忆的完整原文 */
function setNodeRaw(scope, id, raw) {
  const { db } = openScope(scope);
  try {
    const ok = writeRaw(db, id, raw);
    if (ok) markDirty();
    return ok;
  } finally {
    db.close();
  }
}

/** 读取某条记忆在库内保存的完整原文（没有则 null） */
function getNodeRaw(scope, id) {
  const file = scopeFile(scope);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const r = db.prepare('SELECT * FROM node_raw WHERE node_id = ?').get(id);
    return r || null;
  } catch {
    return null;   // 老库还没建 node_raw 表
  } finally {
    db.close();
  }
}

/** 列出还没有入库原文的条目（回填用） */
function listNodesMissingRaw(scope, { limit = 1000 } = {}) {
  const file = scopeFile(scope);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`
      SELECT n.* FROM nodes n
      LEFT JOIN node_raw r ON r.node_id = n.id
      WHERE r.node_id IS NULL
      ORDER BY n.created_at DESC LIMIT ?
    `).all(limit).map((r) => ({ ...r, scope }));
  } catch {
    // 老库无 node_raw 表：那就全是「没原文」
    return db.prepare('SELECT * FROM nodes ORDER BY created_at DESC LIMIT ?').all(limit).map((r) => ({ ...r, scope }));
  } finally {
    db.close();
  }
}

/** 列出「已有原文」的条目及其原文，供一致性自检（doctor）使用 */
function listNodesWithRaw(scope, { limit = 5000 } = {}) {
  const file = scopeFile(scope);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`
      SELECT n.id, n.title, n.summary, n.created_at, n.session_id,
             r.text AS raw_text, r.chars AS raw_chars, r.session_id AS raw_session,
             r.seq_start, r.seq_end
      FROM nodes n
      JOIN node_raw r ON r.node_id = n.id
      ORDER BY n.created_at DESC LIMIT ?
    `).all(limit).map((r) => ({ ...r, scope }));
  } catch {
    return [];   // 老库无 node_raw 表
  } finally {
    db.close();
  }
}

/** 原文覆盖统计：{ total, withRaw, chars, refOnly } */
function rawCoverage(scope) {
  const file = scopeFile(scope);
  if (!fs.existsSync(file)) return { total: 0, withRaw: 0, chars: 0, refOnly: 0 };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const total = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
    let withRaw = 0, chars = 0;
    try {
      const r = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(chars),0) s FROM node_raw').get();
      withRaw = r.c; chars = r.s;
    } catch { /* 老库无表 */ }
    const refOnly = db.prepare("SELECT COUNT(*) c FROM nodes WHERE raw_ref IS NOT NULL AND raw_ref <> ''").get().c;
    return { total, withRaw, chars, refOnly };
  } finally {
    db.close();
  }
}

/**
 * 同义词扩展：把查询里出现的词替换成同义说法，生成多个检索变体。
 * 表在 config.json 的 synonyms 里，形如 { "之前": ["上次", "以前"] }。
 * 只做「包含替换」，不做分词——中文没有空格，整词替换最可控。
 * 变体上限 8 个，防止同义词表写大了把每次检索放大成几十次查询。
 */
function expandQuery(q, synonyms) {
  const set = new Set([q]);
  if (synonyms && typeof synonyms === 'object') {
    for (const [k, vs] of Object.entries(synonyms)) {
      if (!k || !Array.isArray(vs)) continue;
      // 双向：查询命中组内任意一个词（key 或 value）都触发扩展，
      // 否则「刚才」搜不到「之前」的记录。
      const group = [k, ...vs.filter((v) => typeof v === 'string' && v)];
      const hit = group.find((w) => w && q.includes(w));
      if (!hit) continue;
      for (const w of group) {
        if (w && w !== hit && set.size < 8) set.add(q.split(hit).join(w));
      }
    }
  }
  return [...set];
}

/**
 * 检索（支持同义词扩展）。
 *
 * ⚠️ trigram 的 3 字符下限在这里被透明处理：
 *    - 查询 ≥3 字符 → FTS5 MATCH + bm25 排序
 *    - 查询 <3 字符 → LIKE 兜底（否则会静默返回空结果）
 *
 * 同义词变体分别查询、按 id 合并（同一条取 bm25 更小的那次），
 * 避免「记忆」搜不到「memory」这类词面不一致的漏召回。
 */
function searchInScope(scope, query, { limit = 10, kinds = null, status = null, validOnly = false, includeDeleted = false } = {}) {
  const file = scopeFile(scope);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const q = String(query || '').trim();
    if (!q) return [];

    const filters = [];
    const params = [];
    if (kinds?.length) { filters.push(`n.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    if (status) {
      filters.push('n.status = ?'); params.push(status);
    } else if (!includeDeleted) {
      // 软删除约定（2026-10-19 加）：status='deleted' 的条目默认不参与检索。
      filters.push("(n.status IS NULL OR n.status <> 'deleted')");
    }
    // 时效过滤：默认只返回「仍然有效」的条目；valid_until 为空 = 现在还有效
    if (validOnly) filters.push("(n.valid_until IS NULL OR n.valid_until = '')");
    const filterSql = filters.length ? ' AND ' + filters.join(' AND ') : '';

    const runOne = (v) => {
      let rows = null;
      // CJK 检索层优先（2026-10-20 改）
      // 旧逻辑按「整串长度 >= 3」决定走 FTS 还是 LIKE，中文混合查询会静默 0 命中。
      // 现在：先试 nodes_tok_fts（2-gram + OR + bm25），失败或空再退回旧 trigram / LIKE。
      const expr = buildFtsExpr(v);
      if (expr) {
        try {
          rows = db.prepare(`
            SELECT n.*, bm25(nodes_tok_fts) AS score, (r.node_id IS NOT NULL) AS has_raw
            FROM nodes_tok_fts f JOIN nodes n ON n.id = f.rowid
            LEFT JOIN node_raw r ON r.node_id = n.id
            WHERE nodes_tok_fts MATCH ?${filterSql}
            ORDER BY score LIMIT ?
          `).all(expr, ...params, limit);
        } catch {
          rows = null;   // 索引表不存在或表达式异常 → 走后面的兜底
        }
      }
      if (!rows || !rows.length) {
        // 兜底 1：旧 trigram（老库还没回填 tokens 时仍能工作）
        if (v.length >= 3) {
          try {
            rows = db.prepare(`
              SELECT n.*, bm25(nodes_fts) AS score, (r.node_id IS NOT NULL) AS has_raw
              FROM nodes_fts f JOIN nodes n ON n.id = f.rowid
              LEFT JOIN node_raw r ON r.node_id = n.id
              WHERE nodes_fts MATCH ?${filterSql}
              ORDER BY score LIMIT ?
            `).all(v, ...params, limit);
          } catch {
            rows = null;
          }
        }
      }
      if (!rows || !rows.length) {
        // 兜底 2：LIKE（单字、符号、FTS 语法错误等）
        // 必须转义 % 和 _，否则查询里的通配符会变成「匹配一切」
        const esc = v.replace(/[\\%_]/g, (c) => '\\' + c);
        const like = `%${esc}%`;
        rows = db.prepare(`
          SELECT n.*, 0 AS score, (r.node_id IS NOT NULL) AS has_raw FROM nodes n
          LEFT JOIN node_raw r ON r.node_id = n.id
          WHERE (n.title LIKE ? ESCAPE '\\' OR n.summary LIKE ? ESCAPE '\\'
                 OR n.body LIKE ? ESCAPE '\\' OR n.tags LIKE ? ESCAPE '\\')${filterSql}
          ORDER BY n.weight DESC, n.created_at DESC LIMIT ?
        `).all(like, like, like, like, ...params, limit);
      }
      return rows;
    };

    const cfg = loadConfig();
    const variants = expandQuery(q, cfg.synonyms);
    const merged = new Map();
    for (const v of variants) {
      for (const r of runOne(v)) {
        const prev = merged.get(r.id);
        // bm25 是负分、越小越相关；LIKE 结果 score=0。同 id 取更靠前的那次。
        if (!prev || (typeof r.score === 'number' && r.score < (typeof prev.score === 'number' ? prev.score : Infinity))) {
          merged.set(r.id, r);
        }
      }
    }
    return [...merged.values()].map((r) => ({ ...r, scope }));
  } finally {
    db.close();
  }
}

/**
 * 跨 scope 检索 —— 逐库查询后合并排序。
 * 传入的 scopes 就是「允许检索的范围」，未列入的库根本不会被打开。
 */
function search(scopes, query, opts = {}) {
  const cfg = loadConfig();
  const limit = opts.limit ?? cfg.topK;
  const results = [];
  for (const s of scopes) results.push(...searchInScope(s, query, { ...opts, limit: opts.perScopeLimit ?? 20 }));
  return rankAndTrim(results, query, limit, cfg);
}

/** 综合排序：bm25 分数 + 权重 + 时间衰减 */
function rankAndTrim(rows, query, limit, cfg) {
  const now = Date.now();
  const scored = rows.map((r) => {
    // bm25 返回负值，越小越相关 → 转成越大越好的正分
    const bm = typeof r.score === 'number' && r.score < 0 ? -r.score : 0;
    const norm = bm > 0 ? bm / (1 + bm) : 0.3;  // LIKE 兜底给固定基础分

    const ageDays = (now - new Date(r.created_at.replace(' ', 'T')).getTime()) / 86400000;
    const recency = Math.pow(0.5, (Number.isFinite(ageDays) ? ageDays : 0) / cfg.recencyHalfLifeDays);

    const weight = 1 + (r.weight - 3) * cfg.weightBoost;
    const total = (norm * 0.6 + recency * 0.4) * Math.max(0.1, weight);
    return { ...r, _score: Number(total.toFixed(4)) };
  });
  scored.sort((a, b) => b._score - a._score);
  return scored.slice(0, limit);
}

/** 读取某个 scope 的全部节点 */
function listNodes(scope, { limit = 100, kinds = null, status = null, validOnly = false, includeDeleted = false } = {}) {
  const file = scopeFile(scope);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const filters = [];
    const params = [];
    if (kinds?.length) { filters.push(`n.kind IN (${kinds.map(() => '?').join(',')})`); params.push(...kinds); }
    if (status) {
      filters.push('n.status = ?'); params.push(status);
    } else if (!includeDeleted) {
      filters.push("(n.status IS NULL OR n.status <> 'deleted')");
    }
    if (validOnly) filters.push("(n.valid_until IS NULL OR n.valid_until = '')");
    const where = filters.length ? ' WHERE ' + filters.join(' AND ') : '';
    try {
      return db.prepare(
        `SELECT n.*, (r.node_id IS NOT NULL) AS has_raw FROM nodes n
         LEFT JOIN node_raw r ON r.node_id = n.id${where}
         ORDER BY n.weight DESC, n.created_at DESC LIMIT ?`
      ).all(...params, limit).map((r) => ({ ...r, scope }));
    } catch {
      // 老库还没建 node_raw 表
      return db.prepare(
        `SELECT * FROM nodes${where} ORDER BY weight DESC, created_at DESC LIMIT ?`
      ).all(...params, limit).map((r) => ({ ...r, scope }));
    }
  } finally {
    db.close();
  }
}

/** 按 id 取单个节点 */
function getNode(scope, id) {
  const file = scopeFile(scope);
  if (!fs.existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const r = db.prepare('SELECT * FROM nodes WHERE id = ?').get(id);
    return r ? { ...r, scope } : null;
  } finally {
    db.close();
  }
}

/**
 * 删除节点。
 * 默认**软删**（2026-10-19 改）：只把 status 置为 'deleted'，数据与原文都留着，
 * 之后能用 restoreNode 复原。加 { hard: true } 才物理删除（连 node_raw 一起）。
 * 改前是硬删，误删无法挽回。
 */
function deleteNode(scope, id, { hard = false } = {}) {
  const { db } = openScope(scope);
  try {
    if (hard) {
      try { db.prepare('DELETE FROM node_raw WHERE node_id = ?').run(id); } catch { /* 老库无表 */ }
      try { removeTokens(db, id); } catch { /* CJK 索引层不存在 */ }
      const changed = db.prepare('DELETE FROM nodes WHERE id = ?').run(id).changes > 0;
      if (changed) markDirty();
      return changed;
    }
    const r = db.prepare("UPDATE nodes SET status = 'deleted', updated_at = ? WHERE id = ? AND (status IS NULL OR status <> 'deleted')")
      .run(nowIso(), id);
    if (r.changes > 0) markDirty();
    return r.changes > 0;
  } finally {
    db.close();
  }
}

/** 从软删除恢复（status 回到 open） */
function restoreNode(scope, id) {
  const { db } = openScope(scope);
  try {
    const r = db.prepare("UPDATE nodes SET status = 'open', updated_at = ? WHERE id = ? AND status = 'deleted'")
      .run(nowIso(), id);
    if (r.changes > 0) markDirty();
    return r.changes > 0;
  } finally {
    db.close();
  }
}

function updateNode(scope, id, fields) {
  const { db } = openScope(scope);
  try {
    const allowed = ['title', 'summary', 'body', 'tags', 'kind', 'weight', 'pinned', 'status', 'raw_ref',
                     'valid_from', 'valid_until', 'superseded_by', 'corrected'];
    const sets = [];
    const params = [];
    for (const [k, v] of Object.entries(fields)) {
      if (!allowed.includes(k)) continue;
      sets.push(`${k} = ?`);
      params.push(Array.isArray(v) ? v.join(',') : v);
    }
    if (!sets.length) return false;
    sets.push('revision = revision + 1');
    sets.push('updated_at = ?');
    params.push(nowIso(), id);
    const changed = db.prepare(`UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`).run(...params).changes > 0;
    if (changed) {
      // CJK 索引层跟着主表更新（2026-10-20 加）
      try {
        const row = db.prepare('SELECT id, title, summary, tags, body FROM nodes WHERE id = ?').get(id);
        if (row) syncTokens(db, id, row);
      } catch { /* 索引失败不影响主数据 */ }
      markDirty();
    }
    return changed;
  } finally {
    db.close();
  }
}

/**
 * 写入前查重（2026-10-20 v9 加）
 * ============================
 * 背景：此前只用「同 kind + 标签有交集」列候选，靠人判断，47 个 tag 早已发散，
 * 结果就是同一件事写两遍（#15/#28 这类状态快照最典型）。
 * 做法：把候选文本切成 CJK 2-gram 集合，算 Jaccard 相似度。
 *   ≥0.8 视为重复，写入端阻断（--force 可强写）；0.5–0.8 只提示。
 * 只和「当前有效」的条目比（软删/已失效的不参与），否则 superseded 之后会被自己挡住。
 */
function jaccard(aTokens, bTokens) {
  const A = new Set(aTokens);
  const B = new Set(bTokens);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

function findSimilar(scope, text, { threshold = 0.5, limit = 5 } = {}) {
  const file = scopeFile(scope);
  if (!fs.existsSync(file)) return [];
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare(`
      SELECT id, title, summary, tags, kind FROM nodes
      WHERE (status IS NULL OR status <> 'deleted')
        AND COALESCE(valid_until, '') = ''
    `).all();
    const target = cjkTokens(String(text || ''));
    const out = [];
    for (const r of rows) {
      const score = jaccard(target, cjkTokens(`${r.title} ${r.summary || ''} ${r.tags || ''}`));
      if (score >= threshold) out.push({ id: r.id, title: r.title, kind: r.kind, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

/**
 * 元记忆判定（2026-10-20 v9 加）
 * ============================
 * 元记忆 = 「关于记忆系统自身」的条目（记忆库/插件/规则/知识库……）。
 * 实测 2026-10-20：28 条里 19 条命中，占 68%，会挤占真正的工作记忆。
 * 这里只做启发式识别（标题+标签），用于统计和写入提醒，**不做拦截**——
 * 误判的代价（挡住一条正常记忆）比漏判大。
 */
const META_RE = /记忆库|session-recall|知识库|HANDOFF|AGENTS|mem\.js|注入|检索|插件|铁律/i;
function isMetaNode(node) {
  return META_RE.test(`${node.title || ''} ${node.tags || ''}`);
}

function stats() {
  const out = [];
  for (const scope of listScopes()) {
    const file = scopeFile(scope);
    if (!fs.existsSync(file)) continue;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const total = db.prepare('SELECT COUNT(*) c FROM nodes').get().c;
      const byKind = db.prepare('SELECT kind, COUNT(*) c FROM nodes GROUP BY kind ORDER BY c DESC').all();
      // 元记忆占比（2026-10-20 v9 加）：只统计「当前有效」的条目
      const rows = db.prepare("SELECT title, tags, status, COALESCE(valid_until, '') AS vu FROM nodes").all();
      const active = rows.filter((r) => (r.status || 'open') !== 'deleted' && !String(r.vu).trim());
      const meta = active.filter(isMetaNode).length;
      const size = fs.statSync(file).size;
      out.push({ scope, file, total, byKind, bytes: size, active: active.length, meta });
    } catch (e) {
      out.push({ scope, file, error: e.message });
    } finally {
      db.close();
    }
  }
  return out;
}

/** 删除整个 scope（项目库） */
function dropScope(scope) {
  const file = scopeFile(scope);
  if (fs.existsSync(file)) { fs.unlinkSync(file); markDirty(); return true; }
  return false;
}

module.exports = {
  MEM_ROOT, DB_DIR, PROJECT_DIR, CONFIG_PATH,
  DEFAULT_CONFIG, loadConfig, saveConfig,
  slugify, scopeFile, openScope, listScopes,
  addNode, searchInScope, search, rankAndTrim,
  listNodes, getNode, deleteNode, restoreNode, updateNode, stats, dropScope,
  ensureScope, writeRaw, setNodeRaw, getNodeRaw, listNodesMissingRaw, listNodesWithRaw, rawCoverage,
  // CJK 检索层（2026-10-20 加）
  cjkTokens, tokenizeForIndex, buildFtsExpr, syncTokens, removeTokens, backfillTokens,
  // 查重与元记忆统计（2026-10-20 v9 加）
  findSimilar, isMetaNode,
  // 原文片段截取（纯文本处理，不依赖索引）
  rawSnippet,
  markDirty, isDirty,
  nowIso,
};
