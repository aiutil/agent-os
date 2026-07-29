// SPEC-032：生成「一行命令」远程节点安装脚本（unix sh + Windows PowerShell）。
// 脚本内嵌主控 LAN 地址 + 短期 enrollment token + 主控证书指纹 + 版本，节点安装后：
//   下载对应平台自包含 runtime → 注册为守护进程（开机自启 + 崩溃重启）→ 拨回主控。
// 纯函数，便于单测；网关 HTTP 端点直接 serve 其输出。

import { createHash } from 'node:crypto'

export interface InstallScriptParams {
  /** 主控 LAN HTTP 地址（用于下载脚本/探测），如 http://192.168.1.20:7430 。 */
  httpBase: string
  /** 节点回连的 WSS 地址，如 wss://192.168.1.20:7430/agent 。 */
  wsUrl: string
  /** 短期首注册换票；长期 node token 只在 pin 证书后的 WSS 内下发。 */
  enrollmentToken: string
  /** 主控自签证书 SHA-256 指纹（节点 pin）。 */
  fingerprint: string
  /** 发行版本（决定下载哪个 agentos-node 制品）。 */
  version: string
  /** 主控当前 Runtime 协议版本，制品必须精确一致。 */
  protocolVersion: number
  /** 制品所在 GitHub 仓库（owner/repo）。 */
  repo: string
  /** UI 选择的目标平台；脚本检测不一致时立即停止，防止下错包。 */
  expectedPlatform?: string
  /** Release manifest 中该目标平台包的 SHA-256。 */
  assetSha256?: string
}

/** 一行命令：交给用户复制。 */
export function oneLiners(p: InstallScriptParams): { unix: string; powershell: string } {
  const enrollId = tokenId(p.enrollmentToken)
  const unixUrl = `${p.httpBase}/enroll/${enrollId}`
  const powershellUrl = `${unixUrl}.ps1`
  const unixDigest = sha256(unixInstallScript(p))
  const powershellDigest = sha256(powershellInstallScript(p))
  return {
    unix: `agentos_enroll_tmp="$(mktemp "\${TMPDIR:-/tmp}/agentos-enroll.XXXXXX")" && trap 'rm -f "$agentos_enroll_tmp"' EXIT HUP INT TERM && curl -fsSL ${shellSingleQuote(unixUrl)} -o "$agentos_enroll_tmp" && agentos_enroll_sha="$(if command -v sha256sum >/dev/null 2>&1; then sha256sum "$agentos_enroll_tmp"; else shasum -a 256 "$agentos_enroll_tmp"; fi | awk '{print $1}')" && { [ "$agentos_enroll_sha" = "${unixDigest}" ] || { echo '✗ 安装脚本 SHA-256 校验失败' >&2; exit 1; }; } && sh "$agentos_enroll_tmp"`,
    powershell: `$AgentOsEnrollUrl='${powershellSingleQuote(powershellUrl)}'; $AgentOsEnrollPath=Join-Path ([IO.Path]::GetTempPath()) ('agentos-enroll-'+[guid]::NewGuid().ToString('N')+'.ps1'); try { Invoke-WebRequest -UseBasicParsing -Uri $AgentOsEnrollUrl -OutFile $AgentOsEnrollPath; $AgentOsEnrollSha=(Get-FileHash -Algorithm SHA256 $AgentOsEnrollPath).Hash.ToLowerInvariant(); if ($AgentOsEnrollSha -ne '${powershellDigest}') { throw '安装脚本 SHA-256 校验失败' }; & ([scriptblock]::Create((Get-Content $AgentOsEnrollPath -Raw))) } finally { Remove-Item $AgentOsEnrollPath -Force -ErrorAction SilentlyContinue }`
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function powershellSingleQuote(value: string): string {
  return value.replaceAll("'", "''")
}

/** enroll 路径里用 token 前 12 位做可读 id；真实校验仍用完整 token（脚本内嵌）。 */
export function tokenId(token: string): string {
  return token.slice(0, 12)
}

/** unix（mac/Linux）安装脚本全文。 */
export function unixInstallScript(p: InstallScriptParams): string {
  const ver = p.version.replace(/^v/, '')
  const enrollId = tokenId(p.enrollmentToken)
  return `#!/usr/bin/env sh
# Agent OS 远程节点 · 一键接入（自动注册回主控）
set -eu

REPO="${p.repo}"
VERSION="${ver}"
EXPECTED_PROTOCOL="${p.protocolVersion}"
WS_URL="${p.wsUrl}"
ENROLL_TOKEN="${p.enrollmentToken}"
HOST_FP="${p.fingerprint}"
ENROLL_STATUS_URL="${p.httpBase}/enroll/${enrollId}/status"
PREFIX="\${AGENT_OS_NODE_PREFIX:-$HOME/.agent-os-node}"

case "$(uname -s)" in
  Darwin) OS=mac ;;
  Linux)  OS=linux ;;
  *) echo "✗ 不支持的系统：$(uname -s)"; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ARCH=arm64 ;;
  x86_64|amd64)  ARCH=x64 ;;
  *) echo "✗ 不支持的架构：$(uname -m)"; exit 1 ;;
esac
PLATFORM="$OS-$ARCH"
EXPECTED_PLATFORM="${p.expectedPlatform ?? ''}"
[ -z "$EXPECTED_PLATFORM" ] || [ "$PLATFORM" = "$EXPECTED_PLATFORM" ] || { echo "✗ 该命令只适用于 $EXPECTED_PLATFORM，当前为 $PLATFORM"; exit 1; }
[ "$OS" != linux ] || command -v systemctl >/dev/null 2>&1 || { echo "✗ 未检测到 systemd，无法保证开机自启与崩溃恢复"; exit 1; }

case "$PREFIX" in ""|/|"$HOME") echo "✗ 拒绝使用危险安装目录：$PREFIX"; exit 1 ;; esac
PARENT="$(dirname "$PREFIX")"
BASE="$(basename "$PREFIX")"
case "$BASE" in ""|.|..) echo "✗ 拒绝使用危险安装目录：$PREFIX"; exit 1 ;; esac
mkdir -p "$PARENT"
PARENT="$(cd "$PARENT" && pwd -P)"
PREFIX="$PARENT/$BASE"
if printf '%s' "$PREFIX" | LC_ALL=C grep -q '[[:cntrl:]]'; then
  echo "✗ 安装目录不能包含控制字符"
  exit 1
fi
INSTALL_ROOT="$(mktemp -d "$PARENT/.\${BASE}.install.XXXXXX")"
BACKUP="$PARENT/.\${BASE}.previous"
PROMOTED=0
OLD_MOVED=0
HAD_EXISTING=0
[ ! -e "$PREFIX" ] || HAD_EXISTING=1
INSTALL_SUCCEEDED=0
PLIST="$HOME/Library/LaunchAgents/com.lohas.agentos-node.plist"
UNIT_DIR="$HOME/.config/systemd/user"
UNIT_FILE="$UNIT_DIR/agentos-node.service"

ASSET="agentos-node-\${VERSION}-\${PLATFORM}.tar.gz"
URL="https://github.com/$REPO/releases/download/v\${VERSION}/\${ASSET}"
EXPECTED_SHA256="${p.assetSha256 ?? ''}"

echo "→ 安装 Agent OS 远程节点 \${VERSION} (\${PLATFORM}) 到 $PREFIX"
echo "→ 下载 $URL"
TMP_TARBALL="$(mktemp "\${TMPDIR:-/tmp}/agentos-node.XXXXXX.tar.gz")"
cleanup_install() {
  status=$?
  if [ "$INSTALL_SUCCEEDED" -ne 1 ] && [ "$status" -eq 0 ]; then status=1; fi
  trap - EXIT
  rm -f "$TMP_TARBALL"
  if [ "$status" -ne 0 ]; then
    if [ "$PROMOTED" -eq 1 ]; then
      if [ "$OS" = mac ]; then launchctl unload "$PLIST" 2>/dev/null || true
      else systemctl --user stop agentos-node.service 2>/dev/null || true; fi
      rm -rf "$PREFIX"
    fi
    if [ "$OLD_MOVED" -eq 1 ] && [ -e "$BACKUP" ]; then mv "$BACKUP" "$PREFIX"; fi
    if [ "$HAD_EXISTING" -eq 1 ] && [ -e "$PREFIX" ]; then
      if [ "$OS" = mac ]; then launchctl load "$PLIST" 2>/dev/null || true
      else systemctl --user start agentos-node.service 2>/dev/null || true; fi
    elif [ "$PROMOTED" -eq 1 ]; then
      if [ "$OS" = mac ]; then
        rm -f "$PLIST"
      else
        systemctl --user disable agentos-node.service 2>/dev/null || true
        rm -f "$UNIT_FILE"
        systemctl --user daemon-reload 2>/dev/null || true
      fi
    fi
    if [ -n "$INSTALL_ROOT" ] && [ -d "$INSTALL_ROOT" ]; then rm -rf "$INSTALL_ROOT"; fi
  fi
  exit "$status"
}
trap cleanup_install EXIT
curl -fL --retry 5 --retry-delay 2 --retry-all-errors -o "$TMP_TARBALL" "$URL"
if [ -n "$EXPECTED_SHA256" ]; then
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL_SHA256=$(sha256sum "$TMP_TARBALL" | awk '{print $1}');
  else ACTUAL_SHA256=$(shasum -a 256 "$TMP_TARBALL" | awk '{print $1}'); fi
  [ "$ACTUAL_SHA256" = "$EXPECTED_SHA256" ] || { echo "✗ 制品 SHA-256 校验失败"; exit 1; }
fi
tar -xzf "$TMP_TARBALL" -C "$INSTALL_ROOT"
[ -f "$INSTALL_ROOT/runtime-manifest.json" ] || { echo "✗ 制品缺少 runtime-manifest.json"; exit 1; }
[ -d "$INSTALL_ROOT/node_modules" ] || { echo "✗ 制品缺少预编译运行时依赖，拒绝在目标机临时混装"; exit 1; }
RUNTIME_NODE="$INSTALL_ROOT/runtime/bin/node"
[ -x "$RUNTIME_NODE" ] || { echo "✗ 制品缺少可执行的固定 Node runtime"; exit 1; }
MANIFEST_VERSION=$("$RUNTIME_NODE" -p 'require(process.argv[1]).appVersion' "$INSTALL_ROOT/runtime-manifest.json")
MANIFEST_PLATFORM=$("$RUNTIME_NODE" -p 'require(process.argv[1]).platform' "$INSTALL_ROOT/runtime-manifest.json")
MANIFEST_ABI=$("$RUNTIME_NODE" -p 'require(process.argv[1]).nodeAbi' "$INSTALL_ROOT/runtime-manifest.json")
MANIFEST_PROTOCOL=$("$RUNTIME_NODE" -p 'require(process.argv[1]).protocolVersion' "$INSTALL_ROOT/runtime-manifest.json")
MANIFEST_NODE_VERSION=$("$RUNTIME_NODE" -p 'require(process.argv[1]).nodeVersion' "$INSTALL_ROOT/runtime-manifest.json")
CURRENT_ABI=$("$RUNTIME_NODE" -p 'process.versions.modules')
CURRENT_NODE_VERSION=$("$RUNTIME_NODE" -p 'process.versions.node')
[ "$MANIFEST_VERSION" = "$VERSION" ] || { echo "✗ 制品版本不一致：$MANIFEST_VERSION != $VERSION"; exit 1; }
[ "$MANIFEST_PLATFORM" = "$PLATFORM" ] || { echo "✗ 制品平台不一致：$MANIFEST_PLATFORM != $PLATFORM"; exit 1; }
[ "$MANIFEST_ABI" = "$CURRENT_ABI" ] || { echo "✗ Node ABI 不一致：制品 $MANIFEST_ABI / 当前 $CURRENT_ABI"; exit 1; }
[ "$MANIFEST_PROTOCOL" = "$EXPECTED_PROTOCOL" ] || { echo "✗ Runtime 协议不一致：制品 $MANIFEST_PROTOCOL / 主控 $EXPECTED_PROTOCOL"; exit 1; }
[ "$MANIFEST_NODE_VERSION" = "$CURRENT_NODE_VERSION" ] || { echo "✗ 包内 Node 版本与 manifest 不一致"; exit 1; }
case "$CURRENT_NODE_VERSION" in 20.*) ;; *) echo "✗ 节点制品必须使用 Node 20.x，当前为 $CURRENT_NODE_VERSION"; exit 1 ;; esac
"$RUNTIME_NODE" "$INSTALL_ROOT/bin/verify-node-runtime.cjs" "$INSTALL_ROOT" --probe-pty

# 持久化配置（重启沿用）。
cat > "$INSTALL_ROOT/node.env" <<EOF
AGENT_OS_HOST=$WS_URL
AGENT_OS_ENROLL_TOKEN=$ENROLL_TOKEN
AGENT_OS_HOST_FP=$HOST_FP
AGENT_OS_NODE_VERSION=$VERSION
EOF
chmod 600 "$INSTALL_ROOT/node.env"

cat > "$INSTALL_ROOT/agentos-node" <<EOF
#!/usr/bin/env sh
AGENT_OS_NODE_PREFIX="\\$(CDPATH= cd -P "\\$(dirname "\\$0")" && pwd -P)"
export AGENT_OS_NODE_PREFIX
set -a
[ ! -f "\\$AGENT_OS_NODE_PREFIX/node.env" ] || . "\\$AGENT_OS_NODE_PREFIX/node.env"
set +a
exec "\\$AGENT_OS_NODE_PREFIX/runtime/bin/node" "\\$AGENT_OS_NODE_PREFIX/out/main/remote-node.js" "\\$@"
EOF
chmod +x "$INSTALL_ROOT/agentos-node"

cat > "$INSTALL_ROOT/agentos-cli" <<EOF
#!/usr/bin/env sh
AGENT_OS_NODE_PREFIX="\\$(CDPATH= cd -P "\\$(dirname "\\$0")" && pwd -P)"
export AGENT_OS_NODE_PREFIX
exec "\\$AGENT_OS_NODE_PREFIX/runtime/bin/node" "\\$AGENT_OS_NODE_PREFIX/bin/agentos-cli.cjs" "\\$@"
EOF
chmod +x "$INSTALL_ROOT/agentos-cli"

# 保留节点会话/任务数据，但使用本次新的 enrollment 凭证重新配对。
if [ -d "$PREFIX" ]; then
  for persistent in sessions.json tasks.json providers.json chat-store.sqlite chat-store.sqlite-shm chat-store.sqlite-wal node.log; do
    [ ! -f "$PREFIX/$persistent" ] || cp -p "$PREFIX/$persistent" "$INSTALL_ROOT/$persistent"
  done
fi

# 停止旧守护后原子提升已完整验证的 stage；后续任一步失败由 EXIT trap 回滚。
if [ "$OS" = mac ]; then
  launchctl unload "$HOME/Library/LaunchAgents/com.lohas.agentos-node.plist" 2>/dev/null || true
else
  systemctl --user stop agentos-node.service 2>/dev/null || true
fi
[ ! -e "$BACKUP" ] || rm -rf "$BACKUP"
if [ -e "$PREFIX" ]; then mv "$PREFIX" "$BACKUP"; OLD_MOVED=1; fi
mv "$INSTALL_ROOT" "$PREFIX"
INSTALL_ROOT=""
PROMOTED=1
RUNTIME_NODE="$PREFIX/runtime/bin/node"

if [ "$OS" = mac ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  PLIST_PREFIX=$("$RUNTIME_NODE" -e 'const v=process.argv[1];if(/[\\0-\\x08\\x0B\\x0C\\x0E-\\x1F]/.test(v))process.exit(2);process.stdout.write(v.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll(String.fromCharCode(34),"&quot;").replaceAll(String.fromCharCode(39),"&apos;"))' "$PREFIX")
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.lohas.agentos-node</string>
  <key>ProgramArguments</key><array><string>$PLIST_PREFIX/agentos-node</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PLIST_PREFIX/node.log</string>
  <key>StandardErrorPath</key><string>$PLIST_PREFIX/node.log</string>
</dict></plist>
EOF
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
  echo "✓ 已注册 launchd 守护并启动（com.lohas.agentos-node）"
else
  # Linux：只在 systemd user 可用时承诺守护与开机恢复；不再用不可靠的 nohup 冒充 daemon。
  mkdir -p "$UNIT_DIR"
  SYSTEMD_PREFIX=$(printf '%s' "$PREFIX" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g' -e 's/%/%%/g')
  cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Agent OS 远程节点
After=network-online.target

[Service]
EnvironmentFile="$SYSTEMD_PREFIX/node.env"
ExecStart="$SYSTEMD_PREFIX/agentos-node"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now agentos-node.service
  loginctl enable-linger "$(whoami)" 2>/dev/null || true
  echo "✓ 已注册 systemd user 守护并启动（agentos-node.service）"
fi


# 不把“service 命令成功”当成接入成功；等主控确认 WSS 换票、持久化与 adopt 全部完成。
echo "→ 等待主控确认节点注册"
ENROLL_WAIT_ATTEMPTS="\${AGENT_OS_ENROLL_WAIT_ATTEMPTS:-30}"
ENROLL_WAIT_DELAY="\${AGENT_OS_ENROLL_WAIT_DELAY:-2}"
REGISTERED=0
ATTEMPT=0
while [ "$ATTEMPT" -lt "$ENROLL_WAIT_ATTEMPTS" ]; do
  CONFIRM_BODY=$(curl -fsS --max-time 3 -H "Authorization: Bearer $ENROLL_TOKEN" "$ENROLL_STATUS_URL" 2>/dev/null || true)
  case "$CONFIRM_BODY" in
    *'"status":"registered"'*) REGISTERED=1; break ;;
  esac
  ATTEMPT=$((ATTEMPT + 1))
  [ "$ATTEMPT" -ge "$ENROLL_WAIT_ATTEMPTS" ] || sleep "$ENROLL_WAIT_DELAY"
done
if [ "$REGISTERED" -ne 1 ]; then
  echo "✗ 主控未在限时内确认节点注册，将恢复上一版安装"
  "$PREFIX/agentos-cli" daemon status 2>/dev/null || true
  [ ! -f "$PREFIX/node.log" ] || tail -n 40 "$PREFIX/node.log" || true
  exit 1
fi

echo "✓ 完成：主控已确认节点注册（\${WS_URL}）"
echo "→ 本机运维：$PREFIX/agentos-cli -h"
INSTALL_SUCCEEDED=1
`
}

/** Windows PowerShell 安装脚本全文。 */
export function powershellInstallScript(p: InstallScriptParams): string {
  const ver = p.version.replace(/^v/, '')
  const enrollId = tokenId(p.enrollmentToken)
  return `# Agent OS 远程节点 · 一键接入（自动注册回主控）
$ErrorActionPreference = "Stop"
$Repo = "${p.repo}"
$Version = "${ver}"
$ExpectedProtocol = ${p.protocolVersion}
$WsUrl = "${p.wsUrl}"
$EnrollToken = "${p.enrollmentToken}"
$HostFp = "${p.fingerprint}"
$EnrollStatusUrl = "${p.httpBase}/enroll/${enrollId}/status"
$Prefix = if ($env:AGENT_OS_NODE_PREFIX) { $env:AGENT_OS_NODE_PREFIX } else { "$env:USERPROFILE\\.agent-os-node" }
$Prefix = [IO.Path]::GetFullPath($Prefix)
$Root = [IO.Path]::GetPathRoot($Prefix)
if ($Prefix -eq $Root -or $Prefix -eq [IO.Path]::GetFullPath($env:USERPROFILE)) { throw "拒绝使用危险安装目录：$Prefix" }
$Parent = Split-Path -Parent $Prefix
$Base = Split-Path -Leaf $Prefix
$InstallRoot = Join-Path $Parent ".$Base.install-$([guid]::NewGuid().ToString('N'))"
$Backup = Join-Path $Parent ".$Base.previous"
$Promoted = $false
$OldMoved = $false
$HadExisting = Test-Path $Prefix
$TaskName = "AgentOSNode"
$TaskExistedBefore = $false
$tmp = Join-Path $env:TEMP "agentos-node-$([guid]::NewGuid().ToString('N')).tar.gz"

$Platform = "win-x64"
$ExpectedPlatform = "${p.expectedPlatform ?? ''}"
if ($ExpectedPlatform -and $ExpectedPlatform -ne $Platform) { throw "该命令只适用于 $ExpectedPlatform，当前为 $Platform" }
$Asset = "agentos-node-$Version-$Platform.tar.gz"
$Url = "https://github.com/$Repo/releases/download/v$Version/$Asset"
$ExpectedSha256 = "${p.assetSha256 ?? ''}"

try {
  Write-Host "→ 安装 Agent OS 远程节点 $Version ($Platform) 到 $Prefix"
  New-Item -ItemType Directory -Force -Path $Parent, $InstallRoot | Out-Null
  Write-Host "→ 下载 $Url"
  Invoke-WebRequest -Uri $Url -OutFile $tmp
if ($ExpectedSha256) {
  $ActualSha256 = (Get-FileHash -Algorithm SHA256 $tmp).Hash.ToLowerInvariant()
  if ($ActualSha256 -ne $ExpectedSha256.ToLowerInvariant()) { throw "制品 SHA-256 校验失败" }
}
tar -xzf $tmp -C $InstallRoot
if ($LASTEXITCODE -ne 0) { throw "节点包解压失败" }
$RuntimeManifest = Join-Path $InstallRoot "runtime-manifest.json"
if (-not (Test-Path $RuntimeManifest)) { throw "制品缺少 runtime-manifest.json" }
$Manifest = Get-Content $RuntimeManifest -Raw | ConvertFrom-Json
$RuntimeNode = Join-Path $InstallRoot "runtime\\bin\\node.exe"
if (-not (Test-Path $RuntimeNode)) { throw "制品缺少固定 Node runtime；请等待 win-x64 原生制品发布" }
if (-not (Test-Path (Join-Path $InstallRoot "node_modules"))) { throw "制品缺少 Windows 预编译运行时依赖" }
$CurrentAbi = & $RuntimeNode -p "process.versions.modules"
$CurrentNodeVersion = & $RuntimeNode -p "process.versions.node"
if ($Manifest.appVersion -ne $Version) { throw "制品版本不一致：$($Manifest.appVersion) != $Version" }
if ($Manifest.platform -ne $Platform) { throw "制品平台不一致：$($Manifest.platform) != $Platform" }
if ([string]$Manifest.nodeAbi -ne [string]$CurrentAbi) { throw "Node ABI 不一致：制品 $($Manifest.nodeAbi) / 当前 $CurrentAbi" }
if ([int]$Manifest.protocolVersion -ne $ExpectedProtocol) { throw "Runtime 协议不一致：制品 $($Manifest.protocolVersion) / 主控 $ExpectedProtocol" }
if ($Manifest.nodeVersion -ne $CurrentNodeVersion) { throw "包内 Node 版本与 manifest 不一致" }
if (-not $CurrentNodeVersion.StartsWith("20.")) { throw "节点制品必须使用 Node 20.x，当前为 $CurrentNodeVersion" }
& $RuntimeNode (Join-Path $InstallRoot "bin\\verify-node-runtime.cjs") $InstallRoot --probe-pty
if ($LASTEXITCODE -ne 0) { throw "制品文件完整性校验失败" }

# 持久化配置 + 启动包装脚本。
@"
AGENT_OS_HOST=$WsUrl
AGENT_OS_ENROLL_TOKEN=$EnrollToken
AGENT_OS_HOST_FP=$HostFp
AGENT_OS_NODE_VERSION=$Version
"@ | Set-Content -Encoding ASCII (Join-Path $InstallRoot "node.env")

$nodeCmd = Join-Path $InstallRoot "agentos-node.cmd"
@"
@echo off
set "AGENT_OS_NODE_PREFIX=%~dp0"
for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0node.env") do set "%%A=%%B"
"%~dp0runtime\\bin\\node.exe" "%~dp0out\\main\\remote-node.js" %*
"@ | Set-Content -Encoding ASCII $nodeCmd

$cliCmd = Join-Path $InstallRoot "agentos-cli.cmd"
@"
@echo off
set "AGENT_OS_NODE_PREFIX=%~dp0"
"%~dp0runtime\\bin\\node.exe" "%~dp0bin\\agentos-cli.cjs" %*
"@ | Set-Content -Encoding ASCII $cliCmd

$runner = Join-Path $InstallRoot "run-node.cmd"
@"
@echo off
:agentos_restart
call "%~dp0agentos-node.cmd"
timeout /t 5 /nobreak >nul
goto agentos_restart
"@ | Set-Content -Encoding ASCII $runner

# 保留会话/任务数据，停止旧进程后原子提升已验证的 stage。
if (Test-Path $Prefix) {
  foreach ($persistent in @("sessions.json", "tasks.json", "providers.json", "chat-store.sqlite", "chat-store.sqlite-shm", "chat-store.sqlite-wal", "node.log")) {
    $source = Join-Path $Prefix $persistent
    if (Test-Path $source) { Copy-Item $source (Join-Path $InstallRoot $persistent) -Force }
  }
}
schtasks /Query /TN $TaskName 2>$null | Out-Null
$TaskExistedBefore = $LASTEXITCODE -eq 0
if ($TaskExistedBefore) {
  schtasks /End /TN $TaskName 2>$null | Out-Null
  Start-Sleep -Milliseconds 500
}
if (Test-Path $Backup) { Remove-Item $Backup -Recurse -Force }
if (Test-Path $Prefix) { Move-Item $Prefix $Backup; $OldMoved = $true }
Move-Item $InstallRoot $Prefix
$Promoted = $true
$RuntimeNode = Join-Path $Prefix "runtime\\bin\\node.exe"
$nodeCmd = Join-Path $Prefix "agentos-node.cmd"
$cliCmd = Join-Path $Prefix "agentos-cli.cmd"
$runner = Join-Path $Prefix "run-node.cmd"

# 计划任务：登录时启动 + 失败重启（守护）。
schtasks /Query /TN $TaskName 2>$null | Out-Null
schtasks /Create /TN $TaskName /TR "\`"$runner\`"" /SC ONLOGON /RL LIMITED /F | Out-Null
if ($LASTEXITCODE -ne 0) { throw "计划任务创建失败" }
schtasks /Run /TN $TaskName | Out-Null
if ($LASTEXITCODE -ne 0) { throw "计划任务启动失败" }
Write-Host "✓ 已注册计划任务 $TaskName（登录自启）并启动"

# 必须由主控证明长期 token 已持久化且 socket 已 adopt，否则 catch 恢复上一版。
Write-Host "→ 等待主控确认节点注册"
$EnrollWaitAttempts = if ($env:AGENT_OS_ENROLL_WAIT_ATTEMPTS) { [int]$env:AGENT_OS_ENROLL_WAIT_ATTEMPTS } else { 30 }
$EnrollWaitDelay = if ($env:AGENT_OS_ENROLL_WAIT_DELAY) { [int]$env:AGENT_OS_ENROLL_WAIT_DELAY } else { 2 }
$Registered = $false
for ($Attempt = 0; $Attempt -lt $EnrollWaitAttempts; $Attempt++) {
  try {
    $Confirmation = Invoke-RestMethod -Uri $EnrollStatusUrl -Headers @{ Authorization = "Bearer $EnrollToken" } -TimeoutSec 3
    if ($Confirmation.status -eq "registered") { $Registered = $true; break }
  } catch {
    # 启动/换票窗口内可能暂时无法连接，到总超时再统一回滚。
  }
  if ($Attempt + 1 -lt $EnrollWaitAttempts) { Start-Sleep -Seconds $EnrollWaitDelay }
}
if (-not $Registered) { throw "主控未在限时内确认节点注册" }

Write-Host "✓ 完成：主控已确认节点注册（$WsUrl）"
Write-Host "→ 本机运维：$cliCmd -h"
} catch {
  if ($Promoted) {
    schtasks /End /TN $TaskName 2>$null | Out-Null
    if (Test-Path $Prefix) { Remove-Item $Prefix -Recurse -Force }
  }
  if ($OldMoved -and (Test-Path $Backup)) { Move-Item $Backup $Prefix }
  if ($TaskExistedBefore -and (Test-Path $Prefix)) {
    schtasks /Run /TN $TaskName 2>$null | Out-Null
  } elseif ($Promoted) {
    schtasks /Delete /TN $TaskName /F 2>$null | Out-Null
  }
  throw
} finally {
  if (Test-Path $tmp) { Remove-Item $tmp -Force }
  if (Test-Path $InstallRoot) { Remove-Item $InstallRoot -Recurse -Force }
}
`
}
