import assert from 'node:assert/strict'
import test from 'node:test'
import { compareComponents, reconcileComponentIssues } from '../src/engine/component-diff.js'
import { compareBarOutlines } from '../src/engine/bar-outline.js'
import { groupIssues } from '../src/engine/group-issues.js'
import { adaptYangaoGroups } from '../src/lib/findingsAdapter.js'

const width = 400, height = 800
const raster = (background = [0, 0, 0]) => {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < width * height; i++) pixels.set([...background, 255], i * 4)
  return pixels
}
function paint(pixels, x, y, w, h, color) {
  for (let row = Math.max(0, y); row < Math.min(height, y + h); row++) for (let col = Math.max(0, x); col < Math.min(width, x + w); col++) pixels.set([...color, 255], (row * width + col) * 4)
}
function line(pixels, { x = 50, y = 180, glyphWidth = 14, color = [235, 235, 235], count = 7 } = {}) {
  for (let n = 0; n < count; n++) {
    const left = x + n * (glyphWidth + 6)
    paint(pixels, left, y, 3, 24, color)
    paint(pixels, left, y, glyphWidth, 3, color)
    paint(pixels, left, y + 10, glyphWidth - (n % 2) * 3, 3, color)
    paint(pixels, left, y + 21, glyphWidth, 3, color)
  }
}
const compare = (a, b, profile = {}) => compareComponents({ designPixels: a, implementationPixels: b, width, height, profile })
const findings = (result) => adaptYangaoGroups(groupIssues(result.issues, { width, height }), { width, height, comparability: { status: 'medium' } })

test('complete matched lines retain width and position evidence on medium inputs', async () => {
  const a = raster(), b = raster()
  line(a); line(b, { glyphWidth: 13, y: 169 })
  const result = await compare(a, b)
  const rows = findings(result)
  assert.equal(rows.length, 1)
  assert.deepEqual(new Set(rows[0].types), new Set(['文字', '位置']))
  assert.match(rows[0].summary, /不是字号测量/)
  assert.equal(result.issues.find((i) => i.type === '位置').measurement.implementationBox.y, 169)
})

test('separate text lines never merge just because their inferred element names match', async () => {
  const a = raster(), b = raster()
  for (const y of [180, 320]) { line(a, { y }); line(b, { y, glyphWidth: 13 }) }
  assert.equal(findings(await compare(a, b)).length, 2)
})

test('foreground colour survives thin text and does not average in page background', async () => {
  const a = raster(), b = raster()
  line(a); line(b, { color: [40, 200, 90] })
  const changed = (await compare(a, b)).issues.find((i) => i.type === '颜色')
  assert.ok(changed)
  assert.equal(changed.design_value, '#EBEBEB')
  assert.equal(changed.implementation_value, '#28C85A')
})

test('identical, tiny-shift and uniform page-background changes do not create component defects', async () => {
  const a = raster(), shifted = raster(), background = raster([12, 12, 12])
  line(a); line(shifted, { y: 181 }); line(background)
  for (const b of [a, shifted, background]) assert.equal((await compare(a, b)).issues.length, 0)
})

test('different glyph counts do not masquerade as font size or component size', async () => {
  const a = raster(), b = raster()
  line(a); line(b, { count: 3 })
  assert.equal((await compare(a, b)).issues.length, 0)
})

test('system chrome is excluded before component extraction', async () => {
  const a = raster(), b = raster()
  line(a, { y: 15 }); line(b, { y: 15, glyphWidth: 13 })
  assert.equal((await compare(a, b, { ignoreTop: 70 })).issues.length, 0)
})

function media(pixels, delta = 0) {
  for (let y = 320; y < 550; y++) for (let x = 40; x < 360; x++) {
    const tone = 28 + (Math.floor(x / 16) + Math.floor(y / 13)) % 4 * 3 + delta
    paint(pixels, x, y, 1, 1, [tone, tone + 3, tone + 5])
  }
}
test('dark low-edge media missing from the other side becomes a presence question', async () => {
  const a = raster(), b = raster()
  media(a)
  const result = await compare(a, b)
  const absence = result.issues.find((i) => i.presenceEvidence)
  assert.ok(absence)
  assert.equal(absence.type, '内容')
  assert.match(absence.text, /加载状态/)
  const reconciled = reconcileComponentIssues([{ type: '尺寸', box: { x: 38, y: 315, w: 325, h: 280 } }], result)
  assert.equal(reconciled.some((i) => i.type === '尺寸'), false)
})

test('two populated media variants and two blank surfaces do not create absence issues', async () => {
  const a = raster(), b = raster()
  media(a); media(b, 28)
  assert.equal((await compare(a, b)).issues.some((i) => i.presenceEvidence), false)
  assert.equal((await compare(raster(), raster())).issues.length, 0)
})

test('a present separator between missing panels prevents a single enclosing absence box', async () => {
  const a = raster(), b = raster()
  for (const y of [320, 470]) paint(a, 40, y, 320, 120, [38, 35, 32])
  for (const pixels of [a, b]) paint(pixels, 40, 447, 320, 10, [80, 80, 80])
  const absent = (await compare(a, b)).issues.filter((i) => i.presenceEvidence)
  assert.equal(absent.length, 2)
  assert.ok(absent.every((i) => i.box.h < 150))
})

test('transparent padding is not a flat opaque absence or foreground-colour defect', async () => {
  const a = raster(), b = raster()
  media(a)
  for (let y = 300; y < 600; y++) for (let x = 0; x < width; x++) b[(y * width + x) * 4 + 3] = 0
  assert.equal((await compare(a, b)).issues.length, 0)
})

function ring(pixels, gradient = false, color = [210, 170, 90]) {
  for (let y = 140; y < 200; y++) for (let x = 170; x < 230; x++) {
    const r = Math.hypot(x + 0.5 - 200, y + 0.5 - 170)
    if (r <= 28 && r >= 25) {
      const strength = gradient ? 1 - (y - 142) / 56 * 0.75 : 1
      paint(pixels, x, y, 1, 1, color.map((c) => Math.round(c * strength)))
    }
  }
}
test('a complete gradient ring versus a flat stroke retains style evidence', async () => {
  const a = raster(), b = raster()
  ring(a, true); ring(b)
  assert.ok((await compare(a, b)).issues.some((i) => i.element === '圆形描边'))
})

test('a uniform stroke recolour and an identical gradient do not invent lost gradients', async () => {
  const a = raster(), b = raster(), gradient = raster()
  ring(a); ring(b, false, [170, 120, 70]); ring(gradient, true)
  for (const pair of [[a, b], [gradient, gradient]]) assert.equal((await compare(...pair)).issues.some((i) => i.element === '圆形描边'), false)
})

function dot(pixels, glow) {
  for (let y = 120; y < 190; y++) for (let x = 270; x < 340; x++) {
    const r = Math.hypot(x - 305, y - 155)
    const strength = r <= 8 ? 1 : glow ? Math.max(0, (24 - r) / 16) * 0.45 : 0
    if (strength) paint(pixels, x, y, 1, 1, [45, 205, 100].map((c) => Math.round(c * strength)))
  }
}
test('a matched solid point with and without glow is style evidence, not a size defect', async () => {
  const a = raster(), b = raster()
  dot(a, true); dot(b, false)
  const result = await compare(a, b)
  assert.ok(result.issues.some((i) => i.element === '圆点外缘光晕'))
  assert.equal(result.issues.some((i) => i.type === '尺寸'), false)
  assert.equal((await compare(a, a)).issues.length, 0)
  assert.equal((await compare(b, b)).issues.length, 0)
})

test('a paired filled control width is measured without hardcoded page labels', async () => {
  const a = raster(), b = raster()
  paint(a, 230, 150, 115, 35, [30, 30, 30]); paint(b, 224, 150, 121, 35, [30, 30, 30])
  assert.ok((await compare(a, b)).issues.some((i) => i.element === '匹配的横向控件' && i.type === '尺寸'))
  assert.equal((await compare(a, a)).issues.length, 0)
})

test('children moving with a measured parent are not duplicated; independent text style survives', () => {
  const parent = { element: '浅色卡片外框', type: '位置', componentEvidence: true, containerShift: -12, box: { x: 20, y: 200, w: 360, h: 80 } }
  const child = { type: '位置', componentEvidence: true, box: { x: 50, y: 220, w: 100, h: 24 }, measurement: { designBox: { y: 232 }, implementationBox: { y: 220 } } }
  const text = { ...child, type: '文字' }
  const independent = { ...child, measurement: { designBox: { y: 242 }, implementationBox: { y: 220 } } }
  const result = reconcileComponentIssues([parent], { issues: [child, text, independent], matched: [] })
  assert.deepEqual(result, [parent, text, independent])
})

test('a native-resolution container replaces rather than disappears with its coarse duplicate', () => {
  const coarse = { element: '底部操作栏外框', type: '位置', componentEvidence: true, containerShift: -10, box: { x: 20, y: 680, w: 360, h: 80 } }
  const precise = { ...coarse, replacesCoarseBar: true, measurement: { designBox: { y: 692 }, implementationBox: { y: 680 } } }
  assert.deepEqual(reconcileComponentIssues([coarse], { issues: [precise], matched: [] }), [precise])
})

test('matched control fill changes survive but uniform page-and-control shifts do not', async () => {
  const a = raster(), b = raster(), global = raster([12, 12, 12])
  paint(a, 230, 150, 115, 35, [30, 30, 30]); paint(b, 230, 150, 115, 35, [48, 48, 48]); paint(global, 230, 150, 115, 35, [42, 42, 42])
  assert.ok((await compare(a, b)).issues.some((i) => i.type === '颜色' && i.element === '匹配的横向控件'))
  assert.equal((await compare(a, global)).issues.length, 0)
})

function bar(pixels, { top = 680, radius = 34, stroke = 3 } = {}) {
  const left = 24, w = 352, h = 70
  const inside = (x, y, inset) => {
    const r = Math.max(0, radius - inset)
    const cx = Math.max(left + inset + r, Math.min(left + w - inset - r, x))
    const cy = Math.max(top + inset + r, Math.min(top + h - inset - r, y))
    return x >= left + inset && x < left + w - inset && y >= top + inset && y < top + h - inset && Math.hypot(x - cx, y - cy) <= r
  }
  for (let y = top; y < top + h; y++) for (let x = left; x < left + w; x++) if (inside(x + 0.5, y + 0.5, 0)) paint(pixels, x, y, 1, 1, inside(x + 0.5, y + 0.5, stroke) ? [30, 30, 30] : [80, 80, 80])
}
const compareBars = (a, b, profile = {}) => compareBarOutlines({ designPixels: a, implementationPixels: b, width, height, outputWidth: width, outputHeight: height, profile: { mode: 'same-width', ...profile } })

test('native paired outlines retain bottom gap, border and independently changed corner shape', () => {
  const a = raster(), b = raster()
  bar(a); bar(b, { top: 668, radius: 14, stroke: 1 })
  const issues = compareBars(a, b)
  assert.deepEqual(new Set(issues.map((i) => i.type)), new Set(['位置', '边框', '圆角']))
  assert.equal(issues.find((i) => i.type === '位置').containerShift, -12)
})

test('pure bar translation is not a border or corner issue; stroke change alone is not a corner issue', () => {
  const a = raster(), moved = raster(), thinner = raster()
  bar(a); bar(moved, { top: 668 }); bar(thinner, { stroke: 1 })
  assert.deepEqual(compareBars(a, moved).map((i) => i.type), ['位置'])
  assert.deepEqual(compareBars(a, thinner).map((i) => i.type), ['边框'])
  assert.deepEqual(compareBars(a, a), [])
})

test('missing, unoutlined and cropped bars cannot support precise paired outline claims', () => {
  const a = raster(), b = raster()
  bar(a); bar(b, { stroke: 0 })
  assert.deepEqual(compareBars(a, b), [])
  assert.deepEqual(compareBars(a, raster()), [])
  assert.deepEqual(compareBars(a, a, { heightsDiffer: true }), [])
})

test('missing underlying content prevents a floating-bar material conclusion, not position/selection', () => {
  const base = { box: { x: 30, y: 680, w: 340, h: 70 }, componentEvidence: true }
  const material = { ...base, element: '底部操作栏背景质感' }
  const selection = { ...base, element: '底部导航选中态填充' }
  assert.deepEqual(reconcileComponentIssues([material, selection], { issues: [], matched: [], absence: [{ x: 30, y: 350, w: 340, h: 320 }] }), [selection])
})

test('component inspection honors cancellation', async () => {
  const signal = AbortSignal.abort()
  await assert.rejects(compareComponents({ designPixels: raster(), implementationPixels: raster(), width, height, signal }), { name: 'AbortError' })
})
