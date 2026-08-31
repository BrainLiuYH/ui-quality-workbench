import assert from 'node:assert/strict'
import test from 'node:test'

import { diffRasters } from '../src/engine/pixel-diff.js'

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
