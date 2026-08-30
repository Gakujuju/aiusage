/**
 * Render static/logo-icon.svg to the PNG sizes a web app manifest needs.
 *
 * Kept in the repo so the icons can be rebuilt from the logo rather than
 * being four binaries nobody knows how to regenerate.
 *
 * Run:  node packages/web/scripts/make-icons.cjs packages/web/static/logo-icon.svg
 *
 * It reads the rectangles out of the SVG rather than hard-coding them, which
 * is the property that mattered about using the browser: if the logo changes,
 * these icons follow it instead of quietly drifting.
 *
 * No dependencies. zlib is enough to write a PNG.
 */
const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

// Passed in, so this file has no opinion about where the checkout lives.
const SVG = process.argv[2]
const OUT = path.dirname(SVG)

/** 4x4 samples per pixel. Enough that a 14/64 corner radius reads as smooth. */
const SUPERSAMPLE = 4

function parseSvg(source) {
  const viewBox = /viewBox="([^"]+)"/.exec(source)
  const [, , vbW, vbH] = viewBox
    ? viewBox[1].trim().split(/\s+/).map(Number)
    : [0, 0, 64, 64]

  const rects = []
  const pattern = /<rect\b([^>]*)\/?>/g
  let match
  while ((match = pattern.exec(source))) {
    const attrs = match[1]
    const attr = (name) => {
      const found = new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)
      return found ? found[1] : null
    }
    rects.push({
      x: Number(attr('x') ?? 0),
      y: Number(attr('y') ?? 0),
      w: Number(attr('width')),
      h: Number(attr('height')),
      rx: Number(attr('rx') ?? 0),
      fill: attr('fill') || '#000000',
    })
  }
  return { width: vbW, height: vbH, rects }
}

/**
 * The logo uses fill="white", and parsing that as hex silently yields NaN,
 * which lands as black. Unknown names throw rather than guess — a wrong icon
 * colour is not the kind of thing anyone notices in a 192px square.
 */
const NAMED_COLOURS = {
  white: '#ffffff',
  black: '#000000',
  none: null,
}

function toRgb(colour) {
  if (Object.prototype.hasOwnProperty.call(NAMED_COLOURS, colour)) {
    const mapped = NAMED_COLOURS[colour]
    if (mapped === null) return null
    colour = mapped
  }
  if (!/^#[0-9a-fA-F]{3,8}$/.test(colour)) {
    throw new Error(`unsupported fill in the SVG: ${colour}`)
  }
  const value = colour.replace('#', '')
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ]
}

/** Is this point inside the rounded rectangle? */
function inside(rect, px, py) {
  const { x, y, w, h } = rect
  if (px < x || py < y || px > x + w || py > y + h) return false
  const r = Math.min(rect.rx, w / 2, h / 2)
  if (r <= 0) return true

  // Only the four corner squares can fall outside; everything else is in.
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py
  if (cx === px && cy === py) return true
  const dx = px - cx
  const dy = py - cy
  return dx * dx + dy * dy <= r * r
}

/**
 * Paint the SVG into an RGBA buffer.
 *
 * @param scale how much of the canvas the artwork occupies (1 = edge to edge)
 * @param background filled behind everything, for the maskable variant
 */
function render(svg, size, { scale = 1, background = null } = {}) {
  const pixels = Buffer.alloc(size * size * 4)

  if (background) {
    const [r, g, b] = toRgb(background)
    for (let i = 0; i < size * size; i++) {
      pixels[i * 4] = r
      pixels[i * 4 + 1] = g
      pixels[i * 4 + 2] = b
      pixels[i * 4 + 3] = 255
    }
  }

  const drawn = size * scale
  const offset = (size - drawn) / 2
  const unit = svg.width / drawn // canvas pixels -> SVG units
  const step = 1 / SUPERSAMPLE

  for (const rect of svg.rects) {
    const rgb = toRgb(rect.fill)
    if (!rgb) continue // fill="none" draws nothing
    const [r, g, b] = rgb
    // Only the pixels this rect can touch.
    const x0 = Math.max(0, Math.floor(offset + rect.x / unit))
    const x1 = Math.min(size, Math.ceil(offset + (rect.x + rect.w) / unit) + 1)
    const y0 = Math.max(0, Math.floor(offset + rect.y / unit))
    const y1 = Math.min(size, Math.ceil(offset + (rect.y + rect.h) / unit) + 1)

    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) {
        let hits = 0
        for (let sy = 0; sy < SUPERSAMPLE; sy++) {
          for (let sx = 0; sx < SUPERSAMPLE; sx++) {
            const ux = (px + (sx + 0.5) * step - offset) * unit
            const uy = (py + (sy + 0.5) * step - offset) * unit
            if (inside(rect, ux, uy)) hits++
          }
        }
        if (hits === 0) continue

        const coverage = hits / (SUPERSAMPLE * SUPERSAMPLE)
        const i = (py * size + px) * 4
        const dstA = pixels[i + 3] / 255
        const outA = coverage + dstA * (1 - coverage)
        if (outA <= 0) continue
        // Source-over, straight alpha.
        for (let c = 0; c < 3; c++) {
          const src = [r, g, b][c]
          const dst = pixels[i + c]
          pixels[i + c] = Math.round((src * coverage + dst * dstA * (1 - coverage)) / outA)
        }
        pixels[i + 3] = Math.round(outA * 255)
      }
    }
  }

  return pixels
}

function crc32(buf) {
  let c
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256)
    for (let n = 0; n < 256; n++) {
      c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      t[n] = c
    }
    return t
  })())
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

function encodePng(pixels, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // truecolour with alpha
  // 10..12 stay zero: deflate, adaptive filtering, no interlace.

  // One filter byte per scanline. Filter 0 (none) keeps this simple, and the
  // artwork is flat colour, so deflate handles the redundancy anyway.
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const svg = parseSvg(fs.readFileSync(SVG, 'utf8'))
// The first rect is the logo's own background; the maskable variant bleeds
// that same colour to the edges so the 80% inset is invisible.
const plate = svg.rects[0].fill

const targets = [
  { name: 'icon-192.png', size: 192, options: {} },
  { name: 'icon-512.png', size: 512, options: {} },
  { name: 'icon-maskable-192.png', size: 192, options: { scale: 0.8, background: plate } },
  { name: 'icon-maskable-512.png', size: 512, options: { scale: 0.8, background: plate } },
]

for (const target of targets) {
  const png = encodePng(render(svg, target.size, target.options), target.size)
  fs.writeFileSync(path.join(OUT, target.name), png)
  console.log(target.name, png.length, 'bytes')
}
console.log('plate colour from the SVG:', plate)
console.log('rects parsed:', svg.rects.length, 'viewBox', svg.width, 'x', svg.height)
