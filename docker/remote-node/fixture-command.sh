#!/usr/bin/env sh
set -eu

command_name="$(basename "$0")"

if [ "$command_name" = curl ]; then
  output=""
  release_asset=0
  expect_output=0
  for argument in "$@"; do
    if [ "$expect_output" -eq 1 ]; then output="$argument"; expect_output=0; continue; fi
    if [ "$argument" = -o ] || [ "$argument" = --output ]; then expect_output=1; continue; fi
    case "$argument" in
      https://github.com/*/releases/download/*/agentos-node-*.tar.gz) release_asset=1 ;;
    esac
  done
  if [ "$release_asset" -eq 1 ]; then
    [ -n "$output" ] || { echo 'fixture curl: release download has no output path' >&2; exit 2; }
    cp "$AGENT_OS_NODE_ASSET" "$output"
    exit 0
  fi
  exec /usr/bin/curl "$@"
fi

if [ "$command_name" = loginctl ]; then exit 0; fi

if [ "$command_name" = systemctl ]; then
  prefix="${AGENT_OS_NODE_PREFIX:?missing AGENT_OS_NODE_PREFIX}"
  pid_file=/tmp/agentos-node.pid
  case " $* " in
    *" stop "*)
      if [ -f "$pid_file" ]; then
        pid="$(cat "$pid_file")"
        kill "$pid" 2>/dev/null || true
        rm -f "$pid_file"
      fi
      ;;
    *" enable --now "*|*" start "*)
      if [ -f "$pid_file" ] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then exit 0; fi
      "$prefix/agentos-node" >>"$prefix/node.log" 2>&1 &
      echo "$!" > "$pid_file"
      ;;
  esac
  exit 0
fi

echo "unsupported fixture command: $command_name" >&2
exit 2
