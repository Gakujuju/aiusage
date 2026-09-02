import type { WidgetAPI } from '../preload'

/**
 * The bridge preload puts on the window, declared instead of cast away.
 *
 * Every call into it used to go through `(window as any).widget`, which is
 * the receiving end of a contract the sending end had just been given a type
 * for. The cast also hid the interesting part: whether it is there at all.
 *
 * Optional on purpose. A preload that throws never reaches contextBridge and
 * leaves this undefined - which happened, and produced a window that drew
 * its header and nothing else. Marking it optional makes the compiler keep
 * asking about the case that actually occurs.
 */
declare global {
  interface Window {
    widget?: WidgetAPI
  }
}

export {}
