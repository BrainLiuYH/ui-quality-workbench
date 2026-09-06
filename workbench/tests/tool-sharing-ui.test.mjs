import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { sharedTools } from '../src/sharedTools.js'

const css = readFileSync(new URL('../src/prototype.css', import.meta.url), 'utf8')
const prototype = readFileSync(new URL('../src/Prototype.jsx', import.meta.url), 'utf8')

function rule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`))?.[1] || ''
}

test('tool sharing starts with the two user-confirmed entries', () => {
  assert.equal(sharedTools.length, 2)
  assert.deepEqual(sharedTools.map((tool) => tool.id), ['cowart', 'ui-wireframe-workflow'])
  assert.equal(new Set(sharedTools.map((tool) => tool.id)).size, sharedTools.length)

  for (const tool of sharedTools) {
    for (const field of ['id', 'name', 'summary', 'description', 'typeLabel', 'status', 'category']) {
      assert.equal(typeof tool[field], 'string')
      assert.ok(tool[field].trim(), `${tool.id}.${field} should not be empty`)
    }
    for (const field of ['tags', 'useCases', 'capabilities', 'workflow', 'deliverables', 'limitations']) {
      assert.ok(Array.isArray(tool[field]))
      assert.ok(tool[field].length > 0, `${tool.id}.${field} should not be empty`)
    }
  }

  const cowart = sharedTools.find((tool) => tool.id === 'cowart')
  assert.equal(cowart.type, 'tool-plugin')
  assert.match(cowart.typeLabel, /含 3 个 Skill/)
})

test('navigation switches between the audit and tool collection without resetting audit state', () => {
  assert.match(prototype, /useState\("audit"\)/)
  assert.match(prototype, />工具分享<\/button>/)
  assert.match(prototype, /aria-current={activeView === "tools" \? "page" : undefined}/)
  assert.match(prototype, /activeView === "tools" \? <ToolSharingPage/)

  const openView = prototype.match(/const openView = \(view\) => \{([\s\S]*?)\n  \};/)?.[1] || ''
  assert.match(openView, /setActiveView\(view\)/)
  assert.match(openView, /setModal\(null\)/)
  assert.doesNotMatch(openView, /setSources|setFindings|abort|runToken/)
})

test('cards open the shared detail dialog with accessible controls', () => {
  assert.match(prototype, /tools\.map\(\(tool\) => <SharedToolCard/)
  assert.match(prototype, /aria-label={`查看\$\{tool\.name\}详情`}/)
  assert.match(prototype, /setModal\(\{ type: "tool-detail", toolId \}\)/)
  assert.match(prototype, /modal\?\.type === "tool-detail"/)
  assert.match(prototype, /<Dialog title="工具详情"/)
})

test('tool collection owns scrolling and uses a responsive card grid', () => {
  const workspace = rule('.tool-sharing-workspace')
  assert.match(workspace, /min-height:\s*0/)
  assert.match(workspace, /height:\s*100%/)
  assert.match(workspace, /overflow:\s*auto/)

  const grid = rule('.tool-card-grid')
  assert.match(grid, /display:\s*grid/)
  assert.match(grid, /repeat\(auto-fit,\s*minmax\(320px,\s*1fr\)\)/)
})
