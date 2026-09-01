import type { Severity } from './quota'

/**
 * Three icons that are the same icon.
 *
 * The normal one is the icon this widget has always had. The other two are
 * that same shape recoloured, rather than two new drawings, because a tray
 * icon changing colour reads as a state change and a tray icon changing
 * shape reads as a different program.
 *
 * Recolouring happens on the decoded bitmap rather than on a second and
 * third PNG checked into the repo: one drawing stays one drawing, and the
 * two states cannot drift away from it.
 *
 * No number is drawn here. Sixteen pixels hold about two digits, which would
 * be one of the four values on the tooltip with no room to say which one -
 * a number without its label is worse than no number.
 */

/** BGRA, which is the byte order Electron's toBitmap/createFromBitmap use. */
export interface Bgr { b: number; g: number; r: number }

/**
 * What each state is painted in.
 *
 * Amber and red rather than two shades of one hue, because the difference
 * has to survive being 16 pixels wide at the edge of vision. The normal
 * state is not listed: it is not painted at all.
 */
export const SEVERITY_COLOURS: Record<Exclude<Severity, 'ok'>, Bgr> = {
  warn: { b: 0x0b, g: 0x9e, r: 0xf5 },   // amber
  danger: { b: 0x3b, g: 0x3b, r: 0xef }, // red
}

/**
 * Repaint every visible pixel, keeping the alpha channel exactly as it was.
 *
 * Keeping alpha is the whole trick: the shape, its edges and its
 * anti-aliasing all live there, so replacing only the colour leaves a glyph
 * that is identical apart from being amber. Multiplying the colour by the
 * pixel's own brightness keeps the shading it had.
 *
 * The buffer is copied rather than written through - the caller holds the
 * original and will want it again on the next state change.
 */
export function tintBitmap(bgra: Buffer, colour: Bgr): Buffer {
  const out = Buffer.from(bgra)
  for (let i = 0; i + 3 < out.length; i += 4) {
    const alpha = out[i + 3]
    if (alpha === 0) continue
    // How bright this pixel was, so highlights stay highlights.
    const level = Math.max(out[i], out[i + 1], out[i + 2]) / 255
    // Never below half, or the darker parts of the glyph turn to mud.
    const scale = 0.5 + level * 0.5
    out[i] = Math.round(colour.b * scale)
    out[i + 1] = Math.round(colour.g * scale)
    out[i + 2] = Math.round(colour.r * scale)
  }
  return out
}
