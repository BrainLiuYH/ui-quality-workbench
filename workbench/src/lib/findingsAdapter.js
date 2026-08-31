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
    /页面(?:顶部|底部)或高度区域|缺少|额外可见内容/.test(`${member.element || ""}${member.text || ""}`),
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
    .map((group, index) => {
      const members = Array.isArray(group.members) ? group.members : [];
      const types = unique(group.types?.length ? group.types : members.map((member) => member.type));
      const bbox = readableBox(group.box);
      const expectedValues = unique(members.map((member) => member.design_value));
      const implementationValues = unique(members.map((member) => member.implementation_value));
      const descriptions = unique(members.map((member) => member.annotation_text || member.text));
      const type = primaryType(types);
      const copy = copyByType[type] || copyByType.内容;
      const presence = pagePresence(group);
      const presenceEdge = presence ? pagePresenceEdge(group) : null;

      return {
        id: `finding-${index + 1}`,
        engineGroupId: group.id || `group-${index + 1}`,
        priority: "—",
        title: presence ? `页面${presenceEdge}内容没有对应上` : copy.title,
        location: friendlyLocation(bbox, dimensions.width, dimensions.height),
        evidence: presence ? "一边有内容，另一边没有" : copy.evidence,
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
        summary: presence
          ? `两张图在页面${presenceEdge}没有完整对应，请确认截图范围或页面高度。`
          : copy.summary,
        bbox,
        types,
        members,
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
