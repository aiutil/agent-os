// 标签编辑器（SPEC-025）。会话/消息共用：chip 列表 + 输入 + 已用标签补全。
// 组件内部维护草稿，关闭时通过 annotationsStore 写入（乐观更新）。

import { useEffect, useMemo, useState } from 'react'
import { Modal } from '../../../lib/ui/Modal'
import { useAnnotationsStore } from '../../../stores/annotationsStore'
import { annotationTargetKey } from '@shared/types'
import type { AnnotationDisplayMeta, AnnotationTargetRef } from '@shared/types'
import { useT } from '../../../lib/i18n'

interface TagEditorProps {
  open: boolean
  /** 注意：不能用 `ref`（React 保留 prop），故命名 targetRef。 */
  targetRef: AnnotationTargetRef | null
  title: string
  /** 展示快照（标题/预览 + toolId），随标签写入，供收藏页渲染。 */
  meta?: AnnotationDisplayMeta
  onClose(): void
}

export function TagEditor({ open, targetRef, title, meta, onClose }: TagEditorProps): React.JSX.Element | null {
  const { t } = useT()
  // 订阅稳定引用（entries Map），再用 key 读取，避免 selector 每次返回新对象触发 getSnapshot 死循环。
  const entries = useAnnotationsStore((s) => s.entries)
  const tagCounts = useAnnotationsStore((s) => s.tagCounts)
  const setTags = useAnnotationsStore((s) => s.setTags)
  const refreshTags = useAnnotationsStore((s) => s.refreshTags)
  const load = useAnnotationsStore((s) => s.load)
  const targetKey = targetRef ? annotationTargetKey(targetRef) : null
  const annotation = (targetKey ? entries.get(targetKey) : undefined) ?? { favorite: false, tags: [] }
  const [draft, setDraft] = useState<string[]>([])
  const [input, setInput] = useState('')

  // 每次打开对齐当前标注草稿 + 预取标签计数。
  useEffect(() => {
    if (!open || !targetRef) return
      void load(targetRef)
      void refreshTags()
      setDraft(annotation.tags)
      setInput('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetRef])

  const addTag = (): void => {
    const value = input.trim()
    if (!value) return
    if (draft.some((t) => t.toLowerCase() === value.toLowerCase())) {
      setInput('')
      return
    }
    setDraft([...draft, value])
    setInput('')
  }

  const removeTag = (tag: string): void => {
    setDraft(draft.filter((t) => t.toLowerCase() !== tag.toLowerCase()))
  }

  const suggestions = useMemo(() => {
    const used = new Set(draft.map((t) => t.toLowerCase()))
    return tagCounts
      .filter((c) => !used.has(c.tag.toLowerCase()))
      .slice(0, 12)
      .map((c) => c.tag)
  }, [draft, tagCounts])

  const tagsForSave = (): string[] => {
    const value = input.trim()
    if (!value || draft.some((t) => t.toLowerCase() === value.toLowerCase())) return draft
    return [...draft, value]
  }

  const save = (): void => {
    if (targetRef) void setTags(targetRef, tagsForSave(), meta)
    onClose()
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <div className="tag-editor__footer">
          <button type="button" className="tag-editor__action" onClick={onClose}>
            {t('common.action.cancel')}
          </button>
          <button type="button" className="tag-editor__action tag-editor__action--primary" onClick={save}>
            {t('common.action.save')}
          </button>
        </div>
      }
    >
      <div className="tag-editor">
        <div className="tag-editor__chips">
          {draft.length === 0 ? (
            <span className="tag-editor__empty">{t('memory.tagEditor.empty')}</span>
          ) : (
            draft.map((tag) => (
              <span key={tag} className="chat-attached-chip">
                <span className="tag-editor__chip-text">{tag}</span>
                <button
                  type="button"
                  className="chat-attached-chip__remove"
                  aria-label={t('memory.tagEditor.removeTagAria', { tag })}
                  onClick={() => removeTag(tag)}
                >
                  ×
                </button>
              </span>
            ))
          )}
        </div>
        <input
          className="tag-editor__input"
          placeholder={t('memory.tagEditor.placeholder')}
          value={input}
          autoFocus
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addTag()
            } else if (e.key === 'Backspace' && !input && draft.length > 0) {
              removeTag(draft[draft.length - 1]!)
            }
          }}
        />
        {suggestions.length > 0 ? (
          <div className="tag-editor__suggestions">
            {suggestions.map((tag) => (
              <button
                key={tag}
                type="button"
                className="tag-editor__suggestion"
                onClick={() => {
                  setDraft([...draft, tag])
                }}
              >
                + {tag}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </Modal>
  )
}
