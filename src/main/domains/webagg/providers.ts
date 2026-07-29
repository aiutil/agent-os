// 内置 Web AI provider 声明（SPEC-011）。
// inputAdapter 选择器会随站点更新漂移 → 失败显式可见，不静默。

import type { WebProvider } from '@shared/types'

export const BUILTIN_PROVIDERS: WebProvider[] = [
  {
    id: 'claude-web',
    name: 'Claude (Web)',
    url: 'https://claude.ai',
    builtin: true,
    loginProbeUrl: '/login',
    inputAdapter: {
      fillSelector: 'div[contenteditable="true"][data-testid="composer-editor"]',
      sendMethod: 'enter'
    }
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    url: 'https://chatgpt.com',
    builtin: true,
    loginProbeUrl: '/auth/login',
    inputAdapter: {
      fillSelector: '#prompt-textarea',
      sendMethod: 'enter'
    }
  },
  {
    id: 'doubao',
    name: '豆包',
    url: 'https://www.doubao.com/chat',
    builtin: true,
    loginProbeUrl: '/login',
    inputAdapter: {
      fillSelector: 'textarea[placeholder]',
      sendMethod: 'enter'
    }
  },
  {
    id: 'yuanbao',
    name: '元宝',
    url: 'https://yuanbao.tencent.com',
    builtin: true,
    loginProbeUrl: '/login',
    inputAdapter: {
      fillSelector: 'textarea',
      sendMethod: 'enter'
    }
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://www.github.com',
    builtin: true
  },
  {
    id: 'skills-sh',
    name: 'Skills',
    url: 'https://www.skills.sh',
    builtin: true
  },
  {
    id: 'agent-life',
    name: 'Agent Life',
    url: 'https://agentos.aiutil.com/',
    builtin: true
  }
]

export function getProvider(id: string): WebProvider | undefined {
  return BUILTIN_PROVIDERS.find((p) => p.id === id)
}
