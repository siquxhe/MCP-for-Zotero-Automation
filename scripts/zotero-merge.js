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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const BASE = process.env.ZOTERO_MCP_BASE_URL || 'http://127.0.0.1:23119';
const USER = '0';
const STATE_DIR = path.join(os.homedir(), '.workbuddy');
const PLAN_FILE = path.join(STATE_DIR, 'transfer-plan.json');
const AUTH_FILE = path.join(STATE_DIR, 'zotero-write-auth.json');
const AUDIT_FILE = path.join(STATE_DIR, 'zotero-merge-audit.jsonl');
const PROGRESS_FILE = path.join(STATE_DIR, 'zotero-merge-progress.json');
const DRY = process.argv.includes('--dry-run');
const RESUME = process.argv.includes('--resume');

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function request(method, pathName, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const h = { Accept: 'application/json' };
    if (payload !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }
    Object.assign(h, headers || {});
    const req = http.request(BASE + pathName, { method, headers: h }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode || 0, headers: res.headers, data, raw });
      });
    });
    req.on('error', (e) => reject(new Error('连接失败：' + e.message)));
    req.setTimeout(30000, () => req.destroy(new Error('请求超时 30 秒')));
    if (payload !== null) req.write(payload);
    req.end();
  });
}

function assertOk(res, what) {
  if (res.status >= 200 && res.status < 300) return res;
  throw new Error(what + ' 失败 HTTP ' + res.status + '：' + String(res.raw).slice(0, 300));
}

function lastHash() {
  try {
    if (!fs.existsSync(AUDIT_FILE)) return { hash: 'GENESIS', seq: 0 };
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter((l) => l.trim());
    if (!lines.length) return { hash: 'GENESIS', seq: 0 };
    const last = JSON.parse(lines[lines.length - 1]);
    return { hash: last.hash || 'GENESIS', seq: Number(last.seq) || 0 };
  } catch { return { hash: 'GENESIS', seq: 0 }; }
}

function audit(event, fields) {
  if (DRY) { console.log('[dry-audit] ' + event + ' ' + JSON.stringify(fields).slice(0, 160)); return 0; }
  const p = lastHash();
  const core = Object.assign({ seq: p.seq + 1, ts: new Date().toISOString(), event, prev: p.hash }, fields);
  const hash = sha(p.hash + '|' + stable(core));
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(Object.assign({}, core, { hash })) + '\n', 'utf8');
  return p.seq + 1;
}

function verifyChain() {
  if (!fs.existsSync(AUDIT_FILE)) return { valid: true, count: 0 };
  const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter((l) => l.trim());
  let prev = 'GENESIS';
  for (let i = 0; i < lines.length; i++) {
    const rec = JSON.parse(lines[i]);
    const { hash, ...core } = rec;
    if (rec.seq !== i + 1 || rec.prev !== prev || hash !== sha(prev + '|' + stable(core))) {
      return { valid: false, count: lines.length, firstBadSeq: i + 1 };
    }
    prev = hash;
  }
  return { valid: true, count: lines.length };
}

function loadProgress(planHash) {
  if (RESUME && fs.existsSync(PROGRESS_FILE)) {
    const p = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
    if (p.planHash === planHash) return p;
    throw new Error('进度文件与当前计划哈希不符，拒绝续跑');
  }
  return { planHash, done: [], failed: null, startedAt: new Date().toISOString() };
}
function saveProgress(p) {
  if (!DRY) fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2), 'utf8');
}

async function serverId() {
  const r = await request('GET', '/api/users/' + USER + '/collections?limit=1', null);
  assertOk(r, '读取 serverId');
  const sid = r.headers['zotero-server-id'];
  if (!sid) throw new Error('未获取到 Zotero-Server-ID');
  return sid;
}

async function getItem(key) {
  const r = await request('GET', '/api/users/' + USER + '/items/' + encodeURIComponent(key), null);
  assertOk(r, '读取条目 ' + key);
  return r.data;
}

async function patch(key, version, data) {
  const body = Object.assign({}, data, { version });
  const r = await request('PATCH', '/api/users/' + USER + '/items/' + encodeURIComponent(key), body, hdr());
  return r;
}

let AUTH = null;
let SID = null;
function hdr() {
  return { 'Zotero-API-Key': AUTH.key, 'Zotero-Server-ID': SID };
}

function mergeTags(keepTags, delTags) {
  const map = new Map();
  for (const t of keepTags.concat(delTags)) {
    const k = t.tag + '|' + (t.type || 0);
    if (!map.has(k)) map.set(k, { tag: t.tag, type: t.type || 0 });
  }
  return Array.from(map.values()).map((t) => t.type ? t : { tag: t.tag });
}
function mergeCollections(a, b) {
  return Array.from(new Set(a.concat(b)));
}

async function runGroup(g, sid) {
  const keepKey = g.keep.key;
  const keepNow = await getItem(keepKey);
  const keepVersionChanged = keepNow.version !== g.keep.version;

  const actions = [];
  let tags = (keepNow.data.tags || []).slice();
  let collections = (keepNow.data.collections || []).slice();
  for (const t of g.transfers) {
    const now = await getItem(t.key);
    tags = mergeTags(tags, now.data.tags || []);
    collections = mergeCollections(collections, now.data.collections || []);
  }

  for (const t of g.transfers) {
    for (const c of t.children) {
      const child = await getItem(c.key);
      const versionChanged = child.version !== c.version;
      if (child.data.parentItem === keepKey) { actions.push({ op: 'child-already', key: c.key, versionChanged }); continue; }
      if (DRY) { actions.push({ op: 'child-would-move', key: c.key, from: child.data.parentItem, to: keepKey, versionChanged }); continue; }
      const r = await patch(c.key, child.version, { parentItem: keepKey });
      assertOk(r, '转移子项 ' + c.key);
      actions.push({ op: 'child-moved', key: c.key, from: child.data.parentItem, to: keepKey });
      audit('child_moved', { group: g.index, child: c.key, from: child.data.parentItem, to: keepKey });
    }
  }

  const nowKeep = await getItem(keepKey);
  if (stable(tags) !== stable(nowKeep.data.tags || []) || stable(collections) !== stable(nowKeep.data.collections || [])) {
    if (DRY) actions.push({ op: 'metadata-would-merge', key: keepKey, tags: tags.length, collections: collections.length });
    else {
      const r = await patch(keepKey, nowKeep.version, { tags, collections });
      assertOk(r, '合并元数据 ' + keepKey);
      actions.push({ op: 'metadata-merged', key: keepKey, tags: tags.length, collections: collections.length });
      audit('metadata_merged', { group: g.index, key: keepKey, tags: tags.length, collections: collections.length });
    }
  }

  for (const t of g.transfers) {
    if (DRY) { actions.push({ op: 'delete-would', key: t.key }); continue; }
    const cur = await getItem(t.key);
    const delHeaders = Object.assign({}, hdr(), { 'If-Unmodified-Since-Version': String(cur.version) });
    const r = await request('DELETE', '/api/users/' + USER + '/items/' + encodeURIComponent(t.key), null, delHeaders);
    if (r.status !== 204 && r.status !== 200) throw new Error('删除 ' + t.key + ' 失败 HTTP ' + r.status + '：' + String(r.raw).slice(0, 200));
    actions.push({ op: 'deleted', key: t.key });
    audit('item_deleted', { group: g.index, key: t.key, title: t.title });
  }
  return actions;
}

async function main() {
  const planRaw = JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8'));
  const planHash = sha(stable(planRaw));
  const progress = loadProgress(planHash);
  const chain = verifyChain();
  console.log('dry-run=' + DRY + ' resume=' + RESUME + ' planHash=' + planHash.slice(0, 12));
  console.log('groups=' + planRaw.length + ' auditChain=' + JSON.stringify(chain));
  if (!chain.valid) throw new Error('审计链损坏，拒绝执行');

  if (DRY) {
    SID = await serverId();
    console.log('serverId=' + SID);
    for (const g of planRaw) {
      const acts = await runGroup(g, SID);
      console.log('GROUP ' + g.index + ' ' + g.keep.key + ' -> ' + g.transfers.map((t) => t.key).join(','));
      acts.forEach((a) => console.log('  ' + a.op + ' ' + (a.key || '') + (a.to ? ' -> ' + a.to : '')));
    }
    console.log('DRY RUN COMPLETE - no writes performed');
    return;
  }

  AUTH = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  SID = await serverId();
  audit('merge_start', { planHash, groups: planRaw.length, dryRun: false });
  let groupCount = 0;
  for (const g of planRaw) {
    if (progress.done.includes(g.index)) { console.log('skip done group ' + g.index); continue; }
    try {
      const acts = await runGroup(g, SID);
      progress.done.push(g.index);
      saveProgress(progress);
      audit('group_done', { group: g.index, actions: acts.length });
      console.log('group ' + g.index + '/' + planRaw.length + ' done (' + acts.length + ' actions)');
    } catch (err) {
      progress.failed = { group: g.index, error: err.message, at: new Date().toISOString() };
      saveProgress(progress);
      audit('merge_aborted', { group: g.index, error: err.message });
      console.error('ABORTED at group ' + g.index + ': ' + err.message);
      console.error('Progress saved to ' + PROGRESS_FILE + '. Use --resume after fixing.');
      process.exit(2);
    }
    groupCount++;
  }
  audit('merge_complete', { groups: groupCount });
  console.log('MERGE COMPLETE groups=' + groupCount);
}

main().catch((e) => { console.error('FATAL: ' + e.message); process.exit(1); });
