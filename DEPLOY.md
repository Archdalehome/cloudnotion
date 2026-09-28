# 部署指南（Cloudflare Workers + D1 + R2）

## 0. 前置条件

- Node.js 20+，`npm install` 已完成
- 已登录 Cloudflare：`npx wrangler login`
- 账号需可创建 Workers / D1 / R2 资源

## 1. 创建 D1 数据库并回填 `database_id`

`wrangler.jsonc` 中默认是占位值 `00000000-0000-0000-0000-000000000000`（本地 `--local` 开发可用，部署时**必须**替换）：

```bash
npx wrangler d1 create cloudnotion-db
```

命令会打印类似：

```
[[d1_databases]]
binding = "DB"
database_name = "cloudnotion-db"
database_id = "1234abcd-....-........"   # 复制这一行
```

把 `database_id` 填回 `wrangler.jsonc` 的 `d1_databases[0].database_id`。

## 2. 创建 R2 桶

```bash
npx wrangler r2 bucket create cloudnotion-files
```

> 桶名要与 `wrangler.jsonc` 里 `r2_buckets[0].bucket_name` 一致，改名时同步修改。

## 3. 应用迁移

```bash
npm run db:migrate:remote      # wrangler d1 migrations apply cloudnotion-db --remote
```

本地开发用 `npm run db:migrate:local`。迁移文件是幂等的（`CREATE TABLE IF NOT EXISTS`），
可安全重复执行；新增迁移时按 `migrations/0002_xxx.sql` 命名即可被自动识别。

## 4. 构建并部署

```bash
npm run deploy                 # vite build && wrangler deploy
```

部署成功后会得到 `https://cloudnotion.<your-subdomain>.workers.dev`（`workers_dev: true`）。
自定义域名：在 Cloudflare 控制台为 Worker 添加 Custom Domain，或在 `wrangler.jsonc` 增加 `routes`。

### 可选环境变量（`wrangler.jsonc` → `vars`）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APP_NAME` | `CloudNotion` | 前端标题 / 健康检查返回的名称 |
| `MAX_UPLOAD_MB` | `25` | 单文件上传上限（MB） |
| `ALLOW_SIGNUP` | `true` | 设为 `"false"` 关闭公开注册（已有账号仍可登录） |

## 5. 部署后验证

```bash
# 冒烟测试（45 项断言，覆盖注册/建表/记录/视图/分享/成员/附件）
BASE_URL=https://cloudnotion.<your-subdomain>.workers.dev node scripts/smoke-test.mjs

# 路由自检
npm run check:routes
```

浏览器检查：

1. `/` 打开后注册账号，应自动创建一张入门表格
2. 建表 → 加字段 → 加记录 → 切换表格/看板/画廊视图并设置筛选、排序、分组
3. 分享面板生成「只读」链接，用无痕窗口打开 `/share/<token>` 应只能查看；生成「可编辑」链接应能新增/修改/删除记录
4. 上传一个附件字段文件，刷新后仍可下载（验证 R2 绑定）

## 6. GitHub Actions 自动部署（CI/CD）

仓库内置 `.github/workflows/deploy.yml`：**push 到 `main` 即自动部署**；PR 只跑校验与冒烟测试，绝不部署。

| 阶段 | Job | 内容 |
| --- | --- | --- |
| 1 | `verify` | `npm ci` → `npm run typecheck`（client + worker）→ `npm run check:routes` → `vite build` |
| 2 | `e2e` | 本地 D1 迁移 → 后台启动 `wrangler dev --local` → 运行 `scripts/smoke-test.mjs`（45 项断言） |
| 3 | `deploy` | 校验 D1 id → 确保 R2 桶 → `npm run db:migrate:remote` → `vite build` → `wrangler deploy` → 对线上地址跑一遍 45 项冒烟测试 |

### 6.1 一次性配置 Secrets

仓库 `Settings → Secrets and variables → Actions → New repository secret`：

| Secret | 必填 | 说明 |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | ✅ | Cloudflare API 令牌，权限见下 |
| `CLOUDFLARE_ACCOUNT_ID` | ✅ | `npx wrangler whoami` 里的 Account ID |
| `D1_DATABASE_ID` | ➖ | 可选。填了就不必把真实 id 提交进 `wrangler.jsonc`，工作流会自动替换占位符 |

创建 Token：Cloudflare 控制台 → My Profile → API Tokens → Create Token → 选「Edit Cloudflare Workers」模板，并确保含：

- Account · Workers Scripts · Edit
- Account · D1 · Edit
- Account · Workers R2 Storage · Edit
- Account · Account Settings · Read

未配置 `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` 时，`deploy` job 会输出 warning 并**跳过部署**（校验与冒烟测试照常跑），流水线不会变红。

> ⚠️ 若日志在「应用远程 D1 迁移」步骤报 `Authentication error [code: 10000]`，说明 Token 少了 `Account · D1 · Edit`——缺这个权限时连 `npx wrangler d1 list` 都会返回 401（工作流现在会对这种失败输出专门的错误提示，不会只丢一段原始日志）。

### 6.2 首次部署前必须做的一步

`wrangler.jsonc` 的 `database_id` 还是占位符时，流水线会在 `deploy` 阶段以清晰错误停下。二选一：

```bash
# 方案 A：本地创建后回填 wrangler.jsonc 并提交
npx wrangler d1 create cloudnotion-db
# 方案 B：不改代码，把 id 存成 GitHub Secret：D1_DATABASE_ID
```

也可以在 Cloudflare 控制台 **Storage & Databases → D1 SQL Database → Create** 建库（数据库名必须填 `cloudnotion-db`，工作流是按这个名字执行迁移的），再把列表里的 **Database ID** 回填到 `wrangler.jsonc` 的 `database_id`，或存成 `D1_DATABASE_ID` Secret（工作流会校验其 UUID 格式）。

R2 桶无需手动建，工作流会执行 `wrangler r2 bucket create cloudnotion-files`（已存在则跳过）。

### 6.3 手动触发 / 跳过迁移

Actions → Deploy → Run workflow，可勾选：

- `skip_migrations`：只重新部署代码，不动数据库
- `skip_online_smoke`：跳过部署后的线上冒烟测试（临时排障用）

### 6.4 状态徽章

```md
![Deploy](https://github.com/Archdalehome/cloudnotion/actions/workflows/deploy.yml/badge.svg)
```

### 6.5 本地复现 CI 全流程

```bash
npm ci
npm run typecheck ; npm run check:routes ; npm run build:client
npm run db:migrate:local
npx wrangler dev --port 8787 --local    # 另开一个终端保持运行
node scripts/smoke-test.mjs             # 期望 45/45 checks passed
```

## 7. 常见问题

| 现象 | 处理 |
| --- | --- |
| 部署报 `database_id` 无效 | 第 1 步未替换占位符，或换账号后 id 失效 |
| `no such table` | 未执行远程迁移：`npm run db:migrate:remote` |
| 上传报错 / 404 | R2 桶未创建或 `bucket_name` 不一致 |
| `near "values": syntax error` | SQL 中把 `values` 当作列名未加引号；本仓库已统一写成 `"values"` |
| 前端 404 / 空白 | 忘记 `vite build`：`npm run deploy` 会自动构建，勿只跑 `wrangler deploy` |
| 想回滚 | `npx wrangler rollback`（选择上一个版本，见 `npx wrangler deployments list`） |

## 8. 数据备份

```bash
# 导出线上库（SQL 文本）
npx wrangler d1 export cloudnotion-db --remote --output backup.sql
```
