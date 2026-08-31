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
}) {
  return { id, type, element, box, severity, score }
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
