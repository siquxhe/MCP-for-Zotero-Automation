// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 siquxhe
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

'use strict';

const http = require('node:http');
const readline = require('node:readline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE = process.env.ZOTERO_MCP_BASE_URL || 'http://127.0.0.1:23119';
const USER = '0';
const CHUNK_SIZE = 50;
const TOKEN_TTL_MS = 10 * 60 * 1000;

const STATE_DIR = path.join(os.homedir(), '.workbuddy');
const AUDIT_FILE = path.join(STATE_DIR, 'zotero-write-audit.jsonl');
const PENDING_FILE = path.join(STATE_DIR, 'zotero-pending.json');
const AUTH_FILE = path.join(STATE_DIR, 'zotero-write-auth.json');

let memoryAuth = null;

function schema(props, required) {
  const properties = {};
  for (const entry of props) {
    const [name, type, desc, extra] = entry;
    properties[name] = Object.assign({ type, description: desc }, extra || {});
  }
  return required && required.length
    ? { type: 'object', properties, required }
    : { type: 'object', properties };
}

const TOOLS = [
  {
    name: 'zotero_health',
    description: '通过读取一个分类检查 Zotero 本地 API 连通性，返回 API 版本、schema 版本与服务 ID。只读。',
    inputSchema: schema([])
  },
  {
    name: 'zotero_search',
    description: '在本地文献库中按关键词检索条目。只读。',
    inputSchema: schema([
      ['q', 'string', '检索关键词'],
      ['limit', 'number', '返回条数上限，默认 20'],
      ['itemType', 'string', '限定条目类型，如 journalArticle、book'],
      ['tag', 'string', '限定标签']
    ], ['q'])
  },
  {
    name: 'zotero_get_item',
    description: '按键值读取单条文献的完整元数据。只读。',
    inputSchema: schema([['key', 'string', 'Zotero 条目 key，如 ABC123DEF']], ['key'])
  },
  {
    name: 'zotero_get_children',
    description: '读取某条目的子项目，包括笔记与附件。只读。',
    inputSchema: schema([['key', 'string', '父条目 key']], ['key'])
  },
  {
    name: 'zotero_list_collections',
    description: '列出本地库中的分类。只读。',
    inputSchema: schema([['limit', 'number', '返回数量上限，可选']])
  },
  {
    name: 'zotero_collection_items',
    description: '列出指定分类下的顶层条目。只读。',
    inputSchema: schema([
      ['key', 'string', '分类 key'],
      ['limit', 'number', '返回条数上限，默认 50']
    ], ['key'])
  },
  {
    name: 'zotero_list_tags',
    description: '列出本地库中全部标签。只读。',
    inputSchema: schema([['limit', 'number', '返回数量上限，可选']])
  },
  {
    name: 'zotero_saved_search_items',
    description: '执行本地保存的检索式，返回命中条目。只读。',
    inputSchema: schema([['key', 'string', '保存检索式 key']], ['key'])
  },
  {
    name: 'zotero_export_bibtex',
    description: '导出 BibTeX。传 key 导出单条；传 q 导出检索命中结果。只读。',
    inputSchema: schema([
      ['key', 'string', '单条条目 key，与 q 二选一'],
      ['q', 'string', '检索关键词，与 key 二选一']
    ])
  },
  {
    name: 'zotero_fulltext',
    description: '读取指定附件条目已被 Zotero 索引的全文。只读。',
    inputSchema: schema([['key', 'string', '附件条目 key']], ['key'])
  },
  {
    name: 'zotero_write_status',
    description: '查看写能力状态：本地 API、服务 ID、是否已授权、待确认操作数、审计链是否完整。不泄露密钥。只读。',
    inputSchema: schema([])
  },
  {
    name: 'zotero_authorize_write',
    description: '触发 Zotero 本地写授权弹窗，用户需选择 Allow 或 Always Allow。仅在写入前需要；密钥不会出现在返回结果中。',
    inputSchema: schema([])
  },
  {
    name: 'zotero_prepare_import',
    description: '写前预演：校验一批条目、生成人类可读计划与内容哈希，并保存短期令牌。此工具绝不写入 Zotero。必须先把计划展示给用户并取得明确同意。',
    inputSchema: schema([
      ['items', 'array', '待入库条目数组，每项含 itemType 等 Zotero Web API v3 字段', { items: { type: 'object' }, minItems: 1, maxItems: 500 }],
      ['targetCollection', 'string', '可选：目标分类 8 位 key，会自动加入每个条目的 collections'],
      ['note', 'string', '可选：本次入库说明，会记入审计']
    ], ['items'])
  },
  {
    name: 'zotero_commit_import',
    description: '执行入库：必须提供 prepare 返回的 token、确认短语 CONFIRM:<token>、以及同一 payloadHash。令牌一次性且 10 分钟过期，不匹配一律拒绝并记入审计。',
    inputSchema: schema([
      ['token', 'string', 'prepare 返回的一次性令牌'],
      ['confirmPhrase', 'string', '必须严格等于 CONFIRM:<token>'],
      ['payloadHash', 'string', 'prepare 返回的内容哈希']
    ], ['token', 'confirmPhrase', 'payloadHash'])
  },
  {
    name: 'zotero_cancel_pending',
    description: '撤销一个尚未提交的入库计划，并记入审计。',
    inputSchema: schema([['token', 'string', '待撤销的令牌']], ['token'])
  },
  {
    name: 'zotero_audit',
    description: '读取并校验 append-only 写操作审计日志的哈希链，返回最近若干条记录。不返回任何密钥或条目正文。',
    inputSchema: schema([
      ['last', 'number', '返回最近 N 条，默认 20'],
      ['verifyChain', 'boolean', '是否校验整条哈希链，默认 true']
    ])
  },
  {
    name: 'zotero_prepare_delete',
    description: '写前预演删除：校验条目 key、读取标题与版本、生成计划与内容哈希，保存短期令牌。此工具绝不删除任何条目。注意：经本地 API 的删除为直接删除，实测不进入回收站，请先备份。',
    inputSchema: schema([
      ['keys', 'array', '待删除条目 key 数组，每项为 8 位大写 key', { items: { type: 'string' }, minItems: 1, maxItems: 50 }],
      ['note', 'string', '可选：删除原因，会记入审计']
    ], ['keys'])
  },
  {
    name: 'zotero_commit_delete',
    description: '执行删除：必须提供 prepare 返回的 token、确认短语 CONFIRM:<token>、以及同一 payloadHash。带版本前置条件防止误删已变更条目。',
    inputSchema: schema([
      ['token', 'string', 'prepare 返回的一次性令牌'],
      ['confirmPhrase', 'string', '必须严格等于 CONFIRM:<token>'],
      ['payloadHash', 'string', 'prepare 返回的内容哈希']
    ], ['token', 'confirmPhrase', 'payloadHash'])
  },
  {
    name: 'zotero_find_duplicates',
    description: '只读扫描全库，按 DOI 与规范化标题识别重复组，供人工核对。返回每组各副本的 key、标题、分类、子项数与元数据完整度评分，并建议保留项。不写任何数据。',
    inputSchema: schema([['limit', 'number', '最多返回组数，默认 100']])
  },
  {
    name: 'zotero_prepare_merge',
    description: '写前预演合并：接收重复组（保留 key + 待删 key），读取每个待删条目的子项/标签/分类，生成转移计划与哈希，保存短期令牌。绝不写库。合并语义对齐 Zotero 原生 Merge：子项全部转移、标签与分类取并集、再删除副本。',
    inputSchema: schema([
      ['groups', 'array', '重复组数组，每组 {keep: 保留key, delete: [待删key], note?: 说明}', { items: { type: 'object' }, minItems: 1 }],
      ['note', 'string', '可选：本次合并总说明']
    ], ['groups'])
  },
  {
    name: 'zotero_commit_merge',
    description: '执行合并：需 prepare 返回的 token、CONFIRM:<token> 短语与同一 payloadHash。按组先转移子项 parentItem、合并标签/分类，再删除副本；带版本前置条件与失败即停审计。',
    inputSchema: schema([
      ['token', 'string', 'prepare 返回的令牌'],
      ['confirmPhrase', 'string', '必须严格等于 CONFIRM:<token>'],
      ['payloadHash', 'string', 'prepare 返回的内容哈希']
    ], ['token', 'confirmPhrase', 'payloadHash'])
  },
  {
    name: 'zotero_prepare_reassign',
    description: '写前预演分类归属调整：扫描源分类全部条目，生成"从 from 移到 to"的计划与哈希，保存短期令牌。绝不写库。',
    inputSchema: schema([
      ['from', 'string', '源分类 8 位 key'],
      ['to', 'string', '目标分类 8 位 key'],
      ['note', 'string', '可选：说明']
    ], ['from', 'to'])
  },
  {
    name: 'zotero_commit_reassign',
    description: '执行归属调整：需 prepare 的 token、CONFIRM:<token> 短语与同一 payloadHash。逐条 PATCH collections（移除 from、确保含 to），带版本前置条件，失败即停。',
    inputSchema: schema([
      ['token', 'string', 'prepare 返回的令牌'],
      ['confirmPhrase', 'string', '必须严格等于 CONFIRM:<token>'],
      ['payloadHash', 'string', 'prepare 返回的内容哈希']
    ], ['token', 'confirmPhrase', 'payloadHash'])
  },
  {
    name: 'zotero_prepare_delete_collection',
    description: '写前预演删除空分类：校验分类的条目数与子分类数均为 0，否则拒绝。绝不写库。',
    inputSchema: schema([
      ['key', 'string', '待删除分类 8 位 key'],
      ['note', 'string', '可选：说明']
    ], ['key'])
  },
  {
    name: 'zotero_commit_delete_collection',
    description: '执行删除空分类：需 prepare 的 token、CONFIRM:<token> 短语与同一 payloadHash。删除需 If-Unmodified-Since-Version 头，自动取当前版本。',
    inputSchema: schema([
      ['token', 'string', 'prepare 返回的令牌'],
      ['confirmPhrase', 'string', '必须严格等于 CONFIRM:<token>'],
      ['payloadHash', 'string', 'prepare 返回的内容哈希']
    ], ['token', 'confirmPhrase', 'payloadHash'])
  },
  {
    name: 'zotero_prepare_create_collection',
    description: '写前预演新建分类（单次最多 50 个）：校验名称非空、父分类 key 有效且存在、同级无同名分类。绝不写库。',
    inputSchema: schema([
      ['collections', 'array', '待建分类数组，每项 {name:string, parentCollection?:8位key或false}，parentCollection 省略或 false 表示顶级'],
      ['note', 'string', '可选：说明']
    ], ['collections'])
  },
  {
    name: 'zotero_commit_create_collection',
    description: '执行新建分类：需 prepare 的 token、CONFIRM:<token> 与同一 payloadHash。POST /collections + 一次性写令牌，返回每个新分类的 key。',
    inputSchema: schema([
      ['token', 'string', 'prepare 返回的令牌'],
      ['confirmPhrase', 'string', '必须严格等于 CONFIRM:<token>'],
      ['payloadHash', 'string', 'prepare 返回的内容哈希']
    ], ['token', 'confirmPhrase', 'payloadHash'])
  },
  {
    name: 'zotero_prepare_update_collection',
    description: '写前预演修改分类（重命名和/或移动父分类）：读取当前 name/parentCollection/version，校验新父分类存在且不能把父分类设为自身或自己的后代。绝不写库。',
    inputSchema: schema([
      ['key', 'string', '待修改分类 8 位 key'],
      ['name', 'string', '可选：新名称（不提供则不变）'],
      ['parentCollection', 'string', '可选：新父分类 8 位 key；传 false 表示移到顶级。不提供则不变'],
      ['note', 'string', '可选：说明']
    ], ['key'])
  },
  {
    name: 'zotero_commit_update_collection',
    description: '执行修改分类：需 prepare 的 token、CONFIRM:<token> 与同一 payloadHash。PATCH /collections/<key> 带 version 前置条件，返回修改后状态。',
    inputSchema: schema([
      ['token', 'string', 'prepare 返回的令牌'],
      ['confirmPhrase', 'string', '必须严格等于 CONFIRM:<token>'],
      ['payloadHash', 'string', 'prepare 返回的内容哈希']
    ], ['token', 'confirmPhrase', 'payloadHash'])
  }
];

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function ensureStateDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const text = fs.readFileSync(file, 'utf8').trim();
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  ensureStateDir();
  fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
}

function lastAuditHash() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return { hash: 'GENESIS', seq: 0 };
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter((l) => l.trim());
    if (!lines.length) return { hash: 'GENESIS', seq: 0 };
    const last = JSON.parse(lines[lines.length - 1]);
    return { hash: last.hash || 'GENESIS', seq: Number(last.seq) || 0 };
  } catch {
    return { hash: 'GENESIS', seq: 0 };
  }
}

function appendAudit(event, fields) {
  ensureStateDir();
  const prevState = lastAuditHash();
  const core = Object.assign({
    seq: prevState.seq + 1,
    ts: new Date().toISOString(),
    event,
    prev: prevState.hash
  }, fields);
  const hash = sha256(prevState.hash + '|' + stableStringify(core));
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(Object.assign({}, core, { hash })) + '\n', 'utf8');
  return prevState.seq + 1;
}

function verifyAuditChain() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return { valid: true, count: 0, firstBadSeq: null };
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter((l) => l.trim());
    let prev = 'GENESIS';
    for (let i = 0; i < lines.length; i++) {
      const rec = JSON.parse(lines[i]);
      const { hash, ...core } = rec;
      const expected = sha256(prev + '|' + stableStringify(core));
      if (rec.seq !== i + 1 || rec.prev !== prev || hash !== expected) {
        return { valid: false, count: lines.length, firstBadSeq: i + 1 };
      }
      prev = hash;
    }
    return { valid: true, count: lines.length, firstBadSeq: null };
  } catch (err) {
    return { valid: false, count: 0, firstBadSeq: null, error: err.message };
  }
}

function loadPending() {
  const pending = readJson(PENDING_FILE, {});
  const now = Date.now();
  let changed = false;
  for (const token of Object.keys(pending)) {
    if (Date.parse(pending[token].expiresAt) < now) {
      delete pending[token];
      changed = true;
    }
  }
  if (changed) writeJson(PENDING_FILE, pending);
  return pending;
}

function getAuth() {
  if (memoryAuth && memoryAuth.key) return memoryAuth;
  const stored = readJson(AUTH_FILE, null);
  if (stored && stored.key && stored.remember) return stored;
  return null;
}

function request(method, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined || body === null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = { Accept: 'application/json' };
    if (payload !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }
    Object.assign(h, headers || {});
    const req = http.request(BASE + urlPath, { method, headers: h }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode || 0, headers: res.headers, data, raw });
      });
    });
    req.on('error', (err) => reject(new Error('无法连接 Zotero（' + BASE + '）：' + err.message + '。请确认 Zotero 已运行。')));
    req.setTimeout(30000, () => { req.destroy(new Error('请求超时（30 秒）')); });
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function httpError(status, raw) {
  const text = typeof raw === 'string' ? raw.slice(0, 400) : '';
  const map = {
    400: '400 Bad Request：字段或类型不合法。' + text,
    401: '401 Unauthorized：写授权 key 缺失或已失效，请重新调用 zotero_authorize_write。',
    403: '403 Forbidden：本地 API 未启用，或用户拒绝了写授权。',
    409: '409 Conflict：文献库被锁定，稍后重试。',
    412: '412 Precondition Failed：版本冲突或写令牌重复。',
    413: '413：单次提交条目过多（上限 50）。',
    428: '428 Precondition Required：缺少 Zotero-Server-ID。',
    429: '429 Too Many Requests：授权弹窗请求过于频繁（每分钟最多 5 次）。'
  };
  return new Error(map[status] || ('HTTP ' + status + '：' + text));
}

async function get(pathName) {
  const res = await request('GET', pathName, null);
  if (res.status < 200 || res.status >= 300) throw httpError(res.status, res.raw);
  return {
    status: res.status,
    apiVersion: res.headers['zotero-api-version'] || null,
    serverId: res.headers['zotero-server-id'] || null,
    data: res.data
  };
}

async function fetchServerId() {
  const res = await request('GET', '/api/users/' + USER + '/collections?limit=1', null);
  if (res.status < 200 || res.status >= 300) throw httpError(res.status, res.raw);
  const serverId = res.headers['zotero-server-id'];
  if (!serverId) throw new Error('未获取到 Zotero-Server-ID，请确认 Zotero 10+ 且本地 API 已启用。');
  return serverId;
}

function limitParam(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? String(n) : String(fallback);
}

function isItemShape(item) {
  return item !== null && typeof item === 'object' && !Array.isArray(item);
}

const KEY_RE = /^[A-Z0-9]{8}$/;

async function fetchAllItems() {
  const all = [];
  let start = 0;
  while (start < 5000) {
    const res = await request('GET', '/api/users/' + USER + '/items?limit=100&start=' + start, null);
    if (res.status < 200 || res.status >= 300) throw httpError(res.status, res.raw);
    const batch = Array.isArray(res.data) ? res.data : [];
    all.push(...batch);
    if (batch.length < 100) break;
    start += 100;
  }
  return all;
}

function normalizeTitle(text) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ').trim();
}

function metadataScore(item) {
  const d = item.data || {};
  let n = 0;
  const has = (x) => x && String(x).trim();
  if (has(d.DOI)) n += 2;
  if (has(d.publicationTitle)) n += 2;
  if (has(d.date)) n += 1;
  if (has(d.volume)) n += 1;
  if (has(d.issue)) n += 1;
  if (has(d.pages)) n += 1;
  if (Array.isArray(d.creators) && d.creators.length) n += 2;
  if (has(d.abstractNote)) n += 1;
  if ((d.collections || []).length) n += 1;
  if (has(d.url)) n += 1;
  return n;
}

function confirmOp(token, confirmPhrase, payloadHash, pending, kind) {
  if (!token || !confirmPhrase || !payloadHash) throw new Error('缺少 token / confirmPhrase / payloadHash 之一');
  const op = pending[token];
  if (!op || (kind && op.kind !== kind)) {
    appendAudit('reject', { token, reason: 'unknown-or-expired-token', kind });
    throw new Error('令牌不存在、已过期或类型不符，请重新 prepare。');
  }
  if (confirmPhrase !== 'CONFIRM:' + token) {
    appendAudit('reject', { token, reason: 'bad-confirm-phrase', payloadHash: op.payloadHash });
    throw new Error('确认短语不匹配，拒绝执行。必须严格为 CONFIRM:<token>。');
  }
  if (payloadHash !== op.payloadHash) {
    appendAudit('reject', { token, reason: 'hash-mismatch', expected: op.payloadHash, supplied: payloadHash });
    throw new Error('内容哈希不匹配，拒绝执行。请使用 prepare 返回的原始 payloadHash。');
  }
  const auth = getAuth();
  if (!auth || !auth.key) {
    appendAudit('reject', { token, reason: 'no-write-authorization' });
    throw new Error('尚无写授权，请先调用 zotero_authorize_write。');
  }
  return { op, auth };
}

function requireServerMatch(auth, serverId) {
  if (auth.serverId && auth.serverId !== serverId) {
    throw new Error('Zotero 实例已变更（Server-ID 不匹配），请重新授权。');
  }
}

function consumeToken(pending, token, auth) {
  delete pending[token];
  writeJson(PENDING_FILE, pending);
  if (auth.remember !== true) {
    memoryAuth = null;
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
  }
}

function validateItems(items) {
  const errors = [];
  if (!Array.isArray(items)) return { errors: ['items 必须是数组'] };
  if (items.length < 1) return { errors: ['items 不能为空'] };
  if (items.length > 500) errors.push('单次最多 500 条，当前 ' + items.length + ' 条');
  items.forEach((item, i) => {
    if (!isItemShape(item)) { errors.push('第 ' + (i + 1) + ' 项不是对象'); return; }
    if (typeof item.itemType !== 'string' || !item.itemType.trim()) errors.push('第 ' + (i + 1) + ' 项缺少 itemType');
    if (item.key !== undefined) errors.push('第 ' + (i + 1) + ' 项含 key 字段，新建条目不允许指定 key');
    if (item.version !== undefined) errors.push('第 ' + (i + 1) + ' 项含 version 字段，新建条目不允许指定版本');
    if (item.title !== undefined && typeof item.title !== 'string') errors.push('第 ' + (i + 1) + ' 项 title 必须是字符串');
    if (item.DOI !== undefined && typeof item.DOI !== 'string') errors.push('第 ' + (i + 1) + ' 项 DOI 必须是字符串');
    if (item.collections !== undefined) {
      if (!Array.isArray(item.collections) || item.collections.some((c) => typeof c !== 'string' || !KEY_RE.test(c))) {
        errors.push('第 ' + (i + 1) + ' 项 collections 必须是 8 位大写 key 的数组');
      }
    }
    if (item.creators !== undefined) {
      if (!Array.isArray(item.creators)) errors.push('第 ' + (i + 1) + ' 项 creators 必须是数组');
      else item.creators.forEach((c, j) => {
        if (!isItemShape(c)) errors.push('第 ' + (i + 1) + ' 项第 ' + (j + 1) + ' 位作者不是对象');
        else if (!c.name && !c.firstName && !c.lastName) errors.push('第 ' + (i + 1) + ' 项第 ' + (j + 1) + ' 位作者缺少 name 或 firstName/lastName');
      });
    }
  });
  return { errors };
}

function extractKeys(successful) {
  if (!successful || typeof successful !== 'object') return [];
  return Object.values(successful).map((v) => {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object' && typeof v.key === 'string') return v.key;
    return null;
  }).filter(Boolean);
}

async function callTool(name, args) {
  const a = args || {};
  const prefix = '/api/users/' + USER;

  switch (name) {
    case 'zotero_health':
      return await get(prefix + '/collections?limit=1');

    case 'zotero_search': {
      if (!a.q) throw new Error('缺少必需参数 q');
      const p = new URLSearchParams({ q: a.q, format: 'json', limit: limitParam(a.limit, 20) });
      if (a.itemType) p.set('itemType', a.itemType);
      if (a.tag) p.set('tag', a.tag);
      return await get(prefix + '/items?' + p.toString());
    }

    case 'zotero_get_item': {
      if (!a.key) throw new Error('缺少必需参数 key');
      return await get(prefix + '/items/' + encodeURIComponent(a.key));
    }

    case 'zotero_get_children': {
      if (!a.key) throw new Error('缺少必需参数 key');
      return await get(prefix + '/items/' + encodeURIComponent(a.key) + '/children');
    }

    case 'zotero_list_collections': {
      const p = new URLSearchParams();
      if (a.limit) p.set('limit', limitParam(a.limit, 100));
      const tail = p.toString() ? '?' + p.toString() : '';
      return await get(prefix + '/collections' + tail);
    }

    case 'zotero_collection_items': {
      if (!a.key) throw new Error('缺少必需参数 key');
      const p = new URLSearchParams({ limit: limitParam(a.limit, 50) });
      return await get(prefix + '/collections/' + encodeURIComponent(a.key) + '/items?' + p.toString());
    }

    case 'zotero_list_tags': {
      const p = new URLSearchParams();
      if (a.limit) p.set('limit', limitParam(a.limit, 200));
      const tail = p.toString() ? '?' + p.toString() : '';
      return await get(prefix + '/tags' + tail);
    }

    case 'zotero_saved_search_items': {
      if (!a.key) throw new Error('缺少必需参数 key');
      return await get(prefix + '/searches/' + encodeURIComponent(a.key) + '/items');
    }

    case 'zotero_export_bibtex': {
      if (!a.key && !a.q) throw new Error('需要提供 key 或 q 之一');
      if (a.key) return await get(prefix + '/items/' + encodeURIComponent(a.key) + '?format=bibtex');
      const p = new URLSearchParams({ q: a.q, format: 'bibtex', limit: limitParam(a.limit, 20) });
      return await get(prefix + '/items?' + p.toString());
    }

    case 'zotero_fulltext': {
      if (!a.key) throw new Error('缺少必需参数 key');
      return await get(prefix + '/items/' + encodeURIComponent(a.key) + '/fulltext');
    }

    case 'zotero_write_status': {
      const pending = loadPending();
      const chain = verifyAuditChain();
      const auth = getAuth();
      let serverId = null;
      let apiOk = false;
      try { serverId = await fetchServerId(); apiOk = true; } catch { apiOk = false; }
      return {
        status: 'ok',
        localApiEnabled: apiOk,
        serverId,
        writeAuthorized: !!auth,
        authorizationKind: auth ? (auth.remember ? 'persistent' : 'single-use') : 'none',
        pendingCount: Object.keys(pending).length,
        audit: { file: AUDIT_FILE, chainValid: chain.valid, entries: chain.count, firstBadSeq: chain.firstBadSeq },
        pendingFile: PENDING_FILE,
        note: '本工具不会返回授权密钥。'
      };
    }

    case 'zotero_authorize_write': {
      const existing = getAuth();
      if (existing) {
        return {
          status: 'already-authorized',
          kind: existing.remember ? 'persistent' : 'single-use',
          message: '已有可用写授权，无需再次弹窗。'
        };
      }
      const serverId = await fetchServerId();
      const res = await request('POST', '/api/local/authorize', { appName: 'WorkBuddy Zotero MCP' }, {
        'Zotero-Server-ID': serverId
      });
      if (res.status === 403) {
        let denied = false;
        if (res.data && typeof res.data === 'object') denied = res.data.denied === true;
        appendAudit('auth_denied', { serverId, reason: denied ? 'user-denied' : 'forbidden' });
        throw new Error(denied ? '用户拒绝了写授权。' : httpError(403, res.raw).message);
      }
      if (res.status < 200 || res.status >= 300) throw httpError(res.status, res.raw);
      if (!res.data || typeof res.data.key !== 'string') throw new Error('授权响应异常：未返回 key。');
      const record = {
        key: res.data.key,
        serverId,
        remember: res.data.remember === true,
        authorizedAt: new Date().toISOString()
      };
      if (record.remember) writeJson(AUTH_FILE, record);
      else memoryAuth = record;
      appendAudit('auth_granted', { serverId, remember: record.remember });
      return {
        status: 'authorized',
        kind: record.remember ? 'persistent' : 'single-use',
        message: record.remember
          ? '已获得持久授权，密钥保存在本机状态文件，不会出现在对话中。'
          : '已获得一次性授权，成功写入一次后需重新授权。'
      };
    }

    case 'zotero_prepare_import': {
      const items = a.items;
      const check = validateItems(items);
      if (check.errors.length) throw new Error('条目校验失败：' + check.errors.slice(0, 10).join('；'));

      let targetKey = null;
      let targetName = null;
      if (a.targetCollection) {
        if (!KEY_RE.test(a.targetCollection)) throw new Error('targetCollection 必须是 8 位大写 key');
        const collections = await get(prefix + '/collections?limit=100');
        const found = (collections.data || []).find((c) => c.key === a.targetCollection);
        if (!found) throw new Error('目标分类不存在：' + a.targetCollection);
        targetKey = a.targetCollection;
        targetName = found.data && found.data.name ? found.data.name : null;
      }

      const preparedItems = items.map((item) => {
        const copy = Object.assign({}, item);
        if (targetKey) {
          const current = Array.isArray(copy.collections) ? copy.collections.slice() : [];
          if (!current.includes(targetKey)) current.push(targetKey);
          copy.collections = current;
        }
        return copy;
      });

      const payload = {
        items: preparedItems,
        targetCollection: targetKey,
        note: typeof a.note === 'string' ? a.note.slice(0, 500) : ''
      };
      const payloadHash = sha256(stableStringify(payload));
      const token = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const pending = loadPending();
      pending[token] = {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
        payloadHash,
        payload
      };
      writeJson(PENDING_FILE, pending);

      const duplicateAdvisory = { checked: 0, possible: [] };
      const doiItems = preparedItems.filter((it) => typeof it.DOI === 'string' && it.DOI.trim()).slice(0, 20);
      for (const it of doiItems) {
        try {
          const p = new URLSearchParams({ q: it.DOI, qmode: 'everything', limit: '1', format: 'json' });
          const res = await get(prefix + '/items?' + p.toString());
          duplicateAdvisory.checked++;
          if (Array.isArray(res.data) && res.data.length > 0) {
            duplicateAdvisory.possible.push({ DOI: it.DOI, title: it.title || null, existingKey: res.data[0].key });
          }
        } catch { /* advisory only */ }
      }

      const titles = preparedItems.slice(0, 20).map((it, i) => ({ index: i + 1, title: it.title || '(无标题)', itemType: it.itemType }));
      const chunks = Math.ceil(preparedItems.length / CHUNK_SIZE);
      appendAudit('prepare', {
        token,
        payloadHash,
        itemCount: preparedItems.length,
        chunks,
        targetCollection: targetKey,
        targetName,
        note: payload.note,
        titles: titles.map((t) => t.title)
      });

      return {
        status: 'prepared',
        token,
        payloadHash,
        expiresAt: pending[token].expiresAt,
        itemCount: preparedItems.length,
        chunks,
        target: targetKey ? { key: targetKey, name: targetName } : null,
        titles,
        moreTitles: preparedItems.length > titles.length ? preparedItems.length - titles.length : 0,
        duplicateAdvisory,
        warning: chunks > 1
          ? '将分 ' + chunks + ' 次请求提交，单次失败不影响已成功批次；本操作不具备跨批次原子性。'
          : '单次请求提交。',
        nextStep: '请把以上计划完整展示给用户并取得明确同意。同意后调用 zotero_commit_import，参数：token=' + token + '、confirmPhrase=CONFIRM:' + token + '、payloadHash=' + payloadHash + '。'
      };
    }

    case 'zotero_commit_import': {
      const { token, confirmPhrase, payloadHash } = a;
      if (!token || !confirmPhrase || !payloadHash) throw new Error('缺少 token / confirmPhrase / payloadHash 之一');
      const pending = loadPending();
      const op = pending[token];
      if (!op) {
        appendAudit('reject', { token, reason: 'unknown-or-expired-token', suppliedHash: payloadHash });
        throw new Error('令牌不存在或已过期，请重新执行 zotero_prepare_import。');
      }
      if (confirmPhrase !== 'CONFIRM:' + token) {
        appendAudit('reject', { token, reason: 'bad-confirm-phrase', payloadHash: op.payloadHash });
        throw new Error('确认短语不匹配，拒绝写入。必须严格为 CONFIRM:<token>。');
      }
      if (payloadHash !== op.payloadHash) {
        appendAudit('reject', { token, reason: 'hash-mismatch', expected: op.payloadHash, supplied: payloadHash });
        throw new Error('内容哈希不匹配，拒绝写入。请使用 prepare 返回的原始 payloadHash。');
      }

      const auth = getAuth();
      if (!auth || !auth.key) {
        appendAudit('reject', { token, reason: 'no-write-authorization', payloadHash });
        throw new Error('尚无写授权，请先调用 zotero_authorize_write（会在 Zotero 中弹窗）。');
      }
      const serverId = await fetchServerId();
      if (auth.serverId && auth.serverId !== serverId) {
        appendAudit('reject', { token, reason: 'server-id-mismatch', payloadHash });
        throw new Error('Zotero 实例已变更（Server-ID 不匹配），请重新授权。');
      }

      const items = op.payload.items;
      const results = [];
      let totalSuccessful = 0;
      let totalUnchanged = 0;
      let totalFailed = 0;

      for (let start = 0; start < items.length; start += CHUNK_SIZE) {
        const chunk = items.slice(start, start + CHUNK_SIZE);
        const writeToken = crypto.randomBytes(16).toString('hex');
        let res;
        try {
          res = await request('POST', prefix + '/items', chunk, {
            'Zotero-API-Key': auth.key,
            'Zotero-Server-ID': serverId,
            'Zotero-Write-Token': writeToken
          });
        } catch (err) {
          appendAudit('commit_error', { token, payloadHash, chunk: results.length + 1, reason: err.message });
          throw err;
        }
        if (res.status < 200 || res.status >= 300) {
          appendAudit('commit_error', { token, payloadHash, chunk: results.length + 1, status: res.status, reason: String(res.raw).slice(0, 300) });
          throw httpError(res.status, res.raw);
        }
        const ok = extractKeys(res.data && res.data.successful);
        const unchanged = res.data && res.data.unchanged ? Object.keys(res.data.unchanged).length : 0;
        const failed = res.data && res.data.failed ? Object.keys(res.data.failed).length : 0;
        totalSuccessful += ok.length;
        totalUnchanged += unchanged;
        totalFailed += failed;
        results.push({
          chunk: results.length + 1,
          submitted: chunk.length,
          successful: ok.length,
          unchanged,
          failed,
          newKeys: ok,
          failures: res.data && res.data.failed ? res.data.failed : {}
        });
      }

      delete pending[token];
      writeJson(PENDING_FILE, pending);
      if (auth.remember !== true) {
        memoryAuth = null;
        if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
      }
      const seq = appendAudit('commit', {
        token,
        payloadHash,
        itemCount: items.length,
        successful: totalSuccessful,
        unchanged: totalUnchanged,
        failed: totalFailed,
        chunks: results.length,
        targetCollection: op.payload.targetCollection,
        note: op.payload.note
      });

      return {
        status: 'committed',
        token,
        payloadHash,
        auditSeq: seq,
        total: items.length,
        successful: totalSuccessful,
        unchanged: totalUnchanged,
        failed: totalFailed,
        chunks: results
      };
    }

    case 'zotero_cancel_pending': {
      if (!a.token) throw new Error('缺少必需参数 token');
      const pending = loadPending();
      const op = pending[a.token];
      if (!op) throw new Error('令牌不存在或已过期');
      delete pending[a.token];
      writeJson(PENDING_FILE, pending);
      appendAudit('cancel', { token: a.token, payloadHash: op.payloadHash, itemCount: op.payload.items.length });
      return { status: 'cancelled', token: a.token };
    }

    case 'zotero_audit': {
      const chain = verifyAuditChain();
      let entries = [];
      if (fs.existsSync(AUDIT_FILE)) {
        const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter((l) => l.trim());
        const n = Number(a.last) > 0 ? Number(a.last) : 20;
        entries = lines.slice(-n).map((line) => {
          const rec = JSON.parse(line);
          const { token, payloadHash, titles, ...safe } = rec;
          return Object.assign({}, safe, {
            tokenPrefix: typeof token === 'string' ? token.slice(0, 8) : null,
            payloadHashPrefix: typeof payloadHash === 'string' ? payloadHash.slice(0, 12) : null,
            titleCount: Array.isArray(titles) ? titles.length : null
          });
        });
      }
      return { status: 'ok', chain, file: AUDIT_FILE, entries };
    }

    case 'zotero_prepare_delete': {
      const keys = a.keys;
      if (!Array.isArray(keys)) throw new Error('keys 必须是数组');
      if (keys.length < 1 || keys.length > 50) throw new Error('keys 数量须在 1 到 50 之间');
      const bad = keys.filter((k) => typeof k !== 'string' || !KEY_RE.test(k));
      if (bad.length) throw new Error('非法条目 key：' + bad.join(', '));
      if (new Set(keys).size !== keys.length) throw new Error('keys 含重复项');

      const targets = [];
      for (const key of keys) {
        const item = await get(prefix + '/items/' + encodeURIComponent(key));
        const d = item.data && item.data.data ? item.data.data : {};
        targets.push({
          key,
          version: item.data && item.data.version !== undefined ? item.data.version : d.version,
          title: d.title || '(无标题)',
          itemType: d.itemType || null,
          parentItem: d.parentItem || false
        });
      }

      const payload = {
        targets,
        note: typeof a.note === 'string' ? a.note.slice(0, 500) : ''
      };
      const payloadHash = sha256(stableStringify(payload));
      const token = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const pending = loadPending();
      pending[token] = {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
        payloadHash,
        payload,
        kind: 'delete'
      };
      writeJson(PENDING_FILE, pending);
      appendAudit('prepare_delete', {
        token,
        payloadHash,
        keys,
        titles: targets.map((t) => t.title)
      });

      return {
        status: 'prepared_delete',
        token,
        payloadHash,
        expiresAt: pending[token].expiresAt,
        targets,
        note: payload.note,
        warning: '实测：通过本地 API 删除会直接移除条目，不进入回收站，请务必先备份。payloadHash 已绑定每条的当前 version，期间若有改动将以 412 拒绝。',
        nextStep: '请展示以上待删除清单并取得明确同意。同意后调用 zotero_commit_delete，参数：token=' + token + '、confirmPhrase=CONFIRM:' + token + '、payloadHash=' + payloadHash + '。'
      };
    }

    case 'zotero_commit_delete': {
      const { token, confirmPhrase, payloadHash } = a;
      if (!token || !confirmPhrase || !payloadHash) throw new Error('缺少 token / confirmPhrase / payloadHash 之一');
      const pending = loadPending();
      const op = pending[token];
      if (!op || op.kind !== 'delete') {
        appendAudit('reject', { token, reason: 'unknown-or-expired-delete-token', suppliedHash: payloadHash });
        throw new Error('删除令牌不存在或已过期，请重新执行 zotero_prepare_delete。');
      }
      if (confirmPhrase !== 'CONFIRM:' + token) {
        appendAudit('reject', { token, reason: 'bad-confirm-phrase-delete', payloadHash: op.payloadHash });
        throw new Error('确认短语不匹配，拒绝删除。必须严格为 CONFIRM:<token>。');
      }
      if (payloadHash !== op.payloadHash) {
        appendAudit('reject', { token, reason: 'hash-mismatch-delete', expected: op.payloadHash, supplied: payloadHash });
        throw new Error('内容哈希不匹配，拒绝删除。请使用 prepare 返回的原始 payloadHash。');
      }
      const auth = getAuth();
      if (!auth || !auth.key) {
        appendAudit('reject', { token, reason: 'no-write-authorization-delete', payloadHash });
        throw new Error('尚无写授权，请先调用 zotero_authorize_write。');
      }
      const serverId = await fetchServerId();
      if (auth.serverId && auth.serverId !== serverId) {
        appendAudit('reject', { token, reason: 'server-id-mismatch-delete', payloadHash });
        throw new Error('Zotero 实例已变更（Server-ID 不匹配），请重新授权。');
      }

      const targets = op.payload.targets;
      const results = [];
      for (const t of targets) {
        const versionHeader = Number.isInteger(t.version) ? String(t.version) : undefined;
        let res;
        try {
          res = await request('DELETE', prefix + '/items/' + encodeURIComponent(t.key), null, {
            'Zotero-API-Key': auth.key,
            'Zotero-Server-ID': serverId,
            'If-Unmodified-Since-Version': versionHeader
          });
        } catch (err) {
          appendAudit('commit_delete_error', { token, payloadHash, key: t.key, reason: err.message });
          throw err;
        }
        if (res.status !== 204 && res.status !== 200) {
          appendAudit('commit_delete_error', { token, payloadHash, key: t.key, status: res.status, reason: String(res.raw).slice(0, 300) });
          if (res.status === 412) throw new Error('条目 ' + t.key + ' 在预演后被改动，版本冲突（412），已中止删除。');
          throw httpError(res.status, res.raw);
        }
        results.push({ key: t.key, title: t.title, status: res.status, deleted: true });
      }

      delete pending[token];
      writeJson(PENDING_FILE, pending);
      if (auth.remember !== true) {
        memoryAuth = null;
        if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
      }
      const seq = appendAudit('commit_delete', {
        token,
        payloadHash,
        keys: targets.map((t) => t.key),
        titles: targets.map((t) => t.title),
        note: op.payload.note,
        deletedCount: results.length
      });

      return {
        status: 'deleted',
        token,
        payloadHash,
        auditSeq: seq,
        deletedCount: results.length,
        results,
        notice: '条目已删除。实测经本地 API 的删除不进入回收站，如需恢复请使用备份。'
      };
    }

    case 'zotero_find_duplicates': {
      const all = await fetchAllItems();
      const regular = all.filter((it) => it.data && !['attachment', 'note'].includes(it.data.itemType));
      const byDoi = {};
      const byTitle = {};
      for (const it of regular) {
        const d = it.data;
        if (d.DOI) {
          const k = d.DOI.trim().toLowerCase();
          (byDoi[k] = byDoi[k] || []).push(it);
        } else {
          const k = normalizeTitle(d.title);
          if (k) (byTitle[k] = byTitle[k] || []).push(it);
        }
      }
      const groups = [];
      for (const [k, v] of Object.entries(byDoi)) {
        if (v.length > 1) groups.push({ basis: 'DOI', key: k, members: v });
      }
      for (const [k, v] of Object.entries(byTitle)) {
        if (v.length > 1) groups.push({ basis: '标题(无DOI)', key: k.slice(0, 80), members: v });
      }
      groups.sort((a, b) => (a.members[0].data.title || '').localeCompare(b.members[0].data.title || ''));
      const limit = Number(a.limit) > 0 ? Number(a.limit) : 100;
      return {
        status: 'ok',
        scannedItems: regular.length,
        groupCount: groups.length,
        removableTotal: groups.reduce((s, g) => s + g.members.length - 1, 0),
        groups: groups.slice(0, limit).map((g) => {
          const ranked = g.members.map((it) => ({ it, score: metadataScore(it) }))
            .sort((x, y) => y.score - x.score || String(x.it.data.dateAdded).localeCompare(String(y.it.data.dateAdded)));
          return {
            basis: g.basis,
            key: g.key,
            title: g.members[0].data.title || null,
            suggestedKeep: ranked[0].it.key,
            candidates: ranked.map((r) => ({
              key: r.it.key,
              score: r.score,
              title: r.it.data.title || null,
              itemType: r.it.data.itemType,
              collections: r.it.data.collections || [],
              childCount: null
            }))
          };
        }),
        truncated: groups.length > limit,
        note: '仅供核对。合并前请人工确认标题与作者确为同一文献；duplicateAdvisory 曾出现假阳性。'
      };
    }

    case 'zotero_prepare_merge': {
      if (!Array.isArray(a.groups) || !a.groups.length) throw new Error('groups 必须是非空数组');
      const built = [];
      for (let i = 0; i < a.groups.length; i++) {
        const g = a.groups[i];
        if (!isItemShape(g) || !KEY_RE.test(g.keep || '') || !Array.isArray(g.delete) || !g.delete.length) {
          throw new Error('第 ' + (i + 1) + ' 组格式错误：需 {keep: key, delete: [key,...]}');
        }
        if (g.delete.length > 50) throw new Error('第 ' + (i + 1) + ' 组待删数量超过 50');
        const keepItem = await get(prefix + '/items/' + encodeURIComponent(g.keep));
        const keepChildren = await get(prefix + '/items/' + encodeURIComponent(g.keep) + '/children');
        const transfers = [];
        for (const dk of g.delete) {
          if (!KEY_RE.test(dk) || dk === g.keep) throw new Error('非法或重复的待删 key：' + dk);
          const it = await get(prefix + '/items/' + encodeURIComponent(dk));
          const children = await get(prefix + '/items/' + encodeURIComponent(dk) + '/children');
          transfers.push({
            key: dk,
            version: it.data.version,
            title: it.data.data && it.data.data.title ? it.data.data.title : null,
            tags: it.data.data && it.data.data.tags ? it.data.data.tags : [],
            collections: it.data.data && it.data.data.collections ? it.data.data.collections : [],
            children: children.data.map((c) => ({ key: c.key, version: c.version, type: c.data.itemType, note: !!c.data.note }))
          });
        }
        built.push({
          index: i + 1,
          keep: {
            key: g.keep,
            version: keepItem.data.version,
            tags: keepItem.data.data.tags || [],
            collections: keepItem.data.data.collections || [],
            children: keepChildren.data.map((c) => c.key)
          },
          transfers,
          note: typeof g.note === 'string' ? g.note.slice(0, 300) : ''
        });
      }
      const payload = { groups: built, note: typeof a.note === 'string' ? a.note.slice(0, 500) : '' };
      const payloadHash = sha256(stableStringify(payload));
      const token = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const pending = loadPending();
      pending[token] = {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
        payloadHash,
        payload,
        kind: 'merge'
      };
      writeJson(PENDING_FILE, pending);
      const childTotal = built.reduce((s, g) => s + g.transfers.reduce((t, x) => t + x.children.length, 0), 0);
      const deleteTotal = built.reduce((s, g) => s + g.transfers.length, 0);
      appendAudit('prepare_merge', { token, payloadHash, groups: built.length, deletes: deleteTotal, children: childTotal });
      return {
        status: 'prepared_merge',
        token,
        payloadHash,
        expiresAt: pending[token].expiresAt,
        groupCount: built.length,
        deleteCount: deleteTotal,
        childTransferCount: childTotal,
        preview: built.slice(0, 10).map((g) => ({ keep: g.keep.key, delete: g.transfers.map((t) => t.key), children: g.transfers.reduce((s, t) => s + t.children.length, 0) })),
        warning: '合并会转移全部子项并删除副本；本地 API 删除不进回收站，请先备份。',
        nextStep: '展示计划并取得明确同意后调用 zotero_commit_import 之外的 zotero_commit_merge，参数：token=' + token + '、confirmPhrase=CONFIRM:' + token + '、payloadHash=' + payloadHash + '。'
      };
    }

    case 'zotero_commit_merge': {
      const pending = loadPending();
      const { op, auth } = confirmOp(a.token, a.confirmPhrase, a.payloadHash, pending, 'merge');
      const serverId = await fetchServerId();
      requireServerMatch(auth, serverId);
      const headers = { 'Zotero-API-Key': auth.key, 'Zotero-Server-ID': serverId };
      const groups = op.payload.groups;
      let done = 0;
      let childMoved = 0;
      let deleted = 0;
      try {
        for (const g of groups) {
          for (const t of g.transfers) {
            for (const c of t.children) {
              const fresh = await get(prefix + '/items/' + encodeURIComponent(c.key));
              const data = fresh.data.data || {};
              if (data.parentItem === g.keep.key) continue;
              const res = await request('PATCH', prefix + '/items/' + encodeURIComponent(c.key),
                { parentItem: g.keep.key, version: fresh.data.version }, headers);
              if (res.status < 200 || res.status >= 300) throw new Error('转移子项 ' + c.key + ' 失败 HTTP ' + res.status);
              childMoved++;
              appendAudit('child_moved', { group: g.index, child: c.key, to: g.keep.key });
            }
          }
          const keepNow = await get(prefix + '/items/' + encodeURIComponent(g.keep.key));
          const tagMap = new Map();
          for (const t of (keepNow.data.data.tags || []).concat(...g.transfers.map((x) => x.tags))) {
            const k = t.tag + '|' + (t.type || 0);
            if (!tagMap.has(k)) tagMap.set(k, t.type ? { tag: t.tag, type: t.type } : { tag: t.tag });
          }
          const colls = Array.from(new Set((keepNow.data.data.collections || []).concat(...g.transfers.map((x) => x.collections))));
          const tagsArr = Array.from(tagMap.values());
          if (stableStringify(tagsArr) !== stableStringify(keepNow.data.data.tags || []) ||
              stableStringify(colls) !== stableStringify(keepNow.data.data.collections || [])) {
            const res = await request('PATCH', prefix + '/items/' + encodeURIComponent(g.keep.key),
              { tags: tagsArr, collections: colls, version: keepNow.data.version }, headers);
            if (res.status < 200 || res.status >= 300) throw new Error('合并元数据 ' + g.keep.key + ' 失败 HTTP ' + res.status);
          }
          for (const t of g.transfers) {
            const fresh = await get(prefix + '/items/' + encodeURIComponent(t.key));
            const res = await request('DELETE', prefix + '/items/' + encodeURIComponent(t.key), null,
              Object.assign({}, headers, { 'If-Unmodified-Since-Version': String(fresh.data.version) }));
            if (res.status !== 204 && res.status !== 200) throw new Error('删除 ' + t.key + ' 失败 HTTP ' + res.status);
            deleted++;
            appendAudit('item_deleted', { group: g.index, key: t.key });
          }
          done++;
        }
      } catch (err) {
        appendAudit('merge_aborted', { groupsDone: done, error: err.message });
        throw new Error('合并在第 ' + (done + 1) + ' 组中止：' + err.message + '。已完成 ' + done + ' 组，令牌保留可重试。');
      }
      consumeToken(pending, a.token, auth);
      const seq = appendAudit('merge_complete', { groups: done, children: childMoved, deleted });
      return { status: 'merged', groups: done, childMoved, deleted, auditSeq: seq, notice: '副本已直接删除，不进回收站。' };
    }

    case 'zotero_prepare_reassign': {
      if (!KEY_RE.test(a.from || '') || !KEY_RE.test(a.to || '')) throw new Error('from / to 必须是 8 位大写分类 key');
      if (a.from === a.to) throw new Error('from 与 to 不能相同');
      const all = await fetchAllItems();
      const targets = all.filter((it) => it.data && (it.data.collections || []).includes(a.from));
      const both = targets.filter((it) => (it.data.collections || []).includes(a.to));
      const payload = {
        from: a.from, to: a.to,
        keys: targets.map((it) => it.key),
        note: typeof a.note === 'string' ? a.note.slice(0, 300) : ''
      };
      const payloadHash = sha256(stableStringify(payload));
      const token = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const pending = loadPending();
      pending[token] = {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
        payloadHash, payload, kind: 'reassign'
      };
      writeJson(PENDING_FILE, pending);
      appendAudit('prepare_reassign', { token, payloadHash, from: a.from, to: a.to, count: targets.length });
      return {
        status: 'prepared_reassign',
        token, payloadHash,
        expiresAt: pending[token].expiresAt,
        itemCount: targets.length,
        alreadyInBoth: both.length,
        pureSource: targets.length - both.length,
        note: '纯源分类条目将改为目标分类；已双归属条目只移除源分类。',
        nextStep: '展示计划并取得同意后调用 zotero_commit_reassign，参数：token=' + token + '、confirmPhrase=CONFIRM:' + token + '、payloadHash=' + payloadHash + '。'
      };
    }

    case 'zotero_commit_reassign': {
      const pending = loadPending();
      const { op, auth } = confirmOp(a.token, a.confirmPhrase, a.payloadHash, pending, 'reassign');
      const serverId = await fetchServerId();
      requireServerMatch(auth, serverId);
      const headers = { 'Zotero-API-Key': auth.key, 'Zotero-Server-ID': serverId };
      let done = 0;
      try {
        for (const key of op.payload.keys) {
          const fresh = await get(prefix + '/items/' + encodeURIComponent(key));
          const colls = (fresh.data.data.collections || []).map((c) => c === op.payload.from ? op.payload.to : c);
          const next = Array.from(new Set(colls));
          const res = await request('PATCH', prefix + '/items/' + encodeURIComponent(key),
            { collections: next, version: fresh.data.version }, headers);
          if (res.status < 200 || res.status >= 300) throw new Error('改归属 ' + key + ' 失败 HTTP ' + res.status);
          done++;
        }
      } catch (err) {
        appendAudit('reassign_aborted', { done, error: err.message });
        throw new Error('归属调整在第 ' + (done + 1) + ' 条中止：' + err.message);
      }
      consumeToken(pending, a.token, auth);
      const seq = appendAudit('reassign_complete', { from: op.payload.from, to: op.payload.to, count: done });
      return { status: 'reassigned', from: op.payload.from, to: op.payload.to, moved: done, auditSeq: seq };
    }

    case 'zotero_prepare_delete_collection': {
      if (!KEY_RE.test(a.key || '')) throw new Error('key 必须是 8 位大写分类 key');
      const res = await get(prefix + '/collections/' + encodeURIComponent(a.key));
      const numItems = res.data.meta && res.data.meta.numItems || 0;
      const numCollections = res.data.meta && res.data.meta.numCollections || 0;
      const name = res.data.data && res.data.data.name || null;
      if (numItems !== 0 || numCollections !== 0) {
        throw new Error('分类非空（条目 ' + numItems + '，子分类 ' + numCollections + '），拒绝预演删除。');
      }
      const payload = { key: a.key, name, note: typeof a.note === 'string' ? a.note.slice(0, 300) : '' };
      const payloadHash = sha256(stableStringify(payload));
      const token = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const pending = loadPending();
      pending[token] = {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
        payloadHash, payload, kind: 'delete_collection'
      };
      writeJson(PENDING_FILE, pending);
      appendAudit('prepare_delete_collection', { token, payloadHash, key: a.key, name });
      return {
        status: 'prepared_delete_collection',
        token, payloadHash,
        expiresAt: pending[token].expiresAt,
        key: a.key, name, numItems, numCollections,
        nextStep: '展示并取得同意后调用 zotero_commit_delete_collection，参数：token=' + token + '、confirmPhrase=CONFIRM:' + token + '、payloadHash=' + payloadHash + '。'
      };
    }

    case 'zotero_commit_delete_collection': {
      const pending = loadPending();
      const { op, auth } = confirmOp(a.token, a.confirmPhrase, a.payloadHash, pending, 'delete_collection');
      const serverId = await fetchServerId();
      requireServerMatch(auth, serverId);
      const fresh = await get(prefix + '/collections/' + encodeURIComponent(op.payload.key));
      const headers = Object.assign(
        { 'Zotero-API-Key': auth.key, 'Zotero-Server-ID': serverId },
        { 'If-Unmodified-Since-Version': String(fresh.data.version) }
      );
      const res = await request('DELETE', prefix + '/collections/' + encodeURIComponent(op.payload.key), null, headers);
      if (res.status !== 204 && res.status !== 200) throw new Error('删除分类失败 HTTP ' + res.status + '：' + String(res.raw).slice(0, 200));
      consumeToken(pending, a.token, auth);
      const seq = appendAudit('delete_collection', { key: op.payload.key, name: op.payload.name });
      return { status: 'collection_deleted', key: op.payload.key, name: op.payload.name, auditSeq: seq };
    }

    case 'zotero_prepare_create_collection': {
      const list = a.collections;
      if (!Array.isArray(list) || list.length < 1) throw new Error('collections 必须是非空数组');
      if (list.length > 50) throw new Error('单次最多新建 50 个分类');
      const allColls = (await get(prefix + '/collections?limit=100')).data || [];
      const existingByKey = new Map(allColls.map((c) => [c.key, c]));
      const siblingNames = new Map();
      const normalized = [];
      for (let i = 0; i < list.length; i++) {
        const c = list[i];
        if (!isItemShape(c)) throw new Error('第 ' + (i + 1) + ' 项必须是对象');
        if (typeof c.name !== 'string' || !c.name.trim()) throw new Error('第 ' + (i + 1) + ' 项 name 必须是非空字符串');
        const name = c.name.trim();
        let parent = false;
        if (c.parentCollection !== undefined && c.parentCollection !== false && c.parentCollection !== null) {
          if (typeof c.parentCollection !== 'string' || !KEY_RE.test(c.parentCollection)) {
            throw new Error('第 ' + (i + 1) + ' 项 parentCollection 必须是 8 位 key 或 false');
          }
          parent = c.parentCollection;
        }
        if (parent && !existingByKey.has(parent)) throw new Error('第 ' + (i + 1) + ' 项的父分类 ' + parent + ' 不存在');
        const sibKey = parent || 'TOP';
        const sibSet = siblingNames.get(sibKey) || new Set(
          allColls.filter((x) => ((x.data.parentCollection || false) === parent)).map((x) => String(x.data.name || '').toLowerCase())
        );
        if (sibSet.has(name.toLowerCase())) throw new Error('同级已存在同名分类「' + name + '」，拒绝重复创建');
        sibSet.add(name.toLowerCase());
        siblingNames.set(sibKey, sibSet);
        normalized.push({ name, parentCollection: parent });
      }
      const payload = { collections: normalized, note: typeof a.note === 'string' ? a.note.slice(0, 300) : '' };
      const payloadHash = sha256(stableStringify(payload));
      const token = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const pending = loadPending();
      pending[token] = {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
        payloadHash, payload, kind: 'create_collection'
      };
      writeJson(PENDING_FILE, pending);
      appendAudit('prepare_create_collection', { token, payloadHash, count: normalized.length, note: payload.note });
      return {
        status: 'prepared_create_collection', token, payloadHash,
        expiresAt: pending[token].expiresAt,
        collections: normalized, count: normalized.length,
        nextStep: '展示并取得同意后调用 zotero_commit_create_collection，参数：token=' + token + '、confirmPhrase=CONFIRM:' + token + '、payloadHash=' + payloadHash + '。'
      };
    }

    case 'zotero_commit_create_collection': {
      const pending = loadPending();
      const { op, auth } = confirmOp(a.token, a.confirmPhrase, a.payloadHash, pending, 'create_collection');
      const serverId = await fetchServerId();
      requireServerMatch(auth, serverId);
      const writeToken = crypto.randomBytes(16).toString('hex');
      const headers = Object.assign(
        { 'Content-Type': 'application/json', 'Zotero-API-Key': auth.key, 'Zotero-Server-ID': serverId, 'Zotero-Write-Token': writeToken },
        null
      );
      const res = await request('POST', prefix + '/collections', op.payload.collections, headers);
      if (res.status !== 200) throw httpError(res.status, res.raw);
      const result = res.data || {};
      const failed = result.failed || {};
      if (Object.keys(failed).length) throw new Error('部分分类创建失败：' + JSON.stringify(failed).slice(0, 300));
      const successful = result.successful || {};
      const created = Object.keys(successful).map((idx) => {
        const obj = successful[idx] || {};
        const requested = op.payload.collections[Number(idx)] || {};
        return {
          key: obj.key || null,
          name: obj.name || requested.name || null,
          parentCollection: obj.parentCollection || requested.parentCollection || false
        };
      });
      consumeToken(pending, a.token, auth);
      const seq = appendAudit('create_collection', { count: created.length, keys: created.map((c) => c.key), note: op.payload.note });
      return { status: 'collections_created', created, count: created.length, auditSeq: seq };
    }

    case 'zotero_prepare_update_collection': {
      if (!KEY_RE.test(a.key || '')) throw new Error('key 必须是 8 位大写分类 key');
      if (a.name === undefined && a.parentCollection === undefined) {
        throw new Error('至少要提供 name 或 parentCollection 之一');
      }
      const res = await get(prefix + '/collections/' + encodeURIComponent(a.key));
      const cur = res.data.data || {};
      const curName = cur.name || '';
      const curParent = cur.parentCollection || false;
      const version = res.data.version;
      let newName = curName;
      let newParent = curParent;
      if (a.name !== undefined) {
        if (typeof a.name !== 'string' || !a.name.trim()) throw new Error('name 必须是非空字符串');
        newName = a.name.trim();
      }
      if (a.parentCollection !== undefined) {
        if (a.parentCollection === false || a.parentCollection === null || a.parentCollection === '') {
          newParent = false;
        } else if (typeof a.parentCollection === 'string' && KEY_RE.test(a.parentCollection)) {
          newParent = a.parentCollection;
        } else {
          throw new Error('parentCollection 必须是 8 位 key 或 false');
        }
      }
      if (newName === curName && newParent === curParent) throw new Error('没有实际变更（名称与父分类均与当前相同）');
      const allColls = (await get(prefix + '/collections?limit=100')).data || [];
      const byKey = new Map(allColls.map((c) => [c.key, c]));
      if (newParent) {
        if (!byKey.has(newParent)) throw new Error('新父分类 ' + newParent + ' 不存在');
        if (newParent === a.key) throw new Error('不能把分类设为自己的父分类');
        let cursor = newParent;
        const seen = new Set();
        while (cursor && !seen.has(cursor)) {
          seen.add(cursor);
          if (cursor === a.key) throw new Error('不能把分类移到自己的后代之下（会形成循环）');
          const p = (byKey.get(cursor) || {}).data || {};
          cursor = p.parentCollection || false;
        }
      }
      const nameClash = allColls.some((c) => c.key !== a.key &&
        ((c.data.parentCollection || false) === newParent) &&
        String(c.data.name || '').toLowerCase() === newName.toLowerCase());
      if (nameClash) throw new Error('同级已存在同名分类「' + newName + '」，拒绝重命名');
      const payload = {
        key: a.key, version, name: newName, parentCollection: newParent,
        current: { name: curName, parentCollection: curParent },
        note: typeof a.note === 'string' ? a.note.slice(0, 300) : ''
      };
      const payloadHash = sha256(stableStringify(payload));
      const token = crypto.randomBytes(16).toString('hex');
      const now = Date.now();
      const pending = loadPending();
      pending[token] = {
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + TOKEN_TTL_MS).toISOString(),
        payloadHash, payload, kind: 'update_collection'
      };
      writeJson(PENDING_FILE, pending);
      appendAudit('prepare_update_collection', { token, payloadHash, key: a.key, name: newName, parentCollection: newParent });
      return {
        status: 'prepared_update_collection', token, payloadHash,
        expiresAt: pending[token].expiresAt,
        key: a.key, version,
        current: payload.current,
        proposed: { name: newName, parentCollection: newParent },
        nextStep: '展示并取得同意后调用 zotero_commit_update_collection，参数：token=' + token + '、confirmPhrase=CONFIRM:' + token + '、payloadHash=' + payloadHash + '。'
      };
    }

    case 'zotero_commit_update_collection': {
      const pending = loadPending();
      const { op, auth } = confirmOp(a.token, a.confirmPhrase, a.payloadHash, pending, 'update_collection');
      const serverId = await fetchServerId();
      requireServerMatch(auth, serverId);
      const p = op.payload;
      const headers = Object.assign(
        { 'Content-Type': 'application/json', 'Zotero-API-Key': auth.key, 'Zotero-Server-ID': serverId },
        { 'If-Unmodified-Since-Version': String(p.version) }
      );
      const body = { key: p.key, version: p.version, name: p.name, parentCollection: p.parentCollection };
      const res = await request('PATCH', prefix + '/collections/' + encodeURIComponent(p.key), body, headers);
      if (res.status !== 200 && res.status !== 204) throw httpError(res.status, res.raw);
      consumeToken(pending, a.token, auth);
      const seq = appendAudit('update_collection', { key: p.key, from: p.current, to: { name: p.name, parentCollection: p.parentCollection }, note: p.note });
      return { status: 'collection_updated', key: p.key, name: p.name, parentCollection: p.parentCollection, auditSeq: seq };
    }

    default:
      throw new Error('未知工具：' + name);
  }
}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on('line', async (line) => {
  if (!line.trim()) return;
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  const id = req.id;
  try {
    switch (req.method) {
      case 'initialize': {
        const requested = req.params && req.params.protocolVersion;
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: typeof requested === 'string' ? requested : '2024-11-05',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'zotero-local', version: '2.0.0' }
          }
        });
        break;
      }
      case 'notifications/initialized':
        break;
      case 'ping':
        if (id !== undefined) send({ jsonrpc: '2.0', id, result: {} });
        break;
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        break;
      case 'tools/call': {
        const name = req.params && req.params.name;
        const args = (req.params && req.params.arguments) || {};
        try {
          const result = await callTool(name, args);
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result, null, 2)
              }]
            }
          });
        } catch (err) {
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: '错误：' + err.message }], isError: true }
          });
        }
        break;
      }
      default:
        if (id !== undefined) {
          send({ jsonrpc: '2.0', id, error: { code: -32601, message: '未知方法：' + req.method } });
        }
    }
  } catch (err) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: err.message } });
    }
  }
});
