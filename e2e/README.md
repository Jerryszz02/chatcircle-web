# Chat Circles E2E 测试（L4 层）

Playwright + Chromium，移动端 viewport 360×740（PRD §13 手机优先）。
覆盖 test-plan §5 主链路（PRD §1.3 端到端成功定义）：

```
公开详情 → 自动注册 → 报名 → 管理员审核通过 → 开放签到 → 自助签到（重复扫码幂等）
→ 管理员从模板创建并开放问卷 → 参与者提交问卷 → 我的中心查看 → 管理员导出 ZIP 并校验内容
```

## 运行方式

```bash
cd e2e
npm install
npx playwright install chromium   # 首次
npm test                          # 环境自举：迁移+fixture+PocketBase+vite preview，跑完自动停止
```

前置条件：

- `backend/pocketbase` 二进制存在（或用 `PB_BINARY=/path/to/pocketbase` 指定；CI 下载 linux 版注入）；
- 本机有 `sqlite3` CLI（模板 fixture 直插用，macOS/ubuntu 自带）；
- `frontend/` 依赖已安装（`npm ci`，构建在环境脚本内自动执行）。

调试：

```bash
npm run env:start   # 只起环境不跑测试（驻留进程），随后可 npm run test -- --ui 或手工访问
npm run env:stop    # 停止环境
npm run test:headed # 有头模式
npm run report      # 查看 HTML 报告
```

环境变量：`E2E_PB_PORT`（默认 18090）、`E2E_WEB_PORT`（默认 14173）、`E2E_SKIP_BUILD=1`（复用 frontend/dist 跳过构建）。

## 结构与数据隔离

- `scripts/env.mjs`：起停脚本。每次运行重建 `.runtime/`（全新临时 pb_data → 顺序应用全部
  `backend/pb_migrations` → 创建 E2E 超级管理员 → 注入 fixture → 启动 PocketBase(挂 `pb_hooks`)
  → 构建前端 → vite preview），与本地开发库完全隔离，可重复跑。
- `scripts/seed.mjs`：最小 fixture。模板+版本因必填循环引用（迁移 12 注释）经 SQL 直插，
  其余（机构/报名字段/邀请码/管理员/已发布活动）全部走真实 API。
  TODO(待统一)：`backend/scripts/` 标准种子脚本就绪后改调之。
- `tests/main-flow.spec.ts`：主链路单测串行执行；导出 ZIP 解包断言 13 个 CSV、
  报名/签到/答卷记录在案、敏感字段（MOOD 题、wechat_id 字段、用户名）已过滤（AC-16/FR-EXP-002）。
- 断言常量集中在 `seed.mjs` 的 `FIXTURE`，修改 fixture 只需改一处。

## 与测试金字塔的关系

本层只贯通核心链路（test-plan §1「少而精」）；名额并发、越权、状态矩阵等规则断言一律在
L3 服务端集成层，不在此重复。
