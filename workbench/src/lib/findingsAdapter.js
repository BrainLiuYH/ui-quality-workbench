import { inferFindingCategory } from './findingCategories.js';

const severityMap = {
  "严重": "major",
  "中等": "moderate",
  "轻微": "minor",
};

const CONTENT_VARIATION_CODE = "WIDESPREAD_CONTENT_VARIATION";
const CONTENT_DRIVEN_TYPES = new Set(["内容", "文字", "图标", "颜色"]);
const GEOMETRY_TYPES = new Set(["尺寸", "位置"]);
const PRIMARY_TYPE_ORDER = ["布局", "尺寸", "位置", "边框", "圆角", "阴影", "颜色", "文字", "图标", "内容"];

const copyByType = {
  布局: {
    title: "这里的排布不一致",
    evidence: "一边有内容，另一边没有或没有对齐",
    summary: "实现图这里的排布和设计稿不同，请确认是否需要调整。",
    delta: "排布不同",
  },
  尺寸: {
    title: "这个区域大小不一致",
    evidence: "两边显示范围的大小不同",
    summary: "实现图这个区域的大小和设计稿不同。",
    delta: "大小不同",
  },
  位置: {
    title: "这个区域没有对齐",
    evidence: "两边显示的位置没有对齐",
    summary: "实现图这个区域的位置和设计稿没有对齐。",
    delta: "位置不同",
  },
  颜色: {
    title: "这块区域颜色不一致",
    evidence: "两边看到的颜色明显不同",
    summary: "实现图这里的颜色和设计稿不一致。",
    delta: "颜色不同",
  },
  文字: {
    title: "这里的文字显示不同",
    evidence: "两边的文字外观没有对齐",
    summary: "实现图这里的文字显示和设计稿不同。",
    delta: "文字显示不同",
  },
  图标: {
    title: "这个图形显示不同",
    evidence: "两边的小图形外观不同",
    summary: "实现图这个图形和设计稿看起来不同。",
    delta: "图形不同",
  },
  内容: {
    title: "这里的图片或内容不同",
    evidence: "两边显示了不同的图片或数据",
    summary: "这里更像是内容变化，请人工确认是否需要比较。",
    delta: "内容不同",
  },
  边框: {
    title: "这块区域边框不同",
    evidence: "两边的边框外观不同",
    summary: "实现图这里的边框和设计稿不一致。",
    delta: "边框不同",
  },
  圆角: {
    title: "这块区域圆角不同",
    evidence: "两边的圆角外观不同",
    summary: "实现图这里的圆角和设计稿不一致。",
    delta: "圆角不同",
  },
  阴影: {
    title: "这块区域阴影不同",
    evidence: "两边的阴影外观不同",
    summary: "实现图这里的阴影和设计稿不一致。",
    delta: "阴影不同",
  },
};

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function readableBox(box = {}) {
  const x = Math.max(0, Math.round(box.x || 0));
  const y = Math.max(0, Math.round(box.y || 0));
  const width = Math.max(1, Math.round(box.w ?? box.width ?? 1));
  const height = Math.max(1, Math.round(box.h ?? box.height ?? 1));
  return { x, y, width, height };
}

function comparisonSize(context, groups) {
  const width = Number(context?.width ?? context?.targetWidth ?? context?.comparisonWidth);
  const height = Number(context?.height ?? context?.targetHeight ?? context?.comparisonHeight);
  const boxes = groups.map((group) => readableBox(group.box));
  return {
    width: Number.isFinite(width) && width > 0
      ? width
      : Math.max(1, ...boxes.map((box) => box.x + box.width)),
    height: Number.isFinite(height) && height > 0
      ? height
      : Math.max(1, ...boxes.map((box) => box.y + box.height)),
  };
}

function reasonCodes(comparability) {
  return new Set([
    ...(comparability?.reasonDetails || []).map((reason) => reason?.code),
    ...(comparability?.reasons || []).map((reason) =>
      typeof reason === "object" ? reason?.code : null),
  ].filter(Boolean));
}

function primaryType(types) {
  return PRIMARY_TYPE_ORDER.find((type) => types.includes(type)) || "内容";
}

function friendlyLocation(box, width, height) {
  const centerX = (box.x + box.width / 2) / Math.max(1, width);
  const centerY = (box.y + box.height / 2) / Math.max(1, height);
  const widthRatio = box.width / Math.max(1, width);
  const vertical = centerY < 0.12
    ? "页面顶部"
    : centerY < 0.4
      ? "页面上半部分"
      : centerY < 0.65
        ? "页面中部"
        : centerY < 0.9
          ? "页面下半部分"
          : "页面底部";
  if (widthRatio >= 0.62) return vertical;
  const horizontal = centerX < 0.34 ? "偏左" : centerX > 0.66 ? "偏右" : "居中";
  return `${vertical} · ${horizontal}`;
}

function pagePresence(group) {
  return (group.members || []).some((member) =>
    member.element === "页面顶部或高度区域" ||
    member.element === "页面底部或高度区域",
  );
}

function pagePresenceEdge(group) {
  const copy = `${group?.element || ""}${(group?.members || []).map((member) => `${member.element || ""}${member.text || ""}`).join("")}`;
  return copy.includes("页面顶部") || copy.includes("高度或顶部") ? "顶部" : "底部";
}

export function isActionableGroup(group, context = {}) {
  const members = Array.isArray(group?.members) ? group.members : [];
  const types = unique(group?.types?.length ? group.types : members.map((member) => member.type));
  if (!types.length) return false;
  if (group.reviewOnly === true) return false;
  if (members.some((member) => member.backgroundEvidence === true)) return true;
  if (members.some((member) => member.componentEvidence === true)) return true;
  if (Number(group.score ?? members[0]?.score) < 18) return false;
  if (members.some((member) => member.presenceEvidence === 'large-flat-absence')) return true;
  if (pagePresence(group)) return true;

  const element = group.element || members[0]?.element || "";
  if (["小型图形", "局部视觉差异"].includes(element) && group.severity === "轻微") return false;
  if (/^(视觉差异区域|狭长视觉差异|组合视觉区域)$/.test(element) && group.severity === "轻微") {
    return false;
  }

  const width = Number(context.width || context.targetWidth || context.comparisonWidth) || 1;
  const height = Number(context.height || context.targetHeight || context.comparisonHeight) || 1;
  const box = readableBox(group.box);
  const areaRatio = box.width * box.height / Math.max(1, width * height);
  const mediumInput = context.comparability?.status === 'medium';
  const aspect = box.width / Math.max(1, box.height);
  // Small glyph fragments are not evidence that a whole element changed its
  // dimensions. Dynamic text and raster font rendering commonly split a word
  // into several differently shaped connected components.
  if (mediumInput && types.every((type) => GEOMETRY_TYPES.has(type)) &&
    areaRatio < 0.03 && box.height < height * 0.048 &&
    aspect >= 1.7) return false;
  if (mediumInput && types.every((type) => GEOMETRY_TYPES.has(type)) &&
    areaRatio < 0.0035) return false;
  if (mediumInput && types.every((type) => type === '颜色') &&
    box.height < height * 0.027 && box.width < width * 0.75) return false;
  if (mediumInput && types.every((type) => type === '边框') &&
    areaRatio < 0.002) return false;
  // A near-page-width region covering several lower media cards cannot be
  // assigned a single layout cause from pixels alone. Explicit component and
  // one-sided presence evidence were handled above and remain actionable.
  if (box.y > height * 0.55 && areaRatio > 0.18 &&
    box.width > width * 0.6 && types.includes('布局')) return false;
  const widespreadContent = reasonCodes(context.comparability).has(CONTENT_VARIATION_CODE);

  if (!widespreadContent) return true;
  if (types.every((type) => CONTENT_DRIVEN_TYPES.has(type))) return false;
  if (/^(图标或图形|文字内容|文字区域|同行文字内容|图像区域)$/.test(element)) return false;
  if (types.every((type) => GEOMETRY_TYPES.has(type)) && areaRatio < 0.004) return false;
  if (group.severity === "轻微" && !types.some((type) =>
    ["布局", "边框", "圆角", "阴影"].includes(type))) {
    return false;
  }
  return true;
}

export function adaptYangaoGroups(groups = [], context = {}) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  const dimensions = comparisonSize(context, safeGroups);
  const filterContext = {
    ...context,
    ...dimensions,
    comparability: context?.comparability,
  };

  return safeGroups
    .filter((group) => isActionableGroup(group, filterContext))
    .filter((group) => {
      if (group.members?.some((member) => member.componentEvidence)) return true;
      const card = safeGroups.find((candidate) => candidate.members?.some((member) =>
        member.element === '浅色卡片外框' && member.componentEvidence));
      if (!card) return true;
      const box = readableBox(group.box);
      const cardBox = readableBox(card.box);
      const overlapX = Math.max(0,
        Math.min(box.x + box.width, cardBox.x + cardBox.width) -
        Math.max(box.x, cardBox.x));
      const overlapY = Math.max(0,
        Math.min(box.y + box.height, cardBox.y + cardBox.height) -
        Math.max(box.y, cardBox.y));
      return overlapX * overlapY / Math.max(1, box.width * box.height) < 0.62;
    })
    .filter((group) => {
      const box = readableBox(group.box);
      const types = group.types?.length ? group.types :
        (group.members || []).map((member) => member.type);
      if (!types.length || !types.every((type) => type === '颜色') ||
        box.width < dimensions.width * 0.8 ||
        box.height > dimensions.height * 0.055) return true;
      // A thin colour band overlapping the trailing edge of a same-width
      // shifted card is a consequence of that geometry change, not a second
      // independent fill-colour defect.
      return !safeGroups.some((other) => {
        if (other === group || !other.types?.some((type) =>
          ['尺寸', '位置'].includes(type))) return false;
        const parent = readableBox(other.box);
        const overlapX = Math.max(0,
          Math.min(box.x + box.width, parent.x + parent.width) -
          Math.max(box.x, parent.x));
        const overlapY = Math.max(0,
          Math.min(box.y + box.height, parent.y + parent.height) -
          Math.max(box.y, parent.y));
        return overlapX / Math.max(1, box.width) > 0.85 &&
          overlapY / Math.max(1, box.height) > 0.35 &&
          parent.height >= box.height * 1.5;
      });
    })
    .map((group, index) => {
      const members = Array.isArray(group.members) ? group.members : [];
      const types = unique(group.types?.length ? group.types : members.map((member) => member.type));
      const bbox = readableBox(group.box);
      const expectedValues = unique(members.map((member) => member.design_value));
      const implementationValues = unique(members.map((member) => member.implementation_value));
      const descriptions = unique(members.map((member) => member.annotation_text || member.text));
      const flatAbsence = members.some((member) => member.presenceEvidence === 'large-flat-absence');
      const background = members.some((member) => member.backgroundEvidence === true);
      const topBadge = members.some((member) => member.element === '顶部状态标签背景');
      const bottomSelection = members.some((member) => member.element === '底部导航选中态填充');
      const bottomBarPosition = members.find((member) => member.element === '底部操作栏外框');
      const bottomBarBackground = members.find((member) => member.element === '底部操作栏背景质感');
      const lightCard = members.some((member) => member.element === '浅色卡片外框');
      const componentCopy = members.find((member) => member.friendlyTitle);
      const componentTitle = componentCopy && (types.length > 1
        ? `${members.some((member) => member.element === '匹配的横向控件') ? '这个控件' : members.some((member) => member.element?.startsWith('底部操作栏')) ? '底部操作栏外框' : members.some((member) => member.element === '匹配的文字行') ? '这行文字' : '这个组件'}有多处差异`
        : componentCopy.friendlyTitle);
      const componentSummary = unique(members.map((member) => member.friendlySummary)).join(' ');
      const type = primaryType(types);
      const copy = copyByType[type] || copyByType.内容;
      const presence = pagePresence(group);
      const presenceEdge = presence ? pagePresenceEdge(group) : null;

      return {
        id: `finding-${index + 1}`,
        engineGroupId: group.id || `group-${index + 1}`,
        category: inferFindingCategory(group),
        categorySource: 'auto',
        priority: "—",
        title: bottomBarBackground ? "底部操作栏背景质感不一致" : bottomBarPosition ? "底部操作栏距底边不一致" : lightCard ? "浅色卡片位置不一致" : bottomSelection ? "底部导航选中态不一致" : topBadge ? "顶部状态标签背景不一致" : background ? "页面背景色不一致" : flatAbsence ? "这块内容一边有、一边空白" : presence ? `页面${presenceEdge}内容没有对应上` : copy.title,
        location: friendlyLocation(bbox, dimensions.width, dimensions.height),
        evidence: bottomBarBackground ? `设计稿${bottomBarBackground.design_value}；实现稿${bottomBarBackground.implementation_value}` : bottomBarPosition ? `设计 ${bottomBarPosition.design_value}；实现 ${bottomBarPosition.implementation_value}` : lightCard ? "外框大小近似一致，但整体位置有偏移" : bottomSelection ? "选中态大面积填充有差异" : topBadge ? "标签填充相对页面底色不同" : background ? "页面空白区域的底色不同" : flatAbsence ? "同一区域只有一边有明显内容" : presence ? "一边有内容，另一边没有" : copy.evidence,
        evidenceLevel: "inferred",
        confidence: null,
        engineScore: Number.isFinite(Number(group.score ?? members[0]?.score))
          ? Number(group.score ?? members[0]?.score)
          : null,
        delta: presence ? "内容缺失" : copy.delta,
        expected: expectedValues.join("；") || "设计稿中的显示",
        actual: implementationValues.join("；") || "实现图中的显示",
        severity: "unrated",
        upstreamSeverity: group.severity || "轻微",
        engineMagnitude: severityMap[group.severity] || "minor",
        status: "pending",
        note: "",
        summary: bottomBarBackground ? "底部操作栏背景的截图呈现不同：一侧有明显明暗过渡，另一侧近乎均一。可对照设计确认透明度、背景模糊和叠层设置；静态截图不能证明具体实现参数。" : bottomBarPosition ? `${bottomBarPosition.text}。这里测量的是截图像素；请核对底部安全区、定位偏移和截图裁切条件。` : lightCard ? "两侧浅色卡片的外框大小近似一致，实现稿中的卡片整体位置有偏移。" : bottomSelection ? "底部导航选中态的大面积纯色填充不同；请对照设计确认是否应采用整块填充。" : topBadge ? "顶部状态标签相对页面底色的填充亮度不同，请确认背景和描边样式。" : background ? "两张图的大面积页面底色不同，请确认颜色规范和截图显示条件。" : flatAbsence
          ? "一侧有大面积可见内容，另一侧近似空白；请确认页面状态和内容是否应出现。"
          : presence
          ? `两张图在页面${presenceEdge}没有完整对应，请确认截图范围或页面高度。`
          : copy.summary,
        bbox,
        types,
        members,
        ...(componentCopy ? {
          title: componentTitle,
          summary: componentSummary,
          evidence: types.map((type) => copyByType[type]?.delta || type).join(' / '),
          delta: flatAbsence ? '内容缺失' : types.map((type) => copyByType[type]?.delta || type).join(' / '),
        } : {}),
        technical: {
          location: `x ${bbox.x}px，y ${bbox.y}px，${bbox.width} × ${bbox.height}px`,
          method: "像素与边缘启发式",
          descriptions,
          expected: expectedValues,
          actual: implementationValues,
        },
      };
    });
}
