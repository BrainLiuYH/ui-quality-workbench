import assert from 'node:assert/strict'
import test from 'node:test'

import { adaptYangaoGroups, isActionableGroup } from '../src/lib/findingsAdapter.js'
import { groupIssues } from '../src/engine/group-issues.js'

function group({
  id = 'group-1',
  type = '颜色',
  element = '容器区域',
  box = { x: 68, y: 1911, w: 1360, h: 730 },
  severity = '中等',
  reviewOnly = false,
} = {}) {
  return {
    id,
    score: 58,
    severity,
    reviewOnly,
    types: [type],
    element,
    box,
    members: [{
      id: `${id}-member`,
      type,
      element,
      box,
      design_value: '#252427',
      implementation_value: '#8591A5',
      text: '引擎内部技术描述',
    }],
  }
}

test('adapter exposes short plain-language copy and keeps technical data out of the UI fields', () => {
  const [finding] = adaptYangaoGroups([group()], {
    targetWidth: 1500,
    targetHeight: 3333,
  })

  assert.equal(finding.title, '这块区域颜色不一致')
  assert.equal(finding.location, '页面下半部分')
  assert.equal(finding.evidence, '两边看到的颜色明显不同')
  assert.equal(finding.summary, '实现图这里的颜色和设计稿不一致。')
  assert.doesNotMatch(
    [finding.title, finding.location, finding.evidence, finding.summary].join(' '),
    /归一|启发式|未校准|像素|边缘|重心|轮廓密度|x \d+px/,
  )
  assert.match(finding.technical.location, /x 68px/)
  assert.equal(finding.technical.method, '像素与边缘启发式')
})

test('widespread fake-content variation does not become actionable color or tiny geometry findings', () => {
  const context = {
    targetWidth: 1500,
    targetHeight: 3333,
    comparability: {
      reasons: [{ code: 'WIDESPREAD_CONTENT_VARIATION' }],
    },
  }
  const groups = [
    group({ id: 'color', type: '颜色' }),
    group({
      id: 'tiny-size',
      type: '尺寸',
      element: '局部视觉差异',
      box: { x: 340, y: 260, w: 42, h: 36 },
      severity: '轻微',
    }),
    group({
      id: 'layout',
      type: '布局',
      element: '大面积布局区域',
      box: { x: 120, y: 880, w: 1100, h: 520 },
    }),
  ]

  const findings = adaptYangaoGroups(groups, context)

  assert.deepEqual(findings.map((finding) => finding.engineGroupId), ['layout'])
  assert.equal(findings[0].title, '这里的排布不一致')
})

test('review-only engine observations never create list rows or canvas annotations', () => {
  const candidate = group({ type: '内容', element: '图像区域', reviewOnly: true })

  assert.equal(isActionableGroup(candidate, { width: 1500, height: 3333 }), false)
  assert.deepEqual(adaptYangaoGroups([candidate], { width: 1500, height: 3333 }), [])
})

test('one compact visual object with several signals produces one plain-language finding', () => {
  const groups = groupIssues([
    {
      id: 'size-half',
      type: '尺寸',
      element: '可见元素轮廓',
      box: { x: 440, y: 140, w: 120, h: 55 },
      severity: '严重',
      score: 78,
    },
    {
      id: 'border-half',
      type: '边框',
      element: '组件边界',
      box: { x: 438, y: 191, w: 124, h: 61 },
      severity: '中等',
      score: 66,
    },
    {
      id: 'color-center',
      type: '颜色',
      element: '界面元素',
      box: { x: 458, y: 164, w: 84, h: 70 },
      severity: '中等',
      score: 52,
    },
  ], { width: 1000, height: 1000 })

  const findings = adaptYangaoGroups(groups, { width: 1000, height: 1000 })

  assert.equal(findings.length, 1)
  assert.equal(findings[0].title, '这个区域大小不一致')
  assert.equal(findings[0].summary, '实现图这个区域的大小和设计稿不同。')
  assert.deepEqual(new Set(findings[0].types), new Set(['尺寸', '边框', '颜色']))
})
