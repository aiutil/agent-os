#!/usr/bin/env bash
# Agent OS 远程节点 一键安装。
# 用法（在目标主机上）：
#   curl -fsSL https://github.com/aiutil/agent-os/releases/latest/download/install-node.sh | bash
# 可选环境变量：
#   AGENTOS_NODE_VERSION=v0.3.0   指定版本（默认取最新 release）
#   AGENTOS_NODE_PREFIX=~/.agent-os-node   安装目录
set -euo pipefail

REPO="aiutil/agent-os"
PREFIX="${AGENTOS_NODE_PREFIX:-$HOME/.agent-os-node}"
case "$PREFIX" in ""|/|"$HOME") echo "✗ 拒绝使用危险安装目录：$PREFIX"; exit 1 ;; esac
PARENT="$(dirname "$PREFIX")"
BASE="$(basename "$PREFIX")"
case "$BASE" in ""|.|..) echo "✗ 拒绝使用危险安装目录：$PREFIX"; exit 1 ;; esac
mkdir -p "$PARENT"
PARENT="$(cd "$PARENT" && pwd -P)"
PREFIX="$PARENT/$BASE"
INSTALL_ROOT=""
BACKUP="$PARENT/.${BASE}.previous"
PROMOTED=0

echo "→ Agent OS 远程节点 · 一键安装"

for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || { echo "✗ 缺少依赖：$cmd"; exit 1; }
done

VERSION="${AGENTOS_NODE_VERSION:-}"
if [ -z "$VERSION" ]; then
  VERSION="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
fi
[ -n "$VERSION" ] || { echo "✗ 无法确定版本，请用 AGENTOS_NODE_VERSION 指定"; exit 1; }

# 选当前 Unix 平台/架构对应的自包含制品。Windows 使用桌面端生成的 PowerShell 接入命令。
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS" in
  Darwin) PLATFORM="mac" ;;
  Linux)  PLATFORM="linux" ;;
  *) echo "✗ 不支持的系统：$OS（仅提供 mac / linux 预编译节点包）"; exit 1 ;;
esac
case "$ARCH" in
  arm64|aarch64) ARCH_TAG="arm64" ;;
  x86_64|amd64|x64) ARCH_TAG="x64" ;;
  *) echo "✗ 不支持的架构：$ARCH"; exit 1 ;;
esac
ASSET="agentos-node-${VERSION#v}-${PLATFORM}-${ARCH_TAG}.tar.gz"
URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
MANIFEST_ASSET="agentos-node-${VERSION#v}-manifest.json"
MANIFEST_URL="https://github.com/$REPO/releases/download/$VERSION/$MANIFEST_ASSET"

echo "→ 版本 $VERSION（$PLATFORM-$ARCH_TAG）→ 安装到 $PREFIX"
echo "→ 下载 $URL"
# 先探测资源是否存在，缺失时给出清晰提示而不是裸 curl 报错。
curl -fsI --retry 3 --retry-delay 2 --retry-all-errors "$URL" >/dev/null || {
  echo "✗ 找不到节点包：$ASSET"
  echo "  当前 Release 尚未发布该平台/架构的已验证预编译包。"
  echo "  可用 AGENTOS_NODE_VERSION 指定其它版本，或在该主机上用 Node 18+ 自行编译运行。"
  exit 1
}
INSTALL_ROOT="$(mktemp -d "$PARENT/.${BASE}.install.XXXXXX")"
TMP_TARBALL="$(mktemp "${TMPDIR:-/tmp}/agentos-node.XXXXXX.tar.gz")"
cleanup_install() {
  status=$?
  trap - EXIT
  rm -f "$TMP_TARBALL"
  if [ "$status" -ne 0 ]; then
    if [ "$PROMOTED" -eq 1 ]; then
      rm -rf "$PREFIX"
      [ ! -d "$BACKUP" ] || mv "$BACKUP" "$PREFIX"
    elif [ -n "$INSTALL_ROOT" ] && [ -d "$INSTALL_ROOT" ]; then
      rm -rf "$INSTALL_ROOT"
    fi
  fi
  exit "$status"
}
trap cleanup_install EXIT
curl -fL --retry 5 --retry-delay 2 --retry-all-errors -o "$TMP_TARBALL" "$URL"
MANIFEST_JSON="$(curl -fsSL --retry 3 "$MANIFEST_URL")" || { echo "✗ 缺少完整性清单：$MANIFEST_ASSET"; exit 1; }
EXPECTED_SHA256="$(printf '%s\n' "$MANIFEST_JSON" | awk -v target="$ASSET" '
  $0 ~ "\\\"name\\\": \\"" target "\\\"" { found=1 }
  found && $0 ~ /"sha256":/ { gsub(/[",]/, "", $2); print $2; exit }
')"
[ -n "$EXPECTED_SHA256" ] || { echo "✗ 完整性清单未包含 $ASSET"; exit 1; }
if command -v sha256sum >/dev/null 2>&1; then ACTUAL_SHA256="$(sha256sum "$TMP_TARBALL" | awk '{print $1}')";
else ACTUAL_SHA256="$(shasum -a 256 "$TMP_TARBALL" | awk '{print $1}')"; fi
[ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || { echo "✗ 制品 SHA-256 校验失败"; exit 1; }
tar -xzf "$TMP_TARBALL" -C "$INSTALL_ROOT"

# 制品包含固定 Node runtime + 同 ABI 原生模块；目标机无需预装 Node/npm。
RUNTIME_NODE="$INSTALL_ROOT/runtime/bin/node"
[ -x "$RUNTIME_NODE" ] || { echo "✗ 制品缺少固定 Node runtime"; exit 1; }
[ -d "$INSTALL_ROOT/node_modules" ] || { echo "✗ 制品缺少预编译运行时依赖"; exit 1; }
MANIFEST_VERSION="$("$RUNTIME_NODE" -p 'require(process.argv[1]).appVersion' "$INSTALL_ROOT/runtime-manifest.json")"
MANIFEST_PLATFORM="$("$RUNTIME_NODE" -p 'require(process.argv[1]).platform' "$INSTALL_ROOT/runtime-manifest.json")"
MANIFEST_ABI="$("$RUNTIME_NODE" -p 'require(process.argv[1]).nodeAbi' "$INSTALL_ROOT/runtime-manifest.json")"
MANIFEST_PROTOCOL="$("$RUNTIME_NODE" -p 'require(process.argv[1]).protocolVersion' "$INSTALL_ROOT/runtime-manifest.json")"
MANIFEST_NODE_VERSION="$("$RUNTIME_NODE" -p 'require(process.argv[1]).nodeVersion' "$INSTALL_ROOT/runtime-manifest.json")"
CURRENT_ABI="$("$RUNTIME_NODE" -p 'process.versions.modules')"
CURRENT_NODE_VERSION="$("$RUNTIME_NODE" -p 'process.versions.node')"
[ "$MANIFEST_VERSION" = "${VERSION#v}" ] || { echo "✗ 制品版本不一致"; exit 1; }
[ "$MANIFEST_PLATFORM" = "$PLATFORM-$ARCH_TAG" ] || { echo "✗ 制品平台不一致"; exit 1; }
[ "$MANIFEST_ABI" = "$CURRENT_ABI" ] || { echo "✗ Node ABI 不一致"; exit 1; }
[ "$MANIFEST_NODE_VERSION" = "$CURRENT_NODE_VERSION" ] || { echo "✗ 包内 Node 版本与 manifest 不一致"; exit 1; }
case "$CURRENT_NODE_VERSION" in 20.*) ;; *) echo "✗ 节点制品必须使用 Node 20.x"; exit 1 ;; esac
case "$MANIFEST_PROTOCOL" in ''|*[!0-9]*) echo "✗ Runtime 协议版本无效"; exit 1 ;; esac
"$RUNTIME_NODE" "$INSTALL_ROOT/bin/verify-node-runtime.cjs" "$INSTALL_ROOT" --probe-pty

BIN="$INSTALL_ROOT/agentos-node"
cat > "$BIN" <<EOF
#!/usr/bin/env bash
AGENT_OS_NODE_PREFIX="\$(CDPATH= cd -P "\$(dirname "\$0")" && pwd -P)"
export AGENT_OS_NODE_PREFIX
set -a
[ ! -f "\$AGENT_OS_NODE_PREFIX/node.env" ] || . "\$AGENT_OS_NODE_PREFIX/node.env"
set +a
exec "\$AGENT_OS_NODE_PREFIX/runtime/bin/node" "\$AGENT_OS_NODE_PREFIX/out/main/remote-node.js" "\$@"
EOF
chmod +x "$BIN"

CLI="$INSTALL_ROOT/agentos-cli"
cat > "$CLI" <<EOF
#!/usr/bin/env bash
AGENT_OS_NODE_PREFIX="\$(CDPATH= cd -P "\$(dirname "\$0")" && pwd -P)"
export AGENT_OS_NODE_PREFIX
exec "\$AGENT_OS_NODE_PREFIX/runtime/bin/node" "\$AGENT_OS_NODE_PREFIX/bin/agentos-cli.cjs" "\$@"
EOF
chmod +x "$CLI"

# 普通升级保留已配对凭证与节点数据。
if [ -d "$PREFIX" ]; then
  for persistent in node.env sessions.json tasks.json providers.json chat-store.sqlite chat-store.sqlite-shm chat-store.sqlite-wal node.log; do
    [ ! -f "$PREFIX/$persistent" ] || cp -p "$PREFIX/$persistent" "$INSTALL_ROOT/$persistent"
  done
fi
[ ! -e "$BACKUP" ] || rm -rf "$BACKUP"
[ ! -e "$PREFIX" ] || mv "$PREFIX" "$BACKUP"
mv "$INSTALL_ROOT" "$PREFIX"
INSTALL_ROOT=""
PROMOTED=1
BIN="$PREFIX/agentos-node"
CLI="$PREFIX/agentos-cli"

cat <<EOF

✓ 安装完成：
  $BIN
  $CLI

常用诊断：
  "$CLI" -h
  "$CLI" doctor
  "$CLI" status
  "$CLI" daemon status

提示：普通下载安装不会写入主控回连配置。
请优先使用桌面端「设置 → 远程托管 → 添加节点」生成的一行命令完成配对。

把目录加入 PATH 后可直接用 agentos-node / agentos-cli：
  export PATH="$PREFIX:\$PATH"
EOF
