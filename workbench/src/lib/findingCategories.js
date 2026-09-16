export const FINDING_CATEGORIES = [
  { id: 'position', label: '位置' },
  { id: 'size', label: '尺寸' },
  { id: 'color', label: '颜色' },
  { id: 'style', label: '样式' },
  { id: 'typography', label: '文字' },
  { id: 'icon', label: '图标' },
  { id: 'layout', label: '布局' },
  { id: 'content', label: '内容' },
]

export const FINDING_CATEGORY_LABELS = Object.fromEntries(
  FINDING_CATEGORIES.map(({ id, label }) => [id, label]),
)

/**
 * A group has one user-facing primary category, while `types` and `members`
 * retain every finer engine signal. Category is never a priority or severity.
 */
export function inferFindingCategory(group = {}) {
  const members = Array.isArray(group.members) ? group.members : []
  const elements = new Set(members.map((member) => member.element))
  const types = new Set(group.types?.length
    ? group.types
    : members.map((member) => member.type))

  if (elements.has('浅色卡片外框') || elements.has('底部操作栏外框')) return 'position'
  if (elements.has('底部操作栏背景质感')) return 'style'
  if (elements.has('底部导航选中态填充')) return 'style'
  if (elements.has('页面背景') || elements.has('顶部状态标签背景')) return 'color'
  if (members.some((member) => member.presenceEvidence === 'large-flat-absence')) {
    return 'content'
  }
  if (elements.has('页面顶部或高度区域') ||
    elements.has('页面底部或高度区域') || types.has('布局')) return 'layout'
  if (['边框', '圆角', '阴影'].some((type) => types.has(type))) return 'style'
  if (types.has('位置')) return 'position'
  if (types.has('尺寸')) return 'size'
  if (types.has('文字')) return 'typography'
  if (types.has('图标')) return 'icon'
  if (types.has('颜色')) return 'color'
  return 'content'
}
