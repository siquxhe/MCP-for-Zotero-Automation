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
const SRC = 'ZJW8VZK4';
const DST = 'NSQ9AYSJ';
const HOME = path.join(os.homedir(), '.workbuddy');
const AUTH_FILE = path.join(HOME, 'zotero-write-auth.json');
const AUDIT_FILE = path.join(HOME, 'zotero-reassign-audit.jsonl');
const DRY = process.argv.includes('--dry-run');

function stable(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
}
function sha(s) { return crypto.createHash('sha256').update(s, 'utf8').digest('hex'); }

function req(method, pathName, body, headers) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const h = { Accept: 'application/json' };
    if (payload !== null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload, 'utf8');
    }
    Object.assign(h, headers || {});
    const r = http.request(BASE + pathName, { method, headers: h }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let data; try { data = JSON.parse(raw); } catch { data = raw; }
        resolve({ status: res.statusCode || 0, headers: res.headers, data, raw });
      });
    });
    r.on('error', (e) => reject(new Error('连接失败：' + e.message)));
    r.setTimeout(30000, () => r.destroy(new Error('请求超时 30 秒')));
    if (payload !== null) r.write(payload);
    r.end();
  });
}

function audit(event, fields) {
  if (DRY) return 0;
  let hash = 'GENESIS', seq = 0;
  if (fs.existsSync(AUDIT_FILE)) {
    const lines = fs.readFileSync(AUDIT_FILE, 'utf8').split('\n').filter((x) => x.trim());
    if (lines.length) { const last = JSON.parse(lines[lines.length - 1]); hash = last.hash; seq = last.seq; }
  }
  const core = Object.assign({ seq: seq + 1, ts: new Date().toISOString(), event, prev: hash }, fields);
  const h = sha(hash + '|' + stable(core));
  fs.appendFileSync(AUDIT_FILE, JSON.stringify(Object.assign({}, core, { hash: h })) + '\n', 'utf8');
  return seq + 1;
}

async function main() {
  let all = [], start = 0;
  while (start < 800) {
    const r = await req('GET', '/api/users/' + USER + '/items?limit=100&start=' + start, null);
    if (r.status < 200 || r.status >= 300) throw new Error('读取条目失败 HTTP ' + r.status);
    all = all.concat(r.data);
    if (r.data.length < 100) break;
    start += 100;
  }
  const targets = all.filter((it) => (it.data.collections || []).includes(SRC));
  console.log('fetched=' + all.length + ' inSource=' + targets.length + ' dryRun=' + DRY);
  const bad = targets.filter((it) => it.data.itemType === 'attachment' || it.data.itemType === 'note');
  if (bad.length) throw new Error('源分类含 ' + bad.length + ' 个子项，需先确认');
  const alreadyDst = targets.filter((it) => (it.data.collections || []).includes(DST));
  const pureSrc = targets.length - alreadyDst.length;
  console.log('pureSource=' + pureSrc + ' alreadyInBoth=' + alreadyDst.length);

  if (DRY) {
    for (const it of targets.slice(0, 5)) {
      const cols = it.data.collections || [];
      console.log('  ' + it.key + ' v' + it.version + ' [' + cols.join(',') + '] -> [' + DST + '] ' + (it.data.title || '').slice(0, 45));
    }
    console.log('DRY RUN COMPLETE - ' + targets.length + ' items would be reassigned (' + pureSrc + ' pure + ' + alreadyDst.length + ' both), no writes');
    return;
  }

  const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  const sr = await req('GET', '/api/users/' + USER + '/collections?limit=1', null);
  const sid = sr.headers['zotero-server-id'];
  if (!sid) throw new Error('未获取 serverId');
  const headers = { 'Zotero-API-Key': auth.key, 'Zotero-Server-ID': sid };
  audit('reassign_start', { from: SRC, to: DST, count: targets.length });

  let done = 0;
  for (const it of targets) {
    const fresh = await req('GET', '/api/users/' + USER + '/items/' + it.key, null);
    if (fresh.status !== 200) throw new Error('读取 ' + it.key + ' 失败 HTTP ' + fresh.status);
    const d = fresh.data.data;
    const colls = (d.collections || []).map((c) => c === SRC ? DST : c);
    const newColls = Array.from(new Set(colls));
    const res = await req('PATCH', '/api/users/' + USER + '/items/' + it.key,
      { collections: newColls, version: fresh.data.version }, headers);
    if (res.status < 200 || res.status >= 300) {
      audit('reassign_abort', { key: it.key, status: res.status, error: String(res.raw).slice(0, 200) });
      throw new Error('改归属 ' + it.key + ' 失败 HTTP ' + res.status + '：' + String(res.raw).slice(0, 200));
    }
    done++;
    audit('reassigned', { key: it.key, from: SRC, to: DST, version: fresh.data.version });
    if (done % 20 === 0) console.log('progress ' + done + '/' + targets.length);
  }
  audit('reassign_complete', { from: SRC, to: DST, count: done });
  console.log('REASSIGN COMPLETE moved=' + done);
}

main().catch((e) => { console.error('FATAL: ' + e.message); process.exit(1); });
