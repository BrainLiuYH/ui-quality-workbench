import assert from 'node:assert/strict'
import test from 'node:test'

import {
  groupDisplayName,
  groupIssues,
} from '../src/engine/group-issues.js'

const dimensions = { width: 1000, height: 1000 }

function issue({
  id,
  type = '颜色',
  element = '界面元素',
  box,
  severity = '中等',
  score = 50,
  reviewOnly = false,
}) {
  return { id, type, element, box, severity, score, reviewOnly }
}

test('14×48 vertical edge is not named as an icon or text', () => {
  const [group] = groupIssues([
    issue({ id: 'edge-14x48', box: { x: 220, y: 180, w: 14, h: 48 } }),
  ], dimensions)

  assert.equal(group.element, '狭长视觉差异')
  assert.doesNotMatch(group.element, /图标|文字/)
})

test('20×103 border fragment keeps a neutral boundary name', () => {
  const [group] = groupIssues([
    issue({
      id: 'border-20x103',
      type: '边框',
      element: '组件边界',
      box: { x: 760, y: 240, w: 20, h: 103 },
    }),
  ], dimensions)

  assert.equal(group.element, '边界差异')
  assert.doesNotMatch(group.element, /图标|文字/)
})

test('42×67 return arrow can be described as a graphic', () => {
  const [group] = groupIssues([
    issue({
      id: 'back-arrow',
      type: '位置',
      element: '返回箭头轮廓',
      box: { x: 34, y: 52, w: 42, h: 67 },
    }),
  ], dimensions)

  assert.equal(group.element, '图标或图形')
})

test('a compact region without graphic evidence keeps a neutral local name', () => {
  const [group] = groupIssues([
    issue({ id: 'generic-compact', box: { x: 220, y: 160, w: 38, h: 44 } }),
  ], dimensions)

  assert.equal(group.element, '局部视觉差异')
  assert.doesNotMatch(group.element, /图标|图形/)
})

test('split contours from one compact control become one primary visual object', () => {
  const groups = groupIssues([
    issue({
      id: 'button-upper-shape',
      type: '尺寸',
      element: '可见元素轮廓',
      box: { x: 440, y: 140, w: 120, h: 55 },
      severity: '严重',
      score: 78,
    }),
    issue({
      id: 'button-lower-rim',
      type: '边框',
      element: '组件边界',
      box: { x: 438, y: 191, w: 124, h: 61 },
      score: 66,
    }),
    issue({
      id: 'button-fill',
      type: '颜色',
      element: '界面元素',
      box: { x: 458, y: 164, w: 84, h: 70 },
      score: 52,
    }),
  ], dimensions)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].element, '组件区域')
  assert.deepEqual(new Set(groups[0].types), new Set(['尺寸', '边框', '颜色']))
  assert.deepEqual(groups[0].box, { x: 438, y: 140, w: 124, h: 112 })
})

test('nearby compact controls remain separate when there is a visible gap', () => {
  const groups = groupIssues([
    issue({
      id: 'first-control',
      type: '尺寸',
      element: '可见元素轮廓',
      box: { x: 100, y: 100, w: 80, h: 50 },
    }),
    issue({
      id: 'second-control',
      type: '边框',
      element: '组件边界',
      box: { x: 100, y: 165, w: 80, h: 50 },
    }),
  ], dimensions)

  assert.equal(groups.length, 2)
})

test('text inside a compact control remains a separate visual object', () => {
  const groups = groupIssues([
    issue({
      id: 'control-outline',
      type: '尺寸',
      element: '可见元素轮廓',
      box: { x: 400, y: 300, w: 120, h: 70 },
    }),
    issue({
      id: 'control-label',
      type: '文字',
      element: '文字行轮廓',
      box: { x: 425, y: 324, w: 70, h: 20 },
    }),
  ], dimensions)

  assert.equal(groups.length, 2)
  assert.deepEqual(
    new Set(groups.map((group) => group.element)),
    new Set(['组件区域', '文字内容']),
  )
})

test('same-baseline geometry fragments with a tiny word gap become one neutral row', () => {
  const page = { width: 1500, height: 3333 }
  const groups = groupIssues([
    issue({
      id: 'create-fragment',
      type: '位置',
      element: '可见元素轮廓',
      box: { x: 72, y: 266, w: 268, h: 116 },
      severity: '严重',
      score: 74,
    }),
    issue({
      id: 'space-fragment',
      type: '位置',
      element: '可见元素轮廓',
      box: { x: 355, y: 266, w: 264, h: 131 },
      severity: '严重',
      score: 72,
    }),
  ], page)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].element, '组合视觉区域')
  assert.deepEqual(groups[0].types, ['位置'])
  assert.deepEqual(groups[0].box, { x: 72, y: 266, w: 547, h: 131 })
})

test('normalized same-line fragments tolerate one pixel of bounding-box rounding', () => {
  const groups = groupIssues([
    issue({
      id: 'bottom-create-fragment',
      type: '位置',
      element: '可见元素轮廓',
      box: { x: 72, y: 309, w: 268, h: 115 },
      severity: '严重',
      score: 74,
    }),
    issue({
      id: 'bottom-space-fragment',
      type: '位置',
      element: '可见元素轮廓',
      box: { x: 359, y: 309, w: 260, h: 126 },
      severity: '严重',
      score: 72,
    }),
  ], { width: 1500, height: 3333 })

  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].box, { x: 72, y: 309, w: 547, h: 126 })
})

test('a second same-baseline heading pair also merges at its smaller gap', () => {
  const groups = groupIssues([
    issue({
      id: 'start-fragment',
      type: '位置',
      element: '可见元素轮廓',
      box: { x: 485, y: 657, w: 200, h: 101 },
    }),
    issue({
      id: 'creating-fragment',
      type: '位置',
      element: '可见元素轮廓',
      box: { x: 694, y: 655, w: 323, h: 119 },
    }),
  ], { width: 1500, height: 3333 })

  assert.equal(groups.length, 1)
  assert.deepEqual(groups[0].box, { x: 485, y: 655, w: 532, h: 119 })
})

test('nearby buttons with explicit control evidence remain separate', () => {
  const groups = groupIssues([
    issue({
      id: 'left-button',
      type: '位置',
      element: '按钮轮廓',
      box: { x: 100, y: 220, w: 160, h: 72 },
    }),
    issue({
      id: 'right-button',
      type: '位置',
      element: '按钮轮廓',
      box: { x: 270, y: 220, w: 160, h: 72 },
    }),
  ], { width: 1500, height: 1000 })

  assert.equal(groups.length, 2)
})

test('generic geometry fragments remain separate when their horizontal gap is not tiny', () => {
  const groups = groupIssues([
    issue({
      id: 'left-region',
      type: '位置',
      element: '可见元素轮廓',
      box: { x: 100, y: 220, w: 180, h: 80 },
    }),
    issue({
      id: 'right-region',
      type: '位置',
      element: '可见元素轮廓',
      box: { x: 304, y: 220, w: 180, h: 80 },
    }),
  ], { width: 1500, height: 1000 })

  assert.equal(groups.length, 2)
})

test('confirmed adjacent text segments form one true text row', () => {
  const groups = groupIssues([
    issue({
      id: 'title',
      type: '文字',
      element: '文字行轮廓',
      box: { x: 100, y: 200, w: 120, h: 28 },
      score: 60,
    }),
    issue({
      id: 'helper',
      type: '文字',
      element: '辅助文字',
      box: { x: 226, y: 201, w: 70, h: 26 },
      score: 55,
    }),
  ], dimensions)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].element, '同行文字内容')
  assert.equal(groups[0].members.length, 2)
})

test('multiple segments without text evidence never invent a text role', () => {
  const first = {
    types: ['颜色'],
    members: [issue({ id: 'one', box: { x: 20, y: 20, w: 34, h: 34 } })],
    box: { x: 20, y: 20, w: 34, h: 34 },
  }
  const second = {
    types: ['位置'],
    members: [issue({
      id: 'two',
      type: '位置',
      box: { x: 62, y: 20, w: 34, h: 34 },
    })],
    box: { x: 62, y: 20, w: 34, h: 34 },
  }
  const group = {
    types: ['颜色', '位置'],
    members: [...first.members, ...second.members],
    segments: [first, second],
    box: { x: 20, y: 20, w: 76, h: 34 },
  }

  assert.equal(groupDisplayName(group, dimensions), '组合视觉区域')
  assert.doesNotMatch(groupDisplayName(group, dimensions), /文字/)
})

test('a large media object absorbs internal contour fragments into one box', () => {
  const groups = groupIssues([
    issue({
      id: 'hero',
      element: '主视觉图片',
      box: { x: 100, y: 100, w: 800, h: 500 },
      severity: '严重',
      score: 90,
    }),
    issue({
      id: 'color-patch',
      box: { x: 140, y: 150, w: 30, h: 30 },
      score: 70,
    }),
    issue({
      id: 'contour-fragment',
      type: '边框',
      element: '组件边界',
      box: { x: 780, y: 280, w: 20, h: 70 },
      score: 65,
    }),
    issue({
      id: 'false-icon-fragment',
      type: '图标',
      element: '小型图形或图标',
      box: { x: 430, y: 360, w: 24, h: 22 },
      score: 60,
    }),
  ], dimensions)

  assert.equal(groups.length, 1)
  assert.equal(groups[0].element, '图像区域')
  assert.equal(groups[0].members.length, 4)
  assert.deepEqual(groups[0].box, { x: 100, y: 100, w: 800, h: 500 })
})

test('a bottom presence mismatch keeps its specific page-height role', () => {
  const [group] = groupIssues([
    issue({
      id: 'bottom-presence',
      type: '布局',
      element: '页面底部或高度区域',
      box: { x: 0, y: 900, w: 1000, h: 100 },
    }),
  ], dimensions)

  assert.equal(group.element, '页面底部或高度区域')
})

test('a bottom presence band never absorbs or enters an overlapping review-only media group', () => {
  const page = { width: 1500, height: 3333 }
  const bottomBand = issue({
    id: 'bottom-presence',
    type: '布局',
    element: '页面底部或高度区域',
    box: { x: 70, y: 3248, w: 1360, h: 85 },
    severity: '严重',
    score: 84,
  })

  for (const mediaBox of [
    // This box used to absorb the band during the first spatial pass.
    { x: 70, y: 2933, w: 1360, h: 400 },
    // This larger box used to absorb it during the later stable merge pass.
    { x: 70, y: 2333, w: 1360, h: 1000 },
  ]) {
    const groups = groupIssues([
      bottomBand,
      issue({
        id: `mock-media-${mediaBox.h}`,
        type: '内容',
        element: '主视觉图片',
        box: mediaBox,
        score: 62,
        reviewOnly: true,
      }),
    ], page)

    assert.equal(groups.length, 2)
    const presenceGroup = groups.find((group) =>
      group.element === '页面底部或高度区域',
    )
    const mediaGroup = groups.find((group) => group.element === '图像区域')
    assert.deepEqual(presenceGroup.box, bottomBand.box)
    assert.deepEqual(presenceGroup.members.map((member) => member.id), ['bottom-presence'])
    assert.equal(presenceGroup.reviewOnly, false)
    assert.deepEqual(mediaGroup.box, mediaBox)
    assert.equal(mediaGroup.reviewOnly, true)
  }
})

test('two fragments of the same bottom presence band can still merge', () => {
  const groups = groupIssues([
    issue({
      id: 'bottom-left',
      type: '布局',
      element: '页面底部或高度区域',
      box: { x: 0, y: 3248, w: 740, h: 85 },
    }),
    issue({
      id: 'bottom-right',
      type: '布局',
      element: '页面底部或高度区域',
      box: { x: 748, y: 3248, w: 752, h: 85 },
    }),
  ], { width: 1500, height: 3333 })

  assert.equal(groups.length, 1)
  assert.equal(groups[0].element, '页面底部或高度区域')
  assert.deepEqual(groups[0].box, { x: 0, y: 3248, w: 1500, h: 85 })
})

test('a top presence mismatch keeps its specific page-height role', () => {
  const [group] = groupIssues([
    issue({
      id: 'top-presence',
      type: '布局',
      element: '页面顶部或高度区域',
      box: { x: 0, y: 0, w: 1000, h: 100 },
    }),
  ], dimensions)

  assert.equal(group.element, '页面顶部或高度区域')
})
