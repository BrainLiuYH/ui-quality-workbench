import assert from 'node:assert/strict'
import test from 'node:test'

import { diffRasters } from '../src/engine/pixel-diff.js'
import { groupIssues } from '../src/engine/group-issues.js'

function opaqueRaster(width, height, color = [255, 255, 255]) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < width * height; index++) {
    const offset = index * 4
    pixels[offset] = color[0]
    pixels[offset + 1] = color[1]
    pixels[offset + 2] = color[2]
    pixels[offset + 3] = 255
  }
  return pixels
}

function setPixel(pixels, width, x, y, color) {
  const offset = (y * width + x) * 4
  pixels[offset] = color[0]
  pixels[offset + 1] = color[1]
  pixels[offset + 2] = color[2]
  pixels[offset + 3] = 255
}

async function compare(designPixels, implementationPixels, width, height) {
  return diffRasters({
    designPixels,
    implementationPixels,
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: { mode: 'exact', ignoreTop: 0 },
  })
}

test('different flat page backgrounds produce one bounded background observation', async () => {
  const width = 180
  const height = 300
  const design = opaqueRaster(width, height, [0, 0, 0])
  const implementation = opaqueRaster(width, height, [18, 18, 17])
  const result = await compare(design, implementation, width, height)
  const background = result.issues.filter((issue) => issue.backgroundEvidence)

  assert.equal(background.length, 1)
  assert.equal(background[0].design_value, '#000000')
  assert.equal(background[0].implementation_value, '#121211')
  assert.ok(background[0].box.w < width * 0.2)
  assert.ok(result.issues.every((issue) => issue.box.w < width * 0.5))
})

test('a broad flat bottom selection is distinct from small accent marks', async () => {
  const width = 300
  const height = 600
  const design = opaqueRaster(width, height, [15, 15, 15])
  const implementation = opaqueRaster(width, height, [15, 15, 15])
  for (let y = 548; y < 585; y++) {
    for (let x = 25; x < 100; x++) {
      setPixel(implementation, width, x, y, [231, 190, 111])
    }
  }
  for (let y = 552; y < 568; y++) {
    for (let x = 50; x < 65; x++) setPixel(design, width, x, y, [231, 190, 111])
  }
  const result = await compare(design, implementation, width, height)
  const selection = result.issues.find((issue) =>
    issue.element === '底部导航选中态填充')

  assert.ok(selection)
  assert.equal(selection.componentEvidence, true)
  assert.ok(selection.box.y >= 540)
  assert.ok(selection.box.w < width * 0.35)
})

test('a matching light card shifted vertically is reported as position, not size', async () => {
  const width = 300
  const height = 600
  const design = opaqueRaster(width, height, [0, 0, 0])
  const implementation = opaqueRaster(width, height, [0, 0, 0])
  for (let y = 210; y < 260; y++) {
    for (let x = 20; x < 280; x++) setPixel(design, width, x, y, [244, 241, 236])
  }
  for (let y = 196; y < 246; y++) {
    for (let x = 20; x < 280; x++) setPixel(implementation, width, x, y, [244, 241, 236])
  }
  const result = await compare(design, implementation, width, height)
  const card = result.issues.find((issue) => issue.element === '浅色卡片外框')

  assert.ok(card)
  assert.equal(card.type, '位置')
  assert.match(card.text, /-14px/)
})

test('a matching bottom bar with a different bottom gap is a position issue', async () => {
  const width = 300
  const height = 600
  const design = opaqueRaster(width, height, [15, 15, 15])
  const implementation = opaqueRaster(width, height, [15, 15, 15])
  const drawBar = (pixels, top, bottom) => {
    for (let y = top; y < bottom; y++) {
      for (let x = 15; x < 285; x++) {
        setPixel(pixels, width, x, y, [45, 43, 42])
      }
    }
  }
  drawBar(design, 515, 575)
  drawBar(implementation, 495, 555)

  const result = await compare(design, implementation, width, height)
  const bar = result.issues.find((issue) => issue.element === '底部操作栏外框')

  assert.ok(bar)
  assert.equal(bar.type, '位置')
  assert.equal(bar.componentEvidence, true)
  assert.match(bar.design_value, /距截图底边约 2[4-6]px/)
  assert.match(bar.implementation_value, /距截图底边约 4[4-6]px/)
  assert.ok(bar.box.y <= 497 && bar.box.y + bar.box.h >= 573)

  const same = await compare(design, design, width, height)
  assert.equal(same.issues.some((issue) => issue.element === '底部操作栏外框'), false)
  const noBar = await compare(opaqueRaster(width, height, [15, 15, 15]), implementation, width, height)
  assert.equal(noBar.issues.some((issue) => issue.element === '底部操作栏外框'), false)

  const cropped = await diffRasters({
    designPixels: design,
    implementationPixels: implementation,
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: { mode: 'same-width', heightsDiffer: true, ignoreTop: 0 },
  })
  assert.equal(cropped.issues.some((issue) => issue.element === '底部操作栏外框'), false)
})

test('a bottom bar gradient versus a flat fill is a separate background-style candidate', async () => {
  const width = 300
  const height = 600
  const design = opaqueRaster(width, height, [15, 15, 15])
  const implementation = opaqueRaster(width, height, [15, 15, 15])
  for (let y = 515; y < 575; y++) {
    const light = Math.round(31 + (y - 515) * 0.3)
    for (let x = 15; x < 285; x++) {
      setPixel(design, width, x, y, [light, light, light])
      setPixel(implementation, width, x, y, [31, 31, 31])
    }
  }
  for (let y = 525; y < 565; y++) {
    for (let x = 25; x < 100; x++) {
      setPixel(implementation, width, x, y, [231, 190, 111])
    }
  }
  for (let y = 535; y < 550; y++) {
    for (let x = 50; x < 65; x++) {
      setPixel(design, width, x, y, [231, 190, 111])
    }
  }

  const result = await compare(design, implementation, width, height)
  const style = result.issues.find((issue) => issue.element === '底部操作栏背景质感')

  assert.ok(style)
  assert.equal(style.componentEvidence, true)
  assert.match(style.design_value, /有明暗过渡/)
  assert.match(style.implementation_value, /近乎均一/)
  assert.equal(result.issues.some((issue) => issue.element === '底部操作栏外框'), false)
  assert.ok(result.issues.some((issue) => issue.element === '底部导航选中态填充'))

  const matched = await compare(design, design, width, height)
  assert.equal(matched.issues.some((issue) => issue.element === '底部操作栏背景质感'), false)
})

test('dense image-like regions use the neutral content class', async () => {
  const width = 144
  const height = 112
  const design = opaqueRaster(width, height)
  const implementation = opaqueRaster(width, height)

  for (let y = 12; y < 100; y++) {
    for (let x = 12; x < 132; x++) {
      const designValue = (x * 37 + y * 61 + (x ^ y) * 11) % 256
      const implementationValue = (x * 19 + y * 43 + (x * y) % 97) % 256
      setPixel(design, width, x, y, [designValue, 255 - designValue, (designValue * 3) % 256])
      setPixel(implementation, width, x, y, [
        (implementationValue * 5) % 256,
        implementationValue,
        255 - implementationValue,
      ])
    }
  }

  const result = await compare(design, implementation, width, height)

  assert.ok(result.issues.length > 0)
  assert.deepEqual([...new Set(result.issues.map((issue) => issue.type))], ['内容'])
  assert.ok(result.issues.every((issue) => issue.text.includes('无法可靠归因')))
  assert.ok(result.issues.every((issue) => issue.reviewOnly === true))
})

test('single-sided contour evidence never invents a size or position finding', async () => {
  const width = 80
  const height = 80
  const design = opaqueRaster(width, height)
  const implementation = opaqueRaster(width, height)

  for (let y = 30; y < 42; y++) {
    for (let x = 34; x < 46; x++) setPixel(implementation, width, x, y, [25, 25, 25])
  }

  const result = await compare(design, implementation, width, height)

  assert.ok(result.issues.every((issue) => !['尺寸', '位置', '布局'].includes(issue.type)))
})

test('a flat horizontal bar is not inferred to be text', async () => {
  const width = 128
  const height = 64
  const design = opaqueRaster(width, height)
  const implementation = opaqueRaster(width, height)

  for (let y = 24; y < 40; y++) {
    for (let x = 16; x < 112; x++) {
      setPixel(design, width, x, y, [35, 35, 35])
      setPixel(implementation, width, x, y, [80, 80, 80])
    }
  }

  const result = await compare(design, implementation, width, height)

  assert.ok(result.issues.some((issue) => issue.type === '颜色'))
  assert.ok(result.issues.every((issue) => issue.type !== '文字'))
})

test('a slender edge fragment is never labeled as an icon or component style', async () => {
  const width = 72
  const height = 120
  const design = opaqueRaster(width, height)
  const implementation = opaqueRaster(width, height)

  for (let y = 18; y < 102; y++) {
    for (let x = 32; x < 34; x++) setPixel(design, width, x, y, [20, 20, 20])
    for (let x = 36; x < 38; x++) setPixel(implementation, width, x, y, [20, 20, 20])
  }

  const result = await compare(design, implementation, width, height)

  assert.deepEqual(result.issues, [])
})

test('ordinary small opaque color changes remain color findings only', async () => {
  const width = 48
  const height = 48
  const design = opaqueRaster(width, height)
  const implementation = opaqueRaster(width, height)

  for (let y = 14; y < 34; y++) {
    for (let x = 14; x < 34; x++) {
      setPixel(design, width, x, y, [220, 40, 40])
      setPixel(implementation, width, x, y, [40, 80, 220])
    }
  }

  const result = await compare(design, implementation, width, height)

  assert.ok(result.issues.length > 0)
  assert.deepEqual([...new Set(result.issues.map((issue) => issue.type))], ['颜色'])
})

test('ordinary non-slender geometry differences remain detectable without contradictory labels', async () => {
  const width = 64
  const height = 64
  const design = opaqueRaster(width, height)
  const implementation = opaqueRaster(width, height)

  for (let y = 18; y < 38; y++) {
    for (let x = 16; x < 36; x++) setPixel(design, width, x, y, [30, 30, 30])
    for (let x = 22; x < 42; x++) setPixel(implementation, width, x, y, [30, 30, 30])
  }

  const result = await compare(design, implementation, width, height)

  assert.ok(result.issues.some((issue) => ['尺寸', '位置'].includes(issue.type)))
  for (const issue of result.issues) {
    const competing = result.issues.filter((candidate) => {
      const left = Math.max(issue.box.x, candidate.box.x)
      const top = Math.max(issue.box.y, candidate.box.y)
      const right = Math.min(issue.box.x + issue.box.w, candidate.box.x + candidate.box.w)
      const bottom = Math.min(issue.box.y + issue.box.h, candidate.box.y + candidate.box.h)
      const overlap = Math.max(0, right - left) * Math.max(0, bottom - top)
      return candidate.id !== issue.id &&
        overlap / Math.max(1, Math.min(issue.box.w * issue.box.h, candidate.box.w * candidate.box.h)) > 0.9
    })
    assert.deepEqual(competing, [])
  }
})

test('a wide control with a visibly different outline is not lost as width-normalization noise', async () => {
  const width = 180
  const height = 100
  const design = opaqueRaster(width, height, [20, 20, 20])
  const implementation = opaqueRaster(width, height, [20, 20, 20])
  for (let y = 36; y < 64; y++) {
    for (let x = 18; x < 162; x++) {
      const boundary = y < 39 || y >= 61 || x < 21 || x >= 159
      setPixel(design, width, x, y, boundary ? [175, 175, 175] : [34, 34, 34])
      setPixel(implementation, width, x, y, boundary ? [76, 76, 76] : [34, 34, 34])
    }
  }
  const result = await diffRasters({
    designPixels: design, implementationPixels: implementation,
    width, height, outputWidth: width, outputHeight: height,
    profile: { mode: 'width-normalized', ignoreTop: 0 },
  })
  assert.ok(result.issues.some((issue) => issue.type === '颜色' || issue.type === '边框'))
})

test('a wide filled control with an added border keeps structural evidence', async () => {
  const width = 220
  const height = 110
  const design = opaqueRaster(width, height, [18, 18, 18])
  const implementation = opaqueRaster(width, height, [18, 18, 18])
  for (let y = 38; y < 73; y++) {
    for (let x = 20; x < 200; x++) {
      const edge = y < 41 || y >= 70 || x < 23 || x >= 197
      const label = y >= 52 && y < 59 && x >= 84 && x < 136
      setPixel(design, width, x, y, label ? [230, 230, 230] : [40, 40, 40])
      setPixel(implementation, width, x, y, label ? [230, 230, 230] : edge ? [135, 135, 135] : [40, 40, 40])
    }
  }
  const result = await compare(design, implementation, width, height)
  assert.ok(result.issues.some((issue) => issue.type === '边框'),
    `Expected an added-outline finding, got ${JSON.stringify(result.issues)}`)
})

test('a control with independent fill and outline changes retains both signals', async () => {
  const width = 220
  const height = 110
  const design = opaqueRaster(width, height, [18, 18, 18])
  const implementation = opaqueRaster(width, height, [18, 18, 18])
  for (let y = 38; y < 73; y++) {
    for (let x = 20; x < 200; x++) {
      const edge = y < 41 || y >= 70 || x < 23 || x >= 197
      setPixel(design, width, x, y, [40, 40, 40])
      setPixel(implementation, width, x, y,
        edge ? [160, 160, 160] : [72, 72, 72])
    }
  }
  const result = await compare(design, implementation, width, height)
  assert.ok(result.issues.some((issue) => issue.type === '边框'),
    `Missing outline evidence: ${JSON.stringify(result.issues)}`)
  assert.ok(result.issues.some((issue) => issue.type === '颜色'),
    `Missing fill evidence: ${JSON.stringify(result.issues)}`)
})

test('a broad textured card that is blank on the other side raises a presence question', async () => {
  const width = 200
  const height = 180
  const design = opaqueRaster(width, height, [22, 22, 22])
  const implementation = opaqueRaster(width, height, [22, 22, 22])
  for (let y = 64; y < 130; y++) {
    for (let x = 18; x < 182; x++) {
      const value = (x * 19 + y * 41) % 120 + 80
      setPixel(design, width, x, y, [value, value, value])
    }
  }
  const result = await compare(design, implementation, width, height)
  assert.ok(result.issues.some((issue) => issue.presenceEvidence === 'large-flat-absence'),
    `Missing presence question: ${JSON.stringify(result.issues)}`)
  assert.ok(result.issues.every((issue) => issue.type !== '尺寸' && issue.type !== '位置'))
})

test('different corners of a wide bottom control remain visible as a style candidate', async () => {
  const width = 200
  const height = 100
  const design = opaqueRaster(width, height, [19, 19, 19])
  const implementation = opaqueRaster(width, height, [19, 19, 19])
  const inside = (x, y, radius) => {
    if (x < 15 || x >= 185 || y < 40 || y >= 76) return false
    const centerX = x < 15 + radius ? 15 + radius : x >= 185 - radius ? 185 - radius - 1 : x
    const centerY = y < 40 + radius ? 40 + radius : y >= 76 - radius ? 76 - radius - 1 : y
    return Math.hypot(x - centerX, y - centerY) <= radius
  }
  for (let y = 40; y < 76; y++) {
    for (let x = 15; x < 185; x++) {
      if (inside(x, y, 17)) setPixel(design, width, x, y, [48, 48, 48])
      if (inside(x, y, 6)) setPixel(implementation, width, x, y, [48, 48, 48])
    }
  }
  const result = await compare(design, implementation, width, height)
  assert.ok(result.issues.some((issue) => issue.type === '圆角'),
    `Missing corner-shape evidence: ${JSON.stringify(result.issues)}`)
  const cornerGroups = groupIssues(result.issues.filter((issue) => issue.type === '圆角'),
    { width, height })
  assert.equal(cornerGroups.length, 1)
  assert.equal(cornerGroups[0].element, '组件外轮廓')
})
