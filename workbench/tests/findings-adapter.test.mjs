import assert from 'node:assert/strict'
import test from 'node:test'

import { adaptYangaoGroups } from '../src/lib/findingsAdapter.js'

test('pixel magnitude never assigns product severity or delivery priority', () => {
  const [finding] = adaptYangaoGroups([{
    id: 'group-1',
    severity: '严重',
    score: 180,
    element: '大面积视觉区域',
    types: ['内容'],
    box: { x: 0, y: 0, w: 500, h: 500 },
    members: [{
      type: '内容',
      severity: '严重',
      score: 180,
      element: '高纹理可见内容区域',
      design_value: '设计稿可见内容',
      implementation_value: '实现稿可见内容',
      text: '内容差异',
      box: { x: 0, y: 0, w: 500, h: 500 },
    }],
  }])

  assert.equal(finding.severity, 'unrated')
  assert.equal(finding.priority, '—')
  assert.equal(finding.upstreamSeverity, '严重')
  assert.equal(finding.engineMagnitude, 'major')
})
