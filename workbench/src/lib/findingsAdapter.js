const severityMap = {
  "严重": "major",
  "中等": "moderate",
  "轻微": "minor",
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

export function adaptYangaoGroups(groups = []) {
  return groups.map((group, index) => {
    const members = Array.isArray(group.members) ? group.members : [];
    const types = unique(group.types?.length ? group.types : members.map((member) => member.type));
    const bbox = readableBox(group.box);
    const element = group.element || members[0]?.element || `区域 ${index + 1}`;
    const expectedValues = unique(members.map((member) => member.design_value));
    const implementationValues = unique(members.map((member) => member.implementation_value));
    const descriptions = unique(members.map((member) => member.annotation_text || member.text));
    const typeLabel = types.length ? types.join(" / ") : "视觉";

    return {
      id: `finding-${index + 1}`,
      engineGroupId: group.id || `group-${index + 1}`,
      priority: "—",
      title: `${element}存在${typeLabel}差异`,
      location: `归一对比画布 / x ${bbox.x}px，y ${bbox.y}px，${bbox.width} × ${bbox.height}px`,
      evidence: "像素与边缘启发式",
      evidenceLevel: "inferred",
      confidence: null,
      engineScore: Number.isFinite(Number(group.score ?? members[0]?.score))
        ? Number(group.score ?? members[0]?.score)
        : null,
      delta: types.length ? types.join(" · ") : "可见差异",
      expected: expectedValues.join("；") || "设计稿像素特征",
      actual: implementationValues.join("；") || "实现稿像素特征",
      severity: "unrated",
      upstreamSeverity: group.severity || "轻微",
      engineMagnitude: severityMap[group.severity] || "minor",
      status: "pending",
      note: "",
      summary: descriptions.join("；") || `${element}与设计稿在${typeLabel}方面存在可见差异，需人工确认。`,
      bbox,
      types,
      members,
    };
  });
}
