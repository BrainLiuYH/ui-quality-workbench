import assert from 'node:assert/strict'
import test from 'node:test'

import { diffRasters } from '../src/engine/pixel-diff.js'
import { groupIssues } from '../src/engine/group-issues.js'
import { adaptYangaoGroups } from '../src/lib/findingsAdapter.js'

function raster(width, height, color = [16, 18, 20]) {
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

function fill(pixels, width, x, y, w, h, color) {
  for (let row = y; row < y + h; row++) {
    for (let column = x; column < x + w; column++) {
      const offset = (row * width + column) * 4
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
    }
  }
}

test('same page structure with different copy and media creates no actionable annotations', async () => {
  const width = 160
  const height = 220
  const design = raster(width, height)
  const implementation = raster(width, height)

  // Same page regions and card boundary.
  for (const pixels of [design, implementation]) {
    fill(pixels, width, 12, 12, 136, 2, [90, 94, 100])
    fill(pixels, width, 12, 70, 136, 2, [90, 94, 100])
    fill(pixels, width, 12, 78, 136, 118, [46, 50, 56])
  }

  // Different fake labels and values.
  fill(design, width, 18, 28, 58, 8, [235, 235, 235])
  fill(design, width, 18, 48, 92, 6, [150, 150, 150])
  fill(implementation, width, 18, 28, 88, 8, [235, 235, 235])
  fill(implementation, width, 18, 48, 55, 6, [150, 150, 150])

  // Same media box, unrelated placeholder imagery inside it.
  for (let y = 84; y < 190; y++) {
    for (let x = 18; x < 142; x++) {
      const designColor = (Math.floor(x / 6) + Math.floor(y / 5)) % 2
        ? [32, 112, 188]
        : [214, 92, 64]
      const implementationColor = (Math.floor(x / 3) + Math.floor(y / 7)) % 2
        ? [28, 168, 116]
        : [226, 174, 52]
      fill(design, width, x, y, 1, 1, designColor)
      fill(implementation, width, x, y, 1, 1, implementationColor)
    }
  }

  const result = await diffRasters({
    designPixels: design,
    implementationPixels: implementation,
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: { mode: 'exact', ignoreTop: 0 },
  })
  const groups = groupIssues(result.issues, { width, height })
  const findings = adaptYangaoGroups(groups, {
    targetWidth: width,
    targetHeight: height,
    comparability: { reasons: [{ code: 'WIDESPREAD_CONTENT_VARIATION' }] },
  })

  assert.ok(result.issues.length > 0, 'the raster engine should still observe the visual changes')
  assert.deepEqual(findings, [])
})
