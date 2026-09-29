FROM alpine:3.20
ARG ALPINE_MIRROR=https://mirrors.aliyun.com/alpine
RUN sed -i "s#https://dl-cdn.alpinelinux.org/alpine#${ALPINE_MIRROR}#g" /etc/apk/repositories
RUN timeout -s KILL 120 apk add --no-cache tzdata flock python3 \
    && addgroup -g 10001 backup && adduser -D -u 10001 -G backup backup \
    && mkdir /backups && chown 10001:10001 /backups
COPY backup.sh /etc/periodic/daily/backup
COPY backup-worker.py /etc/periodic/daily/backup-worker.py
COPY check-backup.py /usr/local/bin/check-backup.py
COPY backup-scheduler.py /usr/local/bin/backup-scheduler.py
RUN chmod 0755 /etc/periodic/daily/backup
ENV TZ=Asia/Shanghai
USER 10001:10001
HEALTHCHECK --interval=10s --timeout=3s --start-period=2s --retries=3 CMD ["python3", "/usr/local/bin/backup-scheduler.py", "--health"]
CMD ["python3", "/usr/local/bin/backup-scheduler.py"]
ARG CC_RELEASE_SHA=local
LABEL org.opencontainers.image.revision="${CC_RELEASE_SHA}"
