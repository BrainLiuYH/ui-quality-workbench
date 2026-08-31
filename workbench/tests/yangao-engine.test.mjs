import assert from 'node:assert/strict'
import test from 'node:test'

import {
  analyzeImages,
  buildComparisonProfile,
  buildWidthNormalization,
  excludeStatusBarIssues,
  groupIssues,
} from '../src/engine/yangaoEngine.js'
import { analyzeImagesInWorker } from '../src/engine/yangaoWorkerClient.js'
import { diffRasters } from '../src/engine/pixel-diff.js'

const bitmapLike = (width, height) => ({ width, height })

test('buildComparisonProfile exposes the deterministic max-width strategy', () => {
  const original = buildComparisonProfile(bitmapLike(1440, 900), bitmapLike(1440, 900))
  assert.equal(original.mode, 'same-width')
  assert.equal(original.label, '原尺寸对比')

  const normalized = buildComparisonProfile(bitmapLike(1200, 800), bitmapLike(1000, 680))
  assert.equal(normalized.mode, 'width-normalized')
  assert.equal(normalized.targetWidth, 1200)
  assert.equal(normalized.designScale, 1)
  assert.equal(normalized.implementationScale, 1.2)
  assert.equal(normalized.designNormalizedHeight, 800)
  assert.equal(normalized.implementationNormalizedHeight, 816)

  const mobile = buildComparisonProfile(bitmapLike(390, 844), bitmapLike(390, 844))
  assert.equal(mobile.mobilePortrait, true)
  assert.ok(mobile.ignoreTop > 0)
})

test('buildWidthNormalization enlarges only the narrower image and preserves aspect ratios', () => {
  const normalized = buildWidthNormalization(
    bitmapLike(600, 900),
    bitmapLike(1200, 1000),
  )

  assert.equal(normalized.targetWidth, 1200)
  assert.equal(normalized.designScale, 2)
  assert.equal(normalized.implementationScale, 1)
  assert.ok(normalized.designScale >= 1)
  assert.ok(normalized.implementationScale >= 1)
  assert.equal(normalized.designWidth, 1200)
  assert.equal(normalized.designHeight, 1800)
  assert.equal(normalized.implementationWidth, 1200)
  assert.equal(normalized.implementationHeight, 1000)
  assert.equal(normalized.canvasWidth, 1200)
  assert.equal(normalized.canvasHeight, 1800)
  assert.equal(
    normalized.designWidth / normalized.designHeight,
    600 / 900,
  )
})

test('buildWidthNormalization bottom-aligns both normalized image rectangles', () => {
  const normalized = buildWidthNormalization(
    bitmapLike(600, 900),
    bitmapLike(1200, 1000),
    { alignment: 'bottom-left' },
  )

  assert.equal(normalized.alignment, 'bottom-left')
  assert.equal(normalized.verticalAlignment, 'bottom')
  assert.equal(normalized.designOffsetY, 0)
  assert.equal(normalized.implementationOffsetY, 800)
  assert.equal(normalized.designOffsetY + normalized.designHeight, normalized.canvasHeight)
  assert.equal(
    normalized.implementationOffsetY + normalized.implementationHeight,
    normalized.canvasHeight,
  )
})

test('buildWidthNormalization uses element centers to create a non-cropping union canvas', () => {
  const normalized = buildWidthNormalization(
    bitmapLike(100, 100),
    bitmapLike(100, 100),
    {
      alignment: 'element',
      anchors: {
        design: { x: 20, y: 30, width: 40, height: 20 },
        implementation: { x: 35, y: 20, width: 20, height: 20 },
      },
    },
  )

  assert.equal(normalized.anchorReady, true)
  assert.deepEqual(normalized.anchorDelta, { x: -5, y: 10 })
  assert.equal(normalized.canvasWidth, 105)
  assert.equal(normalized.canvasHeight, 110)
  assert.equal(normalized.designWidth, 100)
  assert.equal(normalized.implementationWidth, 100)
  assert.ok(normalized.sharedAreaRatio > 0.8)
})

test('recognized visual anchor points override unequal hand-drawn box centers', () => {
  const normalized = buildWidthNormalization(
    bitmapLike(200, 160),
    bitmapLike(200, 160),
    {
      alignment: 'element',
      anchors: {
        design: { x: 20, y: 20, width: 90, height: 50, anchorX: 80, anchorY: 44 },
        implementation: { x: 45, y: 30, width: 50, height: 28, anchorX: 92, anchorY: 51 },
      },
    },
  )

  assert.deepEqual(normalized.anchorDelta, { x: -12, y: -7 })
  assert.equal(normalized.anchors.design.anchorX, 80)
  assert.equal(normalized.anchors.implementation.anchorX, 92)
})

test('buildWidthNormalization rejects a normalized canvas above the 32 MP safety limit', () => {
  assert.throws(
    () => buildWidthNormalization(
      bitmapLike(1000, 9000),
      bitmapLike(4000, 1000),
    ),
    (error) => error instanceof RangeError && /32 MP safety limit/.test(error.message),
  )
})

test('excludeStatusBarIssues removes mobile system chrome only', () => {
  const profile = { ignoreTop: 60, implementationWidth: 390 }
  const issues = [
    { id: 'issue-1', box: { x: 0, y: 8, w: 390, h: 30 } },
    { id: 'issue-2', box: { x: 20, y: 120, w: 100, h: 40 } },
  ]

  assert.deepEqual(
    excludeStatusBarIssues(issues, profile).map((issue) => issue.id),
    ['issue-2'],
  )
})

test('groupIssues returns the stable workbench group contract', () => {
  const issues = [
    {
      id: 'issue-1',
      type: '颜色',
      severity: '中等',
      score: 42,
      element: '界面元素',
      box: { x: 100, y: 200, w: 120, h: 44 },
    },
    {
      id: 'issue-2',
      type: '位置',
      severity: '严重',
      score: 70,
      element: '可见元素轮廓',
      box: { x: 104, y: 202, w: 116, h: 40 },
    },
  ]

  const [group] = groupIssues(issues, { width: 1440, height: 900 })
  assert.equal(group.id, 'group-1')
  assert.equal(group.severity, '严重')
  assert.deepEqual(group.types, ['位置', '颜色'])
  assert.equal(group.members.length, 2)
  assert.deepEqual(group.box, { x: 100, y: 200, w: 120, h: 44 })
  assert.equal(typeof group.element, 'string')
  assert.ok(group.element.length > 0)
})

test('diffRasters reports no issues for identical pixel buffers', async () => {
  const pixels = new Uint8ClampedArray(8 * 8 * 4).fill(255)
  const result = await diffRasters({
    designPixels: pixels,
    implementationPixels: pixels.slice(),
    width: 8,
    height: 8,
    outputWidth: 8,
    outputHeight: 8,
    profile: { mode: 'exact', ignoreTop: 0 },
  })

  assert.equal(result.coverage, 100)
  assert.deepEqual(result.issues, [])
  assert.deepEqual(result.metrics, { meanDelta: 0, strongRatio: 0 })
})

test('diffRasters detects the unmatched transparent bottom of a shorter image', async () => {
  const width = 16
  const height = 16
  const designPixels = new Uint8ClampedArray(width * height * 4)
  const implementationPixels = new Uint8ClampedArray(width * height * 4)

  for (let pixel = 0; pixel < width * height; pixel++) {
    const index = pixel * 4
    designPixels[index] = 255
    designPixels[index + 1] = 255
    designPixels[index + 2] = 255
    designPixels[index + 3] = 255

    if (Math.floor(pixel / width) < height / 2) {
      implementationPixels[index] = 255
      implementationPixels[index + 1] = 255
      implementationPixels[index + 2] = 255
      implementationPixels[index + 3] = 255
    }
  }

  const result = await diffRasters({
    designPixels,
    implementationPixels,
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: { mode: 'exact', ignoreTop: 0 },
  })

  assert.ok(result.issues.length > 0)
  assert.ok(
    result.issues.some((issue) => issue.box.y + issue.box.h > height / 2),
    'an issue should cover the unmatched bottom half',
  )
  assert.deepEqual(
    [...new Set(result.issues.map((issue) => issue.type))],
    ['布局'],
    'transparent padding must be classified only as an existence/layout difference',
  )
  assert.ok(
    result.issues.every((issue) =>
      issue.text.includes('实现稿') && issue.text.includes('缺少'),
    ),
    'the result should identify which side lacks visible content',
  )
  assert.ok(
    result.issues.every((issue) =>
      !issue.text.includes('#000000') &&
      !['颜色', '文字', '图标', '阴影', '边框'].includes(issue.type),
    ),
    'transparent RGB bytes must not be presented as black content',
  )
  assert.equal(result.issues.length, 1)
})

test('diffRasters reports extra implementation content as a single objective layout class', async () => {
  const width = 20
  const height = 20
  const designPixels = new Uint8ClampedArray(width * height * 4)
  const implementationPixels = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      if (y < height / 2) {
        for (const pixels of [designPixels, implementationPixels]) {
          pixels[index] = 255
          pixels[index + 1] = 255
          pixels[index + 2] = 255
          pixels[index + 3] = 255
        }
      } else {
        implementationPixels[index] = 32
        implementationPixels[index + 1] = 96
        implementationPixels[index + 2] = 192
        implementationPixels[index + 3] = 255
      }
    }
  }

  const result = await diffRasters({
    designPixels,
    implementationPixels,
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: { mode: 'exact', ignoreTop: 0 },
  })

  assert.ok(result.issues.length > 0)
  assert.deepEqual([...new Set(result.issues.map((issue) => issue.type))], ['布局'])
  assert.ok(result.issues.every((issue) =>
    issue.text.includes('设计稿') && issue.text.includes('缺少'),
  ))
  assert.equal(result.issues.length, 1)
})

test('diffRasters treats unmatched top padding as one page-height issue in bottom mode', async () => {
  const width = 16
  const height = 16
  const designPixels = new Uint8ClampedArray(width * height * 4)
  const implementationPixels = new Uint8ClampedArray(width * height * 4)

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (y * width + x) * 4
      designPixels[index] = 255
      designPixels[index + 1] = 255
      designPixels[index + 2] = 255
      designPixels[index + 3] = 255
      if (y >= height / 2) {
        implementationPixels[index] = 255
        implementationPixels[index + 1] = 255
        implementationPixels[index + 2] = 255
        implementationPixels[index + 3] = 255
      }
    }
  }

  const result = await diffRasters({
    designPixels,
    implementationPixels,
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: { mode: 'exact', alignment: 'bottom-left', ignoreTop: 0 },
  })

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].type, '布局')
  assert.equal(result.issues[0].element, '页面顶部或高度区域')
  assert.ok(result.issues[0].box.y < height / 2)
})

test('diffRasters keeps ordinary opaque color detection compatible', async () => {
  const width = 16
  const height = 16
  const designPixels = new Uint8ClampedArray(width * height * 4)
  const implementationPixels = new Uint8ClampedArray(width * height * 4)

  for (let pixel = 0; pixel < width * height; pixel++) {
    const index = pixel * 4
    designPixels[index] = 220
    designPixels[index + 3] = 255
    implementationPixels[index + 2] = 220
    implementationPixels[index + 3] = 255
  }

  const result = await diffRasters({
    designPixels,
    implementationPixels,
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: { mode: 'exact', ignoreTop: 0 },
  })

  assert.ok(result.issues.some((issue) => issue.type === '颜色'))
  assert.ok(result.issues.every((issue) => !issue.text.includes('缺少')))
})

test('analyzeImages honors a pre-aborted signal before touching Canvas', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    analyzeImages({
      designImage: bitmapLike(10, 10),
      implementationImage: bitmapLike(10, 10),
      signal: controller.signal,
    }),
    (error) => error?.name === 'AbortError',
  )
})

test('worker client rejects a pre-aborted run before creating a worker', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    analyzeImagesInWorker({
      designFile: new Blob(),
      implementationFile: new Blob(),
      signal: controller.signal,
    }),
    (error) => error?.name === 'AbortError',
  )
})
