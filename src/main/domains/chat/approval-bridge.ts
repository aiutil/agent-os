import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface ApprovalHookInput {
  turnId: string
  sessionId?: string
  toolUseId: string
  toolName: string
  toolInput: unknown
  permissionSuggestions: unknown[]
}

export type ApprovalHookDecision = 'allow' | 'deny' | 'defer'

export interface ApprovalBridge {
  url: string
  close(): Promise<void>
}

interface ApprovalBridgeOptions {
  token: string
  handle(input: ApprovalHookInput): Promise<ApprovalHookDecision>
}

function responseBody(decision: ApprovalHookDecision): object {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason:
        decision === 'deny'
          ? '用户在 Agent OS 中拒绝了本次工具调用'
          : decision === 'allow'
            ? '用户已在 Agent OS 中批准'
            : '等待用户在 Agent OS 中审批'
    }
  }
}

function writeJson(response: ServerResponse, status: number, body: object): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

export async function startApprovalBridge(options: ApprovalBridgeOptions): Promise<ApprovalBridge> {
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/permission') {
        writeJson(response, 404, { error: 'not found' })
        return
      }
      if (request.headers.authorization !== `Bearer ${options.token}`) {
        writeJson(response, 401, { error: 'unauthorized' })
        return
      }
      const turnId = String(request.headers['x-agent-os-turn'] ?? '')
      if (!turnId) {
        writeJson(response, 400, { error: 'missing turn id' })
        return
      }
      try {
        const body = await readJson(request)
        const decision = await options.handle({
          turnId,
          sessionId: typeof body.session_id === 'string' ? body.session_id : undefined,
          toolUseId: String(body.tool_use_id ?? ''),
          toolName: String(body.tool_name ?? ''),
          toolInput: body.tool_input,
          permissionSuggestions: Array.isArray(body.permission_suggestions)
            ? body.permission_suggestions
            : []
        })
        writeJson(response, 200, responseBody(decision))
      } catch (error) {
        writeJson(response, 500, {
          error: error instanceof Error ? error.message : String(error)
        })
      }
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('审批桥端口分配失败')
  }
  return {
    url: `http://127.0.0.1:${address.port}/permission`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
      })
  }
}
