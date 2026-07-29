// Synthetic Claude control-channel fixture for SPEC-016 integration tests.
/* global fetch, process */
const args = process.argv.slice(2)
const settingsIndex = args.indexOf('--settings')
const settings = JSON.parse(args[settingsIndex + 1])
const hook = settings.hooks.PreToolUse[0].hooks[0]
const resumed = args.includes('--resume')
const headers = {
  authorization: `Bearer ${process.env.AGENT_OS_APPROVAL_TOKEN}`,
  'x-agent-os-turn': process.env.AGENT_OS_CHAT_TURN_ID,
  'content-type': 'application/json'
}

function write(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

async function main() {
  write({
    type: 'system',
    subtype: 'init',
    session_id: 'mock-native-session',
    model: 'mock-claude'
  })
  if (!resumed) {
    write({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'mock-edit-1',
            name: 'Edit',
            input: { file_path: '/tmp/mock.ts' }
          }
        ]
      }
    })
  }

  const response = await fetch(hook.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      hook_event_name: 'PreToolUse',
      session_id: 'mock-native-session',
      tool_use_id: 'mock-edit-1',
      tool_name: 'Edit',
      tool_input: { file_path: '/tmp/mock.ts' }
    })
  })
  const body = await response.json()
  const decision = body.hookSpecificOutput.permissionDecision
  if (decision === 'defer') {
    write({ type: 'result', subtype: 'success', stop_reason: 'tool_deferred' })
    return
  }
  write({
    type: 'user',
    message: {
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'mock-edit-1',
          content: 'updated',
          is_error: decision !== 'allow'
        }
      ]
    }
  })
  write({
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: '完成' }
    }
  })
  write({ type: 'result', subtype: 'success', total_cost_usd: 0 })
}

main().catch((error) => {
  process.stderr.write(String(error))
  process.exitCode = 1
})
