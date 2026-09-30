# 开发与维护文档

新开发者或 agent 从这里接手。本文索引当前仍需维护的资料；代码与测试说明实现，需求规则说明边界，生产结果必须另行核验。

Agent 开始任务前先读根目录 [AGENTS.md](../AGENTS.md)，其中只维护协作与交付规则；技术与业务细节仍按本文索引查阅。

## 中英文入口

| 读者与用途 | 中文 | English |
| --- | --- | --- |
| 项目总介绍 | [README](../README.md) | [README](../README.en.md) |
| Agent 交接与工作规则 | [AGENTS](../AGENTS.md) | [AGENTS](../AGENTS.en.md) |
| 开发者上手 | [开发者指南](developer-guide.md) | [Developer guide](developer-guide.en.md) |
| 机构工作人员 | [机构管理员教程](org-admin-guide.md) | [Organization administrator guide](org-admin-guide.en.md) |
| 平台运营负责人 | [超级管理员教程](super-admin-guide.md) | [Super administrator guide](super-admin-guide.en.md) |

以上五份提供中英文对照；其他专题手册仍使用现有版本。

## 第一次接手

1. 读根目录 [README](../README.md)，了解参与者、机构与平台三类角色。
2. 按[开发者指南](developer-guide.md)启动本地 PocketBase 和前端，理解机构隔离、事务、迁移与前后端分工。
3. 读[业务规则](business-rules.md)，修改账号、报名、签到、问卷或统计前确认不可破坏的约束。
4. 查看[维护待办](maintenance.md)，区分已实现能力、残留风险与待验收事项。
5. 按下表阅读具体领域；提交前执行相关检查，发布前使用[发布清单](release-checklist.md)。

## 按任务查阅

| 任务 | 文档 |
| --- | --- |
| 理解代码、加字段/接口/页面、测试入口 | [开发者指南](developer-guide.md) |
| 确认业务规则、数据口径和权限 | [业务规则](business-rules.md) |
| 修改认证、现场快照、配对、Realtime、导出协议 | [API 契约](api-contracts.md) |
| 修改公开页、路由、元信息与抓取行为 | [公开页 SSR 架构](public-web.md) |
| 启动后端、演示数据、短信配置 | [后端手册](../backend/README.md) |
| 后端集成、越权、迁移与 PB 升级测试 | [后端测试](../backend/tests/README.md) |
| 浏览器主链路回归 | [E2E 测试](../e2e/README.md) |
| MCP 安装、认证、导出与报告上传 | [MCP 手册](../mcp/README.md) |
| 发布验收与真实环境核对 | [发布清单](release-checklist.md) |
| ECS 部署、共享网关、配置与排障 | [部署手册](../deploy/README.md) |
| 本机备份、隔离恢复与邮件告警 | [备份恢复](../deploy/backup-recovery.md) |
| 未来启用异地副本（当前暂缓） | [异地备份](../deploy/offsite-backup.md) |
| 机构日常活动运营 | [机构管理员教程](org-admin-guide.md) |
| 平台机构接入、审批、内容与模板 | [超级管理员教程](super-admin-guide.md) |
| 个人信息请求、期限治理、管理员邮件 | [隐私运营手册](privacy-operations.md) |
| 决定后续维护工作及验证边界 | [维护待办](maintenance.md) |

## 文档维护规则

- 同一事实只设一个主要维护位置，其余文档引用；不另建重复上手指南或已完成任务的计划归档。
- schema/字段以 `backend/pb_migrations/` 为准，前端类型以 `frontend/src/shared/api/` 为准，路由以 router/hooks/Caddy 为准，脚本与 CI 决定实际检查项。不手写固定的文件数、接口数或测试通过总数。
- 功能变更同 PR 更新对应文档；明确区分“仓库实现”“本次验证”和“线上现状”。服务器日志、恢复报告与敏感资料留在受控运维空间。
- 原 `docs/planning/`、早期 Word 设计稿与历史安全修复报告已整合后删除。旧代码注释中的 PRD/FR/AC、T0–T7、M0–M5 和设计章节号仅用于历史追溯；当前规则看业务/API/开发指南，旧内容可用 `git log --all -- <原路径>` 查找，不据此重建过时方案。
