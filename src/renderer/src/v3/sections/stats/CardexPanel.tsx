// 成长页（Cardex）— 完整卡牌图鉴系统，移植自 agent-life。
// 等级卡、能力维度、节律热力图、卡牌库、装备槽、卡牌详情。

import { useEffect, useId, useMemo, useRef, useState } from 'react'
import {
  Brain, CalendarThirty, Close, Command, Crown, Cube,
  Fire, Lightning, Lock, Memory as MemoryIcon, Right,
  Star, Terminal, UserPositioning
} from '@icon-park/react'
import type { StatsGrowth, StatsActivity } from '@shared/types'
import type { Dictionary, KeyPath, Vars } from '@shared/i18n'
import { useT } from '../../../lib/i18n'
import { useDialogFocus, useScrollLock } from '../../../lib/ui'
import { heatLevel } from '../../../lib/heatmap'
import './growth.css'

type TFunc = (key: KeyPath<Dictionary>, vars?: Vars) => string

// ─── Cardex 类型 ────────────────────────────────────────────────────────────

type CardSeries = 'interaction' | 'session' | 'cri' | 'memory' | 'workbench' | 'evolution' | 'rhythm' | 'persona'
type CardRarity = 'common' | 'rare' | 'epic' | 'legendary' | 'mythic'

interface LifeCard {
  id: string
  title: string
  series: CardSeries
  rarity: CardRarity
  metric: number
  target: number
  hint: string
  flavor: string
  hidden?: boolean
  artIndex?: number
}

const SERIES_ICON: Record<CardSeries, typeof Brain> = {
  interaction: Lightning,
  session: Command,
  cri: Terminal,
  memory: MemoryIcon,
  workbench: Cube,
  evolution: Crown,
  rhythm: CalendarThirty,
  persona: UserPositioning
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function pct(value: number, target: number): number {
  return Math.max(0, Math.min(100, Math.round((value / Math.max(1, target)) * 100)))
}

function makeCard(
  id: string, title: string, series: CardSeries, rarity: CardRarity,
  metric: number, target: number, hint: string, flavor: string, hidden = false
): LifeCard {
  return { id, title, series, rarity, metric, target, hint, flavor, hidden }
}

/** 从 growth + activity 数据构建卡牌目录（文案走 i18n） */
function createCardCatalog(
  growth: StatsGrowth,
  activity: StatsActivity,
  t: TFunc
): LifeCard[] {
  const interactions = activity.totalPrompts
  const sessions = activity.byTool.reduce((s, t2) => s + t2.sessions, 0)
  const cri = activity.byTool
    .filter(t2 => ['claude', 'codex', 'gemini', 'opencode'].includes(t2.key))
    .reduce((s, t2) => s + t2.prompts, 0)
  const memories = growth.memoriesCount ?? 0
  const activeDays = activity.activeDays
  // Workbench: count distinct CLI tools the user has actually used (sessions > 0)
  const customWeb = activity.byTool.filter(t2 => t2.sessions > 0).length
  // Evolution: use unique tools used as a proxy for update engagement
  const uniqueToolsUsed = activity.byTool.filter(t2 => t2.prompts > 0).length
  const upgradeSignal = Math.max(uniqueToolsUsed - 1, 0) // rough proxy
  const peakDay = activity.days.reduce((max, d) => Math.max(max, d.prompts), 0)
  const streakWeeks = Math.floor(activity.currentStreak / 7)
  const highQualitySignal = Math.min(interactions, sessions * 8 + memories * 2 + cri)

  return [
    // ── 交互系列 (5) ──
    makeCard('ia-001', t('stats.cardex.cards.ia-001.title'), 'interaction', 'common', interactions, 1, t('stats.cardex.cards.ia-001.hint'), t('stats.cardex.cards.ia-001.flavor')),
    makeCard('ia-002', t('stats.cardex.cards.ia-002.title'), 'interaction', 'common', interactions, 30, t('stats.cardex.cards.ia-002.hint'), t('stats.cardex.cards.ia-002.flavor')),
    makeCard('ia-003', t('stats.cardex.cards.ia-003.title'), 'interaction', 'rare', interactions, 500, t('stats.cardex.cards.ia-003.hint'), t('stats.cardex.cards.ia-003.flavor')),
    makeCard('ia-004', t('stats.cardex.cards.ia-004.title'), 'interaction', 'epic', interactions, 5000, t('stats.cardex.cards.ia-004.hint'), t('stats.cardex.cards.ia-004.flavor')),
    makeCard('ia-005', t('stats.cardex.cards.ia-005.title'), 'interaction', 'legendary', highQualitySignal, 12000, t('stats.cardex.cards.ia-005.hint'), t('stats.cardex.cards.ia-005.flavor')),

    // ── 会话系列 (5) ──
    makeCard('ss-001', t('stats.cardex.cards.ss-001.title'), 'session', 'common', sessions, 1, t('stats.cardex.cards.ss-001.hint'), t('stats.cardex.cards.ss-001.flavor')),
    makeCard('ss-002', t('stats.cardex.cards.ss-002.title'), 'session', 'common', sessions, 10, t('stats.cardex.cards.ss-002.hint'), t('stats.cardex.cards.ss-002.flavor')),
    makeCard('ss-003', t('stats.cardex.cards.ss-003.title'), 'session', 'rare', sessions, 80, t('stats.cardex.cards.ss-003.hint'), t('stats.cardex.cards.ss-003.flavor')),
    makeCard('ss-004', t('stats.cardex.cards.ss-004.title'), 'session', 'epic', sessions, 300, t('stats.cardex.cards.ss-004.hint'), t('stats.cardex.cards.ss-004.flavor')),
    makeCard('ss-005', t('stats.cardex.cards.ss-005.title'), 'session', 'legendary', sessions + memories, 1200, t('stats.cardex.cards.ss-005.hint'), t('stats.cardex.cards.ss-005.flavor')),

    // ── CRI 系列 (5) ──
    makeCard('cri-001', t('stats.cardex.cards.cri-001.title'), 'cri', 'common', cri, 10, t('stats.cardex.cards.cri-001.hint'), t('stats.cardex.cards.cri-001.flavor')),
    makeCard('cri-002', t('stats.cardex.cards.cri-002.title'), 'cri', 'rare', cri, 80, t('stats.cardex.cards.cri-002.hint'), t('stats.cardex.cards.cri-002.flavor')),
    makeCard('cri-003', t('stats.cardex.cards.cri-003.title'), 'cri', 'rare', cri, 300, t('stats.cardex.cards.cri-003.hint'), t('stats.cardex.cards.cri-003.flavor')),
    makeCard('cri-004', t('stats.cardex.cards.cri-004.title'), 'cri', 'epic', cri, 1000, t('stats.cardex.cards.cri-004.hint'), t('stats.cardex.cards.cri-004.flavor')),
    makeCard('cri-005', t('stats.cardex.cards.cri-005.title'), 'cri', 'legendary', cri + sessions, 2200, t('stats.cardex.cards.cri-005.hint'), t('stats.cardex.cards.cri-005.flavor')),

    // ── 记忆系列 (5) ──
    makeCard('mm-001', t('stats.cardex.cards.mm-001.title'), 'memory', 'common', memories, 5, t('stats.cardex.cards.mm-001.hint'), t('stats.cardex.cards.mm-001.flavor')),
    makeCard('mm-002', t('stats.cardex.cards.mm-002.title'), 'memory', 'common', memories, 80, t('stats.cardex.cards.mm-002.hint'), t('stats.cardex.cards.mm-002.flavor')),
    makeCard('mm-003', t('stats.cardex.cards.mm-003.title'), 'memory', 'rare', memories, 300, t('stats.cardex.cards.mm-003.hint'), t('stats.cardex.cards.mm-003.flavor')),
    makeCard('mm-004', t('stats.cardex.cards.mm-004.title'), 'memory', 'epic', memories, 1000, t('stats.cardex.cards.mm-004.hint'), t('stats.cardex.cards.mm-004.flavor')),
    makeCard('mm-005', t('stats.cardex.cards.mm-005.title'), 'memory', 'legendary', memories + sessions, 2200, t('stats.cardex.cards.mm-005.hint'), t('stats.cardex.cards.mm-005.flavor')),

    // ── 工作台系列 (4) ──
    makeCard('wb-001', t('stats.cardex.cards.wb-001.title'), 'workbench', 'common', customWeb, 1, t('stats.cardex.cards.wb-001.hint'), t('stats.cardex.cards.wb-001.flavor')),
    makeCard('wb-002', t('stats.cardex.cards.wb-002.title'), 'workbench', 'rare', customWeb, 3, t('stats.cardex.cards.wb-002.hint'), t('stats.cardex.cards.wb-002.flavor')),
    makeCard('wb-003', t('stats.cardex.cards.wb-003.title'), 'workbench', 'epic', customWeb, 5, t('stats.cardex.cards.wb-003.hint'), t('stats.cardex.cards.wb-003.flavor')),
    makeCard('wb-004', t('stats.cardex.cards.wb-004.title'), 'workbench', 'legendary', customWeb + cri / 60, 8, t('stats.cardex.cards.wb-004.hint'), t('stats.cardex.cards.wb-004.flavor')),

    // ── 进化系列 (4) ──
    makeCard('ev-001', t('stats.cardex.cards.ev-001.title'), 'evolution', 'common', upgradeSignal, 1, t('stats.cardex.cards.ev-001.hint'), t('stats.cardex.cards.ev-001.flavor')),
    makeCard('ev-002', t('stats.cardex.cards.ev-002.title'), 'evolution', 'rare', upgradeSignal, 3, t('stats.cardex.cards.ev-002.hint'), t('stats.cardex.cards.ev-002.flavor')),
    makeCard('ev-003', t('stats.cardex.cards.ev-003.title'), 'evolution', 'epic', upgradeSignal + activeDays / 30, 5, t('stats.cardex.cards.ev-003.hint'), t('stats.cardex.cards.ev-003.flavor')),
    makeCard('ev-004', t('stats.cardex.cards.ev-004.title'), 'evolution', 'legendary', upgradeSignal + customWeb + growth.level / 12, 10, t('stats.cardex.cards.ev-004.hint'), t('stats.cardex.cards.ev-004.flavor')),

    // ── 节律系列 (5) ──
    makeCard('rh-001', t('stats.cardex.cards.rh-001.title'), 'rhythm', 'common', activeDays, 3, t('stats.cardex.cards.rh-001.hint'), t('stats.cardex.cards.rh-001.flavor')),
    makeCard('rh-002', t('stats.cardex.cards.rh-002.title'), 'rhythm', 'common', activeDays, 14, t('stats.cardex.cards.rh-002.hint'), t('stats.cardex.cards.rh-002.flavor')),
    makeCard('rh-003', t('stats.cardex.cards.rh-003.title'), 'rhythm', 'rare', peakDay, 25, t('stats.cardex.cards.rh-003.hint'), t('stats.cardex.cards.rh-003.flavor')),
    makeCard('rh-004', t('stats.cardex.cards.rh-004.title'), 'rhythm', 'epic', streakWeeks, 6, t('stats.cardex.cards.rh-004.hint'), t('stats.cardex.cards.rh-004.flavor')),
    makeCard('rh-005', t('stats.cardex.cards.rh-005.title'), 'rhythm', 'legendary', activeDays + peakDay + streakWeeks * 8, 180, t('stats.cardex.cards.rh-005.hint'), t('stats.cardex.cards.rh-005.flavor')),

    // ── 隐藏人格系列 (6) ──
    makeCard('ps-001', t('stats.cardex.cards.ps-001.title'), 'persona', 'rare', memories, 500, t('stats.cardex.cards.ps-001.hint'), t('stats.cardex.cards.ps-001.flavor'), true),
    makeCard('ps-002', t('stats.cardex.cards.ps-002.title'), 'persona', 'rare', cri + sessions, 900, t('stats.cardex.cards.ps-002.hint'), t('stats.cardex.cards.ps-002.flavor'), true),
    makeCard('ps-003', t('stats.cardex.cards.ps-003.title'), 'persona', 'epic', sessions * 4 + memories, 1400, t('stats.cardex.cards.ps-003.hint'), t('stats.cardex.cards.ps-003.flavor'), true),
    makeCard('ps-004', t('stats.cardex.cards.ps-004.title'), 'persona', 'legendary', highQualitySignal, 3600, t('stats.cardex.cards.ps-004.hint'), t('stats.cardex.cards.ps-004.flavor'), true),
    makeCard('ps-005', t('stats.cardex.cards.ps-005.title'), 'persona', 'epic', peakDay + activeDays, 120, t('stats.cardex.cards.ps-005.hint'), t('stats.cardex.cards.ps-005.flavor'), true),
    makeCard('ps-006', t('stats.cardex.cards.ps-006.title'), 'persona', 'mythic', interactions + sessions + memories + cri, 18000, t('stats.cardex.cards.ps-006.hint'), t('stats.cardex.cards.ps-006.flavor'), true)
  ]
}

function getUnlockedCards(cards: LifeCard[]): LifeCard[] {
  return cards.filter(c => c.metric >= c.target)
}

function getNextCard(cards: LifeCard[]): LifeCard | undefined {
  return [...cards]
    .filter(c => c.metric < c.target)
    .sort((a, b) => pct(b.metric, b.target) - pct(a.metric, a.target))[0]
}

function withCardIndexes(cards: LifeCard[]): LifeCard[] {
  return cards.map((item, index) => ({ ...item, artIndex: index }))
}

// ─── 热力图构建 ──────────────────────────────────────────────────────────────

interface HeatCell {
  date: string
  prompts: number
  level: number
}

function buildHeatGrid(days: { date: string; prompts: number }[], tailDays = 90): HeatCell[] {
  const map = new Map(days.map(d => [d.date, d.prompts]))
  const today = new Date()
  const cells: HeatCell[] = []
  for (let i = tailDays - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    const key = d.toISOString().slice(0, 10)
    const prompts = map.get(key) ?? 0
    cells.push({ date: key, prompts, level: heatLevel(prompts) })
  }
  const firstDay = new Date(cells[0].date).getDay()
  for (let i = 0; i < firstDay; i++) {
    cells.unshift({ date: '', prompts: 0, level: -1 })
  }
  return cells
}

// ─── 子组件 ─────────────────────────────────────────────────────────────────

// 卡牌精灵图：7 列 × 6 行 = 42 张卡牌艺术图
const CARDEX_SPRITE_PATH = 'cardex/cards.png'

function CardArt({ card, unlocked, spriteReady, large = false }: {
  card: LifeCard
  unlocked: boolean
  spriteReady: boolean
  large?: boolean
}) {
  const Icon = SERIES_ICON[card.series]
  const artIndex = card.artIndex ?? 0
  const col = artIndex % 7
  const row = Math.floor(artIndex / 7)
  const spriteStyle: React.CSSProperties = spriteReady
    ? {
        backgroundImage: `url("${CARDEX_SPRITE_PATH}")`,
        backgroundSize: '700% 600%',
        backgroundPosition: `${(col / 6) * 100}% ${(row / 5) * 100}%`
      }
    : {}
  return (
    <div
      className={`cardex-art ${card.rarity} ${unlocked ? 'unlocked' : 'locked'} ${spriteReady ? 'sprite' : 'fallback'} ${large ? 'large' : ''}`}
      style={spriteReady ? spriteStyle : undefined}
    >
      {!spriteReady && (unlocked
        ? <Icon theme="filled" size={large ? 44 : 34} strokeWidth={2} aria-hidden />
        : <Lock theme="outline" size={large ? 40 : 30} strokeWidth={2} aria-hidden />
      )}
    </div>
  )
}

function CardTile({ card, equipped, spriteReady, onToggleEquip, onInspect }: {
  card: LifeCard
  equipped: boolean
  spriteReady: boolean
  onToggleEquip: () => void
  onInspect: () => void
}) {
  const { t } = useT()
  const rarityLabel: Record<CardRarity, string> = {
    common: t('stats.cardex.rarity.common'),
    rare: t('stats.cardex.rarity.rare'),
    epic: t('stats.cardex.rarity.epic'),
    legendary: t('stats.cardex.rarity.legendary'),
    mythic: t('stats.cardex.rarity.mythic')
  }
  const seriesLabel: Record<CardSeries, string> = {
    interaction: t('stats.cardex.series.interaction'),
    session: t('stats.cardex.series.session'),
    cri: t('stats.cardex.series.cri'),
    memory: t('stats.cardex.series.memory'),
    workbench: t('stats.cardex.series.workbench'),
    evolution: t('stats.cardex.series.evolution'),
    rhythm: t('stats.cardex.series.rhythm'),
    persona: t('stats.cardex.series.persona')
  }
  const unlocked = card.metric >= card.target
  const progress = pct(card.metric, card.target)
  return (
    <button type="button" className={`cardex-card ${card.rarity} ${unlocked ? 'unlocked' : 'locked'} ${equipped ? 'equipped' : ''}`} onClick={onInspect}>
      <div className="cardex-rarity">{rarityLabel[card.rarity]}</div>
      <CardArt card={card} unlocked={unlocked} spriteReady={spriteReady} />
      <div className="cardex-card-title">{card.hidden && !unlocked ? '???' : card.title}</div>
      <div className="cardex-card-series">{seriesLabel[card.series]}</div>
      <div className="cardex-card-progress">
        <span><i style={{ width: `${progress}%` }} /></span>
        <b>{Math.min(card.metric, card.target)}/{card.target}</b>
      </div>
      <p>{unlocked ? card.flavor : card.hint}</p>
      {unlocked && (
        <span
          role="button"
          tabIndex={0}
          className="cardex-equip"
          onClick={(e) => { e.stopPropagation(); onToggleEquip() }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onToggleEquip() } }}
        >
          {equipped ? t('stats.cardex.equipped') : t('stats.cardex.equip')}
        </span>
      )}
    </button>
  )
}

// ─── CardexPanel：可复用的卡牌图鉴（供统计页成长 Tab 调用） ────────────────

export interface CardexPanelProps {
  growth: StatsGrowth
  activity: StatsActivity
}

export function CardexPanel({ growth, activity }: CardexPanelProps): React.JSX.Element {
  const { t } = useT()
  const [filter, setFilter] = useState<CardSeries | 'all'>('all')
  const [inspecting, setInspecting] = useState<LifeCard | null>(null)
  const [unlockPopup, setUnlockPopup] = useState<LifeCard | null>(null)
  const [spriteReady, setSpriteReady] = useState(false)
  const modalRef = useRef<HTMLElement>(null)
  const modalTitleId = useId()
  const modalOpen = Boolean(inspecting)
  // 卡牌详情弹窗焦点契约：打开聚焦关闭按钮、Tab 循环、ESC 关闭、关闭恢复焦点；锁定背景滚动。
  useDialogFocus(modalRef, modalOpen, { onEscape: () => setInspecting(null) })
  useScrollLock(modalOpen)

  // 图鉴状态（装备槽 + 已见解锁）后端持久化，跨设备/会话不丢。
  const [equipped, setEquipped] = useState<string[]>([])
  const [stateLoaded, setStateLoaded] = useState(false)
  const seenUnlockedRef = useRef<string[]>([])

  const persistCardex = (equippedNext: string[], seenNext: string[]): void => {
    seenUnlockedRef.current = seenNext
    void window.agentOs.stats
      .setCardexState({ equipped: equippedNext, seenUnlocked: seenNext })
      .catch(() => {})
  }

  // 挂载时拉取持久化状态
  useEffect(() => {
    let cancelled = false
    void window.agentOs.stats
      .getCardexState()
      .then(s => {
        if (cancelled) return
        setEquipped(s.equipped)
        seenUnlockedRef.current = s.seenUnlocked
        setStateLoaded(true)
      })
      .catch(() => {
        if (!cancelled) setStateLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // 预加载卡牌精灵图
  useEffect(() => {
    const image = new Image()
    image.onload = () => setSpriteReady(true)
    image.onerror = () => setSpriteReady(false)
    image.src = CARDEX_SPRITE_PATH
  }, [])

  const cards = useMemo(
    () => withCardIndexes(createCardCatalog(growth, activity, t)),
    [growth, activity, t]
  )

  const unlockedCards = useMemo(() => getUnlockedCards(cards), [cards])
  const nextCard = useMemo(() => getNextCard(cards), [cards])
  const visibleCards = filter === 'all' ? cards : cards.filter(c => c.series === filter)

  const equippedCards = equipped
    .map(id => cards.find(c => c.id === id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))

  const seriesLabel: Record<CardSeries, string> = {
    interaction: t('stats.cardex.series.interaction'),
    session: t('stats.cardex.series.session'),
    cri: t('stats.cardex.series.cri'),
    memory: t('stats.cardex.series.memory'),
    workbench: t('stats.cardex.series.workbench'),
    evolution: t('stats.cardex.series.evolution'),
    rhythm: t('stats.cardex.series.rhythm'),
    persona: t('stats.cardex.series.persona')
  }

  const rhythmStats = useMemo(() => {
    const activeDays = activity.activeDays
    const peakDay = activity.days.reduce((max, d) => Math.max(max, d.prompts), 0)
    const streakWeeks = growth.streakWeeks || Math.floor(activity.currentStreak / 7)
    return [
      { label: t('stats.cardex.rhythm.activeDays'), value: activeDays, suffix: t('stats.cardex.rhythm.daySuffix') },
      { label: t('stats.cardex.rhythm.peakDay'), value: peakDay, suffix: t('stats.cardex.rhythm.timesSuffix') },
      { label: t('stats.cardex.rhythm.streakWeeks'), value: streakWeeks, suffix: t('stats.cardex.rhythm.weekSuffix') }
    ]
  }, [activity, growth.streakWeeks, t])

  // 新卡解锁弹窗（仅在持久化状态就绪后比对，避免首屏误弹）
  useEffect(() => {
    if (!stateLoaded || !cards.length) return
    const unlockedIds = getUnlockedCards(cards).map(c => c.id)
    const seen = new Set(seenUnlockedRef.current)
    const fresh = unlockedIds.find(id => !seen.has(id))
    if (fresh) {
      const card = cards.find(c => c.id === fresh)
      if (card) setUnlockPopup(card)
      persistCardex(equipped, unlockedIds)
    }
  }, [cards, stateLoaded, equipped])

  const toggleEquip = (cardId: string) => {
    setEquipped(prev => {
      const next = prev.includes(cardId)
        ? prev.filter(id => id !== cardId)
        : [cardId, ...prev].slice(0, 3)
      persistCardex(next, seenUnlockedRef.current)
      return next
    })
  }

  const totalCards = cards.length
  const todayCount = activity.days.length > 0
    ? activity.days[activity.days.length - 1].prompts
    : 0
  const heatCells = buildHeatGrid(activity.days)

  return (
    <div className="cardex-page">
        {/* ── 页头 ── */}
        <header className="cardex-page-header">
          <div>
            <h2>Cardex</h2>
            <p>{t('stats.cardex.subtitle')}</p>
          </div>
          <div className="cardex-header-stats">
            <span>Lv.{growth.level}</span>
            <span>{unlockedCards.length}/{totalCards}</span>
            <span>{t('stats.cardex.todayCount', { count: todayCount })}</span>
          </div>
        </header>

        {/* ── 概览行：身份卡 + 下一张 + 装备槽 ── */}
        <section className="cardex-overview">
          <div className="cardex-identity-card">
            <div className="cardex-level-badge">
              <Star theme="filled" size={34} aria-hidden />
            </div>
            <div>
              <h3>Lv.{growth.level} {growth.levelTitle}</h3>
              <p>{growth.nextLevelXp > growth.currentLevelXp ? t('stats.cardex.nextLevelXpRemaining', { xp: growth.nextLevelXp - growth.xp }) : t('stats.cardex.reachedMaxLevel')}</p>
              <div className="cardex-exp">
                <span>
                  <i style={{ width: `${growth.progressPct}%` }} />
                </span>
                <b>{growth.progressPct}%</b>
              </div>
            </div>
          </div>

          <div className="cardex-next-card">
            <span>{t('stats.cardex.nextToUnlock')}</span>
            {nextCard ? (
              <>
                <strong>{nextCard.hidden ? t('stats.cardex.hiddenClueCard') : nextCard.title}</strong>
                <div className="cardex-exp">
                  <span><i style={{ width: `${pct(nextCard.metric, nextCard.target)}%` }} /></span>
                  <b>{pct(nextCard.metric, nextCard.target)}%</b>
                </div>
                <p>{nextCard.hint}</p>
              </>
            ) : <strong>{t('stats.cardex.allUnlocked', { count: totalCards })}</strong>}
          </div>

          <div className="cardex-equipped">
            <span>{t('stats.cardex.equippedCards')}</span>
            <div className="cardex-equipped-list">
              {[0, 1, 2].map(idx => {
                const card = equippedCards[idx]
                return card ? (
                  <button key={card.id} type="button" onClick={() => setInspecting(card)}>
                    <CardArt card={card} unlocked spriteReady={spriteReady} />
                    <small>{card.title}</small>
                  </button>
                ) : <div key={idx} className="cardex-empty-slot">{t('stats.cardex.emptySlot')}</div>
              })}
            </div>
          </div>
        </section>

        {/* ── 能力维度 ── */}
        {growth.dimensions && growth.dimensions.length > 0 && (
          <section className="cardex-abilities">
            {growth.dimensions.map(dim => (
              <div key={dim.key} className="cardex-ability-row">
                <span>{dim.label}</span>
                <i><b style={{ width: `${dim.value * 10}%` }} /></i>
                <strong>{dim.value}/10</strong>
              </div>
            ))}
          </section>
        )}

        {/* ── 节律热力图 ── */}
        <section className="cardex-rhythm">
          <div className="cardex-rhythm-copy">
            <h3>{t('stats.cardex.rhythm.title')}</h3>
            <p>{t('stats.cardex.rhythm.copy')}</p>
          </div>
          <div className="gx-hm-scroll">
            <div className="gx-hm" aria-label={t('stats.cardex.rhythm.heatAria')}>
              {heatCells.map((c, i) => (
                <div
                  key={i}
                  className={`gx-hmc ${c.level < 0 ? 'gx-hmc--hidden' : `gx-hmc--l${c.level}`}`}
                  title={c.date ? t('stats.cardex.rhythm.cellTitle', { date: c.date, count: c.prompts }) : undefined}
                />
              ))}
            </div>
          </div>
          <div className="cardex-rhythm-stats" aria-label={t('stats.cardex.rhythm.summaryAria')}>
            {rhythmStats.map(item => (
              <div key={item.label} className="cardex-rhythm-stat">
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.suffix}</small>
              </div>
            ))}
          </div>
        </section>

        {/* ── 卡牌库 ── */}
        <section className="cardex-library">
          <div className="cardex-filter">
            {(['all', 'interaction', 'session', 'cri', 'memory', 'workbench', 'evolution', 'rhythm', 'persona'] as Array<CardSeries | 'all'>).map(item => (
              <button key={item} type="button" className={filter === item ? 'active' : ''} onClick={() => setFilter(item)}>
                {item === 'all' ? t('common.label.all') : seriesLabel[item]}
              </button>
            ))}
          </div>
          <div className="cardex-grid">
            {visibleCards.map(card => (
              <CardTile
                key={card.id}
                card={card}
                equipped={equipped.includes(card.id)}
                spriteReady={spriteReady}
                onInspect={() => setInspecting(card)}
                onToggleEquip={() => toggleEquip(card.id)}
              />
            ))}
          </div>
        </section>

        {/* ── AI 洞察 ── */}
        {growth.insights.length > 0 && (
          <section className="cardex-insights">
            <h3>{t('stats.cardex.insightsTitle')}</h3>
            <div className="cardex-insight-list">
              {growth.insights.map((text, i) => {
                const ICONS = ['📈', '⏰', '🎯', '🔄', '💡']
                return (
                  <div key={i} className="cardex-insight-item">
                    <div className="cardex-insight-icon">{ICONS[i % ICONS.length]}</div>
                    <div className="cardex-insight-text">{text}</div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {/* ── 卡牌详情弹窗 ── */}
        {inspecting && (
          <div className="cardex-modal-backdrop" role="presentation" onClick={() => setInspecting(null)}>
            <section
              ref={modalRef}
              className="cardex-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby={modalTitleId}
              onClick={(e) => e.stopPropagation()}
            >
              <button type="button" className="cardex-modal-close" onClick={() => setInspecting(null)} aria-label={t('stats.cardex.closeDetail')}>
                <Close theme="outline" size={16} aria-hidden />
              </button>
              <CardArt card={inspecting} unlocked={inspecting.metric >= inspecting.target} spriteReady={spriteReady} large />
              <h3 id={modalTitleId}>{inspecting.hidden && inspecting.metric < inspecting.target ? '???' : inspecting.title}</h3>
              <p>{inspecting.metric >= inspecting.target ? inspecting.flavor : inspecting.hint}</p>
              <div className="cardex-exp">
                <span><i style={{ width: `${pct(inspecting.metric, inspecting.target)}%` }} /></span>
                <b>{Math.min(inspecting.metric, inspecting.target)}/{inspecting.target}</b>
              </div>
              {inspecting.metric >= inspecting.target && (
                <button type="button" className="cardex-modal-equip" onClick={() => toggleEquip(inspecting.id)}>
                  {equipped.includes(inspecting.id) ? t('stats.cardex.unequipCard') : t('stats.cardex.equipCard')}
                </button>
              )}
            </section>
          </div>
        )}

        {/* ── 新卡解锁提示 ── */}
        {unlockPopup && (
          <div className="cardex-unlock-pop" role="status" aria-live="polite">
            <Fire theme="filled" size={18} aria-hidden />
            <span>{t('stats.cardex.newCardUnlocked')}</span>
            <strong>{unlockPopup.title}</strong>
            <button type="button" onClick={() => setUnlockPopup(null)} aria-label={t('stats.cardex.closeUnlockHint')}>
              <Right theme="outline" size={14} aria-hidden />
            </button>
          </div>
        )}
      </div>
  )
}
