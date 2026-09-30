# 发布验收清单

用于每次候选版本，不预先勾选历史结果。记录完整 commit SHA、检查链接、时间、验收人及恢复点；新增账号、现场、导出或部署能力时同 PR 更新相关检查。当前待办见 [maintenance.md](maintenance.md)。

## 1. 自动化与 PR

- [ ] 按[开发指南](developer-guide.md#9-测试与-ci)运行变更涉及的最小检查，新增接口同步越权/业务回归用例。
- [ ] 候选 PR 的 CI 与 E2E 全部通过；包含依赖审计、MCP 安装和 backup/public-web Docker smoke。以实际 workflow jobs 为准，不用过去通过数代替结果。
- [ ] schema 变更验证迁移和存量数据兼容；PB 升级执行[升级测试](../backend/tests/README.md#pocketbase-升级兼容性)。
- [ ] 审查文档/配置链接和 `git diff --check`，确认没有生产数据、密钥或临时产物进入提交。

可选统一入口（先安装 frontend/e2e 依赖、Playwright Chromium、PocketBase 和 OSV-Scanner）：

```sh
bash scripts/t7-release-acceptance.sh
```

该脚本不读取真实 `.env`，也不部署；覆盖配置、Python 备份测试、hooks 语法、前端、生产依赖审计、迁移、后端集成和 E2E。它没有包含全部 CI jobs，例如 MCP 安装与 Docker smoke，不能单凭脚本成功跳过远端检查。

## 2. 候选版本与恢复准备

- [ ] 核对 `.env.example` 与[部署手册](../deploy/README.md)：稳定的手机号 HMAC key、专用备份 key、生产 provider 和三个短信场景模板齐备；生产禁用 mock。
- [ ] 审查新增迁移的可逆范围；保留匹配的代码/镜像、数据库、HMAC key、SMTP 配置、共享 Caddy 站点与证书。普通数据库 ZIP 不包含全部外部配置。
- [ ] 不把 migrate down 当完整回滚：姓名业务字段与管理员邮件模板等存在保留语义；旧前端恢复时须核对验证/重置链接和告知版本。
- [ ] 在隔离环境检查机构 A/B 越权、失效账号/旧 token、配对并发、Realtime 断线恢复、敏感导出行列与问卷统计。
- [ ] 镜像/权限/备份改动完成[隔离恢复演练](../deploy/backup-recovery.md)，匹配快照代码版本，核对 SQLite、业务表、上传文件和权限，记录报告位置。

## 3. 部署与线上回读

- [ ] Deploy 使用同一完整 SHA 的成功 main push CI。E2E 独立确认；workflow 不自动等待它。
- [ ] 核对服务器本地修改、遗留 override、在途运维任务和共享 Empact 网关；配置迁移先备份和验证，不覆盖未知现场改动。
- [ ] 候选预检与部署前一致性备份通过，再切换；app、backup、public-web revision 与目标 SHA 相同，服务健康。
- [ ] 公开 `https://chatcircle.empact.cn/api/cc/health` 成功，首页原始 HTML 含 canonical 与 `__CC_PUBLIC_DATA__`，robots/sitemap 正常，未知路径返回 404，功能页 noindex。
- [ ] HTTP 跳转 HTTPS，TLS/安全头正常；PocketBase 管理台 `/_/` 与内部 `/api/cc/internal/*` 不对公网开放。共享 `empact.cn` 同时可访问。
- [ ] 新运行时实际备份成功：marker、归档/侧车、`check-backup.py`、后台告警均一致；默认本机最近 2 份，份数不等于天数。
- [ ] 宿主机备份监控 timer 正常；涉及告警改动时验证故障/恢复邮件，并由收件人确认收到。整机故障监控与异地恢复仍需单独闭环。

Deploy 没有自动回滚，且会拒绝不满足快进条件的旧 SHA。异常处理见部署/恢复手册；不要只切 Git 再启动旧代码读取已迁移数据库。

## 4. 真机与运营验收

- [ ] 使用授权测试账号走完：微信活动链接 → 注册/登录 → 姓名必填报名 → 审核 → 双角色签到与配对 → 问卷 → 导出；360px 无横向滚动，键盘与错误提示可用。
- [ ] 真实阿里云发码覆盖登录/注册、首次绑定/换绑新号、旧号验证；mock 通过不证明真实收码。
- [ ] 运营自有邮箱走通验证 → OTP 登录 → 找回 → 新密码成功/旧密码拒绝，检查垃圾邮件及失效链接；SMTP 接受不等于收件箱送达。
- [ ] 隐私告知版本、处理主体、联系邮箱、备案展示与当前运营口径一致；个人信息请求有人处理，期限治理按[运营手册](privacy-operations.md)落实。
- [ ] 首次启用或变更异地备份时，按[异地备份手册](../deploy/offsite-backup.md)验证实际副本、告警与恢复；未选目的地时记录为暂缓，不把它勾成完成。

生产配置、真机体验和收件确认未核验时，只报告实际已完成的层次，不将 CI 通过表述为线上验收完成。
