import assert from 'node:assert/strict'
import test from 'node:test'

import {
  demoteNestedMediaColorIssues,
  diffRasters,
} from '../src/engine/pixel-diff.js'

function mediaFeedRaster(width, height, variant) {
  const pixels = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4
      let color = [16, 18, 20]
      const insideCard = x >= 12 && x < 148 && y >= 70 && y < 196
      if (insideCard) {
        const border = x < 15 || x >= 145 || y < 73 || y >= 193
        if (border) {
          color = [90, 94, 100]
        } else if (variant === 'design') {
          const localY = y - 73
          color = Math.floor((x - 15) / 18) % 2
            ? [214 - Math.floor(localY * 0.45), 205 - Math.floor(localY * 0.3), 180]
            : [28 + Math.floor(localY * 0.25), 68, 92]
        } else {
          color = (Math.floor((x - 15) / 5) + Math.floor((y - 73) / 7)) % 2
            ? [28, 168, 116]
            : [226, 174, 52]
        }
      }
      pixels[offset] = color[0]
      pixels[offset + 1] = color[1]
      pixels[offset + 2] = color[2]
      pixels[offset + 3] = 255
    }
  }
  return pixels
}

async function compareBroadMedia(reasonCode) {
  const width = 160
  const height = 220
  return diffRasters({
    designPixels: mediaFeedRaster(width, height, 'design'),
    implementationPixels: mediaFeedRaster(width, height, 'implementation'),
    width,
    height,
    outputWidth: width,
    outputHeight: height,
    profile: {
      mode: 'exact',
      ignoreTop: 0,
      comparability: {
        reasons: [{ code: reasonCode }],
      },
    },
  })
}

function assertReviewOnlyMedia(result) {
  const width = 160

  assert.equal(result.issues.length, 1)
  assert.equal(result.issues[0].type, '内容')
  assert.equal(result.issues[0].reviewOnly, true)
  assert.ok(result.issues[0].box.w >= width * 0.8)
  assert.ok(!['颜色', '位置', '尺寸', '布局'].includes(result.issues[0].type))
}

test('broad mock-media changes stay review-only when the input gate identifies content variation', async () => {
  assertReviewOnlyMedia(await compareBroadMedia('WIDESPREAD_CONTENT_VARIATION'))
})

test('broad mock-media changes stay review-only when strong differences span the page', async () => {
  assertReviewOnlyMedia(await compareBroadMedia('GLOBAL_STRONG_DIFFERENCE'))
})

test('nested media colour fragments become review-only without changing text or position issues', () => {
  const media = {
    id: 'media',
    type: '内容',
    reviewOnly: true,
    mediaEnvelope: true,
    partId: 'part-media',
    box: { x: 20, y: 40, w: 200, h: 120 },
  }
  const color = {
    id: 'color-fragment',
    type: '颜色',
    box: { x: 50, y: 70, w: 40, h: 24 },
  }
  const position = {
    id: 'position',
    type: '位置',
    box: { x: 60, y: 80, w: 32, h: 20 },
  }
  const text = {
    id: 'text',
    type: '文字',
    box: { x: 70, y: 90, w: 80, h: 18 },
  }

  const result = demoteNestedMediaColorIssues([media, color, position, text])
  const demoted = result.find((issue) => issue.id === color.id)

  assert.equal(demoted.type, '内容')
  assert.equal(demoted.reviewOnly, true)
  assert.equal(demoted.mediaEnvelopeId, media.partId)
  assert.deepEqual(result.find((issue) => issue.id === position.id), position)
  assert.deepEqual(result.find((issue) => issue.id === text.id), text)
})

test('a same-shape component colour change remains actionable inside media', () => {
  const media = {
    id: 'media',
    type: '内容',
    reviewOnly: true,
    mediaEnvelope: true,
    partId: 'part-media',
    box: { x: 20, y: 40, w: 200, h: 120 },
  }
  const buttonColor = {
    id: 'button-color',
    type: '颜色',
    stableComponentContour: true,
    box: { x: 70, y: 90, w: 56, h: 28 },
  }

  const result = demoteNestedMediaColorIssues([media, buttonColor])

  assert.deepEqual(result.find((issue) => issue.id === buttonColor.id), buttonColor)
})

test('an ordinary container colour change remains actionable without a media envelope', () => {
  const containerColor = {
    id: 'container-color',
    type: '颜色',
    stableComponentContour: false,
    box: { x: 20, y: 40, w: 200, h: 120 },
  }
  const unrelatedReviewOnlyContent = {
    id: 'ambiguous-content',
    type: '内容',
    reviewOnly: true,
    box: { x: 20, y: 40, w: 200, h: 120 },
  }

  const result = demoteNestedMediaColorIssues([
    unrelatedReviewOnlyContent,
    containerColor,
  ])

  assert.deepEqual(result.find((issue) => issue.id === containerColor.id), containerColor)
})
