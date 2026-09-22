FROM alpine:3.20

# Install runtime dependencies while building the immutable candidate image.  apk
# can hang when the package mirror is unreachable, so KILL provides a hard bound
# for preflight and CI instead of leaving a production container half-started.
RUN timeout -s KILL 120 apk add --no-cache tzdata flock \
    && test -e /usr/share/zoneinfo/Asia/Shanghai \
    && command -v flock >/dev/null

COPY backup.sh /etc/periodic/daily/backup
RUN chmod 0755 /etc/periodic/daily/backup

ENV TZ=Asia/Shanghai

HEALTHCHECK --interval=10s --timeout=3s --start-period=2s --retries=3 CMD \
    test -x /etc/periodic/daily/backup \
    && grep -qx '# cc-backup-lock-v1' /etc/periodic/daily/backup \
    && command -v flock >/dev/null \
    && test -e /usr/share/zoneinfo/Asia/Shanghai \
    && test "$(cat /proc/1/comm)" = crond

CMD ["crond", "-f", "-d", "8"]

# Keep the release label last so dependency layers remain cacheable across SHAs.
ARG CC_RELEASE_SHA=local
LABEL org.opencontainers.image.revision="${CC_RELEASE_SHA}"
