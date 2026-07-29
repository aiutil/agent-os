import type { HeadlessTurnInput, HeadlessTurnLaunch, HeadlessTurnParser } from '../types'
import { composeStdinPrompt } from '../headless-utils'
import { createPlainTextParser } from '../plain-text-control'

export function buildOpenClawHeadlessTurn(input: HeadlessTurnInput): HeadlessTurnLaunch {
  const args = ['chat', '--prompt', composeStdinPrompt(input)]

  if (input.model && input.model !== 'default') {
    args.push('--model', input.model)
  }
  if (input.nativeSessionId) {
    args.push('--resume', input.nativeSessionId)
  }
  if (input.permissionPreset === 'auto') {
    args.push('--yolo')
  }

  return {
    command: 'openclaw',
    args,
    env: {}
  }
}

export function createOpenClawParser(): HeadlessTurnParser {
  return createPlainTextParser({ adapterName: 'OpenClaw' })
}
