/**
 * The four sizes the widget comes in, and what each one fixes.
 *
 * There used to be a zoom factor in 0.1 steps, changed from the tray. A
 * second way of choosing "how big" was about to appear next to it - how many
 * rows the strip draws - and two independent knobs for one visible property
 * is how a screen ends up in a size nobody can explain. So there is one
 * choice, in the user's own words, and each choice is a fixed pair.
 *
 * No node imports here: the renderer reads this too.
 */
export type SizeName = 'normal' | 'small' | 'tiny' | 'micro'

/**
 * How much of each quota line to draw.
 *
 * 'number' is the level with no meter at all, and it is not offered in the
 * settings: it exists because the smallest size fixes it. At zoom 0.5 a
 * ten-cell bar stops being readable before the digits do, so the digits
 * alone say more in the same space.
 */
export type QuotaDetail = 'number' | 'meter' | 'percent' | 'full'

export interface SizeTier {
  /** webContents zoom factor, which scales text, bars and the window alike. */
  zoom: number
  /** A detail level this size forces, or null to leave it to the setting. */
  detail: QuotaDetail | null
}

/** Largest first, the order the user named them in. */
export const SIZE_ORDER: readonly SizeName[] = ['normal', 'small', 'tiny', 'micro']

/*
 * The zoom values were measured, not guessed: a frameless window on Windows
 * is never shorter than 39 device pixels, so below about 0.6 the two-row
 * strip stops getting shorter and only gets narrower. 0.65 is the last step
 * that is still shorter than the one above it; 0.5 is where the strip is
 * still something you can hit with a pointer. The bottom tier drops the
 * meters instead of the zoom going lower, because 42 and 39 tall was a
 * three-pixel difference, which is not a size.
 */
export const SIZE_TIERS: Readonly<Record<SizeName, SizeTier>> = {
  normal: { zoom: 1.0, detail: null },
  small: { zoom: 0.8, detail: null },
  tiny: { zoom: 0.65, detail: null },
  micro: { zoom: 0.5, detail: 'number' },
}

export function isSizeName(value: unknown): value is SizeName {
  return typeof value === 'string' && (SIZE_ORDER as readonly string[]).includes(value)
}

/**
 * The size whose zoom is closest to an old zoomFactor.
 *
 * For the one-time migration of a settings file written before sizes
 * existed. Anything unparseable lands on normal, which is also the default.
 */
export function nearestSize(zoom: number): SizeName {
  if (!Number.isFinite(zoom)) return 'normal'
  let best: SizeName = 'normal'
  let bestDistance = Infinity
  for (const name of SIZE_ORDER) {
    const distance = Math.abs(SIZE_TIERS[name].zoom - zoom)
    if (distance < bestDistance) {
      best = name
      bestDistance = distance
    }
  }
  return best
}

/**
 * What the quota lines draw, given the size, the fold, and the setting.
 *
 * One function so the strip and the open panel cannot disagree about who
 * decides. The size wins when it has an opinion; otherwise the folded strip
 * shows a bar and a number, and the open panel shows whatever was chosen.
 */
export function quotaDetailFor(
  size: SizeName,
  collapsed: boolean,
  chosen: Exclude<QuotaDetail, 'number'>,
): QuotaDetail {
  const fixed = SIZE_TIERS[size].detail
  if (fixed) return fixed
  return collapsed ? 'percent' : chosen
}
