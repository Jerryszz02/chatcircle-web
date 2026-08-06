# syntax=docker/dockerfile:1
# Caddy 反代镜像：编译进 caddy-dns/alidns 插件，用 DNS-01 挑战签发 Let's Encrypt 证书。
# 背景：未备案期间境内 ECS 的 80/443 被拦截，HTTP-01/TLS-ALPN-01 均不可用，
# 只能走 DNS 验证（deploy/README.md §5）。

FROM caddy:2-builder AS builder
# 国内服务器构建：Go 模块走 goproxy.cn
ENV GOPROXY=https://goproxy.cn,direct
RUN xcaddy build --with github.com/caddy-dns/alidns

FROM caddy:2-alpine
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
