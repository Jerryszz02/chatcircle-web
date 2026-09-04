# T7 集成与发布验收

> 适用范围：`docs/planning/account-event-workflow-prd.md` 中 T0–T6 的整体回归与发布前门禁。
> 维护契约：新增账号、活动、Realtime、配对、导出或生产配置能力时，同 PR 更新本清单与对应自动化门禁。

## 1. 自动化验收

从仓库根目录执行：

```bash
bash scripts/t7-release-acceptance.sh
```

该命令不读取真实 `.env`，也不会部署。它必须全部通过：

1. 生产短信 provider、隐私版本、必填环境变量占位、标准 80/443 Automatic HTTPS、TLS/安全头、管理台封闭与部署预检的静态配置检查；
2. PocketBase hooks 与备份脚本语法检查；
3. 前端 lint、typecheck、Vitest 和生产构建；
4. 空库迁移 up/down/up 冒烟；
5. 后端全量集成套件，其中权限隔离、配对并发、完成率口径、敏感导出与导出行列准确性都是服务端裁判；
6. 360×740 Chromium E2E：手机号登录、姓名必填报名、双角色签到编号、工作台配对、参与者 Realtime 配对更新、问卷和细粒度导出。

PR 还必须等待 GitHub 上 `frontend`、`backend-migrations`、`backend-integration` 和 `e2e` 检查全绿；本地通过不能替代远端门禁。

## 2. 测试环境发布验收

以发布候选 commit 在有 Docker 的隔离测试环境执行，不得使用生产业务数据：

- [ ] `docker compose config -q` 通过，`CC_ENVIRONMENT=production`、`CC_SMS_PROVIDER=aliyun`；手机号 HMAC 密钥长度至少 32 字符；三个场景短信模板变量（`CC_SMS_TEMPLATE_LOGIN_REGISTER_CODE`/`CC_SMS_TEMPLATE_BIND_NEW_CODE`/`CC_SMS_TEMPLATE_VERIFY_BOUND_CODE`）与短信凭据（`ALIBABA_CLOUD_ACCESS_KEY_ID`/`SECRET`、`CC_SMS_SIGN_NAME`）均已注入。
- [ ] 正式生产 Compose 只对外发布 `80:80` 与 `443:443`；没有 `8443`，Caddyfile 使用 `chatcircle.empact.cn` 标准 Automatic HTTPS，不含 `dns alidns` 或 `ALIYUN_ACCESS_KEY_*`。
- [ ] `docker compose build` 和 `docker compose up -d` 通过，app 容器健康检查达 `healthy`（用 `docker inspect` / `docker compose ps` 判定，不依赖宿主机 8090）；生产基础 compose 默认不向 host 发布 app `8090`，只在 Docker 私网供 Caddy/backup 访问；需要本机直连调试时显式叠加 `deploy/docker-compose.debug.yml` 才发布回环 `8090`。
- [ ] 用阿里云测试号码验证发码、错码、过期码、重试、provider 失败和停用账号；日志中无验证码、完整手机号或密钥。
- [ ] 使用机构 A/B 两套账号重跑活动、Realtime、配对、导出越权反例，跨机构资源统一为 404，参与者不能枚举他人配对。
- [ ] 主动中断 Realtime 后恢复，管理工作台与参与者配对卡都显示断线状态并重拉快照自校正。
- [ ] 普通导出不含姓名、完整手机号、自定义敏感字段或敏感问题；敏感导出必须二次确认并产生不含实际敏感值的审计记录。
- [ ] 手工触发一次备份，检查 `last_backup.json` 与 `backup.success`；再在隔离环境完成一次恢复演练并抽查账号、活动、报名、签到、配对、问卷和答卷。

## 3. 真机与生产放行

以下项目不能由 CI 或本地代替，未完成时只能称为“自动化验收通过”，不得称为“已上线验收”：

- [ ] 隐私/合规负责人确认当前隐私文案、必要通知法律基础、保存期限和更正/删除申请通道。
- [ ] 360px 真机微信内置浏览器走通“登录→报名→签到→查看配对→填问卷”，无横向滚动，文字/图标均可识别状态。
- [ ] `chatcircle.empact.cn` DNS 指向目标 ECS；安全组/主机防火墙放行 TCP 80/443；服务器上没有其他进程占用 80/443。
- [ ] 不再需要的服务器 `/opt/chatcircle/docker-compose.override.yml` 已备份并删除；部署 workflow 会对其存在直接 fail-closed。
- [ ] 生产 `https://chatcircle.empact.cn` 可直接访问且 HTTP 自动跳转 HTTPS；HSTS、CSP、`/_/` 403、证书自动续期与真实来源 IP 记录均正常。
- [ ] 旧的 `:8443` 入口在 443 验证成功后从安全组关闭；旧 `ALIYUN_ACCESS_KEY_ID/SECRET` 可从生产 `.env` 删除，不再为 Caddy 保留 DNS RAM 凭据。
- [ ] 短信认证 RAM 权限收窄到号码认证实际所需 Action；`ALIBABA_CLOUD_ACCESS_KEY_ID/SECRET` 可独立轮换且不与其他云服务凭据复用。
- [ ] 部署 workflow 成功、线上 `/api/health` 正常，备份告警无活跃失败；记录发布 commit、时间、验收人和回滚点。

生产操作细节、备份与恢复步骤以 [deploy/README.md](../deploy/README.md) 为准。
