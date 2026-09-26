# syntax=docker/dockerfile:1
# Chat Circles 公开页渲染服务镜像：公开页 SSR + /public-assets 静态资源 + robots/sitemap。
#
# 职责边界（安全口径见 docs/planning/public-web-ssr-plan.md）：
#   只渲染「已公开」的数据（活动广场/详情、公开推文、静态介绍页），上游仅调用匿名可读的
#   /api/cc/public/* 与 posts 集合（服务端 API rules 已收窄）；镜像内没有任何密钥、
#   不挂 pb_data 卷、不接触业务数据库。运行配置仅 PORT / CC_SITE_ORIGIN /
#   CC_PB_INTERNAL_URL / CC_PUBLIC_FETCH_TIMEOUT_MS / CC_PUBLIC_MAX_INFLIGHT（均非密钥）。

# ---- stage 1: 构建 dist-public（client 产物 + server bundle）----
FROM node:22-alpine AS public-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# 公开页构建独立于主 SPA（npm run build）：只产出 dist-public/{client,server}
RUN npm run build:public

# ---- stage 2: 运行时 ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
# server bundle 已全量打包（ssr.noExternal），运行时无需 node_modules；
# 仅需 server/index.js（入口 + 渲染）与 client/（manifest + hash 静态资源）
COPY --from=public-build /app/dist-public ./dist-public
EXPOSE 3100
CMD ["node", "dist-public/server/index.js"]

# 提交标记最后注入，避免每次发布使依赖安装和构建层缓存失效（与根 Dockerfile 同约定）。
ARG CC_RELEASE_SHA=local
LABEL org.opencontainers.image.revision=$CC_RELEASE_SHA
