export interface MessageTimePresentation {
  short: string
  full: string
}

export function messageTime(
  iso: string | undefined,
  now = new Date(),
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
): MessageTimePresentation | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime()) || Number.isNaN(now.getTime())) return null

  const parts = (value: Date, includeZone = false): Record<string, string> =>
    Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
        ...(includeZone ? { timeZoneName: 'longOffset' } : {})
      })
        .formatToParts(value)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    )
  const value = parts(date, true)
  const today = parts(now)
  const day = `${value.year}-${value.month}-${value.day}`
  const clock = `${value.hour}:${value.minute}`
  const sameDay = day === `${today.year}-${today.month}-${today.day}`
  const zone = value.timeZoneName === 'GMT' ? 'GMT+00:00' : value.timeZoneName
  return {
    short: sameDay ? clock : `${day} ${clock}`,
    full: `${day} ${clock}:${value.second} ${zone}`
  }
}
