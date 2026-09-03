import type { WidgetData } from './data'
import type { QuotaView } from './quota'
import type { HubFailure } from './hub'

/**
 * Everything one refresh tells the window, in one type.
 *
 * This exists because `webContents.send` takes `any`. Twice in one day this
 * file's callers sent an object with most of it missing, and both times the
 * compiler had nothing to say: the panel builds its strings from these
 * fields the moment an update arrives, so a partial object throws inside a
 * reactive statement and the panel stops repainting. The first time it drew
 * a header and no body; the second it kept stale numbers on screen after the
 * hub had gone away, which is the one thing the message was added to prevent.
 *
 * What was wrong was not that the panel failed to repaint. That is the
 * symptom. What was wrong is that an incomplete update could be sent at all,
 * and fixing the symptom the first time left the shape free to do it again
 * on the next path anybody wrote.
 *
 * So the channel has one sender, in main.ts, and it takes this. Add a
 * section to the panel and forget the failure path, and the build stops.
 */
export interface WidgetUpdate extends WidgetData {
  /** null when the hub could not be read; the panel says why instead. */
  quota: QuotaView | null
  /** null while things are working. */
  hubProblem: HubFailure | null
  /** Which hub this is about, for a message that names it. */
  hubUrl: string
  /**
   * Set when config.json is present and will not parse; null otherwise.
   *
   * Separate from hubProblem because it is not about the hub at all - the
   * address being used is a guess, and every number under it may be about
   * the wrong machine. That is the failure nobody could see on 2026-09-02.
   */
  configProblem: string | null
}

/**
 * The only channel name for this message.
 *
 * Written once so that sending on it without going through the typed sender
 * means typing the string a second time, which is a visible thing to do in
 * review rather than an ordinary-looking call.
 */
export const WIDGET_UPDATE_CHANNEL = 'widget:data-update'

/**
 * What the panel measured, and the smallest it is allowed to become.
 *
 * The floor travels with the measurement on purpose. Main used to hold a
 * single MIN_WINDOW_HEIGHT and apply it to whatever arrived, which worked
 * while there was one kind of panel. There are two now, and their smallest
 * legitimate shapes are nothing alike: an open panel under about 120px has
 * been caught mid-render, while a folded strip is 30-odd pixels by design.
 *
 * Two constants in main would mean main deciding which state the renderer is
 * in - a second copy of a fact the renderer already has. Today produced four
 * failures of exactly that shape, so the number comes from the same message
 * as the height it applies to, and they cannot disagree.
 */
export interface PanelSize {
  width: number
  height: number
  /** Measured from the DOM, not guessed: the smallest legitimate height. */
  minHeight: number
}
