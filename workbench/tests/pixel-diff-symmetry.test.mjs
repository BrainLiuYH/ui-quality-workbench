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

function canonicalIssues(issues) {
  return issues.map((issue) => ({
    type: issue.type,
    severity: issue.severity,
    score: issue.score,
    element: issue.element,
    box: issue.box,
    reviewOnly: issue.reviewOnly ?? false,
  }))
}

function compare(designPixels, implementationPixels, width, height) {
  return diffRasters({
    designPixels,
    implementationPixels,
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: { mode: 'width-normalized', ignoreTop: 0 },
  })
}

test('width-normalized local tolerance is symmetric when screenshot roles are exchanged', async () => {
  const width = 72
  const height = 72
  const detailed = opaqueRaster(width, height)
  const flat = opaqueRaster(width, height)

  // Every flat white pixel has a white neighbour in the detailed raster, but
  // the detailed black pixels do not have a corresponding pixel in the flat
  // raster. A one-way nearest-neighbour lookup therefore erased this entire
  // difference in one role order and reported it in the other.
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((x + y) % 2) continue
      const offset = (y * width + x) * 4
      detailed[offset] = 0
      detailed[offset + 1] = 0
      detailed[offset + 2] = 0
    }
  }

  const detailedFirst = await compare(detailed, flat, width, height)
  const flatFirst = await compare(flat, detailed, width, height)

  assert.deepEqual(detailedFirst.metrics, flatFirst.metrics)
  assert.equal(detailedFirst.coverage, flatFirst.coverage)
  assert.deepEqual(
    canonicalIssues(detailedFirst.issues),
    canonicalIssues(flatFirst.issues),
  )
  assert.ok(detailedFirst.metrics.strongRatio >= 40)
  assert.ok(detailedFirst.issues.length > 0)
})

test('symmetric local tolerance keeps a one-sided transparent region detectable', async () => {
  const width = 48
  const height = 48
  const complete = opaqueRaster(width, height, [32, 96, 192])
  const shorter = opaqueRaster(width, height, [32, 96, 192])

  for (let y = height / 2; y < height; y++) {
    for (let x = 0; x < width; x++) {
      shorter[(y * width + x) * 4 + 3] = 0
    }
  }

  const result = await compare(complete, shorter, width, height)

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].type, '布局')
  assert.ok(result.issues[0].box.y + result.issues[0].box.h > height / 2)
  assert.ok(result.issues[0].text.includes('实现稿'))
  assert.ok(result.issues[0].text.includes('缺少'))
})

test('page-height issue crops a connected content difference to its transparent edge band', async () => {
  const width = 80
  const height = 120
  const transparentBandTop = 108
  const design = opaqueRaster(width, height)
  const implementation = opaqueRaster(width, height)

  // The large color change runs directly into the unmatched transparent
  // footer, so region collection deliberately joins both differences into a
  // single part. Only the footer is valid evidence for a page-height issue.
  for (let y = 50; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      design[offset] = 0
      design[offset + 1] = 0
      design[offset + 2] = 0
      implementation[offset] = 255
      implementation[offset + 1] = 0
      implementation[offset + 2] = 0
      if (y >= transparentBandTop) implementation[offset + 3] = 0
    }
  }

  const result = await compare(design, implementation, width, height)

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].type, '布局')
  assert.equal(result.issues[0].element, '页面底部或高度区域')
  assert.deepEqual(result.issues[0].box, {
    x: 0,
    y: transparentBandTop,
    w: width,
    h: height - transparentBandTop,
  })
})
