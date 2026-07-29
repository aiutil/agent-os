#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import type { MemoryEvidence, MemoryStatus, ProposeMemoryInput } from '@shared/types'
import { MemoryVault } from './domains/memory/vault'
import { memoryVaultPath } from './domains/memory/paths'

interface JsonRpcRequest {
  jsonrpc?: string
  id?: string | number | null
  method?: string
  params?: unknown
}

function stringFlag(args: string[], name: string, fallback = ''): string {
  const index = args.indexOf(name)
  return index >= 0 ? (args[index + 1] ?? fallback) : fallback
}

function optionalFlag(args: string[], name: string): string | undefined {
  const value = stringFlag(args, name)
  return value || undefined
}

function evidenceOf(value: string | undefined): MemoryEvidence[] {
  if (!value) return [{ sourceType: 'agent', sourceId: 'agent-os-memory-cli' }]
  const [sourceType, ...rest] = value.split(':')
  const sourceId = rest.join(':')
  if (!sourceId || !['session', 'file', 'manual', 'agent'].includes(sourceType)) {
    throw new Error('evidence 格式必须是 session:<id>、file:<path>、manual:<id> 或 agent:<id>')
  }
  return [{ sourceType: sourceType as MemoryEvidence['sourceType'], sourceId }]
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function usage(): string {
  return [
    'Agent OS Memory CLI',
    '',
    'agent-os-memory context --cwd <dir> --task <text> [--agent <id>] [--budget <tokens>]',
    'agent-os-memory search --query <text> [--status active,candidate]',
    'agent-os-memory propose --kind <kind> --title <title> --content <text> --scope <scope> [--scope-ref <value>] [--evidence session:<id>]',
    'agent-os-memory update --id <memoryId> [--kind <kind>] [--title <title>] [--content <text>] [--scope <scope>] [--scope-ref <value>] [--tags <a,b>]',
    'agent-os-memory forget --id <memoryId>',
    'agent-os-memory feedback --id <memoryId> --outcome useful|stale|wrong [--agent <id>]',
    'agent-os-memory mcp',
    'agent-os-memory with-memory --cwd <dir> --task <text> [--agent <id>] -- <command> [...args]'
  ].join('\n')
}

async function runMcp(vault: MemoryVault): Promise<void> {
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of input) {
    if (!line.trim()) continue
    let request: JsonRpcRequest
    try {
      request = JSON.parse(line) as JsonRpcRequest
    } catch {
      writeJson({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
      continue
    }
    if (!request.method) continue
    try {
      const result = await mcpResult(vault, request.method, request.params)
      if (request.id !== undefined) writeJson({ jsonrpc: '2.0', id: request.id, result })
    } catch (error) {
      if (request.id !== undefined) {
        writeJson({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: errorText(error) } })
      }
    }
  }
}

async function mcpResult(vault: MemoryVault, method: string, params: unknown): Promise<unknown> {
  if (method === 'initialize') {
    return {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-os-memory', version: '0.2.5' }
    }
  }
  if (method === 'notifications/initialized') return undefined
  if (method === 'ping') return {}
  if (method === 'tools/list') {
    return {
      tools: [
        { name: 'memory_context', description: '获得当前任务可安全注入的长期记忆', inputSchema: { type: 'object', required: ['cwd', 'task'], properties: { cwd: { type: 'string' }, task: { type: 'string' }, agentId: { type: 'string' }, tokenBudget: { type: 'number' } } } },
        { name: 'memory_search', description: '检索已确认或候选长期记忆', inputSchema: { type: 'object', properties: { query: { type: 'string' }, statuses: { type: 'array', items: { type: 'string' } } } } },
        { name: 'memory_propose', description: '提议一条候选长期记忆；不会直接生效', inputSchema: { type: 'object', required: ['kind', 'title', 'content', 'scope'], properties: { kind: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' }, scope: { type: 'string' }, scopeRef: { type: 'string' } } } },
        { name: 'memory_feedback', description: '反馈记忆是否有用或已过时', inputSchema: { type: 'object', required: ['memoryId', 'outcome'], properties: { memoryId: { type: 'string' }, outcome: { type: 'string' }, agentId: { type: 'string' } } } }
      ]
    }
  }
  if (method === 'tools/call') {
    const call = params as { name?: string; arguments?: Record<string, unknown> }
    const args = call.arguments ?? {}
    let result: unknown
    if (call.name === 'memory_context') result = vault.context(args as unknown as Parameters<MemoryVault['context']>[0])
    else if (call.name === 'memory_search') result = vault.list(args)
    else if (call.name === 'memory_propose') result = vault.propose(args as unknown as ProposeMemoryInput)
    else if (call.name === 'memory_feedback') {
      vault.feedback(args as unknown as Parameters<MemoryVault['feedback']>[0])
      result = { ok: true }
    } else throw new Error(`未知 memory tool: ${call.name ?? ''}`)
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
  }
  throw new Error(`不支持的 MCP method: ${method}`)
}

async function withMemory(vault: MemoryVault, args: string[]): Promise<void> {
  const separator = args.indexOf('--')
  if (separator < 0 || separator === args.length - 1) throw new Error('with-memory 需要在 -- 后提供要启动的命令')
  const command = args[separator + 1]!
  const commandArgs = args.slice(separator + 2)
  const cwd = stringFlag(args, '--cwd', process.cwd())
  const task = stringFlag(args, '--task', '')
  const agentId = optionalFlag(args, '--agent')
  const context = vault.context({ cwd, task, ...(agentId ? { agentId } : {}) })
  const tempDir = mkdtempSync(join(tmpdir(), 'agent-os-memory-'))
  const contextPath = join(tempDir, 'context.md')
  writeFileSync(contextPath, context.text, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(contextPath, 0o600) } catch { /* best effort on non-POSIX filesystems */ }
  try {
    const child = spawn(command, commandArgs, {
      cwd,
      stdio: 'inherit',
      env: {
        ...process.env,
        AGENT_OS_MEMORY_CONTEXT_FILE: contextPath,
        AGENT_OS_MEMORY_CONTEXT: context.text,
        AGENT_OS_MEMORY_AGENT_ID: agentId ?? ''
      }
    })
    const code = await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', (exitCode) => resolve(exitCode ?? 1))
    })
    process.exitCode = code
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]
  const vault = new MemoryVault(memoryVaultPath())
  try {
    if (!command || command === '--help' || command === '-h') {
      process.stdout.write(`${usage()}\n`)
      return
    }
    if (command === 'mcp') return runMcp(vault)
    if (command === 'context') {
      writeJson(vault.context({ cwd: stringFlag(args, '--cwd', process.cwd()), task: stringFlag(args, '--task', ''), ...(optionalFlag(args, '--agent') ? { agentId: optionalFlag(args, '--agent') } : {}), ...(optionalFlag(args, '--budget') ? { tokenBudget: Number(optionalFlag(args, '--budget')) } : {}) }))
      return
    }
    if (command === 'search') {
      const statuses = optionalFlag(args, '--status')?.split(',').filter(Boolean)
      writeJson(vault.list({ query: stringFlag(args, '--query', ''), ...(statuses ? { statuses: statuses as MemoryStatus[] } : {}) }))
      return
    }
    if (command === 'propose') {
      writeJson(vault.propose({
        kind: stringFlag(args, '--kind') as ProposeMemoryInput['kind'],
        title: stringFlag(args, '--title'),
        content: stringFlag(args, '--content'),
        scope: stringFlag(args, '--scope') as ProposeMemoryInput['scope'],
        ...(optionalFlag(args, '--scope-ref') ? { scopeRef: optionalFlag(args, '--scope-ref') } : {}),
        evidence: evidenceOf(optionalFlag(args, '--evidence'))
      }))
      return
    }
    if (command === 'update') {
      const tags = optionalFlag(args, '--tags')?.split(',').map((tag) => tag.trim()).filter(Boolean)
      writeJson(vault.update(stringFlag(args, '--id'), {
        ...(optionalFlag(args, '--kind') ? { kind: optionalFlag(args, '--kind') as ProposeMemoryInput['kind'] } : {}),
        ...(optionalFlag(args, '--title') ? { title: optionalFlag(args, '--title') } : {}),
        ...(optionalFlag(args, '--content') ? { content: optionalFlag(args, '--content') } : {}),
        ...(optionalFlag(args, '--scope') ? { scope: optionalFlag(args, '--scope') as ProposeMemoryInput['scope'] } : {}),
        ...(args.includes('--scope-ref') ? { scopeRef: optionalFlag(args, '--scope-ref') ?? null } : {}),
        ...(tags ? { tags } : {})
      }))
      return
    }
    if (command === 'forget') {
      vault.forget(stringFlag(args, '--id'))
      writeJson({ ok: true })
      return
    }
    if (command === 'feedback') {
      vault.feedback({
        memoryId: stringFlag(args, '--id'),
        outcome: stringFlag(args, '--outcome') as 'useful' | 'stale' | 'wrong',
        ...(optionalFlag(args, '--agent') ? { agentId: optionalFlag(args, '--agent') } : {})
      })
      writeJson({ ok: true })
      return
    }
    if (command === 'with-memory') return withMemory(vault, args.slice(1))
    throw new Error(`未知命令：${command}`)
  } finally {
    if (command !== 'mcp') vault.close()
  }
}

void main().catch((error) => {
  process.stderr.write(`agent-os-memory: ${errorText(error)}\n`)
  process.exitCode = 1
})
