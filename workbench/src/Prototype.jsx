import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowsLeftRight,
  Camera,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatCircle,
  Check,
  CheckCircle,
  ClockCounterClockwise,
  Columns,
  CursorClick,
  DotsThree,
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
  UploadSimple,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import { adaptYangaoGroups } from "./lib/findingsAdapter.js";
import { resolveComparisonPolicy } from "./lib/comparisonPolicy.js";
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

function ImageStage({ source, kind, zoom, findings = [], selectedId, onSelect, onUpload, onDropFile, onDropError, overlaySource, overlayOpacity = 0.5, regionMode = false, comparisonProfile }) {
  if (!source) return <ImageUploadPlaceholder kind={kind} onUpload={onUpload} onDropFile={onDropFile} onDropError={onDropError} />;
  const normalizedHeight = comparisonProfile
    ? kind === "design" ? comparisonProfile.designNormalizedHeight : comparisonProfile.implementationNormalizedHeight
    : source.height;
  const frameWidth = comparisonProfile?.targetWidth || source.width;
  const frameHeight = comparisonProfile?.targetHeight || source.height;
  const imageHeightPercent = `${(normalizedHeight / frameHeight) * 100}%`;
  const overlayHeightPercent = comparisonProfile && overlaySource
    ? `${(comparisonProfile.designNormalizedHeight / frameHeight) * 100}%`
    : "100%";
  return (
    <div className="image-stage">
      <figure className={`image-preview-frame ${comparisonProfile?.heightsDiffer ? "is-normalized" : ""}`} style={{ aspectRatio: `${frameWidth} / ${frameHeight}`, width: `min(100%, ${frameWidth}px)`, transform: `scale(${zoom / 100})` }}>
        <img src={source.objectUrl} alt={kind === "design" ? "设计稿预览" : "实现截图预览"} style={{ height: imageHeightPercent }} />
        {overlaySource && <img className="overlay-image" src={overlaySource.objectUrl} alt="叠加的设计稿" style={{ opacity: overlayOpacity, height: overlayHeightPercent }} />}
        {kind === "implementation" && <AnnotationLayer findings={findings} dimensions={{ width: frameWidth, height: frameHeight }} selectedId={selectedId} onSelect={onSelect} variant={regionMode ? "regions" : "outline"} />}
      </figure>
    </div>
  );
}

function ComparisonCanvas({ mode, sources, zoom, findings, selectedId, onSelect, onUpload, onDropFile, onDropError, profile, auditMeta }) {
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
  const assessmentLabel = comparability?.status === "low"
    ? "可比性低 · 已停止生成候选"
    : comparability?.status === "medium"
      ? "可比性中等 · 请人工复核"
      : null;
  const alignmentBanner = design && implementation && (
    <div className={`alignment-banner ${profile.exceedsSafetyLimit || comparisonNeedsAttention ? "is-warning" : ""}`}>
      <span title={comparability?.reasons?.[0] || "以较宽图片为目标宽度，仅等比放大较窄图片；两图顶部对齐，高度差保留为比较内容"}>
        {profile.label} · 目标宽度 {profile.targetWidth}px · 设计稿 {normalizedSourceLabel(design, profile.designNormalizedHeight, profile.designScale)} · 实现稿 {normalizedSourceLabel(implementation, profile.implementationNormalizedHeight, profile.implementationScale)}
      </span>
      <em>{profile.exceedsSafetyLimit ? "超过 3200 万像素限制" : assessmentLabel || (profile.heightsDiffer ? "顶部对齐 · 保留底部差异" : "已就绪")}</em>
    </div>
  );

  if (mode === "side") {
    return (
      <div className="comparison-content">
        {alignmentBanner}
        <div className="compare-split">
          <section className="compare-pane" aria-label="设计稿">
            <header><strong>设计稿</strong><span>{design ? `${design.sourceLabel} · ${design.width}×${design.height}` : "等待输入"}</span></header>
            <ImageStage source={design} kind="design" zoom={zoom} onUpload={() => onUpload("design")} onDropFile={(file) => onDropFile("design", file)} onDropError={onDropError} comparisonProfile={profile} />
          </section>
          <div className="sync-handle" title="同步缩放"><AppIcon icon={ArrowsLeftRight} size={16} /></div>
          <section className="compare-pane" aria-label="实现稿">
            <header><strong>实现稿</strong><span>{implementation ? `${implementation.sourceLabel} · ${implementation.width}×${implementation.height}` : "等待输入"}</span></header>
            <ImageStage source={implementation} kind="implementation" zoom={zoom} findings={findings} selectedId={selectedId} onSelect={onSelect} onUpload={() => onUpload("implementation")} onDropFile={(file) => onDropFile("implementation", file)} onDropError={onDropError} comparisonProfile={profile} />
          </section>
        </div>
      </div>
    );
  }

  const title = mode === "annotate" ? "实现稿 · 差异标注" : mode === "overlay" ? "设计稿 / 实现稿 · 透明度叠加" : "实现稿 · 差异区域";
  return (
    <div className="comparison-content">
      {alignmentBanner}
      <section className={`single-compare single-compare--${mode}`} aria-label={title}>
        <header>
          <strong>{title}</strong>
          {mode === "overlay" && design && implementation ? (
            <label className="opacity-slider">设计稿透明度 <input type="range" min="0" max="100" value={overlayOpacity} onChange={(event) => setOverlayOpacity(Number(event.target.value))} /><span>{overlayOpacity}%</span></label>
          ) : <span>{implementation ? `${implementation.width}×${implementation.height}` : "等待输入"}</span>}
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
        />
      </section>
    </div>
  );
}

function FindingsTable({ findings, selectedId, onSelect, statusFilter, setStatusFilter, visibleColumns, setVisibleColumns }) {
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
    <section className="findings-panel" aria-label="问题清单">
      <div className="table-toolbar">
        <div className="status-tabs" role="tablist" aria-label="问题状态筛选">
          {[["all", "全部"], ["pending", "待确认"], ["confirmed", "已确认"], ["dismissed", "已驳回"], ["ignored", "已忽略"]].map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={statusFilter === id} className={statusFilter === id ? "is-active" : ""} onClick={() => setStatusFilter(id)}>{label} <b>{counts[id]}</b></button>
          ))}
        </div>
        <div className="table-tools">
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
                  <label key={key}><input type="checkbox" checked={visibleColumns[key]} onChange={() => setVisibleColumns((current) => ({ ...current, [key]: !current[key] }))} />{key === "location" ? "位置" : "证据"}</label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="check-cell"><span className="fake-checkbox" /></th>
              <th>优先级 <CaretDown size={11} /></th>
              <th>问题 <CaretDown size={11} /></th>
              {visibleColumns.location && <th>位置 <CaretDown size={11} /></th>}
              {visibleColumns.evidence && <th>证据 <CaretDown size={11} /></th>}
              <th>状态 <CaretDown size={11} /></th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visibleFindings.map((finding) => (
              <tr key={finding.id} aria-selected={selectedId === finding.id} className={selectedId === finding.id ? "is-selected" : ""} onClick={() => onSelect(finding.id)}>
                <td className="check-cell"><span className={`fake-checkbox ${selectedId === finding.id ? "is-checked" : ""}`}>{selectedId === finding.id && <Check size={11} weight="bold" />}</span></td>
                <td><span className="priority-text">{finding.priority}</span></td>
                <td><button type="button" className="row-title" onClick={() => onSelect(finding.id)}>{finding.title}</button></td>
                {visibleColumns.location && <td><span className="truncate">{finding.location}</span></td>}
                {visibleColumns.evidence && <td><span className="evidence-cell">{finding.evidence} <small>({finding.delta})</small></span></td>}
                <td><StatusBadge status={finding.status} /></td>
                <td><div className="row-actions"><button type="button" aria-label="定位问题" onClick={() => onSelect(finding.id)}><AppIcon icon={Eye} size={17} /></button><button type="button" aria-label="查看备注"><AppIcon icon={ChatCircle} size={17} /></button><button type="button" aria-label="更多操作"><AppIcon icon={DotsThree} size={18} weight="bold" /></button></div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {visibleFindings.length === 0 && <div className="empty-table">当前筛选下没有问题</div>}
      </div>
      <footer className="table-footer">
        <span>共 {visibleFindings.length} 条</span>
        <div className="pagination"><button type="button" disabled><AppIcon icon={CaretLeft} size={15} /></button><button type="button" className="is-current">1</button><button type="button" disabled><AppIcon icon={CaretRight} size={15} /></button><button type="button" className="page-size">20 条/页 <CaretDown size={12} /></button></div>
      </footer>
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
      <header className="detail-header"><strong>问题详情</strong><button type="button" aria-label="收起详情"><AppIcon icon={X} size={18} /></button></header>
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
      const comparisonWidth = profile?.targetWidth || source.width;
      const comparisonHeight = profile?.targetHeight || source.height;
      const implementationHeight = profile?.implementationNormalizedHeight || source.height;
      const implementationScale = profile?.implementationScale || 1;
      const padding = Math.max(12, Math.round(Math.max(box.width, box.height) * 0.35));
      const sx = Math.max(0, box.x - padding);
      const sy = Math.max(0, box.y - padding);
      const sw = Math.max(1, Math.min(comparisonWidth - sx, box.width + padding * 2));
      const sh = Math.max(1, Math.min(comparisonHeight - sy, box.height + padding * 2));
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
      const visibleBottom = Math.min(sy + sh, implementationHeight);
      const visibleHeight = Math.max(0, visibleBottom - sy);
      if (visibleHeight > 0) {
        context.drawImage(
          image,
          sx / implementationScale,
          sy / implementationScale,
          sw / implementationScale,
          visibleHeight / implementationScale,
          dx,
          dy,
          dw,
          visibleHeight * scale,
        );
      }
      if (visibleHeight < sh) {
        context.fillStyle = "#6f7e92";
        context.font = "600 14px sans-serif";
        context.fillText("实现截图无对应像素", dx + 12, dy + visibleHeight * scale + 24);
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
      <header className="detail-header"><strong>问题详情</strong><button type="button" aria-label="收起详情"><AppIcon icon={X} size={18} /></button></header>
      <div className="detail-content">
        <div className="issue-nav"><span>问题 {currentIndex + 1} / {findings.length}</span><div><button type="button" disabled={currentIndex === 0} onClick={() => move(-1)} aria-label="上一个问题"><CaretLeft size={16} /></button><button type="button" disabled={currentIndex === findings.length - 1} onClick={() => move(1)} aria-label="下一个问题"><CaretRight size={16} /></button></div></div>
        <section className="detail-summary">
          <span className="eyebrow">{finding.priority === "—" ? "优先级待定" : finding.priority} · {severityMeta[finding.severity]}</span>
          <h2>{finding.title}</h2>
          <p>{finding.summary}</p>
          <div className="metric-row"><div><span>设计稿（估计）</span><strong title={finding.expected}>{finding.expected}</strong></div><div><span>实现稿（估计）</span><strong title={finding.actual}>{finding.actual}</strong></div><div><span>差异类型</span><strong title={finding.delta}>{finding.delta}</strong></div></div>
        </section>
        <section className="detail-section evidence-section">
          <div className="section-heading"><strong>证据</strong><span>{finding.evidence}</span></div>
          <EvidenceCrop finding={finding} source={implementationSource} profile={comparisonProfile} />
          <div className="evidence-meta"><span>{finding.evidenceLevel === "inferred" ? "启发式推断" : finding.evidenceLevel === "measured" ? "测量" : "观察"}</span><span>{finding.engineScore == null ? "差异信号未校准" : `未校准信号 ${Math.round(finding.engineScore)} · 仅用于排序`}</span></div>
        </section>
        <section className="detail-section"><span className="field-label">位置</span><p className="location-text">{finding.location}</p></section>
        <section className="detail-section form-section">
          <div className="field-grid">
            <label>严重程度<select value={finding.severity} onChange={(event) => onChange({ severity: event.target.value })}>{Object.entries(severityMeta).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label>优先级<select value={finding.priority} onChange={(event) => onChange({ priority: event.target.value })}><option value="—">待定</option><option value="P0">P0</option><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option></select></label>
          </div>
          <span className="field-label">处理结果</span>
          <div className="review-actions"><button type="button" aria-pressed={finding.status === "confirmed"} className={finding.status === "confirmed" ? "is-active" : ""} onClick={() => onRequestStatus("confirmed")}><CheckCircle size={15} />确认</button><button type="button" aria-pressed={finding.status === "dismissed"} className={finding.status === "dismissed" ? "is-active" : ""} onClick={() => onRequestStatus("dismissed")}><X size={15} />驳回</button><button type="button" aria-pressed={finding.status === "ignored"} className={finding.status === "ignored" ? "is-active" : ""} onClick={() => onRequestStatus("ignored")}><Info size={15} />忽略</button></div>
        </section>
        <section className="detail-section note-section"><label htmlFor="finding-note">开发备注</label><textarea id="finding-note" value={finding.note} maxLength={200} placeholder="补充修复建议或处理原因…" onChange={(event) => onChange({ note: event.target.value })} /><span>{finding.note.length} / 200</span></section>
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
  const comparisonWidth = profile?.targetWidth || image.naturalWidth;
  const comparisonHeight = profile?.targetHeight || image.naturalHeight;
  const implementationHeight = profile?.implementationNormalizedHeight || image.naturalHeight;
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
  context.drawImage(image, 0, 0, comparisonWidth, implementationHeight);
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
  const qaMode = new URLSearchParams(window.location.search).has("qa");
  const [findings, setFindings] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [mode, setMode] = useState("side");
  const [zoom, setZoom] = useState(100);
  const [inputState, setInputState] = useState("empty");
  const [runStatus, setRunStatus] = useState("draft");
  const [auditMeta, setAuditMeta] = useState(null);
  const [runProgress, setRunProgress] = useState({ phase: "", percent: 0 });
  const [runError, setRunError] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [visibleColumns, setVisibleColumns] = useState({ location: true, evidence: true });
  const [modal, setModal] = useState(null);
  const [toast, setToast] = useState(null);
  const [auditName, setAuditName] = useState("结算页 · 默认状态");
  const [editingTitle, setEditingTitle] = useState(false);
  const [sources, setSources] = useState({ design: null, implementation: null });
  const [capabilities, setCapabilities] = useState(null);
  const sourcesRef = useRef(sources);
  const runTokenRef = useRef(0);
  const sourceImportTokensRef = useRef({ design: 0, implementation: 0 });
  const abortRef = useRef(null);
  const toastTimerRef = useRef(null);
  const profile = useMemo(() => deriveComparisonProfile(sources.design, sources.implementation), [sources]);
  const hasInputs = Boolean(sources.design && sources.implementation);
  const hasAuditResults = runStatus === "completed" && findings.length > 0;
  const displayedFindings = statusFilter === "all" ? findings : findings.filter((item) => item.status === statusFilter);
  const selectedFinding = displayedFindings.find((item) => item.id === selectedId) ?? displayedFindings[0] ?? null;
  const canStart = hasInputs && inputState === "ready" && !profile?.exceedsSafetyLimit && runStatus !== "running";

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
        : profile?.exceedsSafetyLimit
          ? `归一画布 ${profile.targetWidth}×${profile.targetHeight} 超过 3200 万像素限制`
        : hasInputs
          ? "图片已按目标宽度归一 · 等待走查"
          : "请先添加设计稿与实现截图";
  const runButtonLabel = runStatus === "running" ? "取消走查" : ["completed", "incomparable", "failed", "cancelled"].includes(runStatus) ? "重新走查" : "开始走查";

  const notify = (message, tone = "success") => {
    window.clearTimeout(toastTimerRef.current);
    setToast({ message, tone });
    toastTimerRef.current = window.setTimeout(() => setToast(null), 2400);
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
  const cancelRun = () => {
    if (runStatus !== "running") return;
    runTokenRef.current += 1;
    abortRef.current?.abort("用户取消走查");
    abortRef.current = null;
    setFindings([]);
    setSelectedId(null);
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
      const nextFindings = policy.allowFindings ? adaptYangaoGroups(result.groups) : [];
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
      if (changes[role] && current[role] && changes[role] !== current[role]) disposeImageSource(current[role]);
    }
    runTokenRef.current += 1;
    abortRef.current?.abort("输入已更改");
    abortRef.current = null;
    sourcesRef.current = next;
    setSources(next);
    setFindings([]);
    setSelectedId(null);
    setAuditMeta(null);
    setStatusFilter("all");
    setRunStatus("draft");
    setRunError("");
    setRunProgress({ phase: "", percent: 0 });
    setInputState(next.design && next.implementation ? "ready" : "empty");
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
          <button type="button" className="history-item is-active"><span className="history-dot" />{auditName}</button>
          <div className="sidebar-footer"><Info size={15} /><span>V1 · 本地模式</span></div>
        </nav>
        <main className="workspace">
          <header className="workspace-toolbar">
            <div className="audit-title">{editingTitle ? <input autoFocus value={auditName} onChange={(event) => setAuditName(event.target.value)} onBlur={() => setEditingTitle(false)} onKeyDown={(event) => event.key === "Enter" && setEditingTitle(false)} /> : <strong>{auditName}</strong>}<button type="button" aria-label="编辑走查名称" onClick={() => setEditingTitle(true)}><AppIcon icon={PencilSimple} size={16} /></button></div>
            <div className="mode-switch" role="group" aria-label="对比模式">{modeOptions.map((option) => <button key={option.id} type="button" aria-pressed={mode === option.id} className={mode === option.id ? "is-active" : ""} onClick={() => setMode(option.id)}>{option.label}</button>)}</div>
            <div className="source-switch"><button type="button" disabled={runStatus === "running"} onClick={() => setModal({ type: "figma" })}><AppIcon icon={FigmaLogo} size={15} />Figma</button><button type="button" disabled={runStatus === "running"} onClick={() => setModal({ type: "capture" })}><AppIcon icon={Camera} size={15} />网页截图</button><button type="button" disabled={runStatus === "running"} onClick={() => setModal({ type: "upload" })}><AppIcon icon={UploadSimple} size={15} />本地图片</button></div>
            <div className={`run-state run-state--${runStatus}`} role="status" aria-live="polite"><span />{runStateLabel}</div>
            <div className="zoom-control" aria-label="画布缩放"><button type="button" onClick={() => setZoom((value) => Math.max(80, value - 10))} aria-label="缩小"><MagnifyingGlassMinus size={16} /></button><span>{zoom}%</span><button type="button" onClick={() => setZoom((value) => Math.min(120, value + 10))} aria-label="放大"><MagnifyingGlassPlus size={16} /></button></div>
            <button type="button" className={`rerun-button ${runStatus === "running" ? "is-cancel" : ""}`} onClick={runAudit} disabled={runStatus !== "running" && !canStart} title={!hasInputs ? "请先添加设计稿与实现截图" : profile?.exceedsSafetyLimit ? "归一后的比较画布超过 3200 万像素，请使用宽高比更接近的截图或先裁剪" : undefined}>{runButtonLabel}</button>
          </header>
          <div className="workspace-body">
            <div className="center-column">
              <section className="comparison-panel" aria-label="视觉对比画布"><ComparisonCanvas mode={mode} sources={sources} zoom={zoom} findings={findings} selectedId={selectedFinding?.id ?? selectedId} onSelect={setSelectedId} onUpload={openSourcePicker} onDropFile={dropLocalFile} onDropError={(role, message) => notify(`${role === "design" ? "设计稿" : "实现截图"}导入失败：${message}`, "error")} profile={profile} auditMeta={auditMeta} />{runStatus === "running" && <div className="analysis-overlay"><span className="spinner" /><strong>{phaseLabels[runProgress.phase] || "正在走查"}</strong><p>本地引擎处理中 · {Math.round(runProgress.percent || 0)}%</p></div>}</section>
              {hasAuditResults ? <FindingsTable findings={findings} selectedId={selectedFinding?.id ?? null} onSelect={setSelectedId} statusFilter={statusFilter} setStatusFilter={applyStatusFilter} visibleColumns={visibleColumns} setVisibleColumns={setVisibleColumns} /> : <FindingsEmptyPanel runStatus={runStatus} hasInputs={hasInputs} auditMeta={auditMeta} />}
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
