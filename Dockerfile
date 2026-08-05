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
ARG PB_VERSION=0.28.4
RUN apk add --no-cache ca-certificates unzip
WORKDIR /pb
ADD "https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}/pocketbase_${PB_VERSION}_linux_amd64.zip" /tmp/pocketbase.zip
RUN unzip /tmp/pocketbase.zip -d /pb && rm /tmp/pocketbase.zip

COPY --from=frontend-build /app/dist ./pb_public
COPY backend/pb_migrations ./pb_migrations
COPY backend/pb_hooks ./pb_hooks

# 数据（SQLite + 上传文件）放命名卷 /pb/pb_data，镜像与数据分离（PRD §12.3）
VOLUME ["/pb/pb_data"]
EXPOSE 8090
# 启动时自动应用 pb_migrations 后伺服
CMD ["./pocketbase", "serve", "--http=0.0.0.0:8090", "--dir", "/pb/pb_data"]
