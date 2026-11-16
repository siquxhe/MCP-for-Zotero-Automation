# MCP-for-Zotero-Automation
A MCP Server for Automated Zotero Control

---

Zotero 本地自动化工具集：一个零依赖的 MCP server（25 个工具）+ 一个配套 Agent skill，让 AI Agent 能安全地检索、批量入库、去重合并、调整分类归属，并全程留审计。

针对 **Zotero 10+** 的本地 API（`http://127.0.0.1:23119`）设计。不需要 Zotero 插件，不需要 API key（写授权由 Zotero 弹窗给出）。

## 目录

```
.
├── scripts/
│   ├── zotero-mcp.js        # 主 MCP server，25 个工具（stdio 协议）
│   ├── zotero-merge.js      # 独立批量合并工具（备用）
│   └── zotero-reassign.js   # 独立分类归属调整工具（备用）
├── skills/zotero-manager/
│   └── SKILL.md             # 配套 Agent skill：工作流 + 安全铁律
├── mcp.json.example         # MCP 配置示例
├── LICENSE                  # GPL-3.0
└── README.md
```

## 前置条件

1. Zotero 10 或更高版本，桌面客户端正在运行；
2. 在 Zotero 中开启本地 API：**设置 → 高级 → 勾选「允许此计算机上的其他应用程序与 Zotero 通信」**（英文：Allow other applications on this computer to communicate with Zotero）。未开启会返回 `403 Forbidden`；
3. Node.js 18+（推荐 20/22）。脚本零第三方依赖，只用 Node 内置模块；
4. 一个支持 MCP 的 Agent 客户端（如 WorkBuddy、Claude Desktop、Cursor 等）。

> 安全：本地 API 只监听 `127.0.0.1`，读请求无认证。不要端口转发，不要把它暴露到网络。

## 安装

### 1. 安装 MCP server

复制脚本到你希望的位置（例如 `~/.workbuddy/scripts/`），然后在 Agent 客户端的 MCP 配置中加入（见 `mcp.json.example`）：

```json
{
  "mcpServers": {
    "zotero-local": {
      "command": "node",
      "args": ["/绝对路径/zotero-mcp.js"],
      "env": { "ZOTERO_MCP_BASE_URL": "http://127.0.0.1:23119" }
    }
  }
}
```

重启客户端（或在连接器管理界面重新信任该 server），工具会以 `mcp__zotero-local__<name>` 的形式出现。

### 2. 安装 Agent skill（可选，强烈推荐）

把 `skills/zotero-manager/` 整个目录复制到你的用户级 skills 目录（如 `~/.workbuddy/skills/zotero-manager/`）。Skill 会告诉 Agent 完整的安全工作流：写前备份、两阶段确认、如何核对重复组、如何避免误删附件等。

## 工具一览（25 个）

**只读**（10 + 2）：`zotero_health`、`zotero_search`、`zotero_get_item`、`zotero_get_children`、`zotero_list_collections`、`zotero_collection_items`、`zotero_list_tags`、`zotero_saved_search_items`、`zotero_export_bibtex`、`zotero_fulltext`、`zotero_find_duplicates`、`zotero_write_status`、`zotero_audit`。

**写**（两阶段 prepare/commit）：

| prepare | commit | 用途 |
|---|---|---|
| — | `zotero_authorize_write` | 触发 Zotero 写授权弹窗 |
| `zotero_prepare_import` | `zotero_commit_import` | 批量入库 |
| `zotero_prepare_delete` | `zotero_commit_delete` | 删除条目 |
| `zotero_prepare_merge` | `zotero_commit_merge` | 合并重复条目（转移子项 + 并集标签/分类） |
| `zotero_prepare_reassign` | `zotero_commit_reassign` | 调整分类归属 |
| `zotero_prepare_delete_collection` | `zotero_commit_delete_collection` | 删除空分类 |
| `zotero_cancel_pending` | — | 撤销未提交令牌 |

## 安全模型

- **两阶段确认**：任何写操作先 `prepare_*`，它生成人类可读的计划、`payloadHash` 和一次性令牌（10 分钟 TTL）；**必须把计划展示给用户取得明确同意**，才能 `commit_*`。commit 要求三项同时匹配：token、严格等于 `CONFIRM:<token>` 的短语、同一 payloadHash。
- **哈希链审计**：所有写操作写入 append-only JSONL（`~/.workbuddy/zotero-*-audit.jsonl`），每条记录含前序哈希，`zotero_audit` 可校验完整性。
- **版本前置条件**：PATCH 用 body 的 `version`，DELETE 用 `If-Unmodified-Since-Version` 头，防止覆盖并发修改。
- **合并保数据**：合并按 Zotero 原生语义——附件/笔记全部转移到保留条目，标签/分类取并集，再删副本。不会因删除父条目而丢失附件。

> 已知事实：Zotero 10 本地 API 的 `DELETE` 是**直接删除**，不进入回收站。写操作前请务必备份 `zotero.sqlite` + `-wal` + `-shm` 三个文件（WAL 模式，只拷主文件会丢数据）。

## 已知限制 / 踩坑

- `/items?q=` 的 `q` 参数不可靠，按 DOI 查要用 `qmode=everything` 或遍历建索引。
- 分页 `start` 在 Zotero 同步期间不稳定，判重应用 DOI/标题 → key 映射后数 distinct key。
- 写授权弹窗限流：每分钟最多 5 次，超出返回 429。
- 主线程被占用（同步/模态弹窗）时创建条目会 30 秒超时，而读请求毫秒级返回；先检查 Zotero 前台状态。
- 合并的重复检测按 DOI/规范化标题，不是语义判重，存在假阳性；`zotero_find_duplicates` 只作候选清单，需人工核对。

## License

**GNU GPL v3（或更高版本）**。本仓库全部文件统一采用 GPL-3.0-or-later：

- 完整协议见 [LICENSE](LICENSE)；
- 三个脚本头部带 SPDX 标识 `GPL-3.0-or-later`；
- `skills/zotero-manager/SKILL.md` 的 frontmatter 含 `license` 字段；
- `mcp.json.example` 含 `_license` 元数据字段。

许可含义：允许自由使用、修改与分发；若分发修改版或衍生作品，必须以相同许可开源并保留声明。

### 关于"商用"的重要澄清

GPL-3.0 **不禁止商业使用**。依据 FSF 官方 FAQ，被 GPL 覆盖的程序可以被出售、可以集成进商业产品、可以用作商业服务——只要分发时遵守开源义务（提供源代码、保留许可声明、衍生作品同样以 GPL 授权）。GPL 阻止的是**把代码闭源私有化**，不是"用它赚钱"。

如果你的目标是"禁止他人将此代码用于商业用途"，GPL-3.0 达不到该效果，需要换用含非商业条款的许可，例如：

- **CC BY-NC-SA 4.0**：明确禁止商业使用（但请注意这是为创作作品设计的，用于软件有适配争议，且 NC 的"商业"定义较模糊）；
- **自定义商业许可 / 双许可**：开源版非商用，商用需单独授权（最常见于既要传播又要保留商用权的场景）；
- **AGPL-3.0**：若担心的是他人把代码改作在线服务而不开源源码，AGPL 可覆盖网络使用场景——但它**同样不禁止商用**。

本仓库当前按你的明确选择采用 GPL-3.0-or-later。若"禁止商用"是硬性要求，请告知，我会按上述方向调整许可文件与全部标识。
