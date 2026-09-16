// Local, component-first evidence. No OCR, model, page-specific labels or
// screenshot coordinates: match complete foreground shapes before measuring.
import { throwIfAborted, yieldToHost } from './runtime.js'
import { compareBarOutlines } from './bar-outline.js'

const median = (values) => values.length ? values.sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0
const distance = (a, b) => Math.max(...a.map((value, i) => Math.abs(value - b[i])))
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase()
const area = (b) => b.w * b.h
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
const union = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x), h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) })

function pageColor(pixels, width, height, startY) {
  const bins = new Map()
  let total = 0
  for (let y = startY; y < height; y += 7) for (let x = 0; x < width; x += 7) {
    const i = (y * width + x) * 4
    if (pixels[i + 3] < 250) continue
    const rgb = [pixels[i], pixels[i + 1], pixels[i + 2]]
    const key = rgb.map((v) => Math.floor(v / 12)).join(',')
    const bin = bins.get(key) || { count: 0, rgb }
    bin.count++
    bins.set(key, bin)
    total++
  }
  const best = [...bins.values()].sort((a, b) => b.count - a.count)[0]
  return best?.count > total * 0.25 ? best.rgb : null
}

function components(mask, width, height, startY = 0) {
  const visited = new Uint8Array(mask.length)
  const queue = new Int32Array(mask.length)
  const result = []
  for (let seed = startY * width; seed < mask.length; seed++) {
    if (!mask[seed] || visited[seed]) continue
    let head = 0, tail = 1
    queue[0] = seed
    visited[seed] = 1
    let left = width, top = height, right = 0, bottom = 0
    while (head < tail) {
      const p = queue[head++]
      const x = p % width, y = Math.floor(p / width)
      left = Math.min(left, x); right = Math.max(right, x)
      top = Math.min(top, y); bottom = Math.max(bottom, y)
      for (const next of [x ? p - 1 : -1, x < width - 1 ? p + 1 : -1, p - width, p + width]) {
        if (next < startY * width || next >= mask.length || visited[next] || !mask[next]) continue
        visited[next] = 1
        queue[tail++] = next
      }
    }
    if (tail >= 4) result.push({ x: left, y: top, w: right - left + 1, h: bottom - top + 1, count: tail })
  }
  return result
}

function makeMask(pixels, width, height, background, threshold, startY) {
  const mask = new Uint8Array(width * height)
  for (let p = startY * width; p < mask.length; p++) {
    const i = p * 4
    if (pixels[i + 3] >= 250 && Math.max(Math.abs(pixels[i] - background[0]), Math.abs(pixels[i + 1] - background[1]), Math.abs(pixels[i + 2] - background[2])) >= threshold) mask[p] = 1
  }
  return mask
}

function textLines(parts, width, height) {
  // A line needs multiple separated glyph-sized contours, not merely a wide
  // pixel-difference rectangle. Media components and broad fills are excluded.
  const glyphs = parts.filter((p) => p.h >= Math.max(5, width * 0.008) && p.h <= height * 0.045 && p.w <= p.h * 1.7 && p.count / area(p) > 0.12)
  const lines = []
  for (const glyph of glyphs.sort((a, b) => a.x - b.x)) {
    const possible = lines.filter((line) => {
      const dy = Math.max(0, Math.min(line.y + line.h, glyph.y + glyph.h) - Math.max(line.y, glyph.y))
      const gap = glyph.x - line.x - line.w
      return gap >= -Math.min(line.h, glyph.h) * 0.22 && gap <= Math.max(3, Math.min(line.h, glyph.h) * 0.85) && dy / Math.min(line.h, glyph.h) >= 0.6 && Math.max(line.h, glyph.h) / Math.min(line.h, glyph.h) < 2
    })
    const line = possible.sort((a, b) => b.x + b.w - a.x - a.w)[0]
    if (line) {
      Object.assign(line, union(line, glyph), { count: line.count + glyph.count })
      line.glyphs.push(glyph)
    } else lines.push({ ...glyph, glyphs: [glyph] })
  }
  return lines.filter((p) => p.glyphs.length >= 4 && p.w / p.h >= 2.3 && p.count / area(p) < 0.72).map((line) => {
    // Detached accents / i dots belong to the line, never to an icon detector.
    for (const part of parts) if (part.h < line.h * 0.4 && part.x >= line.x && part.x + part.w <= line.x + line.w && part.y < line.y + line.h * 0.12 && Math.abs(line.y - part.y) < line.h * 0.25) Object.assign(line, union(line, part))
    return line
  })
}

function samples(pixels, mask, width, box, region = () => true) {
  const bins = new Map()
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const p = y * width + x
    if (!mask[p] || !region(x, y)) continue
    // Modal colour rejects antialiased blends without deleting thin lettering.
    const rgb = [pixels[p * 4], pixels[p * 4 + 1], pixels[p * 4 + 2]]
    const key = rgb.map((v) => Math.floor(v / 8)).join(',')
    const bin = bins.get(key) || [[], [], []]
    for (let c = 0; c < 3; c++) bin[c].push(rgb[c])
    bins.set(key, bin)
  }
  const channels = [...bins.values()].sort((a, b) => b[0].length - a[0].length)[0]
  return channels?.[0].length >= 6 ? channels.map(median) : null
}

function shapeSignature(mask, width, box, cols = 160, rows = 32) {
  const values = new Uint8Array(cols * rows)
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) {
    const sx = box.x + Math.min(box.w - 1, Math.floor((x + 0.5) / cols * box.w))
    const sy = box.y + Math.min(box.h - 1, Math.floor((y + 0.5) / rows * box.h))
    values[y * cols + x] = mask[sy * width + sx]
  }
  return values
}

function similarity(a, b) {
  let intersection = 0, combined = 0
  for (let i = 0; i < a.length; i++) { intersection += a[i] && b[i] ? 1 : 0; combined += a[i] || b[i] ? 1 : 0 }
  return intersection / Math.max(1, combined)
}

function matchObjects(left, right, width, height, threshold) {
  const possible = []
  for (const a of left) for (const b of right) {
    if (Math.abs(a.y + a.h / 2 - b.y - b.h / 2) > Math.max(a.h * 1.3, height * 0.025) ||
      Math.abs(a.x + a.w / 2 - b.x - b.w / 2) > Math.max(a.w * 0.25, width * 0.035) ||
      Math.max(a.w, b.w) / Math.min(a.w, b.w) > 1.25 || Math.max(a.h, b.h) / Math.min(a.h, b.h) > 1.2) continue
    if (a.glyphs && Math.abs(a.glyphs.length - b.glyphs.length) > 1) continue
    const score = similarity(a.signature, b.signature)
    if (score >= threshold) possible.push({ a, b, score })
  }
  const used = new Set(), matches = []
  for (const pair of possible.sort((a, b) => b.score - a.score)) {
    if (used.has(pair.a) || used.has(pair.b)) continue
    used.add(pair.a); used.add(pair.b); matches.push(pair)
  }
  return matches
}

function dotHalo(pixels, width, height, box, color) {
  const core = []
  for (let y = box.y; y < box.y + box.h; y++) for (let x = box.x; x < box.x + box.w; x++) {
    const i = (y * width + x) * 4
    if (distance([pixels[i], pixels[i + 1], pixels[i + 2]], color) < 18) core.push([x, y])
  }
  if (core.length < 20) return null
  const xs = core.map(([x]) => x), ys = core.map(([, y]) => y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2
  const radius = (Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) + 2) / 4
  if (radius < 3) return null
  const lift = []
  const channel = color.indexOf(Math.max(...color))
  for (let angle = 0; angle < 16; angle++) {
    const values = []
    for (const factor of [1.55, 2.7]) {
      const x = Math.round(cx + Math.cos(angle * Math.PI / 8) * radius * factor), y = Math.round(cy + Math.sin(angle * Math.PI / 8) * radius * factor)
      if (x < 0 || x >= width || y < 0 || y >= height || pixels[(y * width + x) * 4 + 3] < 250) continue
      values.push(pixels[(y * width + x) * 4 + channel])
    }
    if (values.length === 2) lift.push(values[0] - values[1])
  }
  return lift.length >= 12 ? { lift: median(lift), coreRadius: radius, x: Math.round(cx - radius), y: Math.round(cy - radius) } : null
}

export function extractForeground(pixels, width, height, startY = 0) {
  const background = pageColor(pixels, width, height, startY)
  if (!background) return null
  const mask = makeMask(pixels, width, height, background, 64, startY)
  const parts = components(mask, width, height, startY)
  // Read opposite-polarity text inside a flat panel, without mistaking the
  // panel itself for a text line. Border padding keeps the outer page out.
  for (const panel of parts.filter((p) => p.w > width * 0.45 && p.h < height * 0.18 && p.h > height * 0.035 && p.count / area(p) > 0.72)) {
    const color = samples(pixels, mask, width, panel)
    if (!color) continue
    const inset = Math.max(3, Math.round(panel.h * 0.12))
    for (let y = panel.y + inset; y < panel.y + panel.h - inset; y++) for (let x = panel.x + inset; x < panel.x + panel.w - inset; x++) {
      const i = (y * width + x) * 4
      mask[y * width + x] = pixels[i + 3] >= 250 && distance([pixels[i], pixels[i + 1], pixels[i + 2]], color) > 80 ? 1 : 0
    }
    // Keep the outer panel separate from its contents.
    for (let y = panel.y; y < panel.y + panel.h; y++) for (let x = panel.x; x < panel.x + panel.w; x++) {
      if (y < panel.y + inset || y >= panel.y + panel.h - inset || x < panel.x + inset || x >= panel.x + panel.w - inset) mask[y * width + x] = 0
    }
  }
  const foreground = components(mask, width, height, startY)
  const dots = foreground.filter((p) => {
    if (p.w < 8 || p.w > Math.min(width * 0.1, height * 0.06) || p.w / p.h < 0.85 || p.w / p.h > 1.18 || p.count / area(p) < 0.67) return false
    const color = samples(pixels, mask, width, p)
    return color && Math.max(...color) - Math.min(...color) > 55
  })
  const lines = textLines(foreground.filter((p) => !dots.includes(p)), width, height)
  for (const line of lines) { line.signature = shapeSignature(mask, width, line); line.color = samples(pixels, mask, width, line) }
  const graphics = foreground.filter((p) => p.w >= Math.max(6, width * 0.012) && p.h >= Math.max(8, width * 0.012) && p.w < width * 0.13 && p.h < height * 0.07 && p.w / p.h > 0.3 && p.w / p.h < 1.8 && !lines.some((line) => overlap(line, p) > area(p) * 0.8))
  for (const graphic of graphics) { graphic.signature = shapeSignature(mask, width, graphic); graphic.color = samples(pixels, mask, width, graphic) }
  const lowMask = makeMask(pixels, width, height, background, 20, startY)
  const lowParts = components(lowMask, width, height, startY)
  const fills = lowParts.filter((p) => p.w > width * 0.15 && p.w < width * 0.6 && p.h > height * 0.025 && p.h < height * 0.1 && p.w / p.h > 2 && p.count / area(p) > 0.74)
  for (const fill of fills) { fill.signature = shapeSignature(lowMask, width, fill); fill.color = samples(pixels, lowMask, width, fill) }
  for (const dot of dots) { dot.color = samples(pixels, mask, width, dot); dot.halo = dotHalo(pixels, width, height, dot, dot.color); dot.signature = shapeSignature(mask, width, dot) }
  const rings = lowParts.filter((p) => {
    if (p.w < width * 0.045 || p.w > width * 0.2 || p.w / p.h < 0.85 || p.w / p.h > 1.18 || p.count / area(p) > 0.28) return false
    // A complete hollow perimeter, not a plus sign or a few image fragments.
    let rim = 0
    for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) if (lowMask[y * width + x]) {
      const radius = Math.hypot((x + 0.5 - p.x - p.w / 2) / (p.w / 2), (y + 0.5 - p.y - p.h / 2) / (p.h / 2))
      if (radius > 0.82 && radius < 1.06) rim++
    }
    return rim / Math.max(1, p.count) > 0.8
  })
  for (const ring of rings) {
    ring.signature = shapeSignature(lowMask, width, ring)
    ring.topColor = samples(pixels, lowMask, width, ring, (_, y) => y < ring.y + ring.h * 0.2)
    ring.bottomColor = samples(pixels, lowMask, width, ring, (_, y) => y > ring.y + ring.h * 0.8)
  }
  return { background, lines, graphics, rings, fills, dots, mask }
}

function absentRegions(designPixels, implementationPixels, width, height, left, right, startY) {
  const step = Math.max(6, Math.round(width / 100)), cols = Math.ceil(width / step), rows = Math.ceil(height / step)
  const masks = [new Uint8Array(cols * rows), new Uint8Array(cols * rows)]
  for (let gy = Math.ceil(startY / step); gy < rows; gy++) for (let gx = 0; gx < cols; gx++) {
    let count = 0, aVisible = 0, bVisible = 0
    for (let y = gy * step; y < Math.min(height, (gy + 1) * step); y += 2) for (let x = gx * step; x < Math.min(width, (gx + 1) * step); x += 2) {
      const i = (y * width + x) * 4
      if (designPixels[i + 3] < 250 || implementationPixels[i + 3] < 250) continue
      count++
      if (distance([designPixels[i], designPixels[i + 1], designPixels[i + 2]], left.background) > 18) aVisible++
      if (distance([implementationPixels[i], implementationPixels[i + 1], implementationPixels[i + 2]], right.background) > 18) bVisible++
    }
    if (count < 4) continue
    if (aVisible / count > 0.6 && bVisible / count < 0.04) masks[0][gy * cols + gx] = 1
    if (bVisible / count > 0.6 && aVisible / count < 0.04) masks[1][gy * cols + gx] = 1
  }
  return masks.flatMap((mask, side) => components(mask, cols, rows).filter((p) => p.count * step * step > width * height * 0.028 && p.w * step > width * 0.35 && p.h * step > height * 0.08 && p.count / area(p) > 0.55).map((p) => ({ x: p.x * step, y: p.y * step, w: Math.min(width - p.x * step, p.w * step), h: Math.min(height - p.y * step, p.h * step), side })))
}

/** Returns matched component observations in comparison (not CSS) pixels. */
export async function compareComponents({ designPixels, implementationPixels, width, height, outputWidth = width, outputHeight = height, profile = {}, signal }) {
  throwIfAborted(signal)
  const startY = Math.max(0, Math.round((profile.ignoreTopEnd || profile.ignoreTop || 0) * height / outputHeight))
  const left = extractForeground(designPixels, width, height, startY)
  await yieldToHost(signal)
  const right = extractForeground(implementationPixels, width, height, startY)
  if (!left || !right) return { issues: [], matched: [] }
  const sx = outputWidth / width, sy = outputHeight / height
  const scaleBox = (box) => ({ x: Math.round(box.x * sx), y: Math.round(box.y * sy), w: Math.round(box.w * sx), h: Math.round(box.h * sy) })
  const issues = [], matched = []
  let serial = 0
  const add = (pair, type, element, expected, actual, title, text, extra = {}) => {
    issues.push({ type, element, severity: '中等', score: 60, componentEvidence: true, componentId: pair.id, box: scaleBox(pair.b), design_value: expected, implementation_value: actual, text, friendlyTitle: title, friendlySummary: text, measurement: { designBox: scaleBox(pair.a), implementationBox: scaleBox(pair.b), match: pair.score, unit: 'screenshot-px' }, ...extra })
  }
  const fillPairs = matchObjects(left.fills, right.fills, width, height, 0.85)
  for (const pair of fillPairs) {
    pair.id = `fill-${serial++}`
    const { a, b } = pair
    matched.push(scaleBox(union(a, b)))
    if (Math.abs(b.w - a.w) * sx >= Math.max(4, a.w * sx * 0.015) && Math.abs(b.h - a.h) * sy < 3) {
      add(pair, '尺寸', '匹配的横向控件', `外框宽 ${Math.round(a.w * sx)}px`, `外框宽 ${Math.round(b.w * sx)}px`, '这个控件的宽度不同', '两侧可对应的横向控件外框宽度不同，高度近似不变。请同时核对左右边界和内部对齐。')
    }
    if (a.color && b.color && distance(a.color, b.color) >= 12 && distance(a.color.map((v, i) => v - left.background[i]), b.color.map((v, i) => v - right.background[i])) >= 12) {
      add(pair, '颜色', '匹配的横向控件', hex(a.color), hex(b.color), '这个控件的背景颜色不同', '两侧已对应控件的主要填充颜色不同，且不能仅用页面底色的整体变化解释。')
    }
  }
  const parentId = (pair) => fillPairs.find((p) => overlap(p.a, pair.a) / area(pair.a) > 0.95 && overlap(p.b, pair.b) / area(pair.b) > 0.95)?.id
  for (const [kind, pairs] of [['text', matchObjects(left.lines, right.lines, width, height, 0.58)], ['graphic', matchObjects(left.graphics, right.graphics, width, height, 0.77)]]) {
    for (const pair of pairs) {
      pair.id = parentId(pair) || `foreground-${serial++}`
      const { a, b } = pair
      matched.push(scaleBox(union(a, b)))
      const element = kind === 'text' ? '匹配的文字行' : '匹配的小图形'
      const dw = Math.round((b.w - a.w) * sx), dh = Math.round((b.h - a.h) * sy)
      // Size of ink is not font size or container width. Matching silhouettes
      // only supports a candidate, with copy/content verification explicit.
      if (kind === 'text' && Math.abs(dw) >= Math.max(4, a.w * sx * 0.025) && Math.abs(dh) <= Math.max(3, a.h * sy * 0.07)) {
        add(pair, '文字', element, `可见字形宽 ${Math.round(a.w * sx)}px`, `可见字形宽 ${Math.round(b.w * sx)}px`, '这行文字的可见宽度不同', `对应文字行的可见字形${dw < 0 ? '变窄' : '变宽'}，高度近似不变。请核对文案、字体、字重和字间距；这不是字号测量。`)
      }
      const dx = Math.round((b.x + b.w / 2 - a.x - a.w / 2) * sx), dy = Math.round((b.y - a.y) * sy)
      const shiftThreshold = Math.max(4, height * sy * 0.002)
      // Horizontal reflow of a narrower word is not a separate positioning bug.
      if (Math.abs(dy) >= shiftThreshold || (Math.abs(dw) < 4 && Math.abs(dx) >= shiftThreshold)) {
        const vertical = Math.abs(dy) >= shiftThreshold
        add(pair, '位置', element, vertical ? `可见上缘 ${Math.round(a.y * sy)}px` : `可见中心 x=${Math.round((a.x + a.w / 2) * sx)}px`, vertical ? `可见上缘 ${Math.round(b.y * sy)}px` : `可见中心 x=${Math.round((b.x + b.w / 2) * sx)}px`, kind === 'text' ? '这行文字的位置不同' : '这个图形的位置不同', `已对应的${kind === 'text' ? '文字行' : '图形'}${vertical ? `向${dy < 0 ? '上' : '下'}偏移` : `向${dx < 0 ? '左' : '右'}偏移`}。请结合所属组件的位置一起核对。`)
      }
      if (a.color && b.color && distance(a.color, b.color) >= 24) {
        add(pair, '颜色', element, hex(a.color), hex(b.color), kind === 'text' ? '这行文字的颜色不同' : '这个图形的颜色不同', `两侧已对应的${kind === 'text' ? '文字' : '图形'}前景颜色明显不同；比较的是前景实色，不含周围背景。`)
      }
    }
  }
  // Compare a matched solid dot's surrounding falloff, not its halo-inclusive
  // bounding box (which would misreport the glow itself as a size change).
  const dotPairs = matchObjects(
    left.dots.filter((dot) => dot.halo).map((dot) => ({ ...dot, x: dot.halo.x, y: dot.halo.y, w: dot.halo.coreRadius * 2, h: dot.halo.coreRadius * 2 })),
    right.dots.filter((dot) => dot.halo).map((dot) => ({ ...dot, x: dot.halo.x, y: dot.halo.y, w: dot.halo.coreRadius * 2, h: dot.halo.coreRadius * 2 })),
    width, height, 0.8,
  )
  for (const pair of dotPairs) {
    const { a, b } = pair
    if (distance(a.color, b.color) > 24 || Math.max(a.halo.lift, b.halo.lift) < 12 || Math.min(a.halo.lift, b.halo.lift) > 4) continue
    pair.id = parentId(pair) || `halo-${serial++}`
    add(pair, '阴影', '圆点外缘光晕', a.halo.lift >= 12 ? '有可见外缘光晕' : '外缘近乎无光晕', b.halo.lift >= 12 ? '有可见外缘光晕' : '外缘近乎无光晕', '圆点周围的光晕不同', '已对应的实色圆点，一侧周围有可见光晕，另一侧近乎没有。这里只比较截图外观，不推断阴影或模糊参数。')
  }
  for (const pair of matchObjects(left.rings, right.rings, width, height, 0.65)) {
    const { a, b } = pair
    pair.id = `ring-${serial++}`
    if (!a.topColor || !a.bottomColor || !b.topColor || !b.bottomColor) continue
    const aGradient = distance(a.topColor, a.bottomColor), bGradient = distance(b.topColor, b.bottomColor)
    if (Math.max(aGradient, bGradient) > 35 && Math.min(aGradient, bGradient) < 16) {
      add(pair, '边框', '圆形描边', `上部 ${hex(a.topColor)} / 下部 ${hex(a.bottomColor)}`, `上部 ${hex(b.topColor)} / 下部 ${hex(b.bottomColor)}`, '圆形描边的渐变效果不同', '对应圆形描边一侧有明显上下明暗渐变，另一侧近乎同色。请对照设计核对描边效果；未推断具体渐变参数。')
      matched.push(scaleBox(union(a, b)))
    }
  }
  const absence = []
  const blankGap = (a, b) => {
    const pixels = a.side === 0 ? implementationPixels : designPixels
    const background = a.side === 0 ? right.background : left.background
    let count = 0, flat = 0
    for (let y = a.y + a.h; y < b.y; y += 2) for (let x = Math.max(a.x, b.x); x < Math.min(a.x + a.w, b.x + b.w); x += 4) {
      const i = (y * width + x) * 4
      count++
      if (pixels[i + 3] >= 250 && distance([pixels[i], pixels[i + 1], pixels[i + 2]], background) < 18) flat++
    }
    return !count || flat / count > 0.96
  }
  for (const box of absentRegions(designPixels, implementationPixels, width, height, left, right, startY).sort((a, b) => a.y - b.y)) {
    const previous = absence.at(-1)
    if (previous && previous.side === box.side && Math.abs(previous.x - box.x) < width * 0.02 && Math.abs(previous.w - box.w) < width * 0.04 && box.y - previous.y - previous.h < height * 0.05 && blankGap(previous, box)) {
      Object.assign(previous, union(previous, box))
    } else absence.push(box)
  }
  for (const box of absence) {
    const pair = { a: box, b: box, id: `absence-${serial++}`, score: null }
    add(pair, '内容', '大面积内容存在性', box.side === 0 ? '有大面积可见内容' : '近似空白', box.side === 0 ? '近似空白' : '有大面积可见内容', '这块内容一边有、一边空白', '同一区域一侧有连续可见内容，另一侧近似空白。请先确认数据、加载状态和内容是否应出现，不能从截图确定业务根因。', { presenceEvidence: 'large-flat-absence', score: 100, severity: '严重' })
  }
  throwIfAborted(signal)
  issues.push(...compareBarOutlines({ designPixels, implementationPixels, width, height, outputWidth, outputHeight, profile }))
  return { issues, matched, absence: absence.map(scaleBox) }
}

export function reconcileComponentIssues(rasterIssues, componentResult) {
  const containers = [...componentResult.issues, ...rasterIssues].filter((issue) => Number.isFinite(issue.containerShift))
  const precise = componentResult.issues.filter((issue) => {
    if (Number.isFinite(issue.containerShift)) return true
    if (issue.type !== '位置' || !issue.measurement) return true
    const dy = issue.measurement.implementationBox.y - issue.measurement.designBox.y
    return !containers.some((container) => container !== issue && overlap(container.box, issue.box) / area(issue.box) > 0.95 && Math.abs(dy - container.containerShift) <= 5)
  })
  return [...rasterIssues.filter((issue) => {
    if (issue.element === '底部操作栏外框' && componentResult.issues.some((candidate) => candidate.replacesCoarseBar)) return false
    // Missing media underneath a floating bar invalidates a material comparison.
    // Keep position and selection evidence, but do not claim a blur/fill defect.
    if (issue.element === '底部操作栏背景质感' && componentResult.absence?.some((box) => box.y < issue.box.y && box.y + box.h > issue.box.y - issue.box.h * 0.7)) return false
    if (issue.componentEvidence || issue.backgroundEvidence) return true
    if (componentResult.absence?.some((box) => overlap(box, issue.box) / Math.max(1, area(issue.box)) > 0.32)) return false
    return !componentResult.matched.some((box) => overlap(box, issue.box) / Math.max(1, area(issue.box)) > 0.55 && area(issue.box) < area(box) * 2.5)
  }), ...precise]
}
