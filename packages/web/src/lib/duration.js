/**
 * "1時間3分" / "1h 3m" — one way of saying how long, for the whole app.
 *
 * Shared because /quotas and /agents put relative times next to each other in
 * the reader's day: a quota that resets in "1時間 3分" and an approval waiting
 * "1時間 3分" should look like the same kind of measurement.
 *
 * @param {number} ms
 * @param {(key: string) => string} t
 * @returns {string | null} null when there is nothing to report
 */
export function formatDuration(ms, t) {
  // Under a second is not a duration anyone is waiting on, and rendering it
  // as "0秒" claims a measurement that was never taken.
  if (!Number.isFinite(ms) || ms < 1000) return null

  const totalSeconds = Math.floor(ms / 1000)
  // Under a minute, say seconds. "0分" is worse than useless on a board that
  // updates every five seconds — it reads as "no time at all" for something
  // that has in fact just started.
  if (totalSeconds < 60) {
    return t('quotas.forecast.seconds').replace('{n}', String(totalSeconds))
  }

  const totalMinutes = Math.floor(totalSeconds / 60)
  const days = Math.floor(totalMinutes / (60 * 24))
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60)
  const minutes = totalMinutes % 60

  const parts = []
  if (days > 0) parts.push(t('quotas.forecast.days').replace('{n}', String(days)))
  if (hours > 0) parts.push(t('quotas.forecast.hours').replace('{n}', String(hours)))
  // Minutes are noise beside days, and the only unit when nothing else fits.
  if (days === 0 && (minutes > 0 || parts.length === 0)) {
    parts.push(t('quotas.forecast.minutes').replace('{n}', String(minutes)))
  }
  return parts.join(' ')
}
