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

const sameLayoutWithDifferentData = (width, height, variant) => createRaster(
  width,
  height,
  (x, y) => {
    if (y < 16) return [24, 42, 68, 255]
    if (x < 20) return [233, 238, 245, 255]

    const contentX = x - 24
    const contentY = y - 22
    const cardColumn = Math.floor(contentX / 44)
    const cardRow = Math.floor(contentY / 34)
    const inCardX = ((contentX % 44) + 44) % 44
    const inCardY = ((contentY % 34) + 34) % 34
    const insideCard = contentX >= 0 && contentY >= 0 &&
      cardColumn >= 0 && cardColumn < 3 && cardRow >= 0 && cardRow < 3 &&
      inCardX < 40 && inCardY < 29

    if (!insideCard) return [248, 250, 252, 255]
    if (inCardX === 0 || inCardY === 0 || inCardX === 39 || inCardY === 28) {
      return [146, 158, 176, 255]
    }

    // The cards keep exactly the same geometry. Only their fake imagery, text,
    // and business values change, including across most of the page.
    const shiftedX = inCardX + (variant === 'implementation' ? 2 : 0)
    const shiftedY = inCardY + (variant === 'implementation' ? 3 : 0)
    const checker = (Math.floor(shiftedX / 4) + Math.floor(shiftedY / 3)) % 2
    if (variant === 'implementation') {
      return checker ? [34, 166, 118, 255] : [244, 128, 54, 255]
    }
    return checker ? [46, 92, 206, 255] : [225, 62, 126, 255]
  },
)

const sameLayoutWithDifferentMediaTexture = (width, height, variant) => createRaster(
  width,
  height,
  (x, y) => {
    if (y < 16) return [24, 42, 68, 255]
    if (x < 20) return [233, 238, 245, 255]

    const contentX = x - 24
    const contentY = y - 22
    const inCardX = ((contentX % 44) + 44) % 44
    const inCardY = ((contentY % 34) + 34) % 34
    const insideCard = contentX >= 0 && contentY >= 0 &&
      Math.floor(contentX / 44) < 3 && Math.floor(contentY / 34) < 3 &&
      inCardX < 40 && inCardY < 29

    if (!insideCard) return [248, 250, 252, 255]
    if (inCardX === 0 || inCardY === 0 || inCardX === 39 || inCardY === 28) {
      return [146, 158, 176, 255]
    }

    if (variant === 'implementation') {
      const texture = (Math.floor(inCardX / 2) + Math.floor(inCardY / 2)) % 2
      return texture ? [28, 52, 196, 255] : [234, 206, 58, 255]
    }

    const textLine = inCardY === 20 || (inCardY === 24 && inCardX < 24)
    return textLine ? [58, 70, 88, 255] : [137, 143, 151, 255]
  },
)

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

test('bottom alignment reports unmatched transparent rows at the top edge', () => {
  const width = 96
  const height = 120
  const designPixels = basePage(width, height)
  const implementationPixels = designPixels.slice()
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < width; x++) {
      implementationPixels[(y * width + x) * 4 + 3] = 0
    }
  }

  const result = assessComparability({
    designPixels,
    implementationPixels,
    width,
    height,
    profile: { alignment: 'bottom-left', comparisonHeight: height },
  })

  assert.equal(result.status, 'medium')
  assert.ok(result.metrics.unmatchedTopRatio >= 0.2)
  assert.equal(result.metrics.topMissingSide, 'implementation')
  assert.equal(result.metrics.unmatchedBottomRatio, 0)
  assert.ok(result.reasons.some(({ code }) => code === 'TRANSPARENT_TOP_MISMATCH'))
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

test('same layout with different fake data remains reviewable', () => {
  const width = 160
  const height = 132
  const result = assessComparability({
    designPixels: sameLayoutWithDifferentData(width, height, 'design'),
    implementationPixels: sameLayoutWithDifferentData(width, height, 'implementation'),
    width,
    height,
  })

  assert.equal(result.status, 'medium')
  assert.ok(result.score >= 50)
  assert.ok(result.metrics.strongPixelRatio > 0.25)
  assert.equal(result.metrics.oneSidedTransparentRatio, 0)
  assert.ok(result.metrics.changedRowRatio > 0.6)
  assert.ok(result.metrics.changedColumnRatio > 0.6)
  assert.ok(result.metrics.coarseLayoutSimilarity >= 0.6)
  assert.ok(result.reasons.some(({ code }) => code === 'WIDESPREAD_CONTENT_VARIATION'))
  assert.ok(!result.reasons.some(({ level }) => level === 'blocking'))
})

test('same card geometry remains reviewable when media edge density changes', () => {
  const width = 160
  const height = 132
  const result = assessComparability({
    designPixels: sameLayoutWithDifferentMediaTexture(width, height, 'design'),
    implementationPixels: sameLayoutWithDifferentMediaTexture(
      width,
      height,
      'implementation',
    ),
    width,
    height,
  })

  assert.equal(result.status, 'medium')
  assert.ok(result.metrics.strongPixelRatio > 0.25)
  assert.ok(result.metrics.changedRowRatio > 0.6)
  assert.ok(result.metrics.changedColumnRatio > 0.6)
  assert.ok(result.metrics.coarseLayoutSimilarity >= 0.6)
  assert.ok(result.reasons.some(({ code }) => code === 'WIDESPREAD_CONTENT_VARIATION'))
  assert.ok(!result.reasons.some(({ level }) => level === 'blocking'))
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
  assert.ok(result.metrics.layoutStructureChangedCellRatio > 0.25)
  assert.ok(result.metrics.layoutStructureChangedRowRatio > 0.6)
  assert.ok(result.metrics.layoutStructureChangedColumnRatio > 0.6)
  assert.ok(result.metrics.coarseLayoutSimilarity < 0.6)
  assert.ok(result.reasons.some(({ code }) => code === 'GLOBAL_STRONG_DIFFERENCE'))
  assert.ok(result.reasons.some(({ code }) => code === 'WIDESPREAD_STRUCTURE_DIFFERENCE'))
})
