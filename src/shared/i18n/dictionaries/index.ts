// 字典聚合（SPEC-036）。zh 为 schema 源；en 按 `typeof zh` 约束同形（缺键/异形即编译错误）。
// 迁移期此文件不可变（已 import 全部 10 命名空间）；agent 只填充各自 ns.ts。

import type { Lang } from '../types'
import { zh as commonZh, en as commonEn } from './common'
import { zh as settingsZh, en as settingsEn } from './settings'
import { zh as workbenchZh, en as workbenchEn } from './workbench'
import { zh as chatZh, en as chatEn } from './chat'
import { zh as memoryZh, en as memoryEn } from './memory'
import { zh as statsZh, en as statsEn } from './stats'
import { zh as compareZh, en as compareEn } from './compare'
import { zh as webZh, en as webEn } from './web'
import { zh as channelsZh, en as channelsEn } from './channels'
import { zh as systemZh, en as systemEn } from './system'
import { zh as tasksZh, en as tasksEn } from './tasks'

export const ZH = {
  common: commonZh,
  settings: settingsZh,
  workbench: workbenchZh,
  chat: chatZh,
  memory: memoryZh,
  stats: statsZh,
  compare: compareZh,
  web: webZh,
  channels: channelsZh,
  system: systemZh,
  tasks: tasksZh
}

export type Dictionary = typeof ZH

export const EN: Dictionary = {
  common: commonEn,
  settings: settingsEn,
  workbench: workbenchEn,
  chat: chatEn,
  memory: memoryEn,
  stats: statsEn,
  compare: compareEn,
  web: webEn,
  channels: channelsEn,
  system: systemEn,
  tasks: tasksEn
}

export const DICTS: Record<Lang, Dictionary> = { zh: ZH, en: EN }
