import { useEffect, useRef, useState } from "react";
import { ArrowSquareOut, CheckCircle, DownloadSimple, FolderOpen, FilmSlate, SpinnerGap, WarningCircle, X } from "@phosphor-icons/react";
import { cancelVideoJob, checkVideoEnvironment, chooseVideoDownloadFolder, downloadVideo, getLocalCapabilities, getVideoJobs, installVideoDependencies, listVideoDirectories, openVideoDownloadFolder, openVideoJobFolder, parseVideo } from "./lib/localBridge.js";

const ACTIVE = new Set(["parsing", "downloading", "processing"]);
const STATUS_LABELS = { downloading: "正在下载", processing: "正在合并与保存", complete: "已保存", error: "下载失败", cancelled: "已取消" };

function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function duration(value) {
  if (!Number.isFinite(value) || value < 0) return "";
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function VideoFolderDialog({ Dialog, onClose, onSaved }) {
  const [listing, setListing] = useState(null);
  const [path, setPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const request = useRef(0);

  async function browse(directory = "") {
    const id = ++request.current;
    setLoading(true);
    setError("");
    try {
      const result = await listVideoDirectories(directory);
      if (id !== request.current) return;
      setListing(result);
      setPath(result.directory);
    } catch (failure) {
      if (id === request.current) setError(failure.message);
    } finally {
      if (id === request.current) setLoading(false);
    }
  }
  useEffect(() => { browse(); return () => { request.current += 1; }; }, []);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const result = await chooseVideoDownloadFolder(listing.directory);
      onSaved(result);
    } catch (failure) {
      setError(failure.message);
      setSaving(false);
    }
  }

  return <Dialog title="更改保存位置" size="large" onClose={saving ? null : onClose}>
    <div className="dialog-body video-folder-browser">
      <p>选择本机文件夹。更改仅用于新任务，已有视频保留在原位置。</p>
      <div className="video-folder-shortcuts">
        {listing?.shortcuts.map((item) => <button key={item.directory} disabled={loading || saving}
          onClick={() => browse(item.directory)}><FolderOpen size={16} />{item.name}</button>)}
      </div>
      <form className="video-folder-path" onSubmit={(event) => { event.preventDefault(); browse(path); }}>
        <label className="sr-only" htmlFor="video-folder-path">文件夹路径</label>
        <input id="video-folder-path" value={path} onChange={(event) => setPath(event.target.value)} disabled={loading || saving} placeholder="输入文件夹的完整路径" />
        <button disabled={loading || saving || !path}>前往</button>
      </form>
      <button className="video-folder-parent" disabled={loading || saving || !listing || listing.directory === listing.parent}
        onClick={() => browse(listing.parent)}>上一级文件夹</button>
      <div className="video-folder-list" aria-label="可选文件夹" aria-busy={loading}>
        {loading ? <p role="status">正在读取文件夹…</p> : listing?.folders.map((item) => <button key={item.directory}
          disabled={saving} onClick={() => browse(item.directory)}><FolderOpen size={18} />{item.name}</button>)}
        {!loading && listing?.folders.length === 0 && <p>此目录中没有子文件夹，可以直接选择当前文件夹。</p>}
      </div>
      {listing?.truncated && <p>仅显示前 500 个文件夹，可输入完整路径前往。</p>}
      {listing && <p className="video-folder-selected">将保存到：{listing.directory}</p>}
      {error && <p className="dialog-error" role="alert">{error}</p>}
    </div>
    <footer className="dialog-actions">
      <button onClick={onClose} disabled={saving}>取消</button>
      <button className="primary-button" onClick={save} disabled={loading || saving || !listing || path !== listing.directory}>
        {saving ? "正在保存…" : "选择此文件夹"}
      </button>
    </footer>
  </Dialog>;
}

export function VideoDownloaderPage({ url, onUrlChange, Dialog }) {
  const [status, setStatus] = useState(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [connectionError, setConnectionError] = useState("");
  const [jobs, setJobs] = useState([]);
  const [quality, setQuality] = useState("best");
  const [choosingFolder, setChoosingFolder] = useState(false);
  const parsed = jobs.find((job) => job.kind === "parse" && job.url === url.trim());
  const parsing = parsed?.status === "parsing";
  const video = parsed?.status === "ready" ? parsed.video : null;
  const downloads = jobs.filter((job) => job.kind === "download");
  const selectedQuality = video?.qualities.some((item) => item.id === quality) ? quality : "best";
  const alreadyDownloading = downloads.some((job) => job.url === url.trim() && ACTIVE.has(job.status));
  const installing = status?.installation?.status === "installing";

  async function refresh(signal) {
    setChecking(true);
    try {
      const capabilities = await getLocalCapabilities({ signal });
      if (!signal?.aborted) {
        setStatus(capabilities.videoDownloader || null);
        setConnectionError("");
      }
      return Boolean(capabilities.videoDownloader);
    } catch (error) {
      if (error.name !== "AbortError") {
        setConnectionError(error.message);
        setStatus(null);
      }
      return false;
    } finally {
      if (!signal?.aborted) setChecking(false);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    let timer;
    async function poll() {
      let connected = false;
      try {
        const result = await getVideoJobs({ signal: controller.signal });
        if (!controller.signal.aborted) {
          setJobs(result.jobs);
          if (result.videoDownloader) setStatus(result.videoDownloader);
        }
        connected = true;
      } catch (error) {
        if (error.name !== "AbortError") {
          setConnectionError(error.message);
          setStatus(null);
        }
      } finally {
        if (connected && !controller.signal.aborted) timer = setTimeout(poll, 1500);
      }
    }
    refresh(controller.signal).then((connected) => {
      if (connected && !controller.signal.aborted) poll();
    });
    return () => { controller.abort(); clearTimeout(timer); };
  }, []);

  async function run(action) {
    setBusy(true);
    setMessage(null);
    try {
      const result = await action();
      if (result.videoDownloader) setStatus(result.videoDownloader);
      if (result.job) setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)]);
      if (result.message) setMessage({ error: false, text: result.message });
    } catch (error) {
      setMessage({ error: true, text: error.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="tool-sharing-workspace">
      <div className="tool-sharing-content video-downloader-content">
        <header className="tool-sharing-header">
          <div>
            <span className="tool-sharing-eyebrow"><DownloadSimple size={17} weight="fill" />视频下载</span>
            <h1>把视频素材保存到本地</h1>
            <p>粘贴 YouTube、Instagram、X 等平台的链接，直接选择清晰度，下载到你的磁盘。</p>
          </div>
          <span className={`video-app-status ${status?.ready ? "is-ready" : ""}`}>
            {status?.ready ? <CheckCircle size={18} weight="fill" /> : <WarningCircle size={18} />}
            {checking ? "正在检查" : installing ? "正在安装依赖" : status?.ready ? "已就绪" : status?.directoryAvailable === false ? "保存目录不可用" : status ? "依赖待配置" : "未连接"}
          </span>
        </header>

        {!status && !checking && <section className="video-download-card" aria-labelledby="video-connect-heading">
          <h2 id="video-connect-heading">先启动本地下载服务</h2>
          <p className="video-download-hint">这个页面需要本机服务才能解析和保存视频。静态网页或开发预览只会显示界面。</p>
          {connectionError && <p className="video-download-message is-error" role="alert">{connectionError}</p>}
          <div className="video-dependency-help">
            <p><strong>Windows：</strong>在解压后的项目目录或已安装的 Skill 目录，双击 <code>start-windows.cmd</code>；也可在该目录运行：</p>
            <code>py -3 start.py</code>
            <p><strong>macOS：</strong>在同一目录运行：</p>
            <code>python3 start.py</code>
            <p>启动器会检查依赖并打开正确的页面。请保留运行服务的窗口。若由 Codex 安装，可让它“更新此项目并运行 start.py，打开 ready 事件返回的地址，确认视频下载已连接”。</p>
          </div>
          <button onClick={() => window.location.reload()}>服务已启动，重新连接</button>
        </section>}

        <section className="video-download-card" aria-labelledby="video-link-heading">
          <h2 id="video-link-heading">视频链接</h2>
          <form noValidate onSubmit={(event) => { event.preventDefault(); if (url.trim()) run(() => parseVideo(url.trim())); }}>
            <label className="sr-only" htmlFor="video-download-url">粘贴视频链接</label>
            <div className="video-input-row">
              <input id="video-download-url" type="url" value={url} onChange={(event) => onUrlChange(event.target.value)}
                placeholder="每次粘贴一条视频链接，例如 https://www.youtube.com/watch?v=…"
                autoComplete="off" spellCheck={false} required disabled={busy} />
              <button type="submit" className="primary-button" disabled={busy || checking || !status?.ready || !url.trim() || parsing}>
                {parsing ? <SpinnerGap className="video-spinner" size={17} /> : <FilmSlate size={17} />}
                {parsing ? "解析中…" : "解析视频"}
              </button>
            </div>
          </form>
          {parsing && <div className="video-parse-state" role="status">
            <span>正在获取视频信息和可用清晰度…</span>
            <button disabled={busy} onClick={() => run(() => cancelVideoJob(parsed.id))}>取消解析</button>
          </div>}
          {parsed?.status === "error" && <p className="video-download-message is-error" role="alert">{parsed.error}</p>}
          {parsed?.status === "cancelled" && <p className="video-download-hint">解析已取消，可重新解析。</p>}
          {video && <div className="video-result">
            <div className="video-result-summary">
              <span className="video-result-icon"><FilmSlate size={28} /></span>
              <div><h3>{video.title}</h3><p>{[video.source, video.uploader, duration(video.duration)].filter(Boolean).join(" · ")}</p></div>
            </div>
            <div className="video-quality-row">
              <label htmlFor="video-quality">清晰度</label>
              <select id="video-quality" value={selectedQuality} onChange={(event) => setQuality(event.target.value)} disabled={busy}>
                {video.qualities.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
              <button className="primary-button" disabled={busy || !status?.ready || alreadyDownloading}
                onClick={() => run(() => downloadVideo(parsed.id, selectedQuality))}>
                <DownloadSimple size={17} />{alreadyDownloading ? "正在下载" : "下载到磁盘"}
              </button>
            </div>
            <p className="video-download-hint">自动保存为兼容常用播放器的 MP4；必要时会转换编码，处理进度显示在下方。</p>
          </div>}
          {message && <p className={`video-download-message ${message.error ? "is-error" : ""}`} role={message.error ? "alert" : "status"}>{message.text}</p>}
        </section>

        {downloads.length > 0 && <section className="video-download-card" aria-labelledby="video-tasks-heading">
          <div className="video-card-heading"><h2 id="video-tasks-heading">下载任务</h2><span className="video-task-count">{downloads.length} 个任务</span></div>
          <div className="video-tasks">
            {downloads.map((job) => <article className={`video-task ${job.status === "error" ? "is-error" : ""}`} key={job.id}>
              <div className="video-task-header">
                <div><h3>{job.title}</h3><p>{job.quality} · {STATUS_LABELS[job.status] || job.status}</p></div>
                {ACTIVE.has(job.status) && <button disabled={busy} aria-label={`取消下载：${job.title}`} onClick={() => run(() => cancelVideoJob(job.id))}><X size={15} />取消</button>}
                {job.status === "complete" && <div className="video-task-actions">
                  <CheckCircle size={22} className="video-complete-icon" weight="fill" />
                  <button disabled={busy} aria-label={`打开文件夹：${job.title}`} onClick={() => run(() => openVideoJobFolder(job.id))}>
                    <FolderOpen size={17} />打开文件夹
                  </button>
                </div>}
              </div>
              {ACTIVE.has(job.status) && <>
                <progress max="100" value={job.percent ?? undefined} aria-label={`${job.title}下载进度`} />
                <p className="video-task-progress">{job.status === "processing" ? `${job.stage || "正在合并音视频并保存文件"}…${job.percent != null ? ` ${job.percent.toFixed(1)}%` : ""}` : [
                  job.percent != null ? `当前文件 ${job.percent.toFixed(1)}%` : "正在连接视频来源…",
                  job.speed > 0 ? `${bytes(job.speed)}/s` : "",
                  job.eta > 0 ? `预计剩余 ${duration(job.eta)}` : "",
                ].filter(Boolean).join(" · ")}</p>
              </>}
              {job.status === "complete" && <p className="video-task-file">{job.filename} · {bytes(job.bytes)}<br />{job.directory}</p>}
              {job.status === "error" && <p className="video-download-message is-error" role="alert">{job.error}</p>}
              {job.status === "cancelled" && <p className="video-download-hint">任务已取消，重新下载时可继续已有的部分文件。</p>}
            </article>)}
          </div>
          <p className="video-download-hint">切换工具箱模块不会中断任务；保持本地工具箱服务运行，直到下载完成。</p>
        </section>}

        <section className="video-download-card" aria-labelledby="video-folder-heading">
          <div className="video-card-heading">
            <div><h2 id="video-folder-heading">保存位置</h2><p>设置仅保存在本机，更改后用于新任务</p></div>
            <button type="button" disabled={checking || busy || !status || installing} onClick={() => run(checkVideoEnvironment)}>重新检测</button>
          </div>
          <div className="video-download-folder">
            <div><p>{status?.downloadsDirectory || "尚未连接本地下载服务"}</p></div>
            <div className="video-folder-actions">
              <button type="button" disabled={busy || checking || !status?.canChooseDirectory} onClick={() => setChoosingFolder(true)}>更改保存位置</button>
              <button type="button" disabled={busy || !status?.directoryAvailable} onClick={() => run(openVideoDownloadFolder)}><FolderOpen size={17} />打开文件夹</button>
            </div>
          </div>
          {status?.setupError && <p className="video-download-message is-error" role="alert">{status.setupError}</p>}
          {status?.directoryAvailable === false && <p className="video-download-message is-error" role="status">保存目录暂时不可用，请连接保存磁盘并确认可以写入，然后重新检测。</p>}
          {!status && !checking && <p className="video-download-hint">连接本地服务后，会显示这台电脑的保存目录和依赖状态。</p>}
          {status && <details className="video-environment" open={status.dependencies.some((dependency) => !dependency.available) ? true : undefined}>
            <summary>本地下载环境</summary>
            <p className="video-download-hint">首次启动会自动安装缺少的依赖；已有可用程序会继续复用。</p>
            <div className="video-dependencies" aria-label="下载依赖状态">
              {status?.dependencies.map((dependency) => <span key={dependency.name} title={dependency.version || dependency.error}>
                {dependency.available ? <CheckCircle size={15} /> : <WarningCircle size={15} />}
                {dependency.name} · {dependency.available ? "已配置" : "待配置"}
              </span>)}
            </div>
            {installing && <div className="video-dependency-help" role="status">
              <p><SpinnerGap size={16} className="video-spinner" /> {status.installation.message}{status.installation.percent != null ? ` · ${status.installation.percent}%` : ""}</p>
              <progress max="100" value={status.installation.percent ?? undefined} aria-label="当前依赖下载进度" />
              <p>首次安装需要联网，请保持工具箱运行。安装完成后会自动更新状态。</p>
            </div>}
            {status.installation?.status === "complete" && <p className="video-download-hint" role="status">{status.installation.message}</p>}
            {status?.dependencies.some((dependency) => !dependency.available) && <div className="video-dependency-help">
              {!installing && <>
                {status.installation?.errors?.length > 0 && <p className="video-download-message is-error" role="alert">{status.installation.errors.join("\n")}</p>}
                <button className="primary-button" disabled={busy || Boolean(status.setupError)} onClick={() => run(installVideoDependencies)}>
                  <DownloadSimple size={17} />{status.installation?.status === "error" ? "重试安装依赖" : "自动安装缺少的依赖"}
                </button>
                <p>程序安装在本机工具箱配置目录中，无需预先安装 Homebrew；不会更改视频保存位置。</p>
              </>}
              <details><summary>手动安装方式</summary>
              {status.platform === "win32" ? <>
                <p>Windows 用户可在终端安装缺少的程序（需要 WinGet）：</p>
                <code>{"winget install --id yt-dlp.yt-dlp --exact\nwinget install --id DenoLand.Deno --exact\nwinget install --id Gyan.FFmpeg --exact"}</code>
                <p>安装后重新启动工具箱，再点击“重新检测”。若没有 WinGet，可从官方项目下载程序，加入 PATH 或放到本机设置目录下的 bin 文件夹。</p>
              </> : <>
                <p>缺少依赖时，请先安装对应程序。已使用 Homebrew 的 macOS 用户可运行：</p>
                <code>brew install yt-dlp deno ffmpeg</code>
              </>}
              <p>FFprobe 随 FFmpeg 一起安装。手动安装后点击“重新检测”。</p>
              <a href="https://github.com/denoland/deno" target="_blank" rel="noreferrer">Deno</a>
              {" · "}<a href="https://ffmpeg.org/download.html" target="_blank" rel="noreferrer">FFmpeg</a>
              </details>
            </div>}
            <a className="video-project-link" href="https://github.com/yt-dlp/yt-dlp" target="_blank" rel="noreferrer">查看开源下载引擎<ArrowSquareOut size={14} /></a>
          </details>}
          <p className="video-download-hint">当前直接下载公开可访问的视频。需要登录、地区受限或来源平台限制的视频，解析时会显示具体原因。</p>
        </section>
      </div>
      {choosingFolder && <VideoFolderDialog Dialog={Dialog} onClose={() => setChoosingFolder(false)} onSaved={(result) => {
        setStatus(result.videoDownloader);
        setMessage({ error: false, text: result.message });
        setChoosingFolder(false);
      }} />}
    </main>
  );
}
