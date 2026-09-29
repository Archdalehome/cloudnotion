# CloudNotion

![Deploy](https://github.com/Archdalehome/cloudnotion/actions/workflows/deploy.yml/badge.svg)

类 Notion 的灵活表格（Database）系统，全部跑在 **Cloudflare Workers + D1 + R2** 上：

- 后端：单个 Worker（`src/worker/index.ts`），自研路由 + D1（SQLite）持久化 + R2 附件存储
- 前端：React 19 + Vite 单页应用（`src/client`），构建产物由 Workers 静态资源（Assets）托管，`/api/*` 优先交给 Worker，其余走 SPA fallback
- 无第三方运行时依赖（除 React），无 ORM，SQL 直写

## 功能

| 模块 | 说明 |
| --- | --- |
| 账号 | 邮箱 + 密码注册/登录/登出，HttpOnly Cookie 会话（DB 只存 token 哈希） |
| 表格 | 多表格（Database）管理、图标/描述、模板创建、软删除归档 |
| 字段 | 16 种字段类型（文本/数字/单选/多选/状态/日期/勾选/链接/邮箱/电话/附件/创建时间/更新时间/创建人/更新人），可重命名、改宽、拖动排序、类型转换时清洗数据；表头 `▾` 菜单支持「编辑 / 升序 / 降序 / 添加筛选 / 在右侧插入 / ← → 左右移动该列 / 隐藏字段 / 锁定字段 / 删除字段」 |
| 记录 | 新建/编辑/删除、批量创建、批量删除、复制记录、分页（`limit`/`offset`）、乐观更新 + 失败回滚 |
| 视图 | 表格 / 看板 / 画廊三种视图，支持筛选（and/or、多条件）、排序（多键）、分组、隐藏字段、行高/卡片大小，全部配置存 D1 |
| 协作 | 邀请已注册用户为 `editor`/`viewer`，改角色、移除；所有者始终排在成员列表首位且不可被移除 |
| 锁定 | 三层只读控制：**表格锁定**（隐藏表头 `▾` 菜单与 `＋字段` 列、表头不可点开修改窗口，字段与视图结构只读）、**视图锁定**（名称 / 筛选 / 可见字段不可改，不可删除）、**字段锁定**（表头 `▾` 菜单里锁定，该字段所有记录只能查看，编辑与附件上传都会被服务端拒绝） |
| 分享 | 生成只读 / 可编辑公开链接（可设 7/30/90 天过期），`/share/:token` 免登录访问，写操作走 `/api/public/*` |
| 附件 | 上传到 R2（默认上限 25MB，`MAX_UPLOAD_MB` 可调），元数据存 `files` 表 |

## 目录结构

```
src/
  shared/     前后端共享：types.ts(类型)、fields.ts(字段元数据/校验/格式化)、views.ts(视图配置)、templates.ts(表格模板)
  worker/     Worker 后端
    index.ts   入口：路由分发、错误处理、静态资源
    http.ts    json/readJson/参数校验/错误构造等工具
    auth.ts    Cookie 会话、密码哈希、requireUser
    access.ts  表格访问级别判定（view/edit/manage）
    mappers.ts D1 行 -> API 类型
    routes/    auth / databases / properties / records / views / public / files
  client/     React SPA
    App.tsx            会话 + 表格列表 + `/share/:token` 路由
    api.ts             fetch 封装（cookie、ApiError、typed 响应）
    components/        AuthPage Sidebar DatabasePage PublicPage TableGrid CardViews
                       Cell RecordDialog PropertyDialog ViewBar SharePanel Modal Popover
    lib/viewEngine.ts  前端筛选/排序/分组计算
scripts/
  check-routes.mjs  路由静态检查（重复/处理器缺失/公开端点）
  smoke-test.mjs    端到端冒烟测试（45 项断言，失败时退出码 1）
migrations/
  0001_init.sql     D1 初始化迁移
```

## 快速开始

```bash
npm install

# 1. 本地 D1 建表（会写入 .wrangler/state，本地开发不需要真实 database_id）
npm run db:migrate:local

# 2. 构建前端 + 启动 Worker（http://127.0.0.1:8787）
npm run dev
```

- `npm run dev:web`：只跑 Vite 前端（`/api` 需代理到 Worker，见 `vite.config.ts`）
- `npm run typecheck`：`tsconfig.client.json` + `tsconfig.worker.json` 全量类型检查
- `npm run check:routes`：路由自检（当前 35 条路由）
- `npm run test:e2e`：对运行中的 Worker 跑端到端冒烟测试

```bash
# 端到端验证（另开一个终端，先 npm run dev）
node scripts/smoke-test.mjs
BASE_URL=https://cloudnotion.example.workers.dev node scripts/smoke-test.mjs
```

冒烟测试覆盖：健康检查 → 注册/会话 → 建表建字段 → 记录增删改查/批量/复制 → 视图增改删 → 分享链接（只读拒写、可编辑可写）→ 成员邀请/改权/移除/所有者保护 → R2 上传下载 → 清理。

## 数据模型

- `users` / `sessions`：账号与会话（`sessions.token_hash` 唯一）
- `databases`：一张表格；`database_members`：受邀协作者（`role` = editor/viewer）
- `properties`：字段定义（`type` + `config` JSON + `position` REAL 排序 + `is_locked` 字段级锁定）
- `records`：一行记录，`"values"` 字段存 `{ 字段id: 值 }` JSON 文本，`position` REAL 排序
  > 注意：`values` 是 SQLite 保留字，SQL 里必须写成 `"values"`（迁移与 `routes/*.ts` 均已加引号）
- `views`：视图（`type` + `config` JSON：filters/sorts/groupBy/visibleProperties/rowHeight/cardSize…）
- `shares`：公开分享链接（`token` 唯一、`permission`、`expires_at`）
- `files`：R2 对象元数据（`r2_key`、名称、大小、MIME）

## API 一览

```
POST   /api/auth/register | /api/auth/login | /api/auth/logout
GET    /api/session
GET    /api/databases              POST /api/databases
GET|PATCH|DELETE /api/databases/:id
POST   /api/databases/:id/members
POST   /api/databases/:id/properties
GET|POST /api/databases/:id/records
POST   /api/databases/:id/records/bulk | /records/duplicate | /records/delete
GET    /api/databases/:id/rows            （按视图分页取行）
POST   /api/databases/:id/shares
POST   /api/databases/:id/views
PATCH|DELETE /api/views/:id
PATCH|DELETE /api/properties/:id
PATCH|DELETE /api/records/:id
PATCH|DELETE /api/members/:id
DELETE /api/shares/:id
POST   /api/files   GET|DELETE /api/files/:id
GET    /api/public/:token
POST   /api/public/:token/records
PATCH|DELETE /api/public/:token/records/:recordId
GET    /api/health
```

## 部署

见 [DEPLOY.md](./DEPLOY.md)（创建 D1 / R2、替换 `wrangler.jsonc` 中的 `database_id`、远程迁移、`npm run deploy`）。

### 自动部署（GitHub Actions）

`.github/workflows/deploy.yml`：**push 到 `main` 自动部署**，PR 只做校验（不会部署）。

```
verify   npm ci -> npm run typecheck -> npm run check:routes -> vite build
e2e      本地 D1 迁移 -> wrangler dev --local -> scripts/smoke-test.mjs（45 项断言）
deploy   校验 D1 id -> 确保 R2 桶 -> 远程 D1 迁移 -> vite build -> wrangler deploy -> 线上 45 项冒烟测试
```

只需在仓库 `Settings → Secrets and variables → Actions` 配置：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | ✅ | API 令牌（Workers Scripts / D1 / R2 编辑权限） |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Cloudflare 账户 ID |
| `D1_DATABASE_ID` | ➖ | 可选，填了会自动替换 `wrangler.jsonc` 中的占位 `database_id` |

未配置 `CLOUDFLARE_*` 时会安全跳过部署并给出 warning；详细步骤与权限清单见 [DEPLOY.md 第 6 节](./DEPLOY.md)。
