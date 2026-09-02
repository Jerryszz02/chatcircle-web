# Chat Circles E2E 测试（L4 层）

Playwright + Chromium，移动端 viewport 360×740（PRD §13 手机优先）。
覆盖 test-plan §5 主链路（PRD §1.3 端到端成功定义）：

```
公开详情 → 手机号验证码登录 → 姓名必填报名 → 管理员审核通过 → 开放签到
→ 倾诉者/聆听者分别签到并获取 S01/L01 → 现场工作台开始配对
→ 两端 Realtime 更新为 P01 → 问卷 → 我的中心 → 细粒度 CSV ZIP 内容与敏感过滤校验
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
- `tests/main-flow.spec.ts`：主链路串行执行；双参与者独立会话验证现场编号、工作台配对与
  Realtime 参与者卡更新；导出 ZIP 解包断言选中数据域 CSV、manifest/字典、报名/签到/配对/答卷数据，
  并确认姓名、MOOD、wechat_id 与用户名均被普通导出过滤。
- `tests/training-flow.spec.ts`：培训链路（聆听者培训体系）。管理端开放培训签到 → 参与者扫码
  自助签到（重复扫码幂等）→ 培训页「已通过」+ 账号级「已完成聆听者培训」标记 → 管理端名单 →
  撤销 → 恢复「未参加」；负向：无 approved 聆听者报名的参与者扫码显示 listener_not_approved
  引导文案、培训页空态。资格报名挂在独立第二活动（CC_E2E_02）上，避免污染主链路活动的
  审核列表断言；培训签到开放留给 spec 经管理端 UI 操作（与主链路同模式）。
- 断言常量集中在 `seed.mjs` 的 `FIXTURE`，修改 fixture 只需改一处。

## 与测试金字塔的关系

本层只贯通核心链路（test-plan §1「少而精」）；名额并发、越权、状态矩阵等规则断言一律在
L3 服务端集成层，不在此重复。
