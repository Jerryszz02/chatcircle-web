# Chat Circles

Empact 多机构活动管理 / 报名审核 / 签到 / 问卷平台（V1，M0 技术骨架阶段）。

- 前端：React 18 + Vite + TypeScript 单 SPA，按角色路由分区（参与者端 `/`、机构管理端 `/admin`、超级管理端 `/super`，手机优先）
- 后端：PocketBase（认证、API rules、`pb_migrations` 版本化 schema、`pb_hooks` 服务端业务规则、SQLite）
- 部署：Docker Compose 一体化镜像，前端产物由 PocketBase 同源伺服
- 正式域名：`chatcircle.empact.cn`

## 目录结构

```
├── frontend/            # React SPA（src/features/{participant,admin,superadmin} + src/shared/）
├── backend/             # PocketBase：pb_migrations/、pb_hooks/、tests/（见 backend/README.md）
├── deploy/              # 备份脚本等部署辅助
├── docs/                # PRD 与 planning/ 规划文档（技术设计、数据库设计、测试计划等）
├── .github/workflows/   # CI
├── Dockerfile           # 多阶段：前端 build → PocketBase 运行时
└── docker-compose.yml   # app（PocketBase + 前端产物）+ backup（占位）
```

## 本地开发

前置：Node 22+。

```sh
# 前端（默认连 http://127.0.0.1:8090，可用 VITE_PB_URL 覆盖）
cd frontend
npm install
npm run dev

# 后端（另开终端；下载 PocketBase 二进制后启动，详见 backend/README.md）
cd backend
./pocketbase serve --dir pb_data
# 健康检查：http://127.0.0.1:8090/api/cc/health → {"ok":true}
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

两个 job 均为 PR 必过。**建议在 GitHub 仓库创建后为 `main` 配置 branch protection**（Settings → Branches → 要求上述状态检查通过 + 至少 1 人 review，见 test-plan §8 合并门禁）。

## 文档

规划与设计文档入口：[`docs/planning/README.md`](docs/planning/README.md)（技术设计、数据库设计、测试计划、安全隐私细则、PRD v0.1~v0.3）。

## 约定速览

- schema 变更只能经 `backend/pb_migrations/`；业务规则只写在 `pb_hooks/` 与 API rules，前端校验仅是体验层
- 环境差异走环境变量：`.env.example` 入库，真实 `.env` 与 secrets 不入库
- 无硬删除：停用 / 归档 / 作废均以状态表达
