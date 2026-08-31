const VALID_STATUSES = new Set(["high", "medium", "low"]);

function cleanReasons(reasons) {
  return [...new Set((Array.isArray(reasons) ? reasons : [])
    .map((reason) => typeof reason === "string" ? reason : reason?.message)
    .map((reason) => String(reason || "").trim())
    .filter(Boolean))];
}

const REASON_LEVEL_RANK = { blocking: 3, warning: 2, info: 1 };

export function normalizeComparability(comparability) {
  const status = VALID_STATUSES.has(comparability?.status)
    ? comparability.status
    : "medium";
  const numericScore = Number(comparability?.score);
  const reasonDetails = Array.isArray(comparability?.reasons)
    ? comparability.reasons
      .filter((reason) => reason && typeof reason === "object")
      .sort((a, b) => (REASON_LEVEL_RANK[b.level] || 0) - (REASON_LEVEL_RANK[a.level] || 0))
    : [];
  const orderedReasons = reasonDetails.length ? reasonDetails : comparability?.reasons;

  return {
    ...comparability,
    status,
    score: Number.isFinite(numericScore)
      ? Math.max(0, Math.min(100, Math.round(numericScore)))
      : null,
    reasonDetails,
    reasons: cleanReasons(orderedReasons),
  };
}

export function resolveComparisonPolicy(comparability) {
  const normalized = normalizeComparability(comparability);
  const firstReason = normalized.reasons[0] || "页面整体结构或内容对应关系不足";
  const reasonClause = firstReason.replace(/[。！？!?；;]+$/u, "");

  if (normalized.status === "low") {
    return {
      comparability: normalized,
      allowFindings: false,
      runStatus: "incomparable",
      tone: "error",
      stateLabel: "输入可比性较低 · 已停止生成候选",
      title: "两张图暂不适合直接走查",
      description: `${reasonClause}。请确认是同一页面、相近视口且主要布局能够对应后重试。`,
      notification: "输入可比性较低，已停止生成可能误导的问题",
    };
  }

  if (normalized.status === "medium") {
    return {
      comparability: normalized,
      allowFindings: true,
      runStatus: "completed",
      tone: "warning",
      stateLabel: "走查完成 · 输入可比性中等",
      title: "输入可比性中等",
      description: `${reasonClause}。候选问题需要重点人工确认。`,
      notification: "走查完成，但两张图的可比性一般，请重点复核候选问题",
    };
  }

  return {
    comparability: normalized,
    allowFindings: true,
    runStatus: "completed",
    tone: "success",
    stateLabel: "走查完成",
    title: "输入可比性较高",
    description: "两张图的整体结构适合进行视觉差异走查。",
    notification: "走查完成",
  };
}
