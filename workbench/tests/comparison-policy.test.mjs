import assert from 'node:assert/strict'
import test from 'node:test'

import {
  normalizeComparability,
  resolveComparisonPolicy,
} from '../src/lib/comparisonPolicy.js'

test('low comparability blocks findings instead of forcing classifications', () => {
  const policy = resolveComparisonPolicy({
    status: 'low',
    score: 21.4,
    reasons: ['两张图的大面积内容无法对应'],
  })

  assert.equal(policy.allowFindings, false)
  assert.equal(policy.runStatus, 'incomparable')
  assert.match(policy.description, /大面积内容无法对应/)
})

test('medium comparability remains reviewable but explicitly warns the user', () => {
  const policy = resolveComparisonPolicy({
    status: 'medium',
    score: 58,
    reasons: ['局部媒体内容不同', '局部媒体内容不同'],
  })

  assert.equal(policy.allowFindings, true)
  assert.equal(policy.runStatus, 'completed')
  assert.equal(policy.tone, 'warning')
  assert.deepEqual(policy.comparability.reasons, ['局部媒体内容不同'])
})

test('unknown comparability is treated as medium, never silently high confidence', () => {
  const normalized = normalizeComparability({ status: 'mystery', score: 150 })

  assert.equal(normalized.status, 'medium')
  assert.equal(normalized.score, 100)
})

test('structured engine reasons are rendered as human-readable messages', () => {
  const normalized = normalizeComparability({
    status: 'low',
    reasons: [{
      code: 'WIDESPREAD_STRUCTURE_DIFFERENCE',
      level: 'blocking',
      message: '页面结构在多个区域无法对应',
    }],
  })

  assert.deepEqual(normalized.reasons, ['页面结构在多个区域无法对应'])
  assert.equal(normalized.reasonDetails[0].code, 'WIDESPREAD_STRUCTURE_DIFFERENCE')
})

test('policy copy does not duplicate punctuation from engine reasons', () => {
  const policy = resolveComparisonPolicy({
    status: 'low',
    reasons: [{ message: '页面结构无法对应。' }],
  })

  assert.doesNotMatch(policy.description, /。。/)
  assert.equal(policy.description, '页面结构无法对应。请确认是同一页面、相近视口且主要布局能够对应后重试。')
})

test('blocking comparability reasons are shown before secondary warnings', () => {
  const normalized = normalizeComparability({
    status: 'medium',
    reasons: [
      { level: 'warning', message: '底部存在少量高度差。' },
      { level: 'blocking', message: '页面结构在多个区域无法对应。' },
    ],
  })

  assert.deepEqual(normalized.reasons, [
    '页面结构在多个区域无法对应。',
    '底部存在少量高度差。',
  ])
})
