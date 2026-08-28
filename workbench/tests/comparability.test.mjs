import assert from 'node:assert/strict'
import test from 'node:test'

import { assessComparability } from '../src/engine/comparability.js'

function createRaster(width, height, painter) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      const [red, green, blue, alpha = 255] = painter(x, y)
      pixels[index] = red
      pixels[index + 1] = green
      pixels[index + 2] = blue
      pixels[index + 3] = alpha
    }
  }
  return pixels
}

const basePage = (width, height) => createRaster(width, height, (x, y) => {
  if (y < height * 0.12) return [25, 48, 76, 255]
  if (x < width * 0.18) return [230, 235, 242, 255]
  if (y % 24 < 3 && x > width * 0.24) return [105, 120, 140, 255]
  return [248, 250, 252, 255]
})

test('identical rasters are highly comparable', () => {
  const width = 96
  const height = 120
  const designPixels = basePage(width, height)
  const result = assessComparability({
    designPixels,
    implementationPixels: designPixels.slice(),
    width,
    height,
  })

  assert.equal(result.status, 'high')
  assert.equal(result.score, 100)
  assert.equal(result.metrics.strongPixelRatio, 0)
  assert.equal(result.metrics.oneSidedTransparentRatio, 0)
  assert.equal(result.reasons[0].code, 'COMPARABLE_INPUTS')
})

test('a transparent unmatched bottom is reported as an input-height problem', () => {
  const width = 96
  const height = 120
  const designPixels = basePage(width, height)
  const implementationPixels = designPixels.slice()
  for (let y = 90; y < height; y++) {
    for (let x = 0; x < width; x++) {
      implementationPixels[(y * width + x) * 4 + 3] = 0
    }
  }

  const result = assessComparability({
    designPixels,
    implementationPixels,
    width,
    height,
  })

  assert.equal(result.status, 'medium')
  assert.ok(result.metrics.oneSidedTransparentRatio > 0.2)
  assert.ok(result.metrics.unmatchedBottomRatio >= 0.2)
  assert.equal(result.metrics.bottomMissingSide, 'implementation')
  assert.ok(result.reasons.some(({ code }) => code === 'TRANSPARENT_BOTTOM_MISMATCH'))
  assert.ok(!result.reasons.some(({ code }) => code === 'GLOBAL_STRONG_DIFFERENCE'))
})

test('one changed media block does not make the whole page incomparable', () => {
  const width = 120
  const height = 144
  const designPixels = basePage(width, height)
  const implementationPixels = designPixels.slice()

  for (let y = 28; y < 72; y++) {
    for (let x = 24; x < 108; x++) {
      const index = (y * width + x) * 4
      const alternate = (Math.floor(x / 5) + Math.floor(y / 5)) % 2 === 0
      implementationPixels[index] = alternate ? 20 : 225
      implementationPixels[index + 1] = alternate ? 150 : 65
      implementationPixels[index + 2] = alternate ? 205 : 45
      implementationPixels[index + 3] = 255
    }
  }

  const result = assessComparability({
    designPixels,
    implementationPixels,
    width,
    height,
  })

  assert.notEqual(result.status, 'low')
  assert.equal(result.status, 'medium')
  assert.ok(result.metrics.strongPixelRatio > 0.1)
  assert.ok(result.metrics.changedRowRatio < 0.6)
  assert.ok(result.reasons.some(({ code }) => code === 'LOCALIZED_CONTENT_DIFFERENCE'))
  assert.ok(!result.reasons.some(({ code }) => code === 'WIDESPREAD_STRUCTURE_DIFFERENCE'))
})

test('widespread content and coarse structure changes are low-comparability', () => {
  const width = 120
  const height = 144
  const designPixels = createRaster(width, height, (x, y) => {
    const column = Math.floor(x / 15) % 2
    return column === 0
      ? [24, 54 + (y % 40), 88, 255]
      : [238, 242, 247, 255]
  })
  const implementationPixels = createRaster(width, height, (x, y) => {
    const row = Math.floor(y / 12) % 2
    const diagonal = (x + y) % 18 < 9
    return row === 0 && diagonal
      ? [225, 58, 40, 255]
      : [30, 165, 96, 255]
  })

  const result = assessComparability({
    designPixels,
    implementationPixels,
    width,
    height,
  })

  assert.equal(result.status, 'low')
  assert.ok(result.score < 50)
  assert.ok(result.metrics.strongPixelRatio > 0.25)
  assert.ok(result.metrics.changedRowRatio > 0.6)
  assert.ok(result.metrics.changedColumnRatio > 0.6)
  assert.ok(result.metrics.structureChangedCellRatio > 0.25)
  assert.ok(result.reasons.some(({ code }) => code === 'GLOBAL_STRONG_DIFFERENCE'))
  assert.ok(result.reasons.some(({ code }) => code === 'WIDESPREAD_STRUCTURE_DIFFERENCE'))
})
