import type { TranscriptUsageFact } from '@shared/types'

interface ModelPricing {
  pattern: RegExp
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

// 美元 / 百万 token。仅匹配已核验的官方模型别名，未知模型不猜价。
const MODEL_PRICING: ModelPricing[] = [
  {
    pattern: /^claude-(?:3-5-)?sonnet-4-(?:5|6)(?:-|$)/,
    input: 3,
    output: 15,
    cacheWrite: 3.75,
    cacheRead: 0.3
  },
  {
    pattern: /^claude-(?:3-5-)?haiku-4-5(?:-|$)/,
    input: 1,
    output: 5,
    cacheWrite: 1.25,
    cacheRead: 0.1
  },
  {
    pattern: /^claude-(?:3-5-)?opus-4-(?:5|6|7|8)(?:-|$)/,
    input: 5,
    output: 25,
    cacheWrite: 6.25,
    cacheRead: 0.5
  }
]

export function estimateUsageCost(fact: TranscriptUsageFact): number | null {
  if (!fact.model) return null
  const pricing = MODEL_PRICING.find((item) => item.pattern.test(fact.model!))
  if (!pricing) return null
  const tokens = fact.tokens
  return (
    (tokens.input * pricing.input +
      tokens.output * pricing.output +
      tokens.cacheWrite * pricing.cacheWrite +
      tokens.cacheRead * pricing.cacheRead) /
    1_000_000
  )
}
