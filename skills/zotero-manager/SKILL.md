---
license: GPL-3.0-or-later
name: zotero-manager
description: |
  Zotero 文献库管理：通过本地 MCP server `zotero-local` 做检索、去重合并、分类归属调整、备份与审计。当用户提到 Zotero、文献库、去重、重复条目、合并条目、分类调整、批量入库、BibTeX 导出、全文读取时触发。所有写操作走两阶段确认（prepare → commit）并留哈希链审计。
  English: Manage a local Zotero library via the `zotero-local` MCP server — search, deduplicate/merge items, reassign collections, import in batches, with two-phase confirmation and hash-chain audit. Trigger on Zotero, reference library, duplicate items, merge, collection reassign, batch import, BibTeX export, fulltext.
---

# Zotero 文献库管理

通过 MCP server `zotero-local` 操作本机 Zotero 10+。服务端脚本位于用户级 `~/.workbuddy/scripts/zotero-mcp.js`（Windows：`%USERPROFILE%\.workbuddy\scripts\zotero-mcp.js`），配置在 `~/.workbuddy/mcp.json`（脚本路径以该文件实际注册值为准）。
启动会话后工具以 `mcp__zotero-local__<name>` 形式出现；若看不到新工具，重启会话或重新 Trust 连接器。

## 铁律（违反即停止）

1. **写操作必须两阶段**：先 `prepare_*` 生成计划与 payloadHash，**把计划展示给用户并取得明确同意**，再 `commit_*`。三项必填：`token`、严格等于 `CONFIRM:<token>` 的 `confirmPhrase`、同一 `payloadHash`。缺一即拒，并记入审计。
2. **写前先备份**：任何删除/合并/改归属之前，先定位 Zotero 数据目录（默认 `~/Zotero/`，Windows `%USERPROFILE%\Zotero\`；若改过，以 Zotero 设置 → 高级 → 数据和文件夹 中显示的实际路径为准），复制其中 `zotero.sqlite`、`zotero.sqlite-wal`、`zotero.sqlite-shm` 三个文件到备份目录。Zotero 处于 WAL 模式，只拷 `.sqlite` 会丢数据。用 Python sqlite3 打开三文件副本做 `integrity_check` 验证。
3. **删除不可逆**：Zotero 10 本地 API 的 `DELETE` 是**直接删除**，不进回收站。合并/删条目/删分类都不可从 UI 撤销，只能靠备份恢复。
4. **不擅自做删除性操作**：用户说"去重""合并分类"时，先澄清是条目合并还是分类合并——两者不同。合并分类不减少重复。
5. **核对后再合并**：`find_duplicates` 的分组按 DOI 和规范化标题，**不是语义判重**。标题匹配会误判（曾把 Tang 2019 配到无关 PDF 附件）。合并前逐组核对标题与作者。
6. **合并保留子项**：合并必须按 Zotero 原生语义——**子项（附件/笔记）全部转移到保留条目，标签与分类取并集**，再删副本。裸 `DELETE` 会丢失附件/笔记。实测曾出现 62 个待删条目中 50 个带 61 个子项的情况。

## 工具清单（25 个）

### 只读

| 工具 | 用途 |
|---|---|
| `zotero_health` | 连通性、API 版本、Server-ID |
| `zotero_search` | 关键词检索（注意：`q` 默认只搜 title/creator/year，搜 DOI 用 curl 加 `qmode=everything`） |
| `zotero_get_item` / `zotero_get_children` | 条目详情 / 子项（附件、笔记） |
| `zotero_list_collections` / `zotero_collection_items` / `zotero_list_tags` | 分类、分类内条目、标签 |
| `zotero_saved_search_items` | 执行保存的检索式（本地 API 独有） |
| `zotero_export_bibtex` / `zotero_fulltext` | BibTeX 导出 / 已索引全文 |
| `zotero_find_duplicates` | 全库扫描重复组，返回建议保留项 |
| `zotero_write_status` | 授权状态、Server-ID、pending 数、审计链状态 |
| `zotero_audit` | 读取并校验写操作审计链 |

### 写（全部两阶段，prepare/commit 配对）

| prepare | commit | 用途 |
|---|---|---|
| `zotero_authorize_write`（单步） | — | 触发 Zotero 弹窗授权（Allow 一次性 / Always Allow 持久） |
| `zotero_prepare_import` | `zotero_commit_import` | 批量入库（JSON 数组，≤50/请求自动分块） |
| `zotero_prepare_delete` | `zotero_commit_delete` | 删除条目（直接删除，不进回收站） |
| `zotero_prepare_merge` | `zotero_commit_merge` | 合并重复条目：转移子项→并集标签/分类→删副本 |
| `zotero_prepare_reassign` | `zotero_commit_reassign` | 分类归属调整：`from` → `to` |
| `zotero_prepare_delete_collection` | `zotero_commit_delete_collection` | 删除空分类（预演时校验 numItems/numCollections 均为 0） |
| `zotero_cancel_pending` | — | 撤销未提交的令牌 |

## 标准工作流

### 去重合并

```
1. zotero_find_duplicates        → 拿到重复组与建议保留 key
2. 把分组表展示给用户，逐组核对标题/作者；必要时用 zotero_get_item 看详情
3. 用户确认保留项后 → 备份数据库（见铁律 2）
4. zotero_prepare_merge(groups=[{keep, delete:[...]}, ...])
5. 把计划（组数、删除数、子项转移数）展示给用户，取得明确"执行"指令
6. zotero_authorize_write（若未授权）
7. zotero_commit_merge(token, confirmPhrase, payloadHash)
8. 核验：zotero_find_duplicates 应为 0 组；抽查子项 parentItem；zotero_audit 链有效
```

### 分类归属调整

```
1. zotero_list_collections       → 确认 from / to 的 key 与条目数
2. 备份
3. zotero_prepare_reassign(from, to)   → 返回 itemCount / alreadyInBoth / pureSource
4. 展示计划，取得用户同意
5. zotero_commit_reassign(...)
6. 核验：两分类条目数变化符合 pureSource，库总数不变
```

### 删除空分类

```
1. zotero_list_collections 或 zotero_prepare_delete_collection 校验 numItems=0
2. 备份
3. zotero_prepare_delete_collection(key) → 展示给用户
4. 用户确认 → zotero_commit_delete_collection(...)
5. 核验：GET 该分类应 404；全库无条目引用该 key
```

## 关键事实与踩坑记录

- **本地 API 基线**：`http://127.0.0.1:23119`，API v3，仅 loopback，禁止端口转发。需在 Zotero 设置 → 高级勾选"允许此计算机上的其他应用程序与 Zotero 通信"，否则 403。
- **DELETE 必须带 `If-Unmodified-Since-Version` header**；PATCH 用 body 里的 `version` 字段即可。写请求还需 `Zotero-API-Key` 与 `Zotero-Server-ID`。
- **写返回**：条目创建 200 + `successful`/`failed` 逐项；PATCH 204；DELETE 204。
- **本地版本**：Zotero 10+ 的本地版本号与同步版本解耦，GET 常返回 version=0 或较大本地值；PATCH/DELETE 前务必重新 GET 取当前 version，不要用计划里的旧值。
- **`/items?q=` 的 q 参数不可靠**：按 DOI 查要用 `qmode=everything`，或直接遍历 `/items?format=json` 自行建索引。
- **分页 `start` 在同步期间不稳定**：同一轮扫描条目总数可能跳变。判重用 DOI/标题 → key 映射，再数 distinct key，不要用单次分页结果做差集。
- **授权弹窗限流**：`POST /api/local/authorize` 每分钟最多 5 次弹窗，超出返回 429。
- **连接中断先查进程**：核验时若 curl 报连接失败，先查 `Get-Process zotero` 与 23119 端口，可能是 Zotero 重启，不要误判为数据丢失。
- **写通道可能超时**：Zotero 主线程被占用（同步/弹窗）时，创建条目请求会 30 秒超时，而读请求毫秒级返回。遇到时先检查 Zotero 前台是否有未处理弹窗或同步进度。

## 审计与回滚

- 操作审计：`~\.workbuddy\zotero-write-audit.jsonl`（导入/删除/授权）与 `~\.workbuddy\zotero-merge-audit.jsonl`（合并）、`~\.workbuddy\zotero-reassign-audit.jsonl`（改归属）。均为 append-only JSONL，链式 SHA-256，`zotero_audit` 可校验。
- 待确认令牌：`~\.workbuddy\zotero-pending.json`，10 分钟 TTL，一次性。
- 备份目录：工作区 `.workbuddy/backups/`，命名含操作类型与时间戳。回滚需**先关闭 Zotero**，再用备份的三个文件覆盖 Zotero 数据目录（见铁律 2 的路径定位）下同名文件。
