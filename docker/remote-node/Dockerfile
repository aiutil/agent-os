# 模拟「第二台主机」：只执行桌面复制的一行命令，由安装器下载、验证、提升并启动
# build-node-dist.cjs 产生的真实 Release tarball。systemd user 命令在容器内模拟，
# 节点进程、换票、RPC、PTY、制品和主控状态均保持真实。
FROM node:20-bookworm-slim

ARG AGENT_OS_VERSION=0.0.0-dev

RUN apt-get update && apt-get install -y --no-install-recommends \
      zsh ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx \
      /usr/local/bin/corepack /usr/local/lib/node_modules \
    && ! command -v node \
    && ! command -v npm

WORKDIR /app
COPY docker/remote-node/fixture-command.sh /usr/local/libexec/agentos-fixture-command
COPY docker/remote-node/run-installer.sh /usr/local/bin/run-agentos-installer-fixture
RUN chmod +x /usr/local/libexec/agentos-fixture-command /usr/local/bin/run-agentos-installer-fixture \
    && ln -s /usr/local/libexec/agentos-fixture-command /usr/local/bin/systemctl \
    && ln -s /usr/local/libexec/agentos-fixture-command /usr/local/bin/loginctl \
    && ln -s /usr/local/libexec/agentos-fixture-command /usr/local/bin/curl

# 一个「装在远程主机上的 CLI」，让远程节点能发现到一个 agent，并可验证真实 PTY 读写。
RUN printf '#!/bin/sh\ncase "$1" in\n  --version) echo "1.2.3 (Claude Code)";;\n  *) echo "fake-claude-ready $@"; while IFS= read -r line; do echo "fake-claude-received $line"; done;;\nesac\n' \
      > /usr/local/bin/claude && chmod +x /usr/local/bin/claude
RUN printf '#!/bin/sh\ncase "$1" in\n  --version) echo "1.17.11";;\n  *) echo "fake-opencode-ready cwd=$(pwd) $@"; while IFS= read -r line; do echo "fake-opencode-received $line"; done;;\nesac\n' \
      > /usr/local/bin/opencode && chmod +x /usr/local/bin/opencode \
    && mkdir -p /data/remote-project /data/other-project

ENV HOME=/home/agentos \
    AGENT_OS_NODE_PREFIX=/opt/agentos-node \
    AGENT_OS_NODE_DATA=/data \
    AGENT_OS_NODE_LABEL=docker-node \
    AGENT_OS_NODE_VERSION=${AGENT_OS_VERSION} \
    AGENT_OS_ENROLL_WAIT_ATTEMPTS=60 \
    AGENT_OS_ENROLL_WAIT_DELAY=1 \
    AGENT_OS_ONE_LINER=/fixture-config/one-liner.sh \
    AGENT_OS_NODE_ASSET=/fixture/agentos-node.tar.gz
CMD ["/usr/local/bin/run-agentos-installer-fixture"]
