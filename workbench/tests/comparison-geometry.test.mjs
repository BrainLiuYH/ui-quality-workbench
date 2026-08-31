import assert from 'node:assert/strict'
import test from 'node:test'

import {
  getComparisonPlacement,
  intersectCanvasCropWithPlacement,
} from '../src/lib/comparisonGeometry.js'

test('bottom placement maps the shared canvas back to source coordinates', () => {
  const profile = {
    targetWidth: 1200,
    targetHeight: 1800,
    implementationNormalizedWidth: 1200,
    implementationNormalizedHeight: 1000,
    implementationScale: 2,
    implementationOffsetY: 800,
  }
  const placement = getComparisonPlacement(
    profile,
    'implementation',
    { width: 600, height: 500 },
  )

  assert.equal(placement.offsetY, 800)
  assert.equal(placement.bottom, 1800)

  const intersection = intersectCanvasCropWithPlacement(
    { x: 100, y: 760, width: 240, height: 160 },
    placement,
  )

  assert.deepEqual(intersection.canvas, { x: 100, y: 800, width: 240, height: 120 })
  assert.deepEqual(intersection.source, { x: 50, y: 0, width: 120, height: 60 })
})

test('a crop wholly inside transparent padding has no source intersection', () => {
  const placement = getComparisonPlacement({
    targetWidth: 1200,
    targetHeight: 1800,
    implementationNormalizedHeight: 1000,
    implementationScale: 2,
    implementationOffsetY: 800,
  }, 'implementation', { width: 600, height: 500 })

  assert.equal(intersectCanvasCropWithPlacement(
    { x: 0, y: 100, width: 300, height: 200 },
    placement,
  ), null)
})

test('horizontal element offset maps canvas crop back to local source x', () => {
  const placement = getComparisonPlacement({
    comparisonWidth: 1120,
    comparisonHeight: 1000,
    targetWidth: 1000,
    targetHeight: 1000,
    implementationNormalizedWidth: 1000,
    implementationNormalizedHeight: 1000,
    implementationOffsetX: 120,
    implementationOffsetY: 0,
    implementationScale: 2,
  }, 'implementation', { width: 500, height: 500 })

  const intersection = intersectCanvasCropWithPlacement(
    { x: 100, y: 40, width: 100, height: 80 },
    placement,
  )

  assert.deepEqual(intersection.canvas, { x: 120, y: 40, width: 80, height: 80 })
  assert.deepEqual(intersection.source, { x: 0, y: 20, width: 40, height: 40 })
})
