#!/usr/bin/env sh
set -eu

: "${AGENT_OS_ONE_LINER:?missing AGENT_OS_ONE_LINER}"
: "${AGENT_OS_NODE_PREFIX:?missing AGENT_OS_NODE_PREFIX}"
: "${AGENT_OS_EXPECTED_NODE_TOKEN:?missing AGENT_OS_EXPECTED_NODE_TOKEN}"

mkdir -p "$HOME" "$AGENT_OS_NODE_DATA"
! command -v node >/dev/null 2>&1 || { echo 'system Node unexpectedly available' >&2; exit 1; }
! command -v npm >/dev/null 2>&1 || { echo 'system npm unexpectedly available' >&2; exit 1; }
! command -v python3 >/dev/null 2>&1 || { echo 'runtime compiler chain unexpectedly available' >&2; exit 1; }
! command -v make >/dev/null 2>&1 || { echo 'runtime compiler chain unexpectedly available' >&2; exit 1; }
! command -v g++ >/dev/null 2>&1 || { echo 'runtime compiler chain unexpectedly available' >&2; exit 1; }
! command -v gcc >/dev/null 2>&1 || { echo 'runtime compiler chain unexpectedly available' >&2; exit 1; }

sh "$AGENT_OS_ONE_LINER"

grep -Fqx "AGENT_OS_NODE_TOKEN=$AGENT_OS_EXPECTED_NODE_TOKEN" "$AGENT_OS_NODE_PREFIX/node.env"
if grep -q '^AGENT_OS_ENROLL_TOKEN=' "$AGENT_OS_NODE_PREFIX/node.env"; then
  echo 'short enrollment token remained after confirmed exchange' >&2
  exit 1
fi
echo 'FIXTURE: long node token persisted and short enrollment token removed'

pid_file=/tmp/agentos-node.pid
[ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null || {
  echo 'installed node process is not running' >&2
  exit 1
}

# 模拟 systemd 启动的节点不是本 shell 的直接子进程，POSIX wait 会返回 127。
# 以前台 tail 保持容器存活并转发真实节点日志；Docker 停止容器时会清理整个进程组。
exec tail -n +1 -F "$AGENT_OS_NODE_PREFIX/node.log"
