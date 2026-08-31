import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const css = readFileSync(new URL('../src/prototype.css', import.meta.url), 'utf8')
const prototype = readFileSync(new URL('../src/Prototype.jsx', import.meta.url), 'utf8')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

test('side-by-side mode uses one shared scroll container', () => {
  for (const selector of ['.compare-split', '.compare-pane', '.single-compare']) {
    const declarations = rule(selector)
    assert.match(declarations, /min-height:\s*0/)
    assert.match(declarations, /overflow:\s*hidden/)
    assert.doesNotMatch(declarations, /height:\s*100%/)
  }

  const sharedStageRule = css.match(/\.image-stage,\s*\.side-shared-stage\s*\{([^}]*)\}/)?.[1] || ''
  assert.match(sharedStageRule, /overflow:\s*auto/)
  assert.match(sharedStageRule, /min-height:\s*0/)
  assert.match(prototype, /className="side-shared-stage"/)
  assert.equal((prototype.match(/className="side-shared-stage"/g) || []).length, 1)
  assert.match(prototype, /可同步滚动浏览完整页面/)
  assert.doesNotMatch(rule('.side-shared-track'), /overflow:\s*auto/)
  assert.doesNotMatch(rule('.side-preview-cell'), /overflow:\s*auto/)
})

test('findings list exposes a real collapse control and collapsed grid row', () => {
  assert.match(rule('.center-column.is-findings-collapsed'), /52px/)
  assert.match(rule('.findings-panel.is-collapsed'), /grid-template-rows:\s*52px/)
  assert.match(prototype, /aria-expanded={!collapsed}/)
  assert.match(prototype, /onToggleCollapsed/)
})

test('table actions are explicit and do not render inert note or overflow buttons', () => {
  assert.match(prototype, />定位<\/span>/)
  assert.match(prototype, /onLocate\(finding\.id\)/)
  assert.doesNotMatch(prototype, /aria-label="查看备注"|aria-label="更多操作"/)
})

test('vertical alignment control invalidates stale results and reaches the worker', () => {
  assert.match(prototype, /aria-label="图片对齐方式"/)
  assert.match(prototype, /aria-pressed={selected}/)
  assert.match(prototype, /setFindings\(\[\]\)/)
  assert.match(prototype, /alignment,\s*anchors,\s*signal: controller\.signal/)
  assert.match(rule('.alignment-mode-switch'), /display:\s*inline-flex/)
})

test('element alignment is a confirmed two-step selection workflow', () => {
  assert.match(prototype, /selecting-design/)
  assert.match(prototype, /selecting-implementation/)
  assert.match(prototype, /detecting-design/)
  assert.match(prototype, /detecting-implementation/)
  assert.match(prototype, /recognizeElementAnchor/)
  assert.match(prototype, /应用对齐/)
  assert.match(prototype, /AnchorSelectionLayer/)
  assert.match(prototype, /手工粗选/)
  assert.match(prototype, /系统边界/)
  assert.match(css, /anchor-selection-box--rough/)
  assert.match(css, /anchor-selection-box--detected/)
  assert.match(prototype, /只比较重叠区域/)
})
