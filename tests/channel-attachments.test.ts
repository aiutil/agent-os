import { access, readFile, readdir, stat, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_CHANNEL_ATTACHMENT_BYTES,
  MAX_CHANNEL_ATTACHMENTS_TOTAL_BYTES,
  cleanupStaleChannelAttachments,
  materializeAttachments,
  nodeStreamToLimitedBuffer,
  responseToLimitedBuffer,
  safeAttachmentFilename
} from '../src/main/domains/channels/attachments'
import { Readable } from 'node:stream'

describe('SPEC-034 渠道临时附件安全门禁', () => {
  it('去除路径穿越、控制字符并为同名文件添加稳定序号', () => {
    expect(safeAttachmentFilename('../../secret\u0000.txt', 0, 'file')).toBe('01-secret.txt')
    expect(safeAttachmentFilename('..\\..\\photo.png', 1, 'image')).toBe('02-photo.png')
    expect(safeAttachmentFilename(undefined, 2, 'voice', 'audio/ogg')).toBe('03-voice.ogg')
  })

  it('写入仅当前用户可读写的临时目录，并由幂等 cleanup 完整移除', async () => {
    const batch = await materializeAttachments([{
      kind: 'image',
      filename: '../diagram.png',
      mimeType: 'image/png',
      declaredBytes: 4,
      load: async () => ({ buffer: Buffer.from('test') })
    }])
    expect(batch).not.toBeNull()
    const file = batch!.files[0]
    expect(await readFile(file, 'utf8')).toBe('test')
    if (process.platform !== 'win32') {
      expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)
      expect((await stat(file)).mode & 0o777).toBe(0o600)
    }
    await batch!.cleanup()
    await batch!.cleanup()
    await expect(access(file)).rejects.toThrow()
  })

  it('数量或声明大小超限时在下载前拒绝', async () => {
    const load = vi.fn(async () => ({ buffer: Buffer.from('x') }))
    const six = Array.from({ length: 6 }, () => ({ kind: 'file' as const, load }))
    await expect(materializeAttachments(six)).rejects.toThrow('最多处理 5 个')
    await expect(materializeAttachments([{
      kind: 'file',
      declaredBytes: MAX_CHANNEL_ATTACHMENT_BYTES + 1,
      load
    }])).rejects.toThrow('单个附件不能超过 20 MiB')
    expect(load).not.toHaveBeenCalled()
  })

  it('50 MiB 合计门禁在任何下载前拒绝', async () => {
    const load = vi.fn(async () => ({ buffer: Buffer.from('x') }))
    const declaredBytes = Math.floor(MAX_CHANNEL_ATTACHMENTS_TOTAL_BYTES / 3) + 1
    await expect(materializeAttachments(Array.from({ length: 3 }, () => ({
      kind: 'file' as const,
      declaredBytes,
      load
    })))).rejects.toThrow('附件合计不能超过 50 MiB')
    expect(load).not.toHaveBeenCalled()
  })

  it('响应流实际字节超过限制时立即拒绝，不信任 Content-Length 缺失', async () => {
    const response = new Response(Buffer.from('123456'))
    await expect(responseToLimitedBuffer(response, 5)).rejects.toThrow('附件超过允许大小')
  })

  it('飞书等 Node 附件流长时间无数据时主动超时销毁', async () => {
    const stream = new Readable({ read() {} })
    await expect(nodeStreamToLimitedBuffer(stream, 10, 5)).rejects.toThrow('附件下载超时')
    expect(stream.destroyed).toBe(true)
  })

  it('批次中途失败会清理先前已写入的文件', async () => {
    let writtenFile = ''
    await expect(materializeAttachments([
      { kind: 'file', filename: 'ok.txt', load: async () => ({ buffer: Buffer.from('ok') }) },
      {
        kind: 'file',
        filename: 'bad.txt',
        load: async () => {
          const directories = (await readdir(tmpdir())).filter((name) => name.startsWith('agentos-channel-'))
          for (const directory of directories) {
            const candidate = join(tmpdir(), directory, '01-ok.txt')
            try {
              await access(candidate)
              writtenFile = candidate
              break
            } catch {
              // 不是本测试刚写入的批次。
            }
          }
          throw new Error('download failed')
        }
      }
    ])).rejects.toThrow('download failed')
    expect(writtenFile).not.toBe('')
    await expect(access(writtenFile)).rejects.toThrow()
  })

  it('启动清理只删除超过 24 小时的 Agent OS 渠道临时目录', async () => {
    const old = await materializeAttachments([{
      kind: 'file',
      filename: 'old.txt',
      load: async () => ({ buffer: Buffer.from('old') })
    }])
    const recent = await materializeAttachments([{
      kind: 'file',
      filename: 'recent.txt',
      load: async () => ({ buffer: Buffer.from('recent') })
    }])
    const oldDirectory = dirname(old!.files[0])
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000)
    await utimes(oldDirectory, twoDaysAgo, twoDaysAgo)

    await cleanupStaleChannelAttachments()
    await expect(access(old!.files[0])).rejects.toThrow()
    expect(await readFile(recent!.files[0], 'utf8')).toBe('recent')
    await recent!.cleanup()
  })
})
