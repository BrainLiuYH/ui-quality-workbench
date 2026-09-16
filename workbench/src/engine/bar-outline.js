import { bottomBarBounds } from './pixel-diff.js'

const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)]
const difference = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
const rgbAt = (data, width, x, y) => Array.from(data.subarray((y * width + x) * 4, (y * width + x) * 4 + 3))

// Refine a coarse paired-edge proposal using a short, flat, same-colour stroke
// on both horizontal sides. If that proof is absent, keep the coarse candidate.
export function measureBarOutline(data, width, height) {
  const coarse = bottomBarBounds(data, width, height)
  if (!coarse) return null
  const row = (y) => {
    const colors = []
    for (let x = Math.round(width * 0.35); x < width * 0.72; x += Math.max(1, Math.round(width / 140))) {
      if (data[(y * width + x) * 4 + 3] < 250) return null
      colors.push(rgbAt(data, width, x, y))
    }
    const color = [0, 1, 2].map((i) => median(colors.map((c) => c[i])))
    return { y, color, stable: colors.filter((c) => difference(c, color) <= 5).length / colors.length > 0.9 }
  }
  const windowSize = Math.max(5, Math.round(height / 200))
  const runs = (around) => {
    const result = []
    for (let y = Math.max(0, around - windowSize); y <= Math.min(height - 1, around + windowSize); y++) {
      const next = row(y)
      const prev = result.at(-1)
      if (next?.stable && prev && prev.bottom === y && difference(prev.color, next.color) < 5) prev.bottom++
      else if (next?.stable) result.push({ top: y, bottom: y + 1, color: next.color })
    }
    return result.filter((r) => r.bottom - r.top <= Math.max(5, height * 0.004) && r.top > 0 && r.bottom < height)
  }
  const tops = runs(coarse.top).filter((r) => {
    const before = row(r.top - 1), after = row(r.bottom)
    return before && after && difference(before.color, r.color) >= 9 && difference(after.color, r.color) >= 9
  })
  const bottoms = runs(coarse.bottom)
  for (const top of tops) for (const bottom of bottoms) {
    if (difference(top.color, bottom.color) > 6 || Math.abs((top.bottom - top.top) - (bottom.bottom - bottom.top)) > 1) continue
    const barHeight = bottom.bottom - top.top
    if (barHeight < height * 0.05 || barHeight > height * 0.11) continue
    const midY = Math.round((bottom.bottom + top.top) / 2)
    const sides = []
    for (let x = 0; x < width; x++) {
      if (x > width * 0.2 && x < width * 0.8) continue
      if (difference(rgbAt(data, width, x, midY), top.color) >= 8) continue
      // Thin curved strokes spread over adjacent antialiased pixels. Require
      // a nearby, colour-compatible continuation instead of a vertical column.
      if ([-0.08, 0.08].every((offset) => [-2, -1, 0, 1, 2].some((dx) => x + dx >= 0 && x + dx < width && difference(rgbAt(data, width, x + dx, Math.round(midY + barHeight * offset)), top.color) < 21))) sides.push(x)
    }
    const left = sides.find((x) => x < width * 0.2), right = sides.findLast((x) => x > width * 0.8)
    if (left === undefined || right === undefined) continue
    const y = Math.floor((top.top + top.bottom - 1) / 2)
    let start = null, longest = { start: 0, length: 0 }
    for (let x = left; x <= right + 1; x++) {
      const same = x <= right && difference(rgbAt(data, width, x, y), top.color) < 7
      if (same && start === null) start = x
      if (!same && start !== null) {
        if (x - start > longest.length) longest = { start, length: x - start }
        start = null
      }
    }
    if (longest.length < (right - left) * 0.6) continue
    const cornerTrace = [0.08, 0.16, 0.25, 0.35].map((depth) => {
      const rowY = top.top + Math.round(barHeight * depth)
      const traceSide = (origin, direction) => {
        const hits = []
        for (let offset = 0; offset < barHeight / 2; offset++) {
          if (difference(rgbAt(data, width, origin + direction * offset, rowY), top.color) < 21) hits.push(offset)
        }
        // The last short run nearest the inside is the component edge; don't
        // count distant same-colour media pixels as part of the stroke.
        if (!hits.length) return null
        const last = hits.at(-1)
        return median(hits.filter((v) => v >= last - Math.max(3, (top.bottom - top.top) * 2)))
      }
      return [traceSide(left, 1), traceSide(right, -1)]
    })
    return { x: left, y: top.top, w: right - left + 1, h: barHeight, stroke: top.bottom - top.top, cornerTrace, bottom: bottom.bottom }
  }
  return null
}

export function compareBarOutlines({ designPixels, implementationPixels, width, height, outputWidth, outputHeight, profile = {} }) {
  if (!['same-width', 'exact'].includes(profile.mode) || profile.heightsDiffer || profile.alignment === 'element' || profile.designOffsetY || profile.implementationOffsetY) return []
  const a = measureBarOutline(designPixels, width, height), b = measureBarOutline(implementationPixels, width, height)
  if (!a || !b || Math.abs(a.w - b.w) > 5 || Math.abs(a.h - b.h) > 3) return []
  const sx = outputWidth / width, sy = outputHeight / height
  const box = (r) => ({ x: Math.round(r.x * sx), y: Math.round(r.y * sy), w: Math.round(r.w * sx), h: Math.round(r.h * sy) })
  const base = { severity: '中等', score: 65, componentEvidence: true, box: box(b), measurement: { designBox: box(a), implementationBox: box(b), unit: 'screenshot-px' } }
  const result = []
  const shift = Math.round((b.y - a.y) * sy)
  if (Math.abs(shift) >= Math.max(4, outputHeight * 0.002)) {
    result.push({ ...base, componentId: 'bar-position', element: '底部操作栏外框', type: '位置', containerShift: shift, replacesCoarseBar: true,
      design_value: `距截图底边约 ${Math.round((height - a.bottom) * sy)}px`, implementation_value: `距截图底边约 ${Math.round((height - b.bottom) * sy)}px`, text: `匹配上下描边后，实现稿底部操作栏比设计稿向${shift < 0 ? '上' : '下'}偏移约 ${Math.abs(shift)}px` })
  }
  if (Math.abs(a.stroke - b.stroke) * sy >= 1.5) result.push({ ...base, componentId: 'bar-outline', element: '底部操作栏描边', type: '边框', design_value: `上下直边约 ${Math.round(a.stroke * sy)}px`, implementation_value: `上下直边约 ${Math.round(b.stroke * sy)}px`, text: '两侧底部操作栏的上下长直边厚度不同。', friendlyTitle: '底部操作栏的描边粗细不同', friendlySummary: '两侧上下长直边均呈现一致的厚度变化；这不是背景图片的纹理差异。' })
  const cornerDeltas = a.cornerTrace.flatMap((row, i) => row.map((v, side) => v !== null && b.cornerTrace[i][side] !== null ? b.cornerTrace[i][side] - v : null)).filter((v) => v !== null)
  if (cornerDeltas.length >= 6 && Math.abs(median(cornerDeltas)) >= Math.max(4, Math.abs(a.stroke - b.stroke) * 2)) result.push({ ...base, componentId: 'bar-outline', element: '底部操作栏角部轮廓', type: '圆角', design_value: '两端角部的可见轮廓', implementation_value: `相同深度的角部轮廓横向相差约 ${Math.round(Math.abs(median(cornerDeltas)) * sx)}px`, text: '外框宽高近似一致，但相同深度的两端曲线位置不同。', friendlyTitle: '底部操作栏的角部轮廓不同', friendlySummary: '外框宽高近似一致，但两端曲线的转折范围不同。可核对圆角处理；未反推出具体圆角半径。' })
  return result
}
