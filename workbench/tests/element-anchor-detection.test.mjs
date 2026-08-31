import assert from 'node:assert/strict'
import test from 'node:test'

import { detectElementBounds } from '../src/lib/elementAnchorDetection.js'

function raster(width, height, background = [16, 18, 20]) {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let index = 0; index < data.length; index += 4) {
    data[index] = background[0]
    data[index + 1] = background[1]
    data[index + 2] = background[2]
    data[index + 3] = 255
  }
  const fill = (x, y, w, h, color) => {
    for (let row = y; row < y + h; row += 1) {
      for (let column = x; column < x + w; column += 1) {
        const index = (row * width + column) * 4
        data[index] = color[0]
        data[index + 1] = color[1]
        data[index + 2] = color[2]
      }
    }
  }
  return { data, width, height, fill }
}

function drawStatusPill(image, x, y) {
  image.fill(x, y, 80, 2, [102, 108, 115])
  image.fill(x, y + 30, 80, 2, [102, 108, 115])
  image.fill(x, y, 2, 32, [102, 108, 115])
  image.fill(x + 78, y, 2, 32, [102, 108, 115])
  image.fill(x + 13, y + 12, 8, 8, [38, 220, 105])
  for (let index = 0; index < 7; index += 1) {
    image.fill(x + 29 + index * 6, y + 11, 4, 10, [235, 238, 242])
  }
}

test('rough selections snap to the same complete status control', () => {
  const image = raster(220, 120)
  drawStatusPill(image, 110, 35)

  const first = detectElementBounds({
    ...image,
    roughBox: { x: 120, y: 40, width: 58, height: 22 },
  })
  const second = detectElementBounds({
    ...image,
    roughBox: { x: 130, y: 43, width: 42, height: 19 },
  })

  assert.equal(first.recognized, true)
  assert.equal(second.recognized, true)
  assert.ok(Math.abs(first.x - 110) <= 2)
  assert.ok(Math.abs(first.y - 35) <= 2)
  assert.ok(Math.abs(first.width - 80) <= 4)
  assert.ok(Math.abs(first.height - 32) <= 4)
  assert.ok(Math.abs(first.anchorX - second.anchorX) <= 0.5)
  assert.ok(Math.abs(first.anchorY - second.anchorY) <= 0.5)
})

test('separate glyphs are grouped into one text-row element', () => {
  const image = raster(220, 120, [250, 250, 250])
  for (let index = 0; index < 8; index += 1) {
    image.fill(40 + index * 10, 45, 6 + (index % 2), 15, [25, 30, 35])
  }

  const result = detectElementBounds({
    ...image,
    roughBox: { x: 48, y: 43, width: 58, height: 20 },
  })

  assert.equal(result.recognized, true)
  assert.ok(result.x <= 40)
  assert.ok(result.x + result.width >= 116)
  assert.ok(Math.abs(result.anchorY - 52) <= 2)
})

test('flat regions safely keep the manual range', () => {
  const image = raster(120, 80, [245, 245, 245])
  const roughBox = { x: 30, y: 20, width: 40, height: 24 }
  const result = detectElementBounds({ ...image, roughBox })

  assert.equal(result.recognized, false)
  assert.deepEqual(
    { x: result.x, y: result.y, width: result.width, height: result.height },
    roughBox,
  )
})
