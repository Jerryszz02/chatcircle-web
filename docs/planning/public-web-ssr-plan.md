# 公开页 SSR / GEO 部署接入计划（public-web）

> 状态：`进行中`。阶段 A–C（公开渲染核心：`src/public/` 数据层/视图/元信息、`server/` node:http 渲染服务、`build:public` 构建）已在分支 `feat/public-ssr-geo-20260926` 完成并可用；阶段 D（本文，部署接入：镜像、compose、Caddy 路由、CI/deploy 门禁、文档）随本文件落地。
>
> 规划日期：2026-09-27
>
> 用途：记录公开页 SSR 的架构决策、边界与否决方案，作为后续路由/权限变更的评审依据。

## 1. 目标

让公开页（`/`、`/about`、`/privacy`、`/activities`、`/activities/past`、`/a/:id`、`/posts/:id`）的**原始 HTML** 即可被搜索引擎与无 JS 抓取方（含 AI 引用引擎，即 GEO 口径）读到正文、canonical/OG 元信息、JSON-LD 与 robots/sitemap，同时：

- 功能页（登录后的业务界面）保持原 SPA 形态与全部既有安全语义；
- 不放宽任何数据权限（公开页只能读到匿名本就可见的数据）；
- 未知路径返回真实 404（不再 SPA 假 200），功能路径服务端 noindex。

## 2. 决策

**独立渲染服务 public-web + 功能 SPA 保留。**

- 新增 `frontend/server/`（node:http，无框架、无运行时依赖）：SSR 渲染 + `/public-assets/*` 静态资源 + `/robots.txt` + `/sitemap.xml` + 真实 404/503。构建产物 `dist-public/{client,server}`，server bundle 全量打包（`ssr.noExternal`）。
- Caddy 按路径精确分发（单一 `route` 块固定求值顺序，handle 互斥）：公开页/静态资源/爬虫入口 → `public-web:3100`；`/api/*`、`/assets/*` 与功能 SPA 路径 → `app:8090`；`/_/*` 403 保持在路由最前；兜底未知路径 → public-web 回真实 404。
- `/a/:id/register` 是功能页（报名），在 route 内先于公开详情 `/a/*` 命中；Caddy path matcher 无通配符即精确匹配，`/activities` 与 `/activities/past` 并列互不遮蔽。
- 渲染服务与 SPA 共用视图组件（`*View.tsx` 纯展示 + SPA 页面包数据获取），SSR HTML 内嵌 `<script type="application/json" id="__CC_PUBLIC_DATA__">` 首帧数据供 hydrate 复用；该 script 非可执行脚本，CSP 无需放行 inline script。
- 部署接入沿用既有结构：镜像按 `CC_RELEASE_SHA` 标记、预检构建 + 无网络 smoke（`deploy/smoke-public-web-runtime.sh`）、容器健康门禁、OCI revision 绑定；回滚 = 重放上一 SHA，不为 public-web 发明新机制。

## 3. 边界（不得突破）

- **不放宽权限**：公开数据层（`src/public/data.ts`）只调匿名可读的公开端点（`/api/cc/public/*`、`posts` 集合的公开 rule），且所有响应经白名单 mapper 收窄成 DTO——`registration_fields`、`created_by/updated_by`、手机号等字段不得进入公开 HTML。public-web 服务无密钥、不挂 `pb_data` 卷、不发布 host 端口。
- **不引入新基础设施**：不加 Redis/缓存层/消息队列；并发与超时防护用进程内上限（`CC_PUBLIC_MAX_INFLIGHT`、`CC_PUBLIC_FETCH_TIMEOUT_MS`）。SQLite 读压力与站点量级暂不支撑缓存层的复杂度。
- **不做整站 SSG**：见 §4。
- **错误口径**：上游故障 → 503 + `Retry-After: 30`（首页例外：静态介绍仍在时 200，列表区降级为错误态）；内容不存在/不可公开 → 404 通用页，不泄露存在性；sitemap 上游失败 → 503，绝不返回空 sitemap 伪装成功。
- **故障隔离**：caddy 不 depends_on public-web——公开渲染故障只让公开路由 502/503，不得锁死 Caddy 与原业务。

## 4. 否决方案与原因

| 否决方案 | 原因 |
|---|---|
| 一次性静态快照（构建期 SSG 导出 HTML） | 活动/推文是运营期持续变更的数据：构建期快照会在数据变更后长期失真，且需要额外的「变更→重建→发布」通道（当前没有）。SSR 每次渲染实时取数，配合 no-store 与错误降级，口径永远新鲜。 |
| 整站换框架（Next.js/Remix 等 SSR 框架重写） | 现有 SPA（三端路由守卫、PB SDK 会话、Realtime 失效化、看板/导出/配对等）体量大且刚完成上线整改；整站重写风险与工期不可接受，也违反「需求口径以 PRD 为基线」的变更纪律。独立渲染服务只接管公开页，功能页零改动。 |
| 在 PocketBase 进程内做 SSR（pb_hooks 渲染） | JSVM 是隔离作用域的 JS 子集，无 Node API、无 React SSR 生态，hooks 契约禁止引入这种复杂度（见 developer-guide §4/§11）。 |
| prerender 爬虫中间件（检测 UA 回快照） | UA 嗅探双轨服务同 URL 不同内容，既有 SEO 风险也有维护双份渲染路径的负担；SSR 单一口径更稳。 |

## 5. 验证口径

- 无 JS 可读：`curl -s https://chatcircle.empact.cn/ | grep 'rel="canonical"'`、`__CC_PUBLIC_DATA__`、`/robots.txt` 含 Sitemap 行（部署门禁已自动化）。
- 发布配置静态检查：`node deploy/verify-release-config.mjs`（compose 隔离性、Caddy 路由表、XFF 双上游覆盖、noindex、smoke/门禁存在性）。
- 运行时 smoke：CI `public-web-smoke` job 与部署预检共用 `deploy/smoke-public-web-runtime.sh`（无网络/无上游：healthz 200、readyz 503、降级 200 或 503 不挂死、robots 200、未知路径 404）。
