import type { HeadlessTurnInput, HeadlessTurnLaunch, HeadlessTurnParser } from '../types'
import { assertAttachmentsSupported } from '../attachments'
import { composeStdinPrompt } from '../headless-utils'
import { createPlainTextParser } from '../plain-text-control'

export function buildHermesHeadlessTurn(input: HeadlessTurnInput): HeadlessTurnLaunch {
  const args = ['chat', '--query', composeStdinPrompt(input), '--quiet', '--source', 'agent-os']

  if (input.model && input.model !== 'default') {
    args.push('--model', input.model)
  }
  if (input.nativeSessionId) {
    args.push('--resume', input.nativeSessionId)
  }
  if (input.permissionPreset === 'auto') {
    args.push('--yolo')
  }
  const attachmentCapabilities = {
    images: true,
    files: false,
    maxFiles: 1,
    allowedExtensions: ['jpg', 'jpeg', 'png', 'gif', 'webp']
  }
  assertAttachmentsSupported('Hermes', attachmentCapabilities, input.files)
  if (input.files?.[0]) args.push('--image', input.files[0])

  return {
    command: 'hermes',
    args,
    env: {}
  }
}

export function createHermesParser(): HeadlessTurnParser {
  return createPlainTextParser({ adapterName: 'Hermes' })
}
