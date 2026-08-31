// Spatial grouping adapted with permission from SemineChen/yangao, commit
// beac836ba3c81b9a1d40bac8fe75af08444ab742.

const SEVERITY_RANK = { '严重': 3, '中等': 2, '轻微': 1 }

const TEXT_ROLE_PATTERN = /(文字行|文字内容|文本|标题|副标题|辅助文字|正文|文案)/
const AMBIGUOUS_TEXT_PATTERN = /(或文字|文字或)/
const GRAPHIC_ROLE_PATTERN = /(图标|图形|箭头)/
const MEDIA_ROLE_PATTERN = /(图片|图像|照片|插图|主视觉|媒体|封面|头像)/
const CONTAINER_ROLE_PATTERN = /(容器|大面积界面区域|大面积布局区域)/

function boxIntersection(a, b) {
  const x = Math.max(a.x, b.x)
  const y = Math.max(a.y, b.y)
  const right = Math.min(a.x + a.w, b.x + b.w)
  const bottom = Math.min(a.y + a.h, b.y + b.h)
  return Math.max(0, right - x) * Math.max(0, bottom - y)
}

export function unionBox(boxes) {
  if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 }
  const x = Math.min(...boxes.map((box) => box.x))
  const y = Math.min(...boxes.map((box) => box.y))
  const right = Math.max(...boxes.map((box) => box.x + box.w))
  const bottom = Math.max(...boxes.map((box) => box.y + box.h))
  return { x, y, w: right - x, h: bottom - y }
}

function memberHasTextEvidence(member) {
  const element = member.element || ''
  return member.type === '文字' ||
    (!AMBIGUOUS_TEXT_PATTERN.test(element) && TEXT_ROLE_PATTERN.test(element))
}

function groupTextLike(group) {
  return group.types?.includes('文字') ||
    group.members?.some(memberHasTextEvidence) || false
}

function memberHasGraphicEvidence(member) {
  return member.type === '图标' || GRAPHIC_ROLE_PATTERN.test(member.element || '')
}

function groupHasGraphicEvidence(group) {
  return group.types?.includes('图标') ||
    group.members?.some(memberHasGraphicEvidence) || false
}

function isEdgeLike(box) {
  const aspect = box.w / Math.max(1, box.h)
  return aspect <= 0.45 || aspect >= 9
}

function isCompactGraphicShape(box, dimensions) {
  const width = dimensions.width || 1000
  const height = dimensions.height || 1000
  const aspect = box.w / Math.max(1, box.h)
  const maxSide = Math.max(box.w, box.h)
  const sizeLimit = Math.max(56, Math.min(160, width * 0.16, height * 0.11))
  return !isEdgeLike(box) && aspect >= 0.55 && aspect <= 1.9 &&
    Math.min(box.w, box.h) >= 4 && maxSide <= sizeLimit
}

function groupElements(group) {
  return (group.members || []).map((member) => member.element || '')
}

function largeObjectRole(group, dimensions) {
  const box = group.box || group
  const height = dimensions.height || 1000
  const width = dimensions.width || 1000
  const elements = groupElements(group)
  const explicitMedia = elements.some((element) => MEDIA_ROLE_PATTERN.test(element))
  const explicitContainer = elements.some((element) => CONTAINER_ROLE_PATTERN.test(element))
  const areaRatio = box.w * box.h / Math.max(1, width * height)
  const largeGeometry = box.w >= width * 0.36 && box.h >= height * 0.14 &&
    areaRatio >= 0.065 && areaRatio <= 0.82

  if (groupTextLike(group)) return null
  if (explicitMedia) return 'media'
  if (explicitContainer) return 'container'
  return largeGeometry ? 'large' : null
}

function internalFragmentLike(group, large) {
  if (groupTextLike(group)) return false
  const box = group.box
  const largeBox = large.box
  const area = box.w * box.h
  const largeArea = largeBox.w * largeBox.h
  return area <= largeArea * 0.1 &&
    box.w <= largeBox.w * 0.45 && box.h <= largeBox.h * 0.45
}

function issueGroupMatch(a, b) {
  const intersection = boxIntersection(a, b)
  const aArea = a.w * a.h
  const bArea = b.w * b.h
  const minArea = Math.min(aArea, bArea)
  const maxArea = Math.max(aArea, bArea)
  const union = aArea + bArea - intersection
  const iou = intersection / Math.max(1, union)
  const inside = intersection / Math.max(1, minArea)
  const ratio = maxArea / Math.max(1, minArea)
  const aCenterX = a.x + a.w / 2
  const aCenterY = a.y + a.h / 2
  const bCenterX = b.x + b.w / 2
  const bCenterY = b.y + b.h / 2
  const heightRatio = Math.max(a.h, b.h) / Math.max(1, Math.min(a.h, b.h))
  const sameBand = heightRatio < 2.05 &&
    Math.abs(aCenterY - bCenterY) <= Math.max(9, Math.min(a.h, b.h) * 0.5)
  const near = Math.abs(aCenterX - bCenterX) <= Math.max(8, Math.min(a.w, b.w) * 0.28) &&
    Math.abs(aCenterY - bCenterY) <= Math.max(8, Math.min(a.h, b.h) * 0.42)
  const nestedSameElement = inside > 0.66 && ratio < 18 && sameBand

  return iou > 0.24 ||
    (inside > 0.58 && ratio < 5.5) ||
    nestedSameElement ||
    (near && ratio < 4.5)
}

function inlineFragmentMatch(a, b, dimensions) {
  const width = dimensions.width || 1000
  const height = dimensions.height || 1000
  const aBox = a.box
  const bBox = b.box
  const heightRatio = Math.max(aBox.h, bBox.h) /
    Math.max(1, Math.min(aBox.h, bBox.h))
  const top = Math.max(aBox.y, bBox.y)
  const bottom = Math.min(aBox.y + aBox.h, bBox.y + bBox.h)
  const verticalOverlap = Math.max(0, bottom - top) /
    Math.max(1, Math.min(aBox.h, bBox.h))
  const centerDelta = Math.abs(
    aBox.y + aBox.h / 2 - (bBox.y + bBox.h / 2),
  )
  const left = aBox.x <= bBox.x ? aBox : bBox
  const right = aBox.x <= bBox.x ? bBox : aBox
  const gap = Math.max(0, right.x - (left.x + left.w))
  const combined = unionBox([aBox, bBox])
  const aGlyph = !groupHasGraphicEvidence(a) &&
    !isEdgeLike(aBox) && aBox.w <= aBox.h * 1.65
  const bGlyph = !groupHasGraphicEvidence(b) &&
    !isEdgeLike(bBox) && bBox.w <= bBox.h * 1.65
  const aText = groupTextLike(a)
  const bText = groupTextLike(b)
  const fragmentShape = (aText && (bText || bGlyph)) ||
    (bText && (aText || aGlyph))
  const compact = Math.max(aBox.h, bBox.h) <= Math.max(130, height * 0.085)
  const maxGap = Math.max(5, Math.min(42, Math.min(aBox.h, bBox.h) * 0.85))

  return compact && fragmentShape && heightRatio < 1.75 &&
    (verticalOverlap > 0.5 || centerDelta < Math.min(aBox.h, bBox.h) * 0.42) &&
    gap <= maxGap && combined.w < width * 0.55
}

function rowGroupMatch(a, b, dimensions) {
  const width = dimensions.width || 1000
  const height = dimensions.height || 1000
  const aBox = a.box
  const bBox = b.box
  const top = Math.max(aBox.y, bBox.y)
  const bottom = Math.min(aBox.y + aBox.h, bBox.y + bBox.h)
  const verticalOverlap = Math.max(0, bottom - top) /
    Math.max(1, Math.min(aBox.h, bBox.h))
  const centerDelta = Math.abs(
    aBox.y + aBox.h / 2 - (bBox.y + bBox.h / 2),
  )
  const left = aBox.x <= bBox.x ? aBox : bBox
  const right = aBox.x <= bBox.x ? bBox : aBox
  const gap = Math.max(0, right.x - (left.x + left.w))
  const combined = unionBox([aBox, bBox])
  const compactHeight = Math.max(aBox.h, bBox.h) <= Math.max(170, height * 0.11)
  const sameRow = verticalOverlap > 0.36 ||
    centerDelta <= Math.max(10, Math.min(aBox.h, bBox.h) * 0.62)
  const textPair = groupTextLike(a) && groupTextLike(b)
  const maxGap = textPair
    ? Math.max(18, Math.min(120, Math.min(aBox.h, bBox.h) * 2.3))
    : Math.max(10, Math.min(48, Math.min(aBox.h, bBox.h) * 1.05))

  return inlineFragmentMatch(a, b, dimensions) ||
    (compactHeight && sameRow && gap <= maxGap && combined.w < width * 0.9 && textPair)
}

function finalGroupMatch(a, b, dimensions) {
  const aArea = a.box.w * a.box.h
  const bArea = b.box.w * b.box.h
  const large = aArea >= bArea ? a : b
  const small = aArea >= bArea ? b : a
  const largeBox = large.box
  const smallBox = small.box
  const intersection = boxIntersection(a.box, b.box)
  const inside = intersection / Math.max(1, Math.min(aArea, bArea))
  const ratio = Math.max(aArea, bArea) / Math.max(1, Math.min(aArea, bArea))
  const centerX = smallBox.x + smallBox.w / 2
  const centerY = smallBox.y + smallBox.h / 2
  const centerInside = centerX >= largeBox.x - 3 &&
    centerX <= largeBox.x + largeBox.w + 3 &&
    centerY >= largeBox.y - 3 &&
    centerY <= largeBox.y + largeBox.h + 3
  const textParent = groupTextLike(large) && largeBox.w / largeBox.h > 1.35
  const largeRole = largeObjectRole(large, dimensions)
  const nestedFragment = largeRole && centerInside && inside > 0.8 &&
    internalFragmentLike(small, large)
  const left = smallBox.x + smallBox.w < largeBox.x ? smallBox : largeBox
  const right = smallBox.x + smallBox.w < largeBox.x ? largeBox : smallBox
  const gap = Math.max(0, right.x - (left.x + left.w))
  const verticalNear = Math.abs(
    smallBox.y + smallBox.h / 2 - (largeBox.y + largeBox.h / 2),
  ) <= Math.max(10, largeBox.h * 0.62)
  const tiny = Math.max(smallBox.w, smallBox.h) <=
    Math.max(22, (dimensions.width || 1000) * 0.032)
  const smallIsGraphic = groupHasGraphicEvidence(small)
  const tinyNearText = textParent && !smallIsGraphic && tiny && verticalNear &&
    gap <= Math.max(24, largeBox.h * 0.8)

  return rowGroupMatch(a, b, dimensions) ||
    (textParent && !smallIsGraphic && centerInside && inside > 0.48 && ratio < 55) ||
    tinyNearText || nestedFragment
}

function describeGroup(members, segments = []) {
  const ordered = [...members].sort((a, b) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.score - a.score,
  )
  const lead = ordered[0]
  const types = [...new Set(ordered.map((member) => member.type))]
  return {
    severity: lead.severity,
    score: lead.score,
    element: segments.length > 1 ? '组合视觉区域' : lead.element,
    types,
    members: ordered,
    reviewOnly: ordered.every((member) => member.reviewOnly === true),
    segments,
    box: unionBox(ordered.map((member) => member.box)),
    text: `${ordered.length}项问题：${types.join(' / ')}`,
  }
}

function mergeGroupsUntilStable(groups, dimensions) {
  let current = groups.slice()
  let changed = true
  let guard = 0

  while (changed && guard++ < 8) {
    changed = false
    const next = []

    for (const group of current.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
      let target = null
      let bestCost = Infinity

      for (const candidate of next) {
        if (!finalGroupMatch(candidate, group, dimensions)) continue
        const merged = unionBox([candidate.box, group.box])
        const cost = merged.w * merged.h -
          candidate.box.w * candidate.box.h - group.box.w * group.box.h
        if (cost < bestCost) {
          target = candidate
          bestCost = cost
        }
      }

      if (target) {
        const members = [...target.members, ...group.members]
        const segments = [
          ...(target.segments?.length ? target.segments : [target]),
          ...(group.segments?.length ? group.segments : [group]),
        ]
        Object.assign(target, describeGroup(members, segments))
        changed = true
      } else {
        next.push(describeGroup(
          group.members,
          [...(group.segments?.length ? group.segments : [group])],
        ))
      }
    }

    current = next
  }

  return current
}

export function groupDisplayName(group, dimensions = {}) {
  const segments = group.segments || []
  const aspect = group.box.w / Math.max(1, group.box.h)
  const hasText = groupTextLike(group)
  const allText = segments.length > 1 && segments.every((segment) =>
    groupTextLike(segment),
  )
  const objectRole = largeObjectRole(group, dimensions)
  const hasGraphic = groupHasGraphicEvidence(group)
  const compactGraphic = isCompactGraphicShape(group.box, dimensions)
  const elements = groupElements(group)
  const pagePresence = elements.find((element) =>
    element.includes('页面底部或高度区域') ||
    element.includes('页面顶部或高度区域'),
  )
  const regionPresence = group.types.includes('布局') &&
    elements.some((element) => element === '区域内容')

  if (pagePresence) return pagePresence
  if (regionPresence) return '区域内容'
  if (objectRole === 'media') return '图像区域'
  if (objectRole === 'container') return '容器区域'
  if (objectRole === 'large') return '大面积视觉区域'
  if (isEdgeLike(group.box)) {
    return group.types.includes('边框') || elements.some((element) => element.includes('边界'))
      ? '边界差异'
      : '狭长视觉差异'
  }

  if (allText) return '同行文字内容'
  if (hasText && aspect > 1.55 && group.box.h < 140) return '文字内容'
  if (hasText) return '文字区域'
  if (compactGraphic && hasGraphic) return '图标或图形'
  if (compactGraphic) return '局部视觉差异'
  if (segments.length > 1) return '组合视觉区域'
  if (group.types.includes('边框')) return '边界差异'
  return '视觉差异区域'
}

export function groupIssues(issues, dimensions = {}) {
  if (!Array.isArray(issues) || issues.length === 0) return []

  const spatial = []
  const orderedIssues = [...issues].sort((a, b) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.score - a.score,
  )

  for (const issue of orderedIssues) {
    const group = spatial.find((candidate) =>
      candidate.members.some((member) => issueGroupMatch(member.box, issue.box)),
    )
    if (group) group.members.push(issue)
    else spatial.push({ members: [issue] })
  }

  const initial = spatial.map((group) => describeGroup(group.members))
  const rows = []

  for (const group of initial.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    let best = null
    let bestGap = Infinity

    for (const row of rows) {
      if (!rowGroupMatch(row, group, dimensions)) continue
      const gap = Math.max(
        0,
        Math.max(row.box.x, group.box.x) -
          Math.min(row.box.x + row.box.w, group.box.x + group.box.w),
      )
      if (gap < bestGap) {
        best = row
        bestGap = gap
      }
    }

    if (best) {
      const members = [...best.members, ...group.members]
      const segments = [...best.segments, group]
      Object.assign(best, describeGroup(members, segments))
    } else {
      rows.push(describeGroup(group.members, [group]))
    }
  }

  const compacted = mergeGroupsUntilStable(rows, dimensions)
  compacted.sort((a, b) =>
    SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.score - a.score,
  )

  return compacted.map((group, index) => ({
    ...group,
    id: `group-${index + 1}`,
    element: groupDisplayName(group, dimensions),
  }))
}
