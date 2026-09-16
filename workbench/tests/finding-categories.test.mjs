import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FINDING_CATEGORIES,
  FINDING_CATEGORY_LABELS,
  inferFindingCategory,
} from '../src/lib/findingCategories.js'
import { adaptYangaoGroups } from '../src/lib/findingsAdapter.js'

function candidate(types, elements = types.map(() => '组件边界')) {
  return {
    id: 'group-1',
    score: 50,
    severity: '中等',
    types,
    box: { x: 50, y: 100, w: 220, h: 90 },
    members: types.map((type, index) => ({
      type,
      element: elements[index],
      score: 50,
      severity: '中等',
      box: { x: 50, y: 100, w: 220, h: 90 },
      design_value: '设计值',
      implementation_value: '实现值',
    })),
  }
}

test('workbench category taxonomy has stable unique ids and labels', () => {
  assert.equal(FINDING_CATEGORIES.length, 8)
  assert.equal(new Set(FINDING_CATEGORIES.map(({ id }) => id)).size, 8)
  assert.equal(FINDING_CATEGORY_LABELS.position, '位置')
  assert.equal(FINDING_CATEGORY_LABELS.style, '样式')
})

test('component style wins over noisy content color while special cases stay explicit', () => {
  assert.equal(inferFindingCategory(candidate(['边框', '颜色'])), 'style')
  assert.equal(inferFindingCategory(candidate(['位置'], ['浅色卡片外框'])), 'position')
  assert.equal(inferFindingCategory(candidate(['颜色'], ['顶部状态标签背景'])), 'color')
  assert.equal(inferFindingCategory(candidate(['颜色'], ['底部导航选中态填充'])), 'style')
  assert.equal(inferFindingCategory(candidate(['颜色'], ['页面背景'])), 'color')
})

test('one classified finding keeps its fine engine signals for review and export', () => {
  const group = candidate(['边框', '颜色'])
  const [finding] = adaptYangaoGroups([group], { width: 600, height: 900 })

  assert.equal(finding.category, 'style')
  assert.equal(finding.categorySource, 'auto')
  assert.deepEqual(finding.types, ['边框', '颜色'])
  assert.equal(finding.priority, '—')
})
