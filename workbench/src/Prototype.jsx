import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsLeftRight,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  CheckCircle,
  ClockCounterClockwise,
  Columns,
  CursorClick,
  DownloadSimple,
  Eye,
  FileImage,
  FigmaLogo,
  FunnelSimple,
  GlobeSimple,
  House,
  Info,
  LinkSimple,
  ListChecks,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  PencilSimple,
  SidebarSimple,
  Trash,
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { adaptYangaoGroups } from "./lib/findingsAdapter.js";
import { deriveAuditName } from "./lib/auditName.js";
import { getComparisonPlacement, intersectCanvasCropWithPlacement } from "./lib/comparisonGeometry.js";
import { resolveComparisonPolicy } from "./lib/comparisonPolicy.js";
import { recognizeElementAnchor } from "./lib/elementAnchorDetection.js";
import { captureWebPage, getLocalCapabilities, importFigmaFrame } from "./lib/localBridge.js";
import { createImageSource, deriveComparisonProfile, disposeImageSource, selectSingleImageFile, validateImageFile } from "./lib/imageSources.js";
import { analyzeImagesInWorker } from "./engine/yangaoWorkerClient.js";

const statusMeta = {
  pending: { label: "待确认", tone: "neutral" },
  confirmed: { label: "已确认", tone: "dark" },
  dismissed: { label: "已驳回", tone: "muted" },
  ignored: { label: "已忽略", tone: "muted" },
};

const severityMeta = {
  unrated: "待评估",
  critical: "严重",
  major: "较高",
  moderate: "中等",
  minor: "轻微",
  info: "提示",
};

const modeOptions = [
  { id: "annotate", label: "标注" },
  { id: "side", label: "并排" },
  { id: "overlay", label: "叠加" },
  { id: "regions", label: "差异区域" },
];

const idleAnchorFlow = { status: "idle", design: null, implementation: null };

function AppIcon({ icon: Icon, size = 18, weight = "regular" }) {
  return <Icon size={size} weight={weight} aria-hidden="true" />;
}

function StatusBadge({ status }) {
  const meta = statusMeta[status] ?? statusMeta.pending;
  return <span className={`status-badge status-badge--${meta.tone}`}>{meta.label}</span>;
}

function useImageFileDrop({ onFile, onError, disabled = false }) {
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);
  const containsFiles = (event) => Array.from(event.dataTransfer?.types || []).includes("Files");

  const resetDragState = () => {
    dragDepthRef.current = 0;
    setIsDragging(false);
  };
  const handleDragEnter = (event) => {
    if (!containsFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    if (disabled) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    dragDepthRef.current += 1;
    setIsDragging(true);
  };
  const handleDragOver = (event) => {
    if (!containsFiles(event)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
  };
  const handleDragLeave = (event) => {
    if (dragDepthRef.current === 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragging(false);
  };
  const handleDrop = (event) => {
    const files = Array.from(event.dataTransfer?.files || []);
    if (!containsFiles(event) && files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    resetDragState();
    if (disabled) return;
    try {
      const file = selectSingleImageFile(files);
      Promise.resolve(onFile(file)).catch((error) => onError?.(error.message || "图片导入失败"));
    } catch (error) {
      onError?.(error.message || "图片导入失败");
    }
  };

  useEffect(() => {
    if (!isDragging) return undefined;
    const clear = () => resetDragState();
    window.addEventListener("dragend", clear, true);
    window.addEventListener("drop", clear, true);
    window.addEventListener("blur", clear);
    return () => {
      window.removeEventListener("dragend", clear, true);
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("blur", clear);
    };
  }, [isDragging]);

  return {
    isDragging,
    dropProps: {
      onDragEnter: handleDragEnter,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    },
  };
}

function ImageUploadPlaceholder({ kind, onUpload, onDropFile, onDropError }) {
  const isDesign = kind === "design";
  const title = isDesign ? "添加设计稿" : "添加实现截图";
  const hint = isDesign
    ? "支持 PNG / JPG / WebP，也可从 Figma Frame 导入"
    : "支持本地图片，或输入网页地址自动截取当前视口";
  const { isDragging, dropProps } = useImageFileDrop({ onFile: onDropFile, onError: (message) => onDropError?.(kind, message) });

  return (
    <div className={`image-empty-state ${isDragging ? "is-dragging" : ""}`} {...dropProps}>
      <button type="button" className="image-upload-placeholder" onClick={onUpload} aria-label={`上传${isDesign ? "设计稿" : "实现截图"}`}>
        <span className="image-upload-placeholder__icon"><AppIcon icon={FileImage} size={30} /></span>
        <strong>{isDragging ? "松开即可导入" : title}</strong>
        <span aria-live="polite">{isDragging ? "将图片放入当前区域" : hint}</span>
        <em>{isDragging ? "释放文件" : "选择来源或拖入图片"}</em>
      </button>
    </div>
  );
}

function AnnotationLayer({ findings, dimensions, selectedId, onSelect, variant = "outline" }) {
  if (!dimensions || !findings.length) return null;
  return (
    <div className={`annotation-layer annotation-layer--${variant} ${findings.length > 20 ? "is-dense" : ""}`} aria-label="差异标注">
      {findings.map((finding, index) => {
        const box = finding.bbox;
        return (
          <button
            type="button"
            key={finding.id}
            className={`annotation-box ${selectedId === finding.id ? "is-active" : ""}`}
            style={{
              left: `${(box.x / dimensions.width) * 100}%`,
              top: `${(box.y / dimensions.height) * 100}%`,
              width: `${(box.width / dimensions.width) * 100}%`,
              height: `${(box.height / dimensions.height) * 100}%`,
            }}
            onClick={() => onSelect(finding.id)}
            aria-label={`定位问题 ${index + 1}：${finding.title}`}
          >
            <span>{index + 1}</span>
          </button>
        );
      })}
    </div>
  );
}

function SourceActions({ kind, source, onReplace, onRemove, disabled }) {
  if (!source) return null;
  const roleLabel = kind === "design" ? "设计稿" : "实现稿";
  return (
    <div className="source-pane-actions" aria-label={`${roleLabel}操作`}>
      <button type="button" disabled={disabled} onClick={onReplace} aria-label={`替换${roleLabel}`} title={`替换${roleLabel}`}>
        <UploadSimple size={14} />
        <span>替换</span>
      </button>
      <button type="button" className="is-danger" disabled={disabled} onClick={onRemove} aria-label={`移除${roleLabel}`} title={`移除${roleLabel}`}>
        <Trash size={14} />
        <span>移除</span>
      </button>
    </div>
  );
}

function SourcePaneHeader({ kind, source, onReplace, onRemove, disabled }) {
  const roleLabel = kind === "design" ? "设计稿" : "实现稿";
  const details = source ? `${source.name} · ${source.width}×${source.height}` : "等待输入";
  return (
    <header className="source-pane-header">
      <div className="source-pane-summary">
        <strong>{roleLabel}</strong>
        <span title={source ? `${source.sourceLabel} · ${details}` : undefined}>{details}</span>
      </div>
      <SourceActions kind={kind} source={source} onReplace={onReplace} onRemove={onRemove} disabled={disabled} />
    </header>
  );
}

function usePreviewNavigation({ stageRef, focusFrameRef, resetKey, alignment, frameWidth, focusRequest, focusEnabled = true }) {
  useEffect(() => {
    if (!resetKey || !stageRef.current) return;
    const frame = window.requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (!stage) return;
      const top = alignment === "bottom-left"
        ? Math.max(0, stage.scrollHeight - stage.clientHeight)
        : 0;
      stage.scrollTo({ top, left: 0 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [alignment, resetKey, stageRef]);
  useEffect(() => {
    const stage = stageRef.current;
    const frame = focusFrameRef.current;
    if (!focusEnabled || !stage || !frame || !focusRequest?.bbox) return;
    const stageRect = stage.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    if (!frame) return;
    const scale = frame.clientWidth / Math.max(1, frameWidth);
    const box = focusRequest.bbox;
    const frameTop = stage.scrollTop + frameRect.top - stageRect.top;
    const frameLeft = stage.scrollLeft + frameRect.left - stageRect.left;
    const top = frameTop + box.y * scale - (stage.clientHeight - box.height * scale) / 2;
    const boxLeft = frameLeft + box.x * scale;
    const boxRight = boxLeft + box.width * scale;
    const padding = 16;
    let left = stage.scrollLeft;
    if (boxLeft < stage.scrollLeft + padding) left = boxLeft - padding;
    else if (boxRight > stage.scrollLeft + stage.clientWidth - padding) {
      left = boxRight - stage.clientWidth + padding;
    }
    stage.scrollTo({
      top: Math.max(0, Math.min(stage.scrollHeight - stage.clientHeight, top)),
      left: Math.max(0, Math.min(stage.scrollWidth - stage.clientWidth, left)),
      behavior: "smooth",
    });
    stage.focus({ preventScroll: true });
  }, [focusEnabled, focusFrameRef, focusRequest?.token, frameWidth, stageRef]);
}

function AnchorSelectionLayer({ kind, placement, selection, active, onSelect, onInvalid }) {
  const [draft, setDraft] = useState(null);
  const startRef = useRef(null);
  const roleLabel = kind === "design" ? "设计稿" : "实现稿";
  const toLocalPoint = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const canvasX = (event.clientX - rect.left) * placement.canvasWidth / Math.max(1, rect.width);
    const canvasY = (event.clientY - rect.top) * placement.canvasHeight / Math.max(1, rect.height);
    if (canvasX < placement.offsetX || canvasX > placement.right ||
      canvasY < placement.offsetY || canvasY > placement.bottom) return null;
    return {
      x: Math.max(0, Math.min(placement.width, canvasX - placement.offsetX)),
      y: Math.max(0, Math.min(placement.height, canvasY - placement.offsetY)),
    };
  };
  const boxStyle = (box) => box ? {
    left: `${((placement.offsetX + box.x) / placement.canvasWidth) * 100}%`,
    top: `${((placement.offsetY + box.y) / placement.canvasHeight) * 100}%`,
    width: `${(box.width / placement.canvasWidth) * 100}%`,
    height: `${(box.height / placement.canvasHeight) * 100}%`,
  } : undefined;
  const handlePointerDown = (event) => {
    if (!active || event.button !== 0) return;
    const point = toLocalPoint(event);
    if (!point) return onInvalid?.("请从图片内容区域内开始框选");
    event.currentTarget.setPointerCapture(event.pointerId);
    startRef.current = { ...point, clientX: event.clientX, clientY: event.clientY };
    setDraft({ x: point.x, y: point.y, width: 0, height: 0 });
  };
  const handlePointerMove = (event) => {
    if (!active || !startRef.current) return;
    const point = toLocalPoint(event);
    if (!point) return;
    setDraft({
      x: Math.min(startRef.current.x, point.x),
      y: Math.min(startRef.current.y, point.y),
      width: Math.abs(point.x - startRef.current.x),
      height: Math.abs(point.y - startRef.current.y),
    });
  };
  const handlePointerUp = (event) => {
    if (!startRef.current) return;
    const point = toLocalPoint(event);
    const next = point ? {
      x: Math.min(startRef.current.x, point.x),
      y: Math.min(startRef.current.y, point.y),
      width: Math.abs(point.x - startRef.current.x),
      height: Math.abs(point.y - startRef.current.y),
    } : draft;
    const moved = Math.hypot(
      event.clientX - startRef.current.clientX,
      event.clientY - startRef.current.clientY,
    );
    startRef.current = null;
    setDraft(null);
    if (!next || moved < 8 || next.width < 16 || next.height < 16) {
      onInvalid?.("选区太小，请框住一个完整元素");
      return;
    }
    onSelect?.(kind, next);
  };
  const visibleBox = draft || selection;
  const roughBox = !draft && selection?.recognized ? selection.roughBox : null;
  const visibleLabel = draft
    ? "手工粗选"
    : selection?.pending
      ? "正在识别"
      : selection?.recognized
        ? "系统边界"
        : "手工范围";
  return (
    <div
      className={`anchor-selection-layer ${active ? "is-active" : ""}`}
      role="region"
      tabIndex={active ? 0 : -1}
      aria-label={`${roleLabel}${active ? "元素框选区，请拖拽框选参考元素" : "已选择的对齐元素"}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => { startRef.current = null; setDraft(null); }}
    >
      {roughBox ? <span className="anchor-selection-box anchor-selection-box--rough" style={boxStyle(roughBox)} aria-hidden="true"><em>手工粗选</em></span> : null}
      {visibleBox ? <span className={`anchor-selection-box ${draft ? "anchor-selection-box--draft" : selection?.pending ? "anchor-selection-box--pending" : selection?.recognized ? "anchor-selection-box--detected" : "anchor-selection-box--fallback"}`} style={boxStyle(visibleBox)} role="img" aria-label={`${roleLabel}${visibleLabel}`}><em>{visibleLabel}</em>{!draft && selection?.recognized ? <i className="anchor-selection-point" style={{ left: `${((selection.anchorX - selection.x) / Math.max(1, selection.width)) * 100}%`, top: `${((selection.anchorY - selection.y) / Math.max(1, selection.height)) * 100}%` }} /> : null}</span> : null}
    </div>
  );
}

function ImagePreviewFrame({ source, kind, zoom, sideMode = false, findings = [], selectedId, onSelect, onUpload, onDropFile, onDropError, overlaySource, overlayOpacity = 0.5, regionMode = false, comparisonProfile, frameRef, anchorSelection, anchorActive = false, onAnchorSelect, onAnchorInvalid }) {
  if (!source) return <ImageUploadPlaceholder kind={kind} onUpload={onUpload} onDropFile={onDropFile} onDropError={onDropError} />;
  const placement = getComparisonPlacement(comparisonProfile, kind, source);
  const overlayPlacement = getComparisonPlacement(comparisonProfile, "design", overlaySource || {});
  const frameWidth = placement.canvasWidth;
  const frameHeight = placement.canvasHeight;
  const imageWidthPercent = `${(placement.width / frameWidth) * 100}%`;
  const imageLeftPercent = `${(placement.offsetX / frameWidth) * 100}%`;
  const imageHeightPercent = `${(placement.height / frameHeight) * 100}%`;
  const imageTopPercent = `${(placement.offsetY / frameHeight) * 100}%`;
  const overlayWidthPercent = comparisonProfile && overlaySource
    ? `${(overlayPlacement.width / frameWidth) * 100}%`
    : "100%";
  const overlayLeftPercent = `${(overlayPlacement.offsetX / frameWidth) * 100}%`;
  const overlayHeightPercent = comparisonProfile && overlaySource
    ? `${(overlayPlacement.height / frameHeight) * 100}%`
    : "100%";
  const overlayTopPercent = `${(overlayPlacement.offsetY / frameHeight) * 100}%`;
  const scaledFrameWidth = Math.max(1, Math.round(frameWidth * (zoom / 100)));
  const frameZoom = sideMode && zoom > 100 ? 100 : zoom;
  return (
      <figure ref={frameRef} className={`image-preview-frame ${comparisonProfile?.heightsDiffer || comparisonProfile?.alignment === "element" ? "is-normalized" : ""} ${comparisonProfile?.alignment === "bottom-left" ? "is-bottom-aligned" : ""}`} style={{ aspectRatio: `${frameWidth} / ${frameHeight}`, width: `min(${frameZoom}%, ${scaledFrameWidth}px)` }}>
        <img draggable="false" src={source.objectUrl} alt={kind === "design" ? "设计稿预览" : "实现截图预览"} style={{ width: imageWidthPercent, left: imageLeftPercent, height: imageHeightPercent, top: imageTopPercent, right: "auto", bottom: "auto" }} />
        {overlaySource && <img draggable="false" className="overlay-image" src={overlaySource.objectUrl} alt="叠加的设计稿" style={{ opacity: overlayOpacity, width: overlayWidthPercent, left: overlayLeftPercent, height: overlayHeightPercent, top: overlayTopPercent, right: "auto", bottom: "auto" }} />}
        {kind === "implementation" && <AnnotationLayer findings={findings} dimensions={{ width: frameWidth, height: frameHeight }} selectedId={selectedId} onSelect={onSelect} variant={regionMode ? "regions" : "outline"} />}
        {(anchorActive || anchorSelection) ? <AnchorSelectionLayer kind={kind} placement={placement} selection={anchorSelection} active={anchorActive} onSelect={onAnchorSelect} onInvalid={onAnchorInvalid} /> : null}
      </figure>
  );
}

function ImageStage(props) {
  const stageRef = useRef(null);
  const frameRef = useRef(null);
  const placement = getComparisonPlacement(props.comparisonProfile, props.kind, props.source || {});
  usePreviewNavigation({
    stageRef,
    focusFrameRef: frameRef,
    resetKey: props.source?.id,
    alignment: props.comparisonProfile?.alignment,
    frameWidth: placement.canvasWidth,
    focusRequest: props.focusRequest,
    focusEnabled: props.kind === "implementation",
  });
  return (
    <div ref={stageRef} className="image-stage" role="region" tabIndex={0} aria-label={`${props.kind === "design" ? "设计稿" : "实现稿"}预览，可滚动浏览完整图片`}>
      <ImagePreviewFrame {...props} frameRef={frameRef} />
    </div>
  );
}

function SideBySideStage({ sources, zoom, findings, selectedId, onSelect, onUpload, onRemove, onDropFile, onDropError, profile, sourceActionsDisabled, focusRequest, anchorSelections, activeAnchorKind, onAnchorSelect, onAnchorInvalid }) {
  const stageRef = useRef(null);
  const implementationFrameRef = useRef(null);
  const designFrameRef = useRef(null);
  const placement = getComparisonPlacement(profile, "implementation", sources.implementation || {});
  usePreviewNavigation({
    stageRef,
    focusFrameRef: implementationFrameRef,
    resetKey: `${sources.design?.id || ""}|${sources.implementation?.id || ""}|${profile?.anchorDelta?.x || 0}|${profile?.anchorDelta?.y || 0}`,
    alignment: profile?.alignment,
    frameWidth: placement.canvasWidth,
    focusRequest,
  });
  const trackWidth = zoom > 100 ? `${zoom}%` : "100%";
  return (
    <div className="compare-split compare-split--shared">
      <SourcePaneHeader kind="design" source={sources.design} onReplace={() => onUpload("design")} onRemove={() => onRemove("design")} disabled={sourceActionsDisabled} />
      <SourcePaneHeader kind="implementation" source={sources.implementation} onReplace={() => onUpload("implementation")} onRemove={() => onRemove("implementation")} disabled={sourceActionsDisabled} />
      <div ref={stageRef} className="side-shared-stage" role="region" tabIndex={0} aria-label="设计稿与实现稿并排预览，可同步滚动浏览完整页面">
        <div className="side-shared-track" style={{ width: trackWidth }}>
          <div className="side-preview-cell">
            <ImagePreviewFrame source={sources.design} kind="design" zoom={zoom} sideMode onUpload={() => onUpload("design")} onDropFile={(file) => onDropFile("design", file)} onDropError={onDropError} comparisonProfile={profile} frameRef={designFrameRef} anchorSelection={anchorSelections?.design} anchorActive={activeAnchorKind === "design"} onAnchorSelect={onAnchorSelect} onAnchorInvalid={onAnchorInvalid} />
          </div>
          <div className="side-preview-cell is-implementation">
            <ImagePreviewFrame source={sources.implementation} kind="implementation" zoom={zoom} sideMode findings={findings} selectedId={selectedId} onSelect={onSelect} onUpload={() => onUpload("implementation")} onDropFile={(file) => onDropFile("implementation", file)} onDropError={onDropError} comparisonProfile={profile} frameRef={implementationFrameRef} anchorSelection={anchorSelections?.implementation} anchorActive={activeAnchorKind === "implementation"} onAnchorSelect={onAnchorSelect} onAnchorInvalid={onAnchorInvalid} />
          </div>
        </div>
      </div>
      <div className="sync-handle" title="两张图同步滚动"><AppIcon icon={ArrowsLeftRight} size={16} /></div>
    </div>
  );
}

function VerticalAlignmentSwitch({ value, onChange, disabled }) {
  return (
    <div className="alignment-mode-switch" role="group" aria-label="图片对齐方式">
      {[{ value: "top-left", label: "顶部对齐" }, { value: "bottom-left", label: "底部对齐" }, { value: "element", label: "元素对齐" }].map((option) => {
        const selected = value === option.value;
        return <button key={option.value} type="button" aria-pressed={selected} className={selected ? "is-active" : ""} disabled={disabled} onClick={() => onChange(option.value)}>{selected ? <CheckCircle size={13} weight="fill" /> : null}{option.label}</button>;
      })}
    </div>
  );
}

function ComparisonCanvas({ mode, sources, zoom, findings, selectedId, onSelect, onUpload, onRemove, onDropFile, onDropError, profile, auditMeta, sourceActionsDisabled, focusRequest, alignment, onAlignmentChange, anchorFlow, anchors, onBeginElementAlignment, onAnchorSelect, onAnchorInvalid, onApplyElementAlignment, onResetElementAlignment, onCancelElementAlignment, onClearElementAlignment }) {
  const [overlayOpacity, setOverlayOpacity] = useState(50);
  const design = sources.design;
  const implementation = sources.implementation;

  const normalizedSourceLabel = (source, normalizedHeight, scale) => {
    const normalizedSize = `${profile.targetWidth}×${normalizedHeight}`;
    if (scale === 1) return `${source.width}×${source.height}（原尺寸）`;
    return `${source.width}×${source.height} → ${normalizedSize}（${scale.toFixed(2)}×）`;
  };

  const comparability = auditMeta?.comparability;
  const comparisonNeedsAttention = ["medium", "low"].includes(comparability?.status);
  const contentVariation = comparability?.reasonDetails?.some((reason) => reason.code === "WIDESPREAD_CONTENT_VARIATION");
  const assessmentLabel = contentVariation
    ? "内容不同 · 仅检查布局与样式"
    : comparability?.status === "low"
    ? "可比性低 · 已停止生成候选"
    : comparability?.status === "medium"
      ? "可比性中等 · 请人工复核"
      : null;
  const workflowActive = anchorFlow?.status && anchorFlow.status !== "idle";
  const activeAnchorKind = anchorFlow?.status === "selecting-design"
    ? "design"
    : anchorFlow?.status === "selecting-implementation"
      ? "implementation"
      : null;
  const visibleAnchors = workflowActive
    ? { design: anchorFlow.design, implementation: anchorFlow.implementation }
    : alignment === "element" ? anchors : null;
  const workflowCopy = anchorFlow?.status === "selecting-design"
    ? "第 1 步：在左侧设计稿中粗略圈住要对齐的完整元素"
    : anchorFlow?.status === "detecting-design"
      ? "正在识别设计稿中的完整元素边界…"
    : anchorFlow?.status === "selecting-implementation"
      ? "第 2 步：在右侧实现稿中粗略圈住同一个元素"
      : anchorFlow?.status === "detecting-implementation"
        ? "正在识别实现稿中的完整元素边界…"
      : anchorFlow?.status === "review"
        ? anchorFlow.design?.recognized && anchorFlow.implementation?.recognized
          ? "蓝色实线是系统识别的元素边界，请确认两边是同一个元素"
          : "元素边界已处理；橙色范围未能自动吸附时仍可重选"
        : null;
  const chooseAlignment = (next) => next === "element"
    ? onBeginElementAlignment()
    : onAlignmentChange(next);
  const anchorDeltaLabel = profile?.anchorDelta
    ? `实现稿平移 ${profile.anchorDelta.x >= 0 ? "右" : "左"}${Math.abs(profile.anchorDelta.x)}px、${profile.anchorDelta.y >= 0 ? "下" : "上"}${Math.abs(profile.anchorDelta.y)}px`
    : "已按对应元素对齐";
  const alignmentBanner = design && implementation && (
    <div className={`alignment-banner ${profile.exceedsSafetyLimit || comparisonNeedsAttention ? "is-warning" : ""} ${workflowActive ? "is-selecting" : ""}`} aria-busy={anchorFlow?.status?.startsWith("detecting-") || undefined}>
      <span id="element-alignment-instructions" role={workflowActive ? "status" : undefined} aria-live={workflowActive ? "polite" : undefined} title={workflowActive ? workflowCopy : comparability?.reasons?.[0] || `以较宽图片为目标宽度，仅等比放大较窄图片；两图按当前锚点对齐`}>
        {workflowActive ? workflowCopy : `${profile.label} · 目标宽度 ${profile.targetWidth}px · 设计稿 ${normalizedSourceLabel(design, profile.designNormalizedHeight, profile.designScale)} · 实现稿 ${normalizedSourceLabel(implementation, profile.implementationNormalizedHeight, profile.implementationScale)}`}
      </span>
      <div className="alignment-banner-actions">
        {workflowActive ? (
          <div className="alignment-workflow-actions">
            {anchorFlow.status === "review" ? <button type="button" onClick={onResetElementAlignment}>重选</button> : null}
            <button type="button" onClick={onCancelElementAlignment}>取消</button>
            {anchorFlow.status === "review" ? <button type="button" className="is-primary" onClick={onApplyElementAlignment}>应用对齐</button> : null}
          </div>
        ) : (
          <>
            <em>{profile.exceedsSafetyLimit ? "超过 3200 万像素限制" : assessmentLabel || (alignment === "element" ? `${anchorDeltaLabel} · 只比较重叠区域` : profile.heightsDiffer ? `${alignment === "bottom-left" ? "底部" : "顶部"}对齐 · 保留${alignment === "bottom-left" ? "顶部" : "底部"}差异` : "已就绪")}</em>
            <VerticalAlignmentSwitch value={alignment} onChange={chooseAlignment} disabled={sourceActionsDisabled} />
            {alignment === "element" ? <div className="alignment-applied-actions"><button type="button" onClick={onBeginElementAlignment}>重选</button><button type="button" onClick={onClearElementAlignment}>清除</button></div> : null}
          </>
        )}
      </div>
    </div>
  );

  if (mode === "side") {
    return (
      <div className="comparison-content">
        {alignmentBanner}
        <SideBySideStage sources={sources} zoom={zoom} findings={findings} selectedId={selectedId} onSelect={onSelect} onUpload={onUpload} onRemove={onRemove} onDropFile={onDropFile} onDropError={onDropError} profile={profile} sourceActionsDisabled={sourceActionsDisabled} focusRequest={focusRequest} anchorSelections={visibleAnchors} activeAnchorKind={activeAnchorKind} onAnchorSelect={onAnchorSelect} onAnchorInvalid={onAnchorInvalid} />
      </div>
    );
  }

  const title = mode === "annotate" ? "实现稿 · 差异标注" : mode === "overlay" ? "设计稿 / 实现稿 · 透明度叠加" : "实现稿 · 差异区域";
  return (
    <div className="comparison-content">
      {alignmentBanner}
      <section className={`single-compare single-compare--${mode}`} aria-label={title}>
        <header className="source-pane-header">
          <div className="source-pane-summary"><strong>{title}</strong><span title={implementation?.name}>{implementation ? `${implementation.name} · ${implementation.width}×${implementation.height}` : "等待输入"}</span></div>
          <SourceActions kind="implementation" source={implementation} onReplace={() => onUpload("implementation")} onRemove={() => onRemove("implementation")} disabled={sourceActionsDisabled} />
          {mode === "overlay" && design && implementation ? (
            <label className="opacity-slider">设计稿透明度 <input type="range" min="0" max="100" value={overlayOpacity} onChange={(event) => setOverlayOpacity(Number(event.target.value))} /><span>{overlayOpacity}%</span></label>
          ) : null}
        </header>
        <ImageStage
          source={implementation}
          kind="implementation"
          zoom={zoom}
          findings={findings}
          selectedId={selectedId}
          onSelect={onSelect}
          onUpload={() => onUpload("implementation")}
          onDropFile={(file) => onDropFile("implementation", file)}
          onDropError={onDropError}
          overlaySource={mode === "overlay" ? design : null}
          overlayOpacity={overlayOpacity / 100}
          regionMode={mode === "regions"}
          comparisonProfile={profile}
          focusRequest={focusRequest}
        />
      </section>
    </div>
  );
}

function FindingsTable({ findings, selectedId, onSelect, onLocate, statusFilter, setStatusFilter, visibleColumns, setVisibleColumns, collapsed, onToggleCollapsed }) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const visibleFindings = statusFilter === "all" ? findings : findings.filter((item) => item.status === statusFilter);
  const counts = useMemo(() => ({
    all: findings.length,
    pending: findings.filter((f) => f.status === "pending").length,
    confirmed: findings.filter((f) => f.status === "confirmed").length,
    dismissed: findings.filter((f) => f.status === "dismissed").length,
    ignored: findings.filter((f) => f.status === "ignored").length,
  }), [findings]);

  return (
    <section className={`findings-panel ${collapsed ? "is-collapsed" : ""}`} aria-label="问题清单">
      <div className="table-toolbar">
        {collapsed ? (
          <div className="collapsed-findings-summary"><strong>问题列表</strong><span>共 {visibleFindings.length} 条</span></div>
        ) : (
          <div className="status-tabs" role="tablist" aria-label="问题状态筛选">
            {[["all", "全部"], ["pending", "待确认"], ["confirmed", "已确认"], ["dismissed", "已驳回"], ["ignored", "已忽略"]].map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={statusFilter === id} className={statusFilter === id ? "is-active" : ""} onClick={() => setStatusFilter(id)}>{label} <b>{counts[id]}</b></button>
            ))}
          </div>
        )}
        <div className="table-tools">
          {!collapsed && (
            <>
              <div className="popover-wrap">
                <button type="button" className={filtersOpen ? "tool-button is-active" : "tool-button"} onClick={() => { setFiltersOpen(!filtersOpen); setColumnsOpen(false); }}><AppIcon icon={FunnelSimple} size={16} /> 筛选</button>
                {filtersOpen && (
                  <div className="popover compact-popover">
                    <span className="popover-title">按处理状态</span>
                    <button type="button" onClick={() => { setStatusFilter("pending"); setFiltersOpen(false); }}>待确认</button>
                    <button type="button" onClick={() => { setStatusFilter("confirmed"); setFiltersOpen(false); }}>已确认</button>
                    <button type="button" onClick={() => { setStatusFilter("all"); setFiltersOpen(false); }}>清除筛选</button>
                  </div>
                )}
              </div>
              <div className="popover-wrap">
                <button type="button" className={columnsOpen ? "tool-button is-active" : "tool-button"} onClick={() => { setColumnsOpen(!columnsOpen); setFiltersOpen(false); }}><AppIcon icon={Columns} size={16} /> 列设置</button>
                {columnsOpen && (
                  <div className="popover column-popover">
                    <span className="popover-title">显示列</span>
                    {["location", "evidence"].map((key) => (
                      <label key={key}><input type="checkbox" checked={visibleColumns[key]} onChange={() => setVisibleColumns((current) => ({ ...current, [key]: !current[key] }))} />{key === "location" ? "位置" : "判断依据"}</label>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
          <button
            type="button"
            className="tool-button collapse-list-button"
            aria-expanded={!collapsed}
            aria-controls="findings-table-content"
            onClick={() => { setFiltersOpen(false); setColumnsOpen(false); onToggleCollapsed(); }}
          >
            <CaretDown size={15} />
            {collapsed ? "展开列表" : "收起列表"}
          </button>
        </div>
      </div>
      <div id="findings-table-content" className="findings-table-content" hidden={collapsed}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>发现</th>
                  {visibleColumns.location && <th>大概位置</th>}
                  {visibleColumns.evidence && <th>判断依据</th>}
                  <th>状态</th>
                  <th>处理</th>
                </tr>
              </thead>
              <tbody>
                {visibleFindings.map((finding) => (
                  <tr key={finding.id} aria-selected={selectedId === finding.id} className={selectedId === finding.id ? "is-selected" : ""} onClick={() => onSelect(finding.id)}>
                    <td><button type="button" className="row-title" onClick={(event) => { event.stopPropagation(); onSelect(finding.id); }}>{finding.title}</button></td>
                    {visibleColumns.location && <td><span className="truncate">{finding.location}</span></td>}
                    {visibleColumns.evidence && <td><span className="evidence-cell">{finding.evidence}</span></td>}
                    <td><StatusBadge status={finding.status} /></td>
                    <td><div className="row-actions"><button type="button" onClick={(event) => { event.stopPropagation(); onLocate(finding.id); }}><AppIcon icon={Eye} size={16} /><span>定位</span></button></div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            {visibleFindings.length === 0 && <div className="empty-table">当前筛选下没有问题</div>}
          </div>
          <footer className="table-footer"><span>共 {visibleFindings.length} 条</span><span>点击一行查看详情</span></footer>
      </div>
    </section>
  );
}

function getResultEmptyCopy(runStatus, hasInputs = false, auditMeta = null) {
  if (runStatus === "running") return { title: "正在走查", description: "走查完成后，发现的问题会显示在这里。" };
  if ((runStatus === "draft" || runStatus === "cancelled" || runStatus === "stale") && hasInputs) return { title: "等待开始走查", description: "图片已就绪，点击右上角“开始走查”生成候选问题。" };
  if (runStatus === "incomparable") {
    const policy = resolveComparisonPolicy(auditMeta?.comparability);
    return { title: policy.title, description: policy.description };
  }
  if (runStatus === "completed") {
    const policy = resolveComparisonPolicy(auditMeta?.comparability);
    const suffix = policy.comparability.status === "medium" ? "；由于输入可比性一般，仍建议人工复核主要区域。" : "。";
    return { title: "未发现问题", description: `本次走查没有生成需要处理的问题${suffix}` };
  }
  if (runStatus === "failed") return { title: "走查失败", description: "图片仍然保留，请查看顶部错误提示后重试。" };
  return { title: "暂无走查结果", description: "请先上传设计稿与实现截图，再开始走查。" };
}

function FindingsEmptyPanel({ runStatus, hasInputs, auditMeta }) {
  const copy = getResultEmptyCopy(runStatus, hasInputs, auditMeta);
  return (
    <section className="findings-panel findings-panel--empty" aria-label="问题清单">
      <header className="empty-panel-header"><strong>问题列表</strong><span>0 条</span></header>
      <div className="results-empty-state" role="status" aria-live="polite">
        <span className="results-empty-state__icon"><AppIcon icon={ListChecks} size={26} /></span>
        <strong>{copy.title}</strong>
        <p>{copy.description}</p>
      </div>
      <footer className="table-footer"><span>共 0 条</span><span className="empty-footer-hint">等待走查结果</span></footer>
    </section>
  );
}

function DetailEmptyPanel({ runStatus, hasInputs, auditMeta, filtered = false }) {
  const copy = filtered
    ? { title: "当前筛选下没有问题", description: "切换问题状态筛选后，可继续查看对应的问题详情。" }
    : getResultEmptyCopy(runStatus, hasInputs, auditMeta);
  return (
    <aside className="detail-panel detail-panel--empty" aria-label="问题详情">
      <header className="detail-header"><strong>问题详情</strong></header>
      <div className="detail-empty-state" role="status" aria-live="polite">
        <span className="results-empty-state__icon"><AppIcon icon={ListChecks} size={26} /></span>
        <strong>{copy.title}</strong>
        <p>{copy.description}</p>
      </div>
      <div className="detail-footer"><button type="button" className="export-button" disabled><DownloadSimple size={17} />导出清单</button></div>
    </aside>
  );
}

function EvidenceCrop({ finding, source, profile }) {
  const canvasRef = useRef(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !source?.objectUrl || !finding?.bbox) return undefined;
    const image = new Image();
    let cancelled = false;
    image.onload = () => {
      if (cancelled) return;
      const context = canvas.getContext("2d");
      const box = finding.bbox;
      const placement = getComparisonPlacement(profile, "implementation", source);
      const comparisonWidth = placement.canvasWidth;
      const comparisonHeight = placement.canvasHeight;
      const padding = Math.max(12, Math.round(Math.max(box.width, box.height) * 0.35));
      const sx = Math.max(0, box.x - padding);
      const sy = Math.max(0, box.y - padding);
      const sw = Math.max(1, Math.min(comparisonWidth - sx, box.width + padding * 2));
      const sh = Math.max(1, Math.min(comparisonHeight - sy, box.height + padding * 2));
      const intersection = intersectCanvasCropWithPlacement(
        { x: sx, y: sy, width: sw, height: sh },
        placement,
      );
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#f4f7fb";
      context.fillRect(0, 0, canvas.width, canvas.height);
      const scale = Math.min(canvas.width / sw, canvas.height / sh);
      const dw = sw * scale;
      const dh = sh * scale;
      const dx = (canvas.width - dw) / 2;
      const dy = (canvas.height - dh) / 2;
      context.fillStyle = "#e5ebf3";
      context.fillRect(dx, dy, dw, dh);
      if (intersection) {
        const destinationX = dx + (intersection.canvas.x - sx) * scale;
        const destinationY = dy + (intersection.canvas.y - sy) * scale;
        context.drawImage(
          image,
          intersection.source.x,
          intersection.source.y,
          intersection.source.width,
          intersection.source.height,
          destinationX,
          destinationY,
          intersection.canvas.width * scale,
          intersection.canvas.height * scale,
        );
      }
      if (!intersection || intersection.canvas.height < sh) {
        context.fillStyle = "#6f7e92";
        context.font = "600 14px sans-serif";
        context.fillText("实现截图无对应内容", dx + 12, dy + 24);
      }
      context.strokeStyle = "#1467e8";
      context.lineWidth = 3;
      context.strokeRect(dx + (box.x - sx) * scale, dy + (box.y - sy) * scale, box.width * scale, box.height * scale);
    };
    image.src = source.objectUrl;
    return () => { cancelled = true; };
  }, [finding, source, profile]);
  return (
    <div className="evidence-crop"><canvas ref={canvasRef} width="520" height="160" aria-label="实现截图中的问题区域裁剪" /></div>
  );
}

function DetailPanel({ finding, findings, implementationSource, comparisonProfile, onSelect, onChange, onRequestStatus, onExport, exportDisabled }) {
  const currentIndex = findings.findIndex((item) => item.id === finding.id);
  const move = (direction) => {
    const next = Math.min(findings.length - 1, Math.max(0, currentIndex + direction));
    onSelect(findings[next].id);
  };

  return (
    <aside className="detail-panel" aria-label="问题详情">
      <header className="detail-header"><strong>问题详情</strong></header>
      <div className="detail-content">
        <div className="issue-nav"><span>问题 {currentIndex + 1} / {findings.length}</span><div><button type="button" disabled={currentIndex === 0} onClick={() => move(-1)} aria-label="上一个问题"><CaretLeft size={16} /></button><button type="button" disabled={currentIndex === findings.length - 1} onClick={() => move(1)} aria-label="下一个问题"><CaretRight size={16} /></button></div></div>
        <section className="detail-summary">
          <span className="eyebrow">{statusMeta[finding.status]?.label || "待确认"} · {finding.priority === "—" ? "优先级待定" : finding.priority}</span>
          <h2>{finding.title}</h2>
          <p>{finding.summary}</p>
          <dl className="quick-facts"><div><dt>大概位置</dt><dd>{finding.location}</dd></div><div><dt>判断依据</dt><dd>{finding.evidence}</dd></div></dl>
        </section>
        <section className="detail-section evidence-section">
          <div className="section-heading"><strong>对应区域</strong><span>蓝框是检测位置</span></div>
          <EvidenceCrop finding={finding} source={implementationSource} profile={comparisonProfile} />
        </section>
        <section className="detail-section form-section">
          <div className="field-grid">
            <label>影响程度<select value={finding.severity} onChange={(event) => onChange({ severity: event.target.value })}>{Object.entries(severityMeta).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>优先级<select value={finding.priority} onChange={(event) => onChange({ priority: event.target.value })}><option value="—">待定</option><option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option></select></label>
          </div>
          <span className="field-label">处理结果</span>
          <div className="review-actions"><button type="button" aria-pressed={finding.status === "confirmed"} className={finding.status === "confirmed" ? "is-active" : ""} onClick={() => onRequestStatus("confirmed")}><CheckCircle size={15} />确认</button><button type="button" aria-pressed={finding.status === "dismissed"} className={finding.status === "dismissed" ? "is-active" : ""} onClick={() => onRequestStatus("dismissed")}><X size={15} />驳回</button><button type="button" aria-pressed={finding.status === "ignored"} className={finding.status === "ignored" ? "is-active" : ""} onClick={() => onRequestStatus("ignored")}><Info size={15} />忽略</button></div>
        </section>
        <section className="detail-section note-section"><label htmlFor="finding-note">处理说明</label><textarea id="finding-note" value={finding.note} maxLength={200} placeholder="补充处理原因或需要修改的内容…" onChange={(event) => onChange({ note: event.target.value })} /><span>{finding.note.length} / 200</span></section>
      </div>
      <div className="detail-footer"><button type="button" className="export-button" onClick={onExport} disabled={exportDisabled}><DownloadSimple size={17} />{exportDisabled ? "结果已失效，请重跑" : "导出清单"}</button></div>
    </aside>
  );
}

function Dialog({ title, children, onClose, size = "medium" }) {
  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className={`dialog dialog--${size}`} role="dialog" aria-modal="true" aria-label={title} onMouseDown={(event) => event.stopPropagation()}><header><strong>{title}</strong><button type="button" aria-label="关闭" onClick={onClose} disabled={!onClose}><X size={19} /></button></header>{children}</section>
    </div>
  );
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportAnnotatedPng({ auditName, implementation, findings, profile }) {
  const image = new Image();
  image.src = implementation.objectUrl;
  await image.decode();
  const placement = getComparisonPlacement(profile, "implementation", {
    width: image.naturalWidth,
    height: image.naturalHeight,
  });
  const comparisonWidth = placement.canvasWidth;
  const comparisonHeight = placement.canvasHeight;
  const panelWidth = Math.max(420, Math.min(720, Math.round(comparisonWidth * 0.55)));
  const rowHeight = 112;
  const output = document.createElement("canvas");
  output.width = comparisonWidth + panelWidth;
  output.height = Math.max(comparisonHeight, 132 + findings.length * rowHeight);
  const context = output.getContext("2d");
  context.fillStyle = "#f4f7fb";
  context.fillRect(0, 0, output.width, output.height);
  context.fillStyle = "#e5ebf3";
  context.fillRect(0, 0, comparisonWidth, comparisonHeight);
  context.drawImage(image, placement.offsetX, placement.offsetY, placement.width, placement.height);
  context.lineWidth = Math.max(2, Math.round(comparisonWidth / 600));
  context.strokeStyle = "#1467e8";
  context.font = `700 ${Math.max(13, Math.round(comparisonWidth / 80))}px sans-serif`;
  findings.forEach((finding, index) => {
    const box = finding.bbox;
    context.strokeRect(box.x, box.y, box.width, box.height);
    context.fillStyle = "#1467e8";
    context.fillRect(box.x, Math.max(0, box.y - 26), 34, 26);
    context.fillStyle = "#fff";
    context.fillText(String(index + 1), box.x + 10, Math.max(19, box.y - 7));
  });
  const panelX = comparisonWidth;
  context.fillStyle = "#fff";
  context.fillRect(panelX, 0, panelWidth, output.height);
  context.fillStyle = "#17233a";
  context.font = "700 26px sans-serif";
  context.fillText(auditName, panelX + 28, 48);
  context.fillStyle = "#5a687c";
  context.font = "500 15px sans-serif";
  context.fillText(`导出 ${findings.length} 个已选问题 · 编号对应左侧标注`, panelX + 28, 78);
  findings.forEach((finding, index) => {
    const y = 118 + index * rowHeight;
    context.fillStyle = index % 2 ? "#f8fafd" : "#fff";
    context.fillRect(panelX, y - 25, panelWidth, rowHeight);
    context.fillStyle = "#1467e8";
    context.beginPath();
    context.arc(panelX + 43, y + 10, 17, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#fff";
    context.font = "700 14px sans-serif";
    context.fillText(String(index + 1), panelX + 39, y + 15);
    context.fillStyle = "#17233a";
    context.font = "700 16px sans-serif";
    const title = finding.title.length > 28 ? `${finding.title.slice(0, 28)}…` : finding.title;
    context.fillText(`${finding.priority} · ${title}`, panelX + 72, y + 5);
    context.fillStyle = "#5a687c";
    context.font = "500 13px sans-serif";
    context.fillText(finding.location.slice(0, 52), panelX + 72, y + 31);
    context.fillText(`${finding.evidence} · ${finding.delta}`.slice(0, 52), panelX + 72, y + 54);
  });
  const blob = await new Promise((resolve, reject) => output.toBlob((value) => value ? resolve(value) : reject(new Error("PNG 生成失败")), "image/png"));
  downloadBlob(blob, "ui-audit-review-board.png");
}

function ExportDialog({ auditName, findings, sources, profile, onClose, onToast }) {
  const [included, setIncluded] = useState({ confirmed: true, pending: false, dismissed: false, ignored: false });
  const [format, setFormat] = useState("markdown");
  const [working, setWorking] = useState(false);
  const selected = findings.filter((item) => included[item.status]);
  const toggle = (key) => setIncluded((current) => ({ ...current, [key]: !current[key] }));
  const exportFile = async () => {
    if (!selected.length) return;
    setWorking(true);
    const order = ["P0", "P1", "P2", "P3", "—"];
    const ordered = [...selected].sort((a, b) => order.indexOf(a.priority) - order.indexOf(b.priority));
    if (format === "png") {
      await exportAnnotatedPng({ auditName, implementation: sources.implementation, findings: ordered, profile });
    } else {
      const metadata = {
        audit: auditName,
        exportedAt: new Date().toISOString(),
        engine: "yangao@beac836ba3c81b9a1d40bac8fe75af08444ab742",
        comparisonProfile: profile,
        sources: {
          design: sources.design && { name: sources.design.name, type: sources.design.sourceType, width: sources.design.width, height: sources.design.height, sourceUrl: sources.design.sourceUrl || undefined },
          implementation: sources.implementation && { name: sources.implementation.name, type: sources.implementation.sourceType, width: sources.implementation.width, height: sources.implementation.height, sourceUrl: sources.implementation.sourceUrl || undefined },
        },
      };
      const content = format === "json"
        ? JSON.stringify({ ...metadata, findings: ordered }, null, 2)
        : [`# UI 走查清单`, ``, `审查：${auditName}`, ``, `引擎：${metadata.engine}`, `对比模式：${profile?.label || "未记录"}`, ``, ...ordered.flatMap((item) => [`## ${item.priority} · ${item.title}`, `- 状态：${statusMeta[item.status].label}`, `- 严重度：${severityMeta[item.severity]}`, `- 位置：${item.location}`, `- 证据：${item.evidence}（${item.delta}）`, `- 判断：${item.summary}`, `- 建议：${item.note || "待补充"}`, ``])].join("\n");
      downloadBlob(new Blob([content], { type: format === "json" ? "application/json" : "text/markdown" }), `ui-audit.${format === "json" ? "json" : "md"}`);
    }
    onToast(`已导出 ${selected.length} 条问题`);
    onClose();
  };
  return (
    <Dialog title="导出审阅清单" onClose={onClose}>
      <div className="dialog-body">
        <div className="notice"><Info size={18} /><div><strong>默认只导出已确认问题</strong><p>待确认、已驳回与已忽略的问题只有显式勾选后才会进入清单。</p></div></div>
        <div className="export-options">{[["confirmed", "已确认"], ["pending", "待确认"], ["dismissed", "已驳回"], ["ignored", "已忽略"]].map(([key, label]) => <label key={key}><input type="checkbox" checked={included[key]} onChange={() => toggle(key)} /><span>{label}</span><b>{findings.filter((item) => item.status === key).length}</b></label>)}</div>
        <label className="dialog-field">文件格式<select value={format} onChange={(event) => setFormat(event.target.value)}><option value="markdown">Markdown</option><option value="json">JSON</option><option value="png">带标注验收板 PNG</option></select></label>
      </div>
      <footer className="dialog-actions"><button type="button" onClick={onClose} disabled={working}>取消</button><button type="button" className="primary-button" disabled={!selected.length || working} onClick={exportFile}><DownloadSimple size={17} />{working ? "正在生成…" : `导出 ${selected.length} 条`}</button></footer>
    </Dialog>
  );
}

function UploadDropZone({ role, label, file, existing, preferred, working, onFile, onError }) {
  const { isDragging, dropProps } = useImageFileDrop({ onFile, onError, disabled: working });
  const chooseFile = (event) => {
    const candidate = event.target.files?.[0] || null;
    event.target.value = "";
    if (!candidate) return;
    try {
      validateImageFile(candidate);
      onError("");
      onFile(candidate);
    } catch (error) {
      onError(error.message || "图片导入失败");
    }
  };

  return (
    <label data-upload-role={role} aria-disabled={working} aria-busy={working} className={`upload-zone ${preferred ? "is-preferred" : ""} ${isDragging ? "is-dragging" : ""} ${working ? "is-disabled" : ""}`} {...dropProps}>
      <FileImage size={26} />
      <strong>{isDragging ? "松开即可导入" : label}</strong>
      <span aria-live="polite">{isDragging ? "将图片放入当前区域" : file?.name || existing?.name || "拖入 PNG / JPG / WebP"}</span>
      <input type="file" accept="image/png,image/jpeg,image/webp" aria-label={`选择${label}`} disabled={working} onChange={chooseFile} />
      <em>{isDragging ? "释放文件" : file || existing ? "重新选择或拖入" : "点击选择或拖入"}</em>
    </label>
  );
}

function UploadDialog({ sources, preferredRole, onClose, onApply }) {
  const [selected, setSelected] = useState({ design: null, implementation: null });
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const canApply = Boolean((selected.design || sources.design) && (selected.implementation || sources.implementation) && (selected.design || selected.implementation));
  const submit = async () => {
    setWorking(true);
    setError("");
    try {
      await onApply(selected);
    } catch (reason) {
      setError(reason.message || "图片读取失败");
      setWorking(false);
    }
  };
  return (
    <Dialog title="选择本地对比图片" onClose={working ? undefined : onClose} size="large">
      <div className="dialog-body">
        <div className="upload-grid">{[["design", "设计稿（期望）"], ["implementation", "实现稿（实际）"]].map(([role, label]) => {
          const file = selected[role];
          const existing = sources[role];
          return <UploadDropZone key={role} role={role} label={label} file={file} existing={existing} preferred={preferredRole === role} working={working} onFile={(nextFile) => { setError(""); setSelected((current) => ({ ...current, [role]: nextFile })); }} onError={setError} />;
        })}</div>
        <div className="notice"><Info size={18} /><div><strong>支持点击选择或拖拽导入</strong><p>分别将设计稿与实现截图拖到对应区域。文件仅在本地解码和比较，单张最多 40 MB、3200 万像素。</p></div></div>
        {error && <div className="dialog-error" role="alert"><WarningCircle size={17} />{error}</div>}
      </div>
      <footer className="dialog-actions"><button type="button" onClick={onClose} disabled={working}>取消</button><button type="button" className="primary-button" disabled={!canApply || working} onClick={submit}>{working ? "正在读取…" : "应用图片"}</button></footer>
    </Dialog>
  );
}

function FigmaDialog({ capabilities, onClose, onFallback, onImport }) {
  const [url, setUrl] = useState("");
  const [scale, setScale] = useState(2);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const tokenRef = useRef(null);
  const submit = async () => {
    setWorking(true);
    setError("");
    try {
      await onImport({ url: url.trim(), accessToken: tokenRef.current?.value.trim() || "", scale });
    } catch (reason) {
      setError(reason.message || "Figma 导入失败");
      setWorking(false);
    }
  };
  return (
    <Dialog title="从 Figma 导入 Frame" onClose={working ? undefined : onClose}>
      <div className="dialog-body">
        <label className="dialog-field">Figma Frame 地址<div className="input-with-icon"><LinkSimple size={17} /><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://figma.com/design/…?node-id=…" /></div></label>
        <label className="dialog-field">访问令牌（本次使用，不保存）<input ref={tokenRef} type="password" autoComplete="off" placeholder={capabilities?.figma?.environmentToken ? "已检测到 FIGMA_ACCESS_TOKEN，可留空" : "需要 file_content:read 权限"} /></label>
        <label className="dialog-field">导出倍率<select value={scale} onChange={(event) => setScale(Number(event.target.value))}><option value="1">1×</option><option value="2">2×</option><option value="3">3×</option><option value="4">4×</option></select></label>
        <div className="notice"><Info size={18} /><div><strong>必须链接到具体 Frame</strong><p>地址需要包含 node-id。令牌只发送给当前本地服务，再由它请求 Figma 官方图片接口。</p></div></div>
        {error && <div className="dialog-error" role="alert"><WarningCircle size={17} />{error}</div>}
      </div>
      <footer className="dialog-actions"><button type="button" onClick={onFallback} disabled={working}><UploadSimple size={17} />改用图片上传</button><button type="button" onClick={onClose} disabled={working}>取消</button><button type="button" className="primary-button" disabled={!url.trim() || working} onClick={submit}>{working ? "正在导入…" : "导入 Frame"}</button></footer>
    </Dialog>
  );
}

function WebCaptureDialog({ capabilities, onClose, onFallback, onCapture }) {
  const [url, setUrl] = useState("http://localhost:3000/");
  const [width, setWidth] = useState(1440);
  const [height, setHeight] = useState(1024);
  const [waitMs, setWaitMs] = useState(1500);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState("");
  const submit = async () => {
    setWorking(true);
    setError("");
    try {
      await onCapture({ url: url.trim(), width, height, waitMs });
    } catch (reason) {
      setError(reason.message || "网页截图失败");
      setWorking(false);
    }
  };
  return (
    <Dialog title="从网页地址获取实现截图" onClose={working ? undefined : onClose}>
      <div className="dialog-body">
        <label className="dialog-field">网页地址<div className="input-with-icon"><GlobeSimple size={17} /><input type="url" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="http://localhost:3000/" /></div></label>
        <div className="field-grid"><label>视口宽度<input type="number" min="320" max="3840" value={width} onChange={(event) => setWidth(Number(event.target.value))} /></label><label>视口高度<input type="number" min="320" max="8000" value={height} onChange={(event) => setHeight(Number(event.target.value))} /></label></div>
        <label className="dialog-field">页面稳定等待时间<select value={waitMs} onChange={(event) => setWaitMs(Number(event.target.value))}><option value="500">0.5 秒</option><option value="1500">1.5 秒</option><option value="3000">3 秒</option><option value="5000">5 秒</option></select></label>
        <div className={`notice ${capabilities?.capture?.available ? "" : "notice--warning"}`}><Camera size={18} /><div><strong>{capabilities?.capture?.available ? `将使用 ${capabilities.capture.browsers?.[0]?.name || "本机浏览器"}` : "尚未检测到可用的 Chromium 浏览器"}</strong><p>首版使用隔离的无痕浏览器上下文，只截取指定视口，不继承现有浏览器登录状态。</p></div></div>
        {error && <div className="dialog-error" role="alert"><WarningCircle size={17} />{error}</div>}
      </div>
      <footer className="dialog-actions"><button type="button" onClick={onFallback} disabled={working}><UploadSimple size={17} />改用本地截图</button><button type="button" onClick={onClose} disabled={working}>取消</button><button type="button" className="primary-button" disabled={!url.trim() || working || capabilities?.capture?.available === false} onClick={submit}>{working ? "正在截图…" : "获取截图"}</button></footer>
    </Dialog>
  );
}

function ReasonDialog({ status, onClose, onSubmit }) {
  const [reason, setReason] = useState("");
  const label = status === "dismissed" ? "驳回" : "忽略";
  return (
    <Dialog title={`${label}这个候选问题`} onClose={onClose}>
      <div className="dialog-body"><label className="dialog-field">处理原因<textarea autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder={`请说明${label}原因，便于后续追溯…`} /></label></div>
      <footer className="dialog-actions"><button type="button" onClick={onClose}>取消</button><button type="button" className="primary-button" disabled={!reason.trim()} onClick={() => onSubmit(reason.trim())}>确认{label}</button></footer>
    </Dialog>
  );
}

export function Prototype() {
  const query = new URLSearchParams(window.location.search);
  const qaMode = query.has("qa");
  const [findings, setFindings] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("side");
  const [alignment, setAlignment] = useState(query.get("align") === "bottom" ? "bottom-left" : "top-left");
  const [anchors, setAnchors] = useState({ design: null, implementation: null });
  const [anchorFlow, setAnchorFlow] = useState(idleAnchorFlow);
  const [zoom, setZoom] = useState(100);
  const [inputState, setInputState] = useState("empty");
  const [runStatus, setRunStatus] = useState("draft");
  const [auditMeta, setAuditMeta] = useState(null);
  const [runProgress, setRunProgress] = useState({ phase: "", percent: 0 });
  const [runError, setRunError] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [visibleColumns, setVisibleColumns] = useState({ location: true, evidence: true });
  const [findingsCollapsed, setFindingsCollapsed] = useState(false);
  const [focusRequest, setFocusRequest] = useState(null);
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [auditName, setAuditName] = useState("未命名走查");
  const [auditNameDraft, setAuditNameDraft] = useState("未命名走查");
  const [editingTitle, setEditingTitle] = useState(false);
  const [sources, setSources] = useState({ design: null, implementation: null });
  const [capabilities, setCapabilities] = useState(null);
  const sourcesRef = useRef(sources);
  const runTokenRef = useRef(0);
  const sourceImportTokensRef = useRef({ design: 0, implementation: 0 });
  const anchorRecognitionTokenRef = useRef(0);
  const abortRef = useRef(null);
  const toastTimerRef = useRef(null);
  const focusTokenRef = useRef(0);
  const auditNameManualRef = useRef(false);
  const profile = useMemo(() => deriveComparisonProfile(
    sources.design,
    sources.implementation,
    { alignment, anchors },
  ), [alignment, anchors, sources]);
  const hasInputs = Boolean(sources.design && sources.implementation);
  const hasAuditResults = runStatus === "completed" && findings.length > 0;
  const displayedFindings = statusFilter === "all" ? findings : findings.filter((item) => item.status === statusFilter);
  const selectedFinding = displayedFindings.find((item) => item.id === selectedId) ?? displayedFindings[0] ?? null;
  const canStart = hasInputs && inputState === "ready" && !profile?.exceedsSafetyLimit &&
    anchorFlow.status === "idle" &&
    (alignment !== "element" || (profile?.anchorReady && profile?.sharedAreaRatio >= 0.55)) &&
    runStatus !== "running";

  useEffect(() => {
    sourcesRef.current = sources;
  }, [sources]);

  useEffect(() => {
    const controller = new AbortController();
    getLocalCapabilities({ signal: controller.signal }).then(setCapabilities).catch(() => setCapabilities({ bridge: false, figma: { available: false }, capture: { available: false } }));
    return () => controller.abort();
  }, []);

  useEffect(() => () => {
    abortRef.current?.abort();
    sourceImportTokensRef.current.design += 1;
    sourceImportTokensRef.current.implementation += 1;
    anchorRecognitionTokenRef.current += 1;
    window.clearTimeout(toastTimerRef.current);
    disposeImageSource(sourcesRef.current.design);
    disposeImageSource(sourcesRef.current.implementation);
  }, []);

  const phaseLabels = {
    prepare: "准备图片",
    rasterize: "归一化画布",
    comparability: "检查输入可比性",
    "pixel-diff": "计算像素差异",
    "edge-diff": "分析边缘结构",
    regions: "定位差异区域",
    coverage: "检查遗漏区域",
    classify: "生成候选类型",
    group: "聚合问题区域",
    complete: "完成",
  };

  const runStateLabel = inputState === "importing"
    ? "正在读取输入…"
    : runStatus === "running"
      ? `${phaseLabels[runProgress.phase] || "正在分析"} · ${Math.round(runProgress.percent || 0)}%`
      : runStatus === "failed"
        ? `走查失败 · ${runError}`
      : runStatus === "incomparable"
        ? resolveComparisonPolicy(auditMeta?.comparability).stateLabel
      : runStatus === "completed"
        ? `${resolveComparisonPolicy(auditMeta?.comparability).stateLabel}${findings.length ? ` · ${findings.length} 个候选` : " · 未发现超过阈值的差异"}`
        : anchorFlow.status !== "idle"
          ? anchorFlow.status.startsWith("detecting-") ? "正在识别元素边界…" : "正在选择对齐元素…"
        : profile?.exceedsSafetyLimit
          ? `归一画布 ${profile.comparisonWidth || profile.targetWidth}×${profile.comparisonHeight || profile.targetHeight} 超过 3200 万像素限制`
        : hasInputs
          ? alignment === "element"
            ? "图片已按对应元素对齐 · 等待走查"
            : `图片已同宽${alignment === "bottom-left" ? "底部" : "顶部"}对齐 · 等待走查`
          : "请先添加设计稿与实现截图";
  const runButtonLabel = runStatus === "running" ? "取消走查" : ["completed", "incomparable", "failed", "cancelled"].includes(runStatus) ? "重新走查" : "开始走查";

  const notify = (message, tone = "success") => {
    window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
  };
  const invalidateAuditForAlignment = () => {
    setFindings([]);
    setSelectedId(null);
    setFocusRequest(null);
    setAuditMeta(null);
    setStatusFilter("all");
    setRunStatus("draft");
    setRunError("");
    setRunProgress({ phase: "", percent: 0 });
  };
  const changeAlignment = (nextAlignment) => {
    if (runStatus === "running" || nextAlignment === alignment) return;
    if (!["top-left", "bottom-left"].includes(nextAlignment)) return;
    anchorRecognitionTokenRef.current += 1;
    setAlignment(nextAlignment);
    setAnchorFlow(idleAnchorFlow);
    invalidateAuditForAlignment();
    notify(`已改为${nextAlignment === "bottom-left" ? "底部" : "顶部"}对齐，请重新走查`);
  };
  const beginElementAlignment = () => {
    if (runStatus === "running" || !hasInputs) return;
    anchorRecognitionTokenRef.current += 1;
    setMode("side");
    setAnchorFlow({ status: "selecting-design", design: null, implementation: null });
    notify("第 1 步：请在设计稿中粗略圈住参考元素");
  };
  const selectAlignmentAnchor = async (kind, box) => {
    const expectedStatus = kind === "design" ? "selecting-design" : "selecting-implementation";
    if (anchorFlow.status !== expectedStatus) return;
    const source = sourcesRef.current[kind];
    if (!source) return;
    const requestToken = ++anchorRecognitionTokenRef.current;
    const sourceId = source.id;
    const pendingSelection = {
      ...box,
      roughBox: { ...box },
      recognized: false,
      pending: true,
      confidence: 0,
    };
    setAnchorFlow((current) => current.status === expectedStatus
      ? { ...current, status: `detecting-${kind}`, [kind]: pendingSelection }
      : current);
    notify(`正在识别${kind === "design" ? "设计稿" : "实现稿"}中的完整元素边界…`);

    let recognizedSelection;
    try {
      const placement = getComparisonPlacement(profile, kind, source);
      recognizedSelection = await recognizeElementAnchor(source, box, placement);
    } catch {
      recognizedSelection = {
        ...box,
        roughBox: { ...box },
        anchorX: box.x + box.width / 2,
        anchorY: box.y + box.height / 2,
        recognized: false,
        confidence: 0,
        method: "manual-fallback",
      };
    }
    if (anchorRecognitionTokenRef.current !== requestToken || sourcesRef.current[kind]?.id !== sourceId) return;

    const detectingStatus = `detecting-${kind}`;
    setAnchorFlow((current) => {
      if (current.status !== detectingStatus) return current;
      return kind === "design"
        ? { ...current, status: "selecting-implementation", design: recognizedSelection }
        : { ...current, status: "review", implementation: recognizedSelection };
    });
    if (kind === "design") {
      notify(recognizedSelection.recognized
        ? "已识别设计稿元素边界；请在实现稿中粗略圈住同一个元素"
        : "边界不够清晰，已保留手工范围；请继续圈选实现稿", recognizedSelection.recognized ? "success" : "warning");
    } else {
      notify(recognizedSelection.recognized
        ? "两边元素已识别，请确认蓝色边界后应用对齐"
        : "边界不够清晰，已保留手工范围；请确认或重选", recognizedSelection.recognized ? "success" : "warning");
    }
  };
  const applyElementAlignment = () => {
    if (anchorFlow.status !== "review" || !anchorFlow.design || !anchorFlow.implementation) return;
    const nextAnchors = { design: anchorFlow.design, implementation: anchorFlow.implementation };
    const nextProfile = deriveComparisonProfile(sources.design, sources.implementation, {
      alignment: "element",
      anchors: nextAnchors,
    });
    if (nextProfile.sharedAreaRatio < 0.55) {
      notify("对齐后的共同区域太少，请选择更接近的位置", "error");
      return;
    }
    if (nextProfile.exceedsSafetyLimit) {
      notify("对齐后的画布过大，请重新选择对应元素", "error");
      return;
    }
    const widthSimilarity = Math.min(anchorFlow.design.width, anchorFlow.implementation.width) /
      Math.max(anchorFlow.design.width, anchorFlow.implementation.width);
    const heightSimilarity = Math.min(anchorFlow.design.height, anchorFlow.implementation.height) /
      Math.max(anchorFlow.design.height, anchorFlow.implementation.height);
    setAnchors(nextAnchors);
    setAlignment("element");
    anchorRecognitionTokenRef.current += 1;
    setAnchorFlow(idleAnchorFlow);
    invalidateAuditForAlignment();
    notify(widthSimilarity < 0.55 || heightSimilarity < 0.55
      ? "已应用对齐，但两个选区形状差异较大，请确认选中了同一元素"
      : "已按对应元素对齐，请重新走查",
    widthSimilarity < 0.55 || heightSimilarity < 0.55 ? "warning" : "success");
  };
  const resetElementAlignment = () => {
    anchorRecognitionTokenRef.current += 1;
    setAnchorFlow({ status: "selecting-design", design: null, implementation: null });
    notify("请重新粗略圈住设计稿中的参考元素");
  };
  const cancelElementAlignment = () => {
    anchorRecognitionTokenRef.current += 1;
    setAnchorFlow(idleAnchorFlow);
    notify("已取消本次框选");
  };
  const clearElementAlignment = () => {
    anchorRecognitionTokenRef.current += 1;
    setAnchors({ design: null, implementation: null });
    setAlignment("top-left");
    setAnchorFlow(idleAnchorFlow);
    invalidateAuditForAlignment();
    notify("已清除元素对齐，恢复顶部对齐");
  };
  const beginTitleEditing = () => {
    setAuditNameDraft(auditName);
    setEditingTitle(true);
  };
  const finishTitleEditing = (commit = true) => {
    let resolvedName = auditName;
    if (commit) {
      const nextName = auditNameDraft.trim();
      if (nextName && nextName !== auditName) {
        setAuditName(nextName);
        auditNameManualRef.current = true;
        resolvedName = nextName;
      }
    }
    setAuditNameDraft(resolvedName);
    setEditingTitle(false);
  };
  const updateSelected = (patch) => {
    const activeId = selectedFinding?.id ?? selectedId;
    const nextFindings = findings.map((item) => item.id === activeId ? { ...item, ...patch } : item);
    setFindings(nextFindings);
    if (statusFilter !== "all" && patch.status && patch.status !== statusFilter) {
      setSelectedId(nextFindings.find((item) => item.status === statusFilter)?.id ?? null);
    }
    notify("已更新当前问题");
  };
  const applyStatusFilter = (nextFilter) => {
    setStatusFilter(nextFilter);
    const nextVisible = nextFilter === "all" ? findings : findings.filter((item) => item.status === nextFilter);
    if (!nextVisible.some((item) => item.id === selectedId)) setSelectedId(nextVisible[0]?.id ?? null);
  };
  const requestStatus = (status) => {
    if (status === "dismissed" || status === "ignored") return setModal({ type: "reason", status });
    updateSelected({ status });
  };
  const locateFinding = (id) => {
    const finding = findings.find((item) => item.id === id);
    if (!finding) return;
    setSelectedId(id);
    setFocusRequest({ id, bbox: finding.bbox, token: ++focusTokenRef.current });
  };
  const cancelRun = () => {
    if (runStatus !== "running") return;
    runTokenRef.current += 1;
    abortRef.current?.abort("用户取消走查");
    abortRef.current = null;
    setFindings([]);
    setSelectedId(null);
    setFocusRequest(null);
    setAuditMeta(null);
    setRunStatus("cancelled");
    setRunProgress({ phase: "", percent: 0 });
    notify("已取消本次走查");
  };

  const runAudit = async () => {
    if (runStatus === "running") return cancelRun();
    if (!canStart) return;
    const runToken = ++runTokenRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    setFindings([]);
    setSelectedId(null);
    setFocusRequest(null);
    setStatusFilter("all");
    setRunStatus("running");
    setAuditMeta(null);
    setRunError("");
    setRunProgress({ phase: "prepare", percent: 0 });
    notify("已启动本地图片走查");
    try {
      const result = await analyzeImagesInWorker({
        designFile: sources.design.file,
        implementationFile: sources.implementation.file,
        alignment,
        anchors,
        signal: controller.signal,
        onProgress: setRunProgress,
      });
      if (runTokenRef.current !== runToken) return;
      const policy = resolveComparisonPolicy(result.comparability);
      setAuditMeta({
        comparability: policy.comparability,
        coverage: result.coverage,
        profile: result.profile,
      });
      const nextFindings = policy.allowFindings ? adaptYangaoGroups(result.groups, result.profile) : [];
      setFindings(nextFindings);
      setSelectedId(nextFindings[0]?.id ?? null);
      setRunStatus(policy.runStatus);
      setRunProgress({ phase: "complete", percent: 100 });
      if (!policy.allowFindings) {
        notify(policy.notification, policy.tone);
      } else if (policy.comparability.status === "medium") {
        notify(`${policy.notification}${nextFindings.length ? `：生成 ${nextFindings.length} 个候选` : ""}`, policy.tone);
      } else {
        notify(nextFindings.length ? `走查完成：生成 ${nextFindings.length} 个待确认候选` : "走查完成：未发现超过阈值的差异");
      }
    } catch (error) {
      if (runTokenRef.current !== runToken) return;
      if (error.name === "AbortError") {
        setRunStatus("cancelled");
        return;
      }
      setRunError(error.message || "未知错误");
      setRunStatus("failed");
      setAuditMeta(null);
      notify("走查失败，输入图片已保留", "error");
    } finally {
      if (runTokenRef.current === runToken) abortRef.current = null;
    }
  };

  const commitSources = (changes) => {
    const current = sourcesRef.current;
    const next = { ...current, ...changes };
    for (const role of ["design", "implementation"]) {
      if (Object.prototype.hasOwnProperty.call(changes, role) && current[role] && changes[role] !== current[role]) disposeImageSource(current[role]);
    }
    runTokenRef.current += 1;
    anchorRecognitionTokenRef.current += 1;
    abortRef.current?.abort("输入已更改");
    abortRef.current = null;
    sourcesRef.current = next;
    setSources(next);
    if (Object.prototype.hasOwnProperty.call(changes, "design") || Object.prototype.hasOwnProperty.call(changes, "implementation")) {
      setAnchors({ design: null, implementation: null });
      setAnchorFlow(idleAnchorFlow);
      if (alignment === "element") setAlignment("top-left");
    }
    setFindings([]);
    setSelectedId(null);
    setFocusRequest(null);
    setAuditMeta(null);
    setStatusFilter("all");
    setRunStatus("draft");
    setRunError("");
    setRunProgress({ phase: "", percent: 0 });
    setInputState(next.design && next.implementation ? "ready" : "empty");
    if (!auditNameManualRef.current) {
      const nextAuditName = deriveAuditName(next);
      setAuditName(nextAuditName);
      setAuditNameDraft(nextAuditName);
    }
    return next;
  };

  const applyLocalFiles = async (selected) => {
    if (runStatus === "running") throw new Error("请先取消当前走查，再更换输入图片。");
    const roles = ["design", "implementation"].filter((role) => selected[role]);
    const importTokens = Object.fromEntries(roles.map((role) => [role, ++sourceImportTokensRef.current[role]]));
    setInputState("importing");
    const created = {};
    try {
      if (selected.design) created.design = await createImageSource(selected.design, { sourceType: "local", sourceLabel: "本地图片" });
      if (selected.implementation) created.implementation = await createImageSource(selected.implementation, { sourceType: "local", sourceLabel: "本地图片" });
      for (const role of roles) {
        if (sourceImportTokensRef.current[role] !== importTokens[role]) {
          disposeImageSource(created[role]);
          delete created[role];
        }
      }
      if (!Object.keys(created).length) return sourcesRef.current;
      const next = commitSources(created);
      if (next.design && next.implementation) notify("图片已就绪，请开始走查");
      else if (created.design) notify("设计稿已导入，请继续添加实现截图");
      else if (created.implementation) notify("实现截图已导入，请继续添加设计稿");
    } catch (error) {
      disposeImageSource(created.design);
      disposeImageSource(created.implementation);
      const stillCurrent = roles.some((role) => sourceImportTokensRef.current[role] === importTokens[role]);
      if (!stillCurrent) return sourcesRef.current;
      setInputState(sourcesRef.current.design || sourcesRef.current.implementation ? "empty" : "invalid");
      throw error;
    }
    setModal(null);
  };

  const dropLocalFile = async (role, file) => {
    if (runStatus === "running") {
      notify("请先取消当前走查，再更换输入图片。", "error");
      return;
    }
    try {
      await applyLocalFiles({ [role]: file });
    } catch (error) {
      notify(`导入失败：${error.message || "图片读取失败"}`, "error");
    }
  };

  const removeSource = (role) => {
    if (runStatus === "running" || inputState === "importing") {
      notify("请等待当前操作结束后再移除图片。", "error");
      return;
    }
    if (!sourcesRef.current[role]) return;
    sourceImportTokensRef.current[role] += 1;
    commitSources({ [role]: null });
    notify(`${role === "design" ? "设计稿" : "实现稿"}已移除`);
  };

  const importFromFigma = async ({ url, accessToken, scale }) => {
    if (runStatus === "running") throw new Error("请先取消当前走查，再更换输入图片。");
    const importToken = ++sourceImportTokensRef.current.design;
    setInputState("importing");
    try {
      const file = await importFigmaFrame({ url, accessToken, scale });
      const source = await createImageSource(file, { sourceType: "figma", sourceLabel: "Figma Frame", sourceUrl: url });
      if (sourceImportTokensRef.current.design !== importToken) {
        disposeImageSource(source);
        return;
      }
      commitSources({ design: source });
      setModal(null);
      notify("Figma Frame 已导入");
    } catch (error) {
      if (sourceImportTokensRef.current.design === importToken) setInputState(sourcesRef.current.design || sourcesRef.current.implementation ? "empty" : "invalid");
      throw error;
    }
  };

  const captureFromWeb = async ({ url, width, height, waitMs }) => {
    if (runStatus === "running") throw new Error("请先取消当前走查，再更换输入图片。");
    const importToken = ++sourceImportTokensRef.current.implementation;
    setInputState("importing");
    try {
      const file = await captureWebPage({ url, width, height, waitMs });
      const source = await createImageSource(file, { sourceType: "web", sourceLabel: "网页截图", sourceUrl: url });
      if (sourceImportTokensRef.current.implementation !== importToken) {
        disposeImageSource(source);
        return;
      }
      commitSources({ implementation: source });
      setModal(null);
      notify("网页截图已获取");
    } catch (error) {
      if (sourceImportTokensRef.current.implementation === importToken) setInputState(sourcesRef.current.design || sourcesRef.current.implementation ? "empty" : "invalid");
      throw error;
    }
  };

  const openSourcePicker = (role) => {
    if (runStatus === "running") return notify("请先取消当前走查，再更换输入", "error");
    if (anchorFlow.status !== "idle") return notify("请先完成或取消元素框选", "warning");
    setModal({ type: "upload", preferredRole: role });
  };

  return (
    <div className={`app-shell ${qaMode ? "qa-mode" : ""}`}>
      <header className="global-header"><button type="button" className="icon-button" aria-label="收起导航"><AppIcon icon={SidebarSimple} size={21} /></button><strong>UI 质量工作台</strong><span className="autosave-state"><Info size={15} weight="fill" /> V1 · 本地分析</span></header>
      <div className="app-body">
        <nav className="side-nav" aria-label="工作台导航">
          <div className="nav-group"><button type="button"><AppIcon icon={House} />工作台</button><button type="button" className="is-active"><AppIcon icon={ListChecks} weight="fill" />UI 走查</button><button type="button" className="is-disabled" title="后续版本开放" aria-disabled="true"><AppIcon icon={CursorClick} />交互体验审查<span>稍后</span></button></div>
          <div className="nav-divider" />
          <div className="nav-section-title"><span><AppIcon icon={ClockCounterClockwise} />历史记录</span><CaretDown size={14} /></div>
          <button type="button" className="history-item is-active" title={auditName}><span className="history-dot" /><span className="history-item-label">{auditName}</span></button>
          <div className="sidebar-footer"><Info size={15} /><span>V1 · 本地模式</span></div>
        </nav>
        <main className="workspace">
          <header className="workspace-toolbar">
            <div className="audit-title">{editingTitle ? <input autoFocus value={auditNameDraft} onChange={(event) => setAuditNameDraft(event.target.value)} onBlur={() => finishTitleEditing(true)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); finishTitleEditing(true); } else if (event.key === "Escape") { event.preventDefault(); finishTitleEditing(false); } }} aria-label="走查名称" /> : <strong title={auditName}>{auditName}</strong>}<button type="button" aria-label="编辑走查名称" onClick={beginTitleEditing}><AppIcon icon={PencilSimple} size={16} /></button></div>
            <div className="mode-switch" role="group" aria-label="对比模式">{modeOptions.map((option) => <button key={option.id} type="button" aria-pressed={mode === option.id} className={mode === option.id ? "is-active" : ""} onClick={() => { if (anchorFlow.status !== "idle" && option.id !== "side") return notify("请先完成或取消元素框选", "warning"); setMode(option.id); }}>{option.label}</button>)}</div>
            <div className="source-switch"><button type="button" disabled={runStatus === "running" || anchorFlow.status !== "idle"} onClick={() => setModal({ type: "figma" })}><AppIcon icon={FigmaLogo} size={15} />Figma</button><button type="button" disabled={runStatus === "running" || anchorFlow.status !== "idle"} onClick={() => setModal({ type: "capture" })}><AppIcon icon={Camera} size={15} />网页截图</button><button type="button" disabled={runStatus === "running" || anchorFlow.status !== "idle"} onClick={() => setModal({ type: "upload" })}><AppIcon icon={UploadSimple} size={15} />本地图片</button></div>
            <div className={`run-state run-state--${runStatus}`} role="status" aria-live="polite"><span />{runStateLabel}</div>
            <div className="zoom-control" aria-label="画布缩放"><button type="button" disabled={anchorFlow.status !== "idle"} onClick={() => setZoom((value) => Math.max(80, value - 10))} aria-label="缩小"><MagnifyingGlassMinus size={16} /></button><span>{zoom}%</span><button type="button" disabled={anchorFlow.status !== "idle"} onClick={() => setZoom((value) => Math.min(120, value + 10))} aria-label="放大"><MagnifyingGlassPlus size={16} /></button></div>
            <button type="button" className={`rerun-button ${runStatus === "running" ? "is-cancel" : ""}`} onClick={runAudit} disabled={runStatus !== "running" && !canStart} title={!hasInputs ? "请先添加设计稿与实现截图" : anchorFlow.status !== "idle" ? "请先完成或取消元素框选" : alignment === "element" && !profile?.anchorReady ? "请先框选两张图中的对应元素" : alignment === "element" && profile?.sharedAreaRatio < 0.55 ? "元素对齐后的共同区域太少，请重新框选" : profile?.exceedsSafetyLimit ? "归一后的比较画布超过 3200 万像素，请使用宽高比更接近的截图或先裁剪" : undefined}>{runButtonLabel}</button>
          </header>
          <div className="workspace-body">
            <div className={`center-column ${hasAuditResults && findingsCollapsed ? "is-findings-collapsed" : ""}`}>
              <section className="comparison-panel" aria-label="视觉对比画布"><ComparisonCanvas mode={mode} sources={sources} zoom={zoom} findings={findings} selectedId={selectedFinding?.id ?? selectedId} onSelect={setSelectedId} onUpload={openSourcePicker} onRemove={removeSource} onDropFile={dropLocalFile} onDropError={(role, message) => notify(`${role === "design" ? "设计稿" : "实现截图"}导入失败：${message}`, "error")} profile={profile} auditMeta={auditMeta} sourceActionsDisabled={runStatus === "running" || inputState === "importing" || anchorFlow.status !== "idle"} focusRequest={focusRequest} alignment={alignment} onAlignmentChange={changeAlignment} anchorFlow={anchorFlow} anchors={anchors} onBeginElementAlignment={beginElementAlignment} onAnchorSelect={selectAlignmentAnchor} onAnchorInvalid={(message) => notify(message, "warning")} onApplyElementAlignment={applyElementAlignment} onResetElementAlignment={resetElementAlignment} onCancelElementAlignment={cancelElementAlignment} onClearElementAlignment={clearElementAlignment} />{runStatus === "running" && <div className="analysis-overlay"><span className="spinner" /><strong>{phaseLabels[runProgress.phase] || "正在走查"}</strong><p>本地引擎处理中 · {Math.round(runProgress.percent || 0)}%</p></div>}</section>
              {hasAuditResults ? <FindingsTable findings={findings} selectedId={selectedFinding?.id ?? null} onSelect={setSelectedId} onLocate={locateFinding} statusFilter={statusFilter} setStatusFilter={applyStatusFilter} visibleColumns={visibleColumns} setVisibleColumns={setVisibleColumns} collapsed={findingsCollapsed} onToggleCollapsed={() => setFindingsCollapsed((value) => !value)} /> : <FindingsEmptyPanel runStatus={runStatus} hasInputs={hasInputs} auditMeta={auditMeta} />}
            </div>
            {hasAuditResults && selectedFinding ? <DetailPanel finding={selectedFinding} findings={displayedFindings} implementationSource={sources.implementation} comparisonProfile={profile} onSelect={setSelectedId} onChange={updateSelected} onRequestStatus={requestStatus} onExport={() => setModal({ type: "export" })} exportDisabled={false} /> : <DetailEmptyPanel runStatus={runStatus} hasInputs={hasInputs} auditMeta={auditMeta} filtered={hasAuditResults && !selectedFinding} />}
          </div>
        </main>
      </div>
      {toast && <div className={`toast toast--${toast.tone}`} role={toast.tone === "error" ? "alert" : "status"} aria-live={toast.tone === "error" ? "assertive" : "polite"}>{["error", "warning"].includes(toast.tone) ? <WarningCircle size={17} weight="fill" /> : <CheckCircle size={17} weight="fill" />}{toast.message}</div>}
      {modal?.type === "export" && hasAuditResults && <ExportDialog auditName={auditName} findings={findings} sources={sources} profile={profile} onClose={() => setModal(null)} onToast={notify} />}
      {modal?.type === "upload" && <UploadDialog sources={sources} preferredRole={modal.preferredRole} onClose={() => setModal(null)} onApply={applyLocalFiles} />}
      {modal?.type === "figma" && <FigmaDialog capabilities={capabilities} onClose={() => setModal(null)} onFallback={() => setModal({ type: "upload", preferredRole: "design" })} onImport={importFromFigma} />}
      {modal?.type === "capture" && <WebCaptureDialog capabilities={capabilities} onClose={() => setModal(null)} onFallback={() => setModal({ type: "upload", preferredRole: "implementation" })} onCapture={captureFromWeb} />}
      {modal?.type === "reason" && <ReasonDialog status={modal.status} onClose={() => setModal(null)} onSubmit={(reason) => { updateSelected({ status: modal.status, note: reason }); setModal(null); }} />}
      <span className="sr-only" aria-live="polite">{sources.design ? `设计稿 ${sources.design.name}` : "尚无设计稿"}；{sources.implementation ? `实现稿 ${sources.implementation.name}` : "尚无实现稿"}</span>
    </div>
  );
}
