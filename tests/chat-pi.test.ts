import { describe, expect, it } from 'vitest'
import { createPiParser } from '../src/main/domains/adapters/pi/control'

describe('Pi native event lifecycle (SPEC-052)', () => {
  it('waits through tool turns for agent_end and preserves final text', () => {
    const parser = createPiParser()
    const parse = (event: unknown) => parser.parse(JSON.stringify(event))
    expect(parse({ type: 'session', id: 'pi-test' })).toEqual([
      { kind: 'session-bound', nativeSessionId: 'pi-test' }
    ])
    expect(parse({ type: 'session', id: 'pi-test' })).toEqual([])
    for (const id of ['list', 'read']) {
      const start = {
        type: 'tool_execution_start',
        toolCallId: id,
        toolName: 'read',
        args: { path: 'README.md' }
      }
      expect(parse(start)).toEqual([
        { kind: 'tool-start', toolUseId: id, toolName: 'read', input: { path: 'README.md' } }
      ])
      expect(parse(start)).toEqual([])
      const end = {
        type: 'tool_execution_end',
        toolCallId: id,
        result: { content: [{ type: 'text', text: 'public content' }] },
        isError: false
      }
      expect(parse(end)).toEqual([
        { kind: 'tool-result', toolUseId: id, content: 'public content', isError: false }
      ])
      expect(parse(end)).toEqual([])
      expect(
        parse({ type: 'turn_end', message: { stopReason: 'toolUse' }, toolResults: [] })
      ).toEqual([])
    }
    expect(
      parse({
        type: 'message_update',
        assistantMessageEvent: { type: 'text_delta', delta: '最终功能表' }
      })
    ).toEqual([{ kind: 'text-delta', text: '最终功能表' }])
    expect(parse({ type: 'turn_end', message: { stopReason: 'stop' } })).toEqual([])
    expect(parse({ type: 'agent_end', messages: [] })).toEqual([
      { kind: 'turn-end', status: 'completed' }
    ])
    expect(parse({ type: 'agent_end', messages: [] })).toEqual([])
  })

  it('retains tool errors and tolerates non-text or malformed payloads', () => {
    const parser = createPiParser()
    expect(
      parser.parse(
        JSON.stringify({
          type: 'tool_execution_end',
          toolCallId: 'bad',
          isError: true,
          result: {
            content: [
              null,
              { type: 'image', data: 'not-for-text' },
              { type: 'text', text: 'denied' }
            ]
          }
        })
      )
    ).toEqual([{ kind: 'tool-result', toolUseId: 'bad', content: 'denied', isError: true }])
    expect(
      parser.parse(JSON.stringify({ type: 'tool_execution_end', toolCallId: 'empty' }))
    ).toEqual([{ kind: 'tool-result', toolUseId: 'empty', content: '', isError: false }])
    expect(parser.parse('null')).toEqual([])
    expect(parser.parse('{}')).toEqual([])
    expect(parser.parse('{')).toEqual([{ kind: 'unknown', rawType: 'invalid-json', payload: '{' }])
  })

  it('preserves thinking and legacy tool-event compatibility', () => {
    const parser = createPiParser()
    const update = (event: unknown) =>
      parser.parse(JSON.stringify({ type: 'message_update', assistantMessageEvent: event }))
    expect(update({ type: 'thinking_delta', delta: '分析' })).toEqual([
      { kind: 'thinking-delta', text: '分析' }
    ])
    expect(
      update({
        type: 'tool_use_start',
        partial: { content: [{ type: 'tool_use', id: 'legacy', name: 'Read', input: {} }] }
      })
    ).toEqual([{ kind: 'tool-start', toolUseId: 'legacy', toolName: 'Read', input: {} }])
    expect(
      update({ type: 'tool_result', tool_use_id: 'legacy', content: 'ok', is_error: false })
    ).toEqual([{ kind: 'tool-result', toolUseId: 'legacy', content: 'ok', isError: false }])
  })
})
