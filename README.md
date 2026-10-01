# CloudNotion

![Deploy](https://github.com/Archdalehome/cloudnotion/actions/workflows/deploy.yml/badge.svg)

类 Notion 的灵活表格（Database）系统，全部跑在 **Cloudflare Workers + D1 + R2** 上：

- 后端：单个 Worker（`src/worker/index.ts`），自研路由 + D1（SQLite）持久化 + R2 附件存储
- 前端：React 19 + Vite 单页应用（`src/client`），构建产物由 Workers 静态资源（Assets）托管，`/api/*` 优先交给 Worker，其余走 SPA fallback
- 无第三方运行时依赖（除 React），无 ORM，SQL 直写

## 功能

| 模块 | 说明 |
| --- | --- |
| 账号 | 邮箱 + 密码注册/登录/登出，HttpOnly Cookie 会话（DB 只存 token 哈希）；用户名 / 邮箱 / 退出平时在侧边栏底部，侧边栏收起（手机端抽屉关闭）时挪到右上角顶部条 |
| 表格 | 多表格（Database）管理、图标/描述、**新建即空白表格**（只有「名称」字段，弹窗里不再让用户挑模板）、软删除归档 |
| 字段 | 16 种字段类型（文本/数字/单选/多选/状态/日期/勾选/链接/邮箱/电话/附件/创建时间/更新时间/创建人/更新人），可重命名、改宽、拖动排序、类型转换时清洗数据；表头 `▾` 菜单支持「编辑 / 升序 / 降序 / 添加筛选 / 在右侧插入 / ← → 左右移动该列 / 隐藏字段 / 锁定字段 / 删除字段」；**升序 / 降序是单键排序**：视图里只保留一条排序规则，对某个字段升 / 降序会自动取消其他字段的排序，当前排序字段在表头显示 ↑ / ↓；表格末尾不再显示「＋ 字段」列，新增字段统一走表头 `▾` 菜单的「＋ 在右侧插入」 |
| 记录 | 新建/编辑/删除、批量创建、批量删除、复制记录、分页（`limit`/`offset`）、乐观更新 + 失败回滚；行末的「复制记录 / 删除记录」操作列已移除，复制 / 删除统一走**批量操作栏（已选 N 条 / 复制 / 删除 / 取消选择）**，它显示在「＋ 新建筛选」后面的视图工具栏里；行首的方框列不再吸边，跟着表格一起左右滚动 |
| 视图 | **新建视图固定为表格类型**（弹窗里不再让用户选类型；表格 / 看板 / 画廊三种类型依然都能正常渲染，看板、画廊来自示例数据或历史数据），支持筛选（**按「必须满足」块分组**：「＋ 添加必须满足块」可以加任意多个块，块与块之间是「且」；每个块里用「＋ 添加任意满足」加任意多条条件，命中任意一条就算这一块通过。所以 `(A 或 B) 且 (C 或 D)` = 块 1（A / B 任意满足）+ 块 2（C / D 任意满足）。老视图只带视图级 `conjunction` 时行为不变：`or` = 单块全「或」，`and` = 每条各成一块）、排序（单键）、分组、隐藏字段、行高/卡片大小，全部配置存 D1 |
| 协作 | 成员分为 `editor`/`viewer`，所有者始终排在成员列表首位且不可被移除（邀请 / 改角色 / 移除的接口保留在后端，界面已移除管理入口） |
| 锁定 | 两层只读控制：**视图锁定**（名称 / 筛选 / 可见字段不可改，不可删除）、**字段锁定**（表头 `▾` 菜单里锁定，该字段所有记录只能查看，编辑与附件上传都会被服务端拒绝）。表级「表格锁定」已移除：`PATCH /api/databases/:id` 里的 `locked` 会被忽略，字段与视图结构只受访问权与定向分享限制 |
| 分享 | **视图定向分享**：把单个视图（含它的筛选与可见字段）分享给已注册账号，打开面板的入口是视图工具栏的「分享」；公开链接 `/share/:token`（只读 / 可编辑、可设 7/30/90 天过期，写操作走 `/api/public/*`）接口保留，界面已移除生成入口 |
| 附件 | 上传到 R2（默认上限 25MB，`MAX_UPLOAD_MB` 可调），元数据存 `files` 表 |
| 备注 | 记录卡片底部的备注**只增不改**（后端不提供修改 / 删除备注的接口，输入框旁也有提示）；输入 `@` 可提醒协作者——**表格所有者、表格成员、以及被定向分享视图的访客**彼此之间都能互相 @（公开链接的匿名访客没有身份，不在此列）；被 @ 的人会在左上角收件箱（灰色单色图标 + 红点数字）收到一条私信，点开即已读并跳到那条备注（高亮定位）；**跳转时会先把这条记录同步到最新再打开卡片**（走 `GET /api/records/:id`，只取一条记录，不受分页限制），卡片开着期间每 20 秒、以及切回标签页时再同步一次，所以别人刚加的备注 / 刚改的单元格不用刷新页面就能看到；@ 不到自己与表格外的人，单条备注最多 50 人 |

## 目录结构

```
src/
  shared/     前后端共享：types.ts(类型)、fields.ts(字段元数据/校验/格式化)、views.ts(视图配置)、templates.ts(表格模板，仅后端建表/示例数据使用；前端新建表格固定 blank)
  worker/     Worker 后端
    index.ts   入口：路由分发、错误处理、静态资源
    http.ts    json/readJson/参数校验/错误构造等工具
    auth.ts    Cookie 会话、密码哈希、requireUser
    access.ts  表格访问级别判定（view/edit/manage）
    mappers.ts D1 行 -> API 类型
    routes/    auth / databases / properties / records / views / public / files / notes
  client/     React SPA
    App.tsx            会话 + 表格列表 + `/share/:token` 路由
    api.ts             fetch 封装（cookie、ApiError、typed 响应）
    components/        AuthPage Sidebar DatabasePage PublicPage TableGrid CardViews
                       Cell RecordDialog PropertyDialog ViewBar SharePanel Modal Popover
                       InboxButton UserChip FilterPanel
    lib/viewEngine.ts  前端筛选/排序/分组计算
    lib/time.ts        相对时间 / 精确时间的格式化
scripts/
  check-routes.mjs  路由静态检查（重复/处理器缺失/公开端点）
  smoke-test.mjs    端到端冒烟测试（失败时退出码 1）
migrations/
  0001_init.sql     D1 初始化迁移
  ...               0002-0005：视图定向分享 / 字段锁定 / 分享限制编辑等增量迁移
  0006_notes.sql    记录备注（notes）+ @提醒私信（note_mentions）
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
- `npm run check:routes`：路由自检（当前 40 条路由）
- `npm run test:e2e`：对运行中的 Worker 跑端到端冒烟测试

```bash
# 端到端验证（另开一个终端，先 npm run dev）
node scripts/smoke-test.mjs
BASE_URL=https://cloudnotion.example.workers.dev node scripts/smoke-test.mjs
```

冒烟测试覆盖：健康检查 → 注册/会话 → 建表建字段 → 记录增删改查/批量/复制 → 视图增改删（含表级锁定参数被忽略的回归断言）→ 分享链接（只读拒写、可编辑可写）→ 成员邀请/改权/移除/所有者保护 → 备注 + @提醒私信（收件箱未读/已读、所有者 ↔ 定向分享访客互相 @、单条记录同步接口）→ R2 上传下载 → 清理。

## 数据模型

- `users` / `sessions`：账号与会话（`sessions.token_hash` 唯一）
- `databases`：一张表格；`database_members`：受邀协作者（`role` = editor/viewer）
- `properties`：字段定义（`type` + `config` JSON + `position` REAL 排序 + `is_locked` 字段级锁定）
- `records`：一行记录，`"values"` 字段存 `{ 字段id: 值 }` JSON 文本，`position` REAL 排序
  > 注意：`values` 是 SQLite 保留字，SQL 里必须写成 `"values"`（迁移与 `routes/*.ts` 均已加引号）
- `views`：视图（`type` + `config` JSON：filters/sorts/groupBy/visibleProperties/rowHeight/cardSize…）
- `shares`：公开分享链接（`token` 唯一、`permission`、`expires_at`）
- `files`：R2 对象元数据（`r2_key`、名称、大小、MIME）
- `notes`：记录备注（评论），**只增不改**（没有 update / delete 语句与接口）
- `note_mentions`：备注里 @ 到的人 → 收件箱私信；`read_at` 为 NULL 表示未读（就是红点里的数字）

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
GET    /api/records/:id                    （单条记录同步：值 + 备注 + 已用格子）
POST   /api/records/:id/notes              （备注只增不改：没有修改 / 删除接口）
GET    /api/inbox                          （未读私信列表 + 红点数字）
POST   /api/inbox/:id/read                 （点开一条私信 → 已读）
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
e2e      本地 D1 迁移 -> wrangler dev --local -> scripts/smoke-test.mjs（46 项断言）
deploy   校验 D1 id -> 确保 R2 桶 -> 远程 D1 迁移 -> vite build -> wrangler deploy -> 线上 46 项冒烟测试
```

只需在仓库 `Settings → Secrets and variables → Actions` 配置：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | ✅ | API 令牌（Workers Scripts / D1 / R2 编辑权限） |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | Cloudflare 账户 ID |
| `D1_DATABASE_ID` | ➖ | 可选，填了会自动替换 `wrangler.jsonc` 中的占位 `database_id` |

未配置 `CLOUDFLARE_*` 时会安全跳过部署并给出 warning；详细步骤与权限清单见 [DEPLOY.md 第 6 节](./DEPLOY.md)。
