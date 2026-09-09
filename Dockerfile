# syntax=docker/dockerfile:1
# Chat Circles 一体化镜像：前端 build 产物放 pb_public 由 PocketBase 同源伺服（technical-design §5.7）

# ---- stage 1: 前端构建 ----
FROM node:22-alpine AS frontend-build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
# 生产部署前后端同源，VITE_PB_URL 通常留空；需跨域直连时以构建参数注入
ARG VITE_PB_URL=
ENV VITE_PB_URL=${VITE_PB_URL}
RUN npm run build

# ---- stage 2: PocketBase 运行时 ----
FROM alpine:3.20
ARG CC_RELEASE_SHA=local
LABEL org.opencontainers.image.revision=$CC_RELEASE_SHA
ARG PB_VERSION=0.39.7
# 官方 release 校验值（release 页面 checksums.txt），升级 PB_VERSION 时必须同步更新
ARG PB_SHA256=0fe09a4e1a8f6e5b53d206c2e6b94a5812febcb43082d66d69bc8ba4d8e8429c
RUN apk add --no-cache ca-certificates curl unzip
WORKDIR /pb
# 境内 ECS 直连 GitHub Releases 慢且偶发 EOF（2026-08-07 实测 ~16KB/s），
# 不用 ADD <url>：它每次构建都发请求校验缓存，请求失败直接构建失败。
# RUN 层命中缓存则完全不联网；未命中时 curl 断点续传 + 全类型错误重试 8 次
# （busybox wget 实测无法处理 GitHub 的 TLS/重定向，故装 curl）。
RUN curl -fSL -C - --retry 8 --retry-delay 10 --retry-all-errors --connect-timeout 20 \
      -o /tmp/pocketbase.zip \
      "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip"
# 供应链校验：下载产物须匹配官方 sha256，不一致直接构建失败（busybox 自带 sha256sum）
RUN echo "$PB_SHA256  /tmp/pocketbase.zip" | sha256sum -c -
RUN unzip /tmp/pocketbase.zip -d /pb && rm /tmp/pocketbase.zip

COPY --from=frontend-build /app/dist ./pb_public
COPY backend/pb_migrations ./pb_migrations
COPY backend/pb_hooks ./pb_hooks

# 数据（SQLite + 上传文件）放命名卷 /pb/pb_data，镜像与数据分离（PRD §12.3）
VOLUME ["/pb/pb_data"]
EXPOSE 8090
# 启动时自动应用 pb_migrations 后伺服
CMD ["./pocketbase", "serve", "--http=0.0.0.0:8090", "--dir", "/pb/pb_data"]
