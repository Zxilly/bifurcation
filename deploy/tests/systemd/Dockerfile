FROM ubuntu:24.04
ENV container=docker
RUN apt-get update && apt-get install -y --no-install-recommends systemd systemd-sysv dbus ca-certificates curl openssl iproute2 \
    && apt-get clean && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
