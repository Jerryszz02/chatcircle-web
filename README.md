# Chat Circles

Empact 多机构活动管理 / 报名审核 / 签到 / 问卷 / 聆听者培训平台（V1）。

- 前端：React 18 + Vite + TypeScript 单 SPA，按角色路由分区（参与者端 `/`、机构管理端 `/admin`、超级管理端 `/super`，手机优先）
- 后端：PocketBase（认证、API rules、`pb_migrations` 版本化 schema、`pb_hooks` 服务端业务规则、SQLite）
- 部署：Docker Compose 一体化镜像，前端产物由 PocketBase 同源伺服
- 正式域名：`chatcircle.empact.cn`

## 目录结构

```
├── frontend/            # React SPA（src/features/{participant,admin,superadmin} + src/shared/）
├── backend/             # PocketBase：pb_migrations/、pb_hooks/、tests/（集成套件）、scripts/（种子），见 backend/README.md
├── mcp/                 # agent 数据取送 MCP server（取数走导出 API、报告回传 reports 集合），见 mcp/README.md
├── deploy/              # 备份脚本等部署辅助
├── docs/                # PRD 与 planning/ 规划文档（技术设计、数据库设计、测试计划等）
├── .github/workflows/   # CI
├── Dockerfile           # 多阶段：前端 build → PocketBase 运行时
└── docker-compose.yml   # app（PocketBase + 前端产物）+ backup（每日 PB 备份 API 一致性备份，30 天滚动）
```

## 本地开发

前置：Node 22+、python3（后端测试与种子脚本，仅用标准库）。

```sh
# 前端（默认连 http://127.0.0.1:8090，可用 VITE_PB_URL 覆盖）
cd frontend
npm install
npm run dev

# 后端（另开终端；下载 PocketBase 二进制、迁移、超管与种子数据详见 backend/README.md）
cd backend
./pocketbase migrate up --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
./pocketbase superuser create admin@cc.local '换成你自己的强密码' --dir pb_data   # 首次
bash scripts/seed_demo.sh                                                        # 可选：演示种子数据
./pocketbase serve --dir pb_data --migrationsDir pb_migrations --hooksDir pb_hooks
# 健康检查：http://127.0.0.1:8090/api/cc/health → {"ok":true}
```

> ⚠️ 启动 PocketBase 时 `--dir` / `--migrationsDir` / `--hooksDir` 三个参数必须显式传：
> 实测不传会按默认位置解析，加载到错误内容（hooks 不生效 / 用错数据目录）。

## 测试

```sh
# 前端单元/组件测试（Vitest）
cd frontend && npm run test

# 后端集成测试套件（L3，CI 必过；自举临时实例，不污染本地 pb_data）
bash backend/tests/run_integration.sh

# 迁移冒烟（up/down 往返 + API 抽查）
bash backend/tests/migration_smoke.sh
```

## Docker 一键启动

```sh
cp .env.example .env   # 按需修改
docker compose up --build
# 访问 http://localhost:8090（三端同源；管理后台 http://localhost:8090/_/）
```

> 注意：本仓库 Dockerfile / docker-compose.yml 尚未在本机构建验证（开发机无 docker），语法已人工核对；首次在有 Docker 的环境执行 `docker compose up --build` 时请留意构建输出。

## CI

`.github/workflows/ci.yml`（push 到 main 与全部 PR 触发）：

| Job | 内容 |
| --- | --- |
| `frontend` | `npm ci` → lint → typecheck → 单元测试（Vitest）→ build |
| `backend-migrations` | 下载指定版本 PocketBase → 空目录跑通 `migrate up` → `node --check` 全部 `pb_hooks/**/*.pb.js` |
| `backend-integration` | 下载指定版本 PocketBase → `backend/tests/run_integration.sh` 全量集成套件（越权矩阵 AC-03、名额并发 AC-08、状态机 AC-07、签到 AC-09/20、聆听者培训体系、问卷资格、导出 AC-16/17、限流 AC-21、备份告警 AC-23、无硬删除 AC-18） |

三个 job 均为 PR 必过。**建议在 GitHub 仓库创建后为 `main` 配置 branch protection**（Settings → Branches → 要求上述状态检查通过 + 至少 1 人 review，见 test-plan §8 合并门禁）。

## 文档

规划与设计文档入口：[`docs/planning/README.md`](docs/planning/README.md)（技术设计、数据库设计、测试计划、安全隐私细则、PRD v0.1~v0.3）。

## 约定速览

- schema 变更只能经 `backend/pb_migrations/`；业务规则只写在 `pb_hooks/` 与 API rules，前端校验仅是体验层
- 环境差异走环境变量：`.env.example` 入库，真实 `.env` 与 secrets 不入库
- 无硬删除：停用 / 归档 / 作废均以状态表达
