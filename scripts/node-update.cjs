#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
/* global require, module, process, Buffer, URL, setTimeout */
/* Safe remote-node updater used by agentos-cli. */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const http = require('node:http')
const https = require('node:https')
const { createHash, randomBytes } = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')

const PERSISTENT_FILES = [
  'node.env',
  'sessions.json',
  'tasks.json',
  'providers.json',
  'chat-store.sqlite',
  'chat-store.sqlite-shm',
  'chat-store.sqlite-wal',
  'node.log'
]

function assertSafePrefix(prefix) {
  const resolved = path.resolve(prefix)
  const root = path.parse(resolved).root
  const home = path.resolve(os.homedir())
  if (!resolved || resolved === root || resolved === home) {
    throw new Error(`refusing unsafe node prefix: ${resolved}`)
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error(`installed node prefix is missing: ${resolved}`)
  }
  return resolved
}

function normalizeVersion(version) {
  const normalized = String(version || '').replace(/^v/, '')
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(normalized)) {
    throw new Error(`invalid release version: ${version}`)
  }
  return normalized
}

function validateRepo(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo || '')) {
    throw new Error(`invalid GitHub repository: ${repo}`)
  }
  return repo
}

function matchingProvenance(left, right) {
  const fields = [
    'schemaVersion',
    'version',
    'sourceRevision',
    'sourceTreeClean',
    'runtimeProtocolVersion',
    'installNodeSha256'
  ]
  return fields.every((field) => left?.[field] === right?.[field])
}

function validateReleaseMetadata({ version, platform, assetName, provenance, manifest }) {
  if (provenance?.schemaVersion !== 1 || provenance.version !== version ||
    provenance.sourceTreeClean !== true || !/^[a-f0-9]{40}$/i.test(provenance.sourceRevision || '') ||
    !Number.isInteger(provenance.runtimeProtocolVersion) || provenance.runtimeProtocolVersion < 1 ||
    !/^[a-f0-9]{64}$/i.test(provenance.installNodeSha256 || '')) {
    throw new Error('release provenance is missing or invalid')
  }
  if (manifest?.version !== version || !matchingProvenance(provenance, manifest.provenance)) {
    throw new Error('aggregate manifest provenance does not match the release')
  }
  const entry = Array.isArray(manifest.assets)
    ? manifest.assets.find((item) => item?.name === assetName)
    : null
  const runtime = entry?.runtime
  const filesReady = Array.isArray(runtime?.files) && runtime.files.length > 0 && runtime.files.every((file) =>
    typeof file?.path === 'string' && file.path.length > 0 &&
    Number.isInteger(file?.bytes) && file.bytes >= 0 &&
    /^[a-f0-9]{64}$/i.test(file?.sha256 || '')
  )
  if (!entry || !/^[a-f0-9]{64}$/i.test(entry.sha256 || '') || entry.fileIntegrityVerified !== true ||
    runtime?.selfContainedNodeRuntime !== true || runtime.appVersion !== version ||
    runtime.platform !== platform || runtime.protocolVersion !== provenance.runtimeProtocolVersion ||
    runtime.sourceRevision !== provenance.sourceRevision || !/^20\./.test(runtime.nodeVersion || '') ||
    !/^\d+$/.test(runtime.nodeAbi || '') || !filesReady) {
    throw new Error(`${assetName} is not a complete verified runtime artifact`)
  }
  return { entry, provenance }
}

function allowHttp(url) {
  if (url.protocol !== 'http:') return
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (!local || process.env.AGENT_OS_NODE_UPDATE_ALLOW_HTTP !== '1') {
    throw new Error(`refusing non-HTTPS update URL: ${url}`)
  }
}

function request(urlValue, redirects = 5) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlValue)
    allowHttp(url)
    const client = url.protocol === 'http:' ? http : https
    const req = client.get(url, {
      headers: { 'user-agent': 'agentos-node-updater', accept: 'application/octet-stream' },
      timeout: 20_000
    }, (response) => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        if (redirects <= 0) return reject(new Error(`too many redirects for ${url}`))
        return resolve(request(new URL(response.headers.location, url).toString(), redirects - 1))
      }
      if (response.statusCode !== 200) {
        response.resume()
        return reject(new Error(`${url} returned HTTP ${response.statusCode}`))
      }
      resolve(response)
    })
    req.on('timeout', () => req.destroy(new Error(`request timed out: ${url}`)))
    req.on('error', reject)
  })
}

async function withRetries(operation, attempts = 3) {
  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, attempt * 500))
    }
  }
  throw lastError
}

async function fetchBufferOnce(url, maxBytes = 10 * 1024 * 1024) {
  const response = await request(url)
  const chunks = []
  let bytes = 0
  for await (const chunk of response) {
    bytes += chunk.length
    if (bytes > maxBytes) throw new Error(`response too large: ${url}`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function fetchBuffer(url, maxBytes = 10 * 1024 * 1024) {
  return withRetries(() => fetchBufferOnce(url, maxBytes))
}

async function fetchJson(url) {
  return JSON.parse((await fetchBuffer(url)).toString('utf8'))
}

async function downloadFile(url, destination) {
  const response = await request(url)
  const temporary = `${destination}.partial`
  const hash = createHash('sha256')
  try {
    const handle = fs.openSync(temporary, 'wx', 0o600)
    try {
      for await (const chunk of response) {
        let offset = 0
        while (offset < chunk.length) offset += fs.writeSync(handle, chunk, offset)
        hash.update(chunk)
      }
      fs.fsyncSync(handle)
    } finally {
      fs.closeSync(handle)
    }
    fs.renameSync(temporary, destination)
    return hash.digest('hex')
  } catch (error) {
    fs.rmSync(temporary, { force: true })
    throw error
  }
}

async function latestVersion(repo) {
  validateRepo(repo)
  const api = process.env.AGENT_OS_NODE_UPDATE_LATEST_URL ||
    `https://api.github.com/repos/${repo}/releases/latest`
  return normalizeVersion((await fetchJson(api)).tag_name)
}

async function prepareNodeUpdate({ repo, version, platform, prefix }) {
  const safeRepo = validateRepo(repo)
  const normalized = normalizeVersion(version)
  const safePrefix = assertSafePrefix(prefix)
  if (!['mac-arm64', 'mac-x64', 'linux-arm64', 'linux-x64', 'win-x64'].includes(platform)) {
    throw new Error(`unsupported update platform: ${platform}`)
  }
  const assetName = `agentos-node-${normalized}-${platform}.tar.gz`
  const manifestName = `agentos-node-${normalized}-manifest.json`
  const provenanceName = `agentos-release-${normalized}-provenance.json`
  const releaseBase = (process.env.AGENT_OS_NODE_UPDATE_RELEASE_BASE ||
    `https://github.com/${safeRepo}/releases/download/v${normalized}`).replace(/\/$/, '')
  const parent = path.dirname(safePrefix)
  const base = path.basename(safePrefix)
  const stage = fs.mkdtempSync(path.join(parent, `.${base}.update-`))
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentos-node-update-'))
  const archive = path.join(downloadDir, assetName)
  try {
    const [provenance, manifest] = await Promise.all([
      fetchJson(`${releaseBase}/${provenanceName}`),
      fetchJson(`${releaseBase}/${manifestName}`)
    ])
    const validated = validateReleaseMetadata({
      version: normalized,
      platform,
      assetName,
      provenance,
      manifest
    })
    const archiveSha = await withRetries(() => downloadFile(`${releaseBase}/${assetName}`, archive))
    if (archiveSha !== validated.entry.sha256.toLowerCase()) {
      throw new Error(`archive SHA-256 mismatch for ${assetName}`)
    }
    const extracted = spawnSync('tar', ['-xzf', archive, '-C', stage], { encoding: 'utf8' })
    if (extracted.status !== 0) throw new Error(`node archive extraction failed: ${extracted.stderr || extracted.stdout}`)
    const runtimeManifestPath = path.join(stage, 'runtime-manifest.json')
    const runtimeManifest = JSON.parse(fs.readFileSync(runtimeManifestPath, 'utf8'))
    if (runtimeManifest.appVersion !== normalized || runtimeManifest.platform !== platform ||
      runtimeManifest.protocolVersion !== validated.provenance.runtimeProtocolVersion ||
      runtimeManifest.sourceRevision !== validated.provenance.sourceRevision) {
      throw new Error('archive runtime manifest does not match aggregate provenance')
    }
    const runtimeNode = path.join(stage, 'runtime', 'bin', platform === 'win-x64' ? 'node.exe' : 'node')
    const verifier = path.join(stage, 'bin', 'verify-node-runtime.cjs')
    if (!fs.existsSync(runtimeNode) || !fs.existsSync(verifier)) {
      throw new Error('archive is missing its fixed Node runtime or verifier')
    }
    const verification = spawnSync(runtimeNode, [verifier, stage, '--probe-pty'], { encoding: 'utf8' })
    if (verification.status !== 0) {
      throw new Error(`staged runtime verification failed: ${verification.stderr || verification.stdout}`)
    }
    return {
      prefix: safePrefix,
      stage,
      version: normalized,
      platform,
      protocolVersion: validated.provenance.runtimeProtocolVersion,
      sourceRevision: validated.provenance.sourceRevision,
      preparedAtMs: Date.now()
    }
  } catch (error) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw error
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true })
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`
}

function powershellQuote(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}

function unixBootstrap(plan, parentPid, scriptPath) {
  const prefix = shellQuote(plan.prefix)
  const stage = shellQuote(plan.stage)
  const backup = shellQuote(path.join(path.dirname(plan.prefix), `.${path.basename(plan.prefix)}.previous`))
  const statusFile = shellQuote(path.join(plan.prefix, 'node-status.json'))
  const plist = shellQuote(path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.lohas.agentos-node.plist'))
  const persistent = PERSISTENT_FILES.map(shellQuote).join(' ')
  const mac = plan.platform.startsWith('mac-')
  const stop = mac
    ? `launchctl unload ${plist} >/dev/null 2>&1 || true`
    : 'systemctl --user stop agentos-node.service >/dev/null 2>&1 || true'
  const start = mac
    ? `launchctl load ${plist}`
    : 'systemctl --user daemon-reload && systemctl --user start agentos-node.service'
  return `#!/bin/sh
set -eu
PREFIX=${prefix}
STAGE=${stage}
BACKUP=${backup}
STATUS_FILE=${statusFile}
VERSION=${shellQuote(plan.version)}
PROTOCOL=${plan.protocolVersion}
PREPARED_AT=${plan.preparedAtMs}
PARENT_PID=${parentPid}
SCRIPT_PATH=${shellQuote(scriptPath)}
OLD_MOVED=0
PROMOTED=0
UPDATE_OK=0

stop_service() { ${stop}; }
start_service() { ${start}; }
cleanup_update() {
  status=$?
  trap - EXIT
  set +e
  if [ "$UPDATE_OK" -ne 1 ]; then
    if [ "$PROMOTED" -eq 1 ]; then stop_service; rm -rf "$PREFIX"; fi
    if [ "$OLD_MOVED" -eq 1 ] && [ -e "$BACKUP" ]; then mv "$BACKUP" "$PREFIX"; fi
    [ ! -e "$PREFIX" ] || start_service >/dev/null 2>&1 || true
    echo "✗ 节点升级失败，已恢复上一版" >&2
    status=1
  fi
  [ "$PROMOTED" -eq 1 ] || rm -rf "$STAGE"
  rm -f "$SCRIPT_PATH"
  exit "$status"
}
trap cleanup_update EXIT
while kill -0 "$PARENT_PID" >/dev/null 2>&1; do sleep 0.1; done

stop_service
for persistent in ${persistent}; do
  [ ! -f "$PREFIX/$persistent" ] || cp -p "$PREFIX/$persistent" "$STAGE/$persistent"
done
"$STAGE/runtime/bin/node" -e 'const fs=require("fs");const f=process.argv[1],v=process.argv[2];const lines=fs.readFileSync(f,"utf8").split(/\\r?\\n/).filter(x=>x&&!x.startsWith("AGENT_OS_NODE_VERSION="));lines.push("AGENT_OS_NODE_VERSION="+v);const t=f+".update";fs.writeFileSync(t,lines.join("\\n")+"\\n",{mode:384});fs.renameSync(t,f)' "$STAGE/node.env" "$VERSION"
[ -f "$STAGE/out/main/remote-node.js" ] || { echo "✗ 升级包缺少远程节点入口" >&2; exit 1; }
[ -f "$STAGE/bin/agentos-cli.cjs" ] || { echo "✗ 升级包缺少运维 CLI" >&2; exit 1; }
cat > "$STAGE/agentos-node" <<EOF
#!/usr/bin/env sh
AGENT_OS_NODE_PREFIX="\\$(CDPATH= cd -P "\\$(dirname "\\$0")" && pwd -P)"
export AGENT_OS_NODE_PREFIX
set -a
[ ! -f "\\$AGENT_OS_NODE_PREFIX/node.env" ] || . "\\$AGENT_OS_NODE_PREFIX/node.env"
set +a
exec "\\$AGENT_OS_NODE_PREFIX/runtime/bin/node" "\\$AGENT_OS_NODE_PREFIX/out/main/remote-node.js" "\\$@"
EOF
cat > "$STAGE/agentos-cli" <<EOF
#!/usr/bin/env sh
AGENT_OS_NODE_PREFIX="\\$(CDPATH= cd -P "\\$(dirname "\\$0")" && pwd -P)"
export AGENT_OS_NODE_PREFIX
exec "\\$AGENT_OS_NODE_PREFIX/runtime/bin/node" "\\$AGENT_OS_NODE_PREFIX/bin/agentos-cli.cjs" "\\$@"
EOF
chmod +x "$STAGE/agentos-node" "$STAGE/agentos-cli"
rm -rf "$BACKUP"
mv "$PREFIX" "$BACKUP"
OLD_MOVED=1
mv "$STAGE" "$PREFIX"
PROMOTED=1
start_service

ATTEMPTS="\${AGENT_OS_UPDATE_WAIT_ATTEMPTS:-60}"
DELAY="\${AGENT_OS_UPDATE_WAIT_DELAY:-2}"
CONNECTED=0
i=0
while [ "$i" -lt "$ATTEMPTS" ]; do
  if [ -f "$STATUS_FILE" ] && "$PREFIX/runtime/bin/node" -e 'const fs=require("fs");const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const ok=s.state==="connected"&&s.hostVersion===process.argv[2]&&s.protocolVersion===Number(process.argv[3])&&Date.parse(s.updatedAt)>=Number(process.argv[4])&&Date.parse(s.adoptedAt)>=Number(process.argv[4]);process.exit(ok?0:1)' "$STATUS_FILE" "$VERSION" "$PROTOCOL" "$PREPARED_AT"; then
    CONNECTED=1
    break
  fi
  i=$((i + 1))
  [ "$i" -ge "$ATTEMPTS" ] || sleep "$DELAY"
done
[ "$CONNECTED" -eq 1 ] || exit 1
UPDATE_OK=1
echo "✓ 节点已升级到 $VERSION，主控完成 Runtime/PTY/Agent 接管确认"
`
}

function powershellBootstrap(plan, parentPid, scriptPath) {
  const backup = path.join(path.dirname(plan.prefix), `.${path.basename(plan.prefix)}.previous`)
  const statusFile = path.join(plan.prefix, 'node-status.json')
  const persistent = PERSISTENT_FILES.map(powershellQuote).join(', ')
  return `$ErrorActionPreference = "Stop"
$Prefix = ${powershellQuote(plan.prefix)}
$Stage = ${powershellQuote(plan.stage)}
$Backup = ${powershellQuote(backup)}
$StatusFile = ${powershellQuote(statusFile)}
$Version = ${powershellQuote(plan.version)}
$Protocol = ${plan.protocolVersion}
$PreparedAt = [int64]${plan.preparedAtMs}
$ParentPid = ${parentPid}
$ScriptPath = ${powershellQuote(scriptPath)}
$OldMoved = $false
$Promoted = $false
$UpdateOk = $false
$TaskName = "AgentOSNode"
try {
  Wait-Process -Id $ParentPid -ErrorAction SilentlyContinue
  schtasks /End /TN $TaskName 2>$null | Out-Null
  foreach ($Persistent in @(${persistent})) {
    $Source = Join-Path $Prefix $Persistent
    if (Test-Path $Source) { Copy-Item $Source (Join-Path $Stage $Persistent) -Force }
  }
  & (Join-Path $Stage "runtime\\bin\\node.exe") -e 'const fs=require("fs");const f=process.argv[1],v=process.argv[2];const lines=fs.readFileSync(f,"utf8").split(/\\r?\\n/).filter(x=>x&&!x.startsWith("AGENT_OS_NODE_VERSION="));lines.push("AGENT_OS_NODE_VERSION="+v);const t=f+".update";fs.writeFileSync(t,lines.join("\\n")+"\\n",{mode:384});fs.renameSync(t,f)' (Join-Path $Stage "node.env") $Version
  if ($LASTEXITCODE -ne 0) { throw "node.env version update failed" }
  if (-not (Test-Path (Join-Path $Stage "out\\main\\remote-node.js"))) { throw "升级包缺少远程节点入口" }
  if (-not (Test-Path (Join-Path $Stage "bin\\agentos-cli.cjs"))) { throw "升级包缺少运维 CLI" }
  $StageNodeCmd = Join-Path $Stage "agentos-node.cmd"
@"
@echo off
set "AGENT_OS_NODE_PREFIX=%~dp0"
for /f "usebackq tokens=1,* delims==" %%A in ("%~dp0node.env") do set "%%A=%%B"
"%~dp0runtime\\bin\\node.exe" "%~dp0out\\main\\remote-node.js" %*
"@ | Set-Content -Encoding ASCII $StageNodeCmd
  $StageCliCmd = Join-Path $Stage "agentos-cli.cmd"
@"
@echo off
set "AGENT_OS_NODE_PREFIX=%~dp0"
"%~dp0runtime\\bin\\node.exe" "%~dp0bin\\agentos-cli.cjs" %*
"@ | Set-Content -Encoding ASCII $StageCliCmd
  $StageRunner = Join-Path $Stage "run-node.cmd"
  @"
@echo off
:agentos_restart
call "%~dp0agentos-node.cmd"
timeout /t 5 /nobreak >nul
goto agentos_restart
"@ | Set-Content -Encoding ASCII $StageRunner
  if (Test-Path $Backup) { Remove-Item $Backup -Recurse -Force }
  Move-Item $Prefix $Backup
  $OldMoved = $true
  Move-Item $Stage $Prefix
  $Promoted = $true
  schtasks /Run /TN $TaskName | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "scheduled task start failed" }
  $Attempts = if ($env:AGENT_OS_UPDATE_WAIT_ATTEMPTS) { [int]$env:AGENT_OS_UPDATE_WAIT_ATTEMPTS } else { 60 }
  $Delay = if ($env:AGENT_OS_UPDATE_WAIT_DELAY) { [int]$env:AGENT_OS_UPDATE_WAIT_DELAY } else { 2 }
  $Connected = $false
  for ($Attempt = 0; $Attempt -lt $Attempts; $Attempt++) {
    if (Test-Path $StatusFile) {
      try {
        $Status = Get-Content $StatusFile -Raw | ConvertFrom-Json
        $Updated = [DateTimeOffset]::Parse($Status.updatedAt).ToUnixTimeMilliseconds()
        $Adopted = [DateTimeOffset]::Parse($Status.adoptedAt).ToUnixTimeMilliseconds()
        if ($Status.state -eq "connected" -and $Status.hostVersion -eq $Version -and [int]$Status.protocolVersion -eq $Protocol -and $Updated -ge $PreparedAt -and $Adopted -ge $PreparedAt) { $Connected = $true; break }
      } catch {}
    }
    if ($Attempt + 1 -lt $Attempts) { Start-Sleep -Seconds $Delay }
  }
  if (-not $Connected) { throw "controller adoption acknowledgement timed out" }
  $UpdateOk = $true
  Write-Host "✓ 节点已升级到 $Version，主控完成 Runtime/PTY/Agent 接管确认"
} catch {
  if ($Promoted) {
    schtasks /End /TN $TaskName 2>$null | Out-Null
    if (Test-Path $Prefix) { Remove-Item $Prefix -Recurse -Force }
  }
  if ($OldMoved -and (Test-Path $Backup)) { Move-Item $Backup $Prefix }
  if (Test-Path $Prefix) { schtasks /Run /TN $TaskName 2>$null | Out-Null }
  Write-Error "节点升级失败，已恢复上一版：$($_.Exception.Message)"
  exit 1
} finally {
  if (-not $Promoted -and (Test-Path $Stage)) { Remove-Item $Stage -Recurse -Force }
  Remove-Item $ScriptPath -Force -ErrorAction SilentlyContinue
}
`
}

function launchPreparedUpdate(plan) {
  const suffix = randomBytes(6).toString('hex')
  const windows = plan.platform === 'win-x64'
  const scriptPath = path.join(os.tmpdir(), `agentos-node-update-${suffix}.${windows ? 'ps1' : 'sh'}`)
  const body = windows
    ? powershellBootstrap(plan, process.pid, scriptPath)
    : unixBootstrap(plan, process.pid, scriptPath)
  fs.writeFileSync(scriptPath, body, { mode: windows ? 0o600 : 0o700 })
  const command = windows ? 'powershell.exe' : 'sh'
  const args = windows
    ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath]
    : [scriptPath]
  const child = spawn(command, args, { stdio: 'inherit', windowsHide: false })
  child.once('error', () => {
    fs.rmSync(scriptPath, { force: true })
    fs.rmSync(plan.stage, { recursive: true, force: true })
  })
  child.unref()
  return { pid: child.pid, scriptPath }
}

module.exports = {
  latestVersion,
  prepareNodeUpdate,
  launchPreparedUpdate,
  validateReleaseMetadata,
  unixBootstrap,
  powershellBootstrap
}
