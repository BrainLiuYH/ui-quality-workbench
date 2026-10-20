#!/usr/bin/env python3
"""Verify and serve Design Toolbox with a loopback-only source bridge."""

from __future__ import annotations

import argparse
import hashlib
import html
import importlib.util
import http.client
import http.server
import json
import math
import mimetypes
import os
import plistlib
import posixpath
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from datetime import datetime, timezone
from email.utils import format_datetime
from pathlib import Path
from typing import BinaryIO, Dict, Optional, Tuple
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, quote, unquote, urlencode, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


HOST = "127.0.0.1"
SKILL_DIR = Path(__file__).resolve().parent.parent
BUNDLED_WEB_ROOT = SKILL_DIR / "assets" / "workbench"
SOURCE_WEB_ROOT = SKILL_DIR / "dist" / "client"
WEB_ROOT = BUNDLED_WEB_ROOT if BUNDLED_WEB_ROOT.is_dir() else SOURCE_WEB_ROOT
ASSET_REFERENCE = re.compile(r"(?:src|href)=[\"'](/[^\"']+)[\"']")
FIGMA_FILE_KEY = re.compile(r"^[A-Za-z0-9_-]{6,128}$")
FIGMA_NODE_ID = re.compile(r"^\d+:\d+$")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
PNG_IEND = b"\x00\x00\x00\x00IEND\xaeB\x60\x82"

TOKEN_HEADER = "X-Workbench-Token"
MAX_JSON_BODY_BYTES = 32 * 1024
MAX_FIGMA_JSON_BYTES = 2 * 1024 * 1024
MAX_PNG_BYTES = 50 * 1024 * 1024
FIGMA_TIMEOUT_SECONDS = 20
REQUEST_IO_TIMEOUT_SECONDS = 15
CAPTURE_LIMITS = {
    "width": {"min": 320, "max": 3840},
    "height": {"min": 200, "max": 10000},
    "waitMs": {"min": 0, "max": 30000},
    "maxPixels": 25_000_000,
    "timeoutSeconds": 50,
}
def video_config_path() -> Path:
    legacy = Path.home() / "Library/Application Support/DesignToolbox/video-downloader.json"
    if sys.platform == "darwin" or legacy.is_file():
        return legacy
    if sys.platform == "win32":
        base = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")
    return base / "DesignToolbox/video-downloader.json"


YDL_CONFIG_PATH = video_config_path()
VIDEO_CONFIG_LOCK = threading.RLock()
VIDEO_DEPENDENCY_CHECKS: Dict[str, dict] = {}
VIDEO_SETUP_ERROR = ""
VIDEO_INSTALL_LOCK = threading.Lock()
VIDEO_INSTALL_STATE = {"status": "idle", "message": "", "percent": None, "errors": []}


def dependency_installer():
    spec = importlib.util.spec_from_file_location(
        "video_dependency_installer", Path(__file__).with_name("install_video_dependencies.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class RequestError(Exception):
    """An expected request failure that can be returned without a traceback."""

    def __init__(self, status: int, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def emit(payload: Dict[str, object], *, stream=sys.stdout) -> None:
    print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), file=stream, flush=True)


def is_within_root(candidate: Path, root: Path) -> bool:
    return candidate == root or root in candidate.parents


def bundle_manifest(root: Path) -> Tuple[Dict[str, object], list[str]]:
    errors: list[str] = []
    if root.is_symlink():
        errors.append("The bundle root must not be a symbolic link")
    index = root / "index.html"
    if not index.is_file() or index.stat().st_size == 0:
        errors.append("Missing workbench index.html")
        return {"files": 0, "bytes": 0, "sha256": None}, errors

    try:
        html = index.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        errors.append("Cannot read index.html: {}".format(exc))
        return {"files": 0, "bytes": 0, "sha256": None}, errors

    for reference in ASSET_REFERENCE.findall(html):
        referenced_path = (root / reference.lstrip("/")).resolve()
        if not is_within_root(referenced_path, root.resolve()) or not referenced_path.is_file():
            errors.append("Missing referenced asset: {}".format(reference))

    digest = hashlib.sha256()
    file_count = 0
    byte_count = 0
    try:
        all_paths = sorted(root.rglob("*"))
        for path in all_paths:
            if path.is_symlink():
                errors.append("Symbolic links are not allowed: {}".format(path.relative_to(root).as_posix()))
        paths = [path for path in all_paths if path.is_file() and not path.is_symlink()]
        for path in paths:
            relative = path.relative_to(root).as_posix()
            size = path.stat().st_size
            if size == 0:
                errors.append("Empty bundle file: {}".format(relative))
            digest.update(relative.encode("utf-8"))
            digest.update(b"\0")
            with path.open("rb") as handle:
                for block in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(block)
                    byte_count += len(block)
            file_count += 1
    except OSError as exc:
        errors.append("Cannot inspect bundle: {}".format(exc))

    return {
        "files": file_count,
        "bytes": byte_count,
        "sha256": digest.hexdigest() if file_count else None,
    }, errors


def parse_figma_url(raw_url: object) -> Tuple[str, str]:
    """Return (file_key, canonical_node_id) from a Figma design/file URL."""
    if not isinstance(raw_url, str) or not raw_url.strip() or len(raw_url) > 4096:
        raise RequestError(400, "url must be a Figma design/file URL")
    normalized_url = raw_url.strip()
    if any(ord(character) < 32 or ord(character) == 127 for character in normalized_url):
        raise RequestError(400, "Figma URL contains control characters")
    try:
        parsed = urlsplit(normalized_url)
    except ValueError as exc:
        raise RequestError(400, "Invalid Figma URL") from exc
    hostname = (parsed.hostname or "").lower().rstrip(".")
    if parsed.scheme != "https" or hostname not in {"figma.com", "www.figma.com"}:
        raise RequestError(400, "Only https://www.figma.com design/file URLs are supported")
    try:
        supplied_port = parsed.port
    except ValueError as exc:
        raise RequestError(400, "Invalid Figma URL authority") from exc
    if parsed.username or parsed.password or supplied_port not in (None, 443):
        raise RequestError(400, "Invalid Figma URL authority")

    segments = [unquote(segment) for segment in parsed.path.split("/") if segment]
    if len(segments) < 2 or segments[0] not in {"design", "file"}:
        raise RequestError(400, "Figma URL path must start with /design/ or /file/")
    file_key = segments[1]
    if not FIGMA_FILE_KEY.fullmatch(file_key):
        raise RequestError(400, "Invalid Figma file key")

    node_values = parse_qs(parsed.query, keep_blank_values=True).get("node-id", [])
    if len(node_values) != 1 or not node_values[0]:
        raise RequestError(400, "Figma URL must include exactly one node-id")
    raw_node_id = node_values[0]
    node_id = raw_node_id if ":" in raw_node_id else raw_node_id.replace("-", ":")
    if not FIGMA_NODE_ID.fullmatch(node_id):
        raise RequestError(400, "node-id must identify one Figma node")
    return file_key, node_id


def _read_limited(stream: BinaryIO, limit: int) -> bytes:
    try:
        payload = stream.read(limit + 1)
    except http.client.HTTPException as exc:
        raise RequestError(502, "Upstream response ended unexpectedly") from exc
    if len(payload) > limit:
        raise RequestError(502, "Upstream response exceeded the size limit")
    return payload


def _figma_image_host_allowed(raw_url: str) -> bool:
    try:
        parsed = urlsplit(raw_url)
    except ValueError:
        return False
    hostname = (parsed.hostname or "").lower().rstrip(".")
    try:
        supplied_port = parsed.port
    except ValueError:
        return False
    suffixes = ("figma.com", "figmausercontent.com", "amazonaws.com")
    return (
        parsed.scheme == "https"
        and supplied_port in (None, 443)
        and not parsed.username
        and not parsed.password
        and any(hostname == suffix or hostname.endswith("." + suffix) for suffix in suffixes)
    )


class _RejectRedirects(HTTPRedirectHandler):
    def redirect_request(self, _request, _file_pointer, _code, _message, _headers, _new_url):
        return None


class _FigmaImageRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, file_pointer, code, message, headers, new_url):
        absolute_url = urljoin(request.full_url, new_url)
        if not _figma_image_host_allowed(absolute_url):
            raise RequestError(502, "Figma image redirected to an unexpected host")
        redirected = super().redirect_request(
            request, file_pointer, code, message, headers, absolute_url
        )
        if redirected is not None:
            redirected.remove_header("X-Figma-Token")
        return redirected


def _open_figma_metadata(request: Request, timeout: int):
    return build_opener(_RejectRedirects()).open(request, timeout=timeout)


def _open_figma_image(request: Request, timeout: int):
    return build_opener(_FigmaImageRedirects()).open(request, timeout=timeout)


def _png_complete(payload: bytes) -> bool:
    return payload.startswith(PNG_SIGNATURE) and payload.endswith(PNG_IEND)


def _figma_token_valid(token: str) -> bool:
    return bool(token) and token.isascii() and not any(
        ord(character) < 32 or ord(character) == 127 for character in token
    )


def fetch_figma_png(file_key: str, node_id: str, token: str, scale: float) -> bytes:
    if not _figma_token_valid(token):
        raise RequestError(400, "Figma access token contains unsupported characters")
    query = urlencode({"ids": node_id, "format": "png", "scale": scale})
    endpoint = "https://api.figma.com/v1/images/{}?{}".format(quote(file_key, safe=""), query)
    metadata_request = Request(
        endpoint,
        headers={
            "Accept": "application/json",
            "User-Agent": "UIQualityWorkbench/0.2",
            "X-Figma-Token": token,
        },
    )
    try:
        with _open_figma_metadata(metadata_request, FIGMA_TIMEOUT_SECONDS) as response:
            metadata_bytes = _read_limited(response, MAX_FIGMA_JSON_BYTES)
        metadata = json.loads(metadata_bytes.decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 401:
            raise RequestError(401, "Figma rejected the access token") from exc
        if exc.code == 403:
            raise RequestError(403, "Figma token cannot access this file or lacks file_content:read") from exc
        if exc.code == 429:
            raise RequestError(429, "Figma rate limit reached; try again later") from exc
        raise RequestError(502, "Figma image request failed with HTTP {}".format(exc.code)) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise RequestError(504, "Figma image request timed out or could not connect") from exc
    except (UnicodeError, json.JSONDecodeError, TypeError) as exc:
        raise RequestError(502, "Figma returned an invalid image response") from exc

    if not isinstance(metadata, dict):
        raise RequestError(502, "Figma returned an invalid image response")
    if metadata.get("err"):
        raise RequestError(422, "Figma could not render the requested node")
    images = metadata.get("images")
    image_url = images.get(node_id) if isinstance(images, dict) else None
    if not isinstance(image_url, str) or not image_url:
        raise RequestError(422, "Figma did not return a PNG for the requested node")
    if not _figma_image_host_allowed(image_url):
        raise RequestError(502, "Figma returned an unexpected image host")

    try:
        image_request = Request(
            image_url,
            headers={"Accept": "image/png", "User-Agent": "UIQualityWorkbench/0.2"},
        )
    except (TypeError, ValueError) as exc:
        raise RequestError(502, "Figma returned an invalid image URL") from exc
    try:
        with _open_figma_image(image_request, FIGMA_TIMEOUT_SECONDS) as response:
            final_url = response.geturl()
            if not _figma_image_host_allowed(final_url):
                raise RequestError(502, "Figma image redirected to an unexpected host")
            png = _read_limited(response, MAX_PNG_BYTES)
    except RequestError:
        raise
    except HTTPError as exc:
        raise RequestError(502, "Figma PNG download failed with HTTP {}".format(exc.code)) from exc
    except (URLError, TimeoutError, OSError) as exc:
        raise RequestError(504, "Figma PNG download timed out or could not connect") from exc
    if not _png_complete(png):
        raise RequestError(502, "Figma response was not a PNG image")
    return png


BROWSER_CANDIDATES = (
    ("chrome", "Google Chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "google-chrome"),
    ("chrome-beta", "Google Chrome Beta", "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta", "google-chrome-beta"),
    ("chromium", "Chromium", "/Applications/Chromium.app/Contents/MacOS/Chromium", "chromium"),
    ("edge", "Microsoft Edge", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "microsoft-edge"),
    ("edge-beta", "Microsoft Edge Beta", "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta", "microsoft-edge-beta"),
)


def discover_browsers() -> list[Dict[str, str]]:
    """Find supported Chromium-family executables without launching them."""
    discovered: list[Dict[str, str]] = []
    seen: set[str] = set()
    for browser_id, name, application_path, command in BROWSER_CANDIDATES:
        candidates = [application_path]
        command_path = shutil.which(command)
        if command_path:
            candidates.append(command_path)
        if browser_id == "chromium":
            fallback_path = shutil.which("chromium-browser")
            if fallback_path:
                candidates.append(fallback_path)
        if browser_id == "edge":
            fallback_path = shutil.which("msedge")
            if fallback_path:
                candidates.append(fallback_path)
        for candidate in candidates:
            path = Path(candidate)
            if not path.is_file() or not os.access(path, os.X_OK):
                continue
            resolved = str(path.resolve())
            if resolved in seen:
                continue
            discovered.append({"id": browser_id, "name": name, "path": resolved})
            seen.add(resolved)
            break
    return discovered


def validate_capture_payload(payload: object) -> Tuple[str, int, int, int]:
    if not isinstance(payload, dict):
        raise RequestError(400, "JSON body must be an object")
    raw_url = payload.get("url")
    if not isinstance(raw_url, str) or not raw_url.strip() or len(raw_url) > 4096:
        raise RequestError(400, "url must be an http or https URL")
    url = raw_url.strip()
    if any(ord(character) < 32 or ord(character) == 127 for character in url):
        raise RequestError(400, "URL contains control characters")
    try:
        parsed = urlsplit(url)
    except ValueError as exc:
        raise RequestError(400, "Invalid URL") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RequestError(400, "url must be an http or https URL")
    if parsed.username or parsed.password:
        raise RequestError(400, "URL credentials are not supported")
    try:
        parsed.hostname.encode("idna")
    except UnicodeError as exc:
        raise RequestError(400, "URL contains an invalid hostname") from exc
    try:
        parsed.port
    except ValueError as exc:
        raise RequestError(400, "URL contains an invalid port") from exc

    width = payload.get("width", 1440)
    height = payload.get("height", 1024)
    wait_ms = payload.get("waitMs", 1000)
    for name, value in (("width", width), ("height", height), ("waitMs", wait_ms)):
        if isinstance(value, bool) or not isinstance(value, int):
            raise RequestError(400, "{} must be an integer".format(name))
        limits = CAPTURE_LIMITS[name]
        if value < limits["min"] or value > limits["max"]:
            raise RequestError(400, "{} must be between {} and {}".format(name, limits["min"], limits["max"]))
    if width * height > CAPTURE_LIMITS["maxPixels"]:
        raise RequestError(400, "width × height exceeds the capture pixel limit")
    return url, width, height, wait_ms


def _process_group_exists(process: subprocess.Popen) -> bool:
    if os.name != "posix":
        return process.poll() is None
    try:
        os.killpg(process.pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


def _stop_browser_process(process: subprocess.Popen) -> None:
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        except OSError:
            try:
                process.terminate()
            except OSError:
                pass
        try:
            process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        if _process_group_exists(process):
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass
    elif process.poll() is None:
        if sys.platform == "win32":
            # yt-dlp can own an FFmpeg child: stopping just the parent leaves it writing.
            try:
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                               stderr=subprocess.DEVNULL, timeout=10, check=False)
            except (OSError, subprocess.SubprocessError):
                pass
        try:
            process.terminate()
            process.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            try:
                process.kill()
            except OSError:
                pass
    try:
        process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try:
            process.kill()
            process.wait(timeout=1)
        except (OSError, subprocess.TimeoutExpired):
            pass


class BrowserProcessRegistry:
    """Track capture processes so service shutdown cannot orphan a browser."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._processes: set[subprocess.Popen] = set()
        self._closing = False

    def register(self, process: subprocess.Popen) -> bool:
        with self._lock:
            if self._closing:
                return False
            self._processes.add(process)
            return True

    def unregister(self, process: subprocess.Popen) -> None:
        with self._lock:
            self._processes.discard(process)

    def close(self) -> None:
        with self._lock:
            self._closing = True
            processes = list(self._processes)
            self._processes.clear()
        for process in processes:
            _stop_browser_process(process)


def _png_file_complete(path: Path) -> bool:
    try:
        size = path.stat().st_size
        if size < len(PNG_SIGNATURE) + len(PNG_IEND):
            return False
        with path.open("rb") as handle:
            if handle.read(len(PNG_SIGNATURE)) != PNG_SIGNATURE:
                return False
            handle.seek(-len(PNG_IEND), os.SEEK_END)
            return handle.read(len(PNG_IEND)) == PNG_IEND
    except OSError:
        return False


def capture_webpage(
    url: str,
    width: int,
    height: int,
    wait_ms: int,
    process_registry: Optional[BrowserProcessRegistry] = None,
) -> Tuple[bytes, Dict[str, str]]:
    browsers = discover_browsers()
    if not browsers:
        raise RequestError(503, "No supported Chrome, Chromium, or Edge browser was found")
    browser = browsers[0]
    timeout = min(CAPTURE_LIMITS["timeoutSeconds"], 15 + int(wait_ms / 1000))
    with tempfile.TemporaryDirectory(prefix="ui-workbench-capture-") as temp_dir:
        screenshot_path = Path(temp_dir) / "capture.png"
        profile_path = Path(temp_dir) / "profile"
        command = [
            browser["path"],
            "--headless=new",
            "--disable-component-update",
            "--disable-gpu",
            "--disable-extensions",
            "--hide-scrollbars",
            "--no-first-run",
            "--no-default-browser-check",
            "--run-all-compositor-stages-before-draw",
            "--force-device-scale-factor=1",
            "--user-data-dir={}".format(profile_path),
            "--window-size={},{}".format(width, height),
            "--screenshot={}".format(screenshot_path),
        ]
        if wait_ms:
            command.append("--virtual-time-budget={}".format(wait_ms))
        command.append(url)
        process: Optional[subprocess.Popen] = None
        try:
            process = subprocess.Popen(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=os.name == "posix",
            )
        except OSError as exc:
            raise RequestError(503, "The selected browser could not be started") from exc
        registered = False
        if process_registry is not None:
            registered = process_registry.register(process)
            if not registered:
                _stop_browser_process(process)
                raise RequestError(503, "Workbench is shutting down")

        deadline = time.monotonic() + timeout
        try:
            while time.monotonic() < deadline:
                if screenshot_path.is_file():
                    size = screenshot_path.stat().st_size
                    if size > MAX_PNG_BYTES:
                        raise RequestError(502, "Captured image exceeded the size limit")
                    if _png_file_complete(screenshot_path):
                        break
                if process.poll() is not None:
                    raise RequestError(502, "Browser capture failed or produced an incomplete PNG")
                time.sleep(0.05)
            else:
                raise RequestError(504, "Browser capture timed out")
        finally:
            _stop_browser_process(process)
            if registered:
                process_registry.unregister(process)

        if screenshot_path.stat().st_size > MAX_PNG_BYTES:
            raise RequestError(502, "Captured image exceeded the size limit")
        png = screenshot_path.read_bytes()
    if not _png_complete(png):
        raise RequestError(502, "Browser did not produce a PNG image")
    return png, browser


def video_downloader_config() -> Dict[str, object]:
    try:
        payload = json.loads(YDL_CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            return {}
        return payload
    except (OSError, ValueError):
        return {}


def _read_video_config_for_update() -> dict:
    # Never replace a damaged or unreadable existing preference file with defaults.
    try:
        config = json.loads(YDL_CONFIG_PATH.read_text(encoding="utf-8"))
        if not isinstance(config, dict):
            raise ValueError()
        return config
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise RequestError(503, "无法读取下载设置，请检查本机配置文件；原设置未被覆盖。") from exc


def _save_video_config(config: dict) -> None:
    YDL_CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=YDL_CONFIG_PATH.parent,
                                         prefix=".video-settings-", delete=False) as handle:
            temporary = Path(handle.name)
            json.dump(config, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(temporary, YDL_CONFIG_PATH)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def _video_tool_candidates(name: str, configured: object, resolved: dict) -> list[str]:
    binary = {"yt-dlp": "yt-dlp", "Deno": "deno", "FFmpeg": "ffmpeg", "FFprobe": "ffprobe"}[name]
    if sys.platform == "win32":
        binary += ".exe"
    managed = Path.home() / "Library/Application Support/com.imsyy.yt-dlp-gui"
    candidates = [configured]
    if name == "FFprobe" and resolved.get("FFmpeg"):
        candidates.append(str(Path(resolved["FFmpeg"]).with_name(binary)))
    candidates.extend([
        shutil.which(binary),
        str(managed / ("ffmpeg/" + binary if name in {"FFmpeg", "FFprobe"} else binary)),
        "/opt/homebrew/bin/" + binary,
        "/usr/local/bin/" + binary,
        str(Path.home() / ".local/bin" / binary),
        str(Path.home() / ".deno/bin" / binary),
        str(YDL_CONFIG_PATH.parent / "bin" / binary),
    ])
    if sys.platform == "win32":
        local = Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData/Local")
        roaming = Path(os.environ.get("APPDATA") or Path.home() / "AppData/Roaming")
        candidates.extend([
            str(Path(sys.executable).parent / "Scripts" / binary),
            str(local / "Microsoft/WinGet/Links" / binary),
            str(Path.home() / "scoop/shims" / binary),
            str(roaming / "com.imsyy.yt-dlp-gui" / binary),
            str(roaming / "com.imsyy.yt-dlp-gui/ffmpeg" / binary),
        ])
        # A running Codex may still have the old PATH after a package installation.
        for parent, pattern in (
            (local / "Microsoft/WinGet/Packages", "*/*/bin/" + binary),
            (local / "Microsoft/WinGet/Packages", "*/" + binary),
            (local / "Programs/Python", "Python*/Scripts/" + binary),
            (roaming / "Python", "Python*/Scripts/" + binary),
        ):
            if parent.is_dir():
                candidates.extend(str(path) for path in sorted(parent.glob(pattern), reverse=True))
    return list(dict.fromkeys(path for path in candidates if isinstance(path, str) and Path(path).is_absolute()))


def initialize_video_downloader(payload: object = None) -> dict:
    """Bootstrap once at service start; explicitly recheck after an installation."""
    global VIDEO_SETUP_ERROR
    if payload not in (None, {}):
        raise RequestError(400, "环境检查不接受参数。")
    with VIDEO_CONFIG_LOCK:
        try:
            config = _read_video_config_for_update()
            previous = json.dumps(config, sort_keys=True)
            if not config.get("downloadsDirectory"):
                directory = Path.home() / "Downloads" / "设计工具箱"
                directory.mkdir(parents=True, exist_ok=True)
                config["downloadsDirectory"] = str(directory)
            # An existing custom directory, including an offline disk, is never replaced.
            tools = config.get("tools")
            tools = dict(tools) if isinstance(tools, dict) else {}
            for name in ("yt-dlp", "Deno", "FFmpeg", "FFprobe"):
                diagnostic = {"available": False, "error": "未找到可执行文件"}
                for candidate in _video_tool_candidates(name, tools.get(name), tools):
                    if not Path(candidate).is_file() or not os.access(candidate, os.X_OK):
                        continue
                    try:
                        flag = "-version" if name in {"FFmpeg", "FFprobe"} else "--version"
                        arguments = [candidate, "--ignore-config", flag] if name == "yt-dlp" else [candidate, flag]
                        result = subprocess.run(arguments, stdin=subprocess.DEVNULL,
                                                capture_output=True, text=True, errors="replace",
                                                timeout=45 if name == "yt-dlp" else 8, check=True)
                        version = (result.stdout or result.stderr).splitlines()[0][:160]
                        diagnostic = {"path": candidate, "available": True, "version": version}
                        tools[name] = candidate
                        break
                    except (OSError, subprocess.SubprocessError, IndexError):
                        diagnostic = {"path": candidate, "available": False, "error": "程序无法运行，请检查安装或系统架构"}
                VIDEO_DEPENDENCY_CHECKS[name] = diagnostic
            config["tools"] = tools
            if json.dumps(config, sort_keys=True) != previous:
                _save_video_config(config)
            VIDEO_SETUP_ERROR = ""
        except (OSError, RequestError) as exc:
            VIDEO_SETUP_ERROR = exc.message if isinstance(exc, RequestError) else "无法创建下载目录或保存本机设置：" + str(exc)
            raise RequestError(503, VIDEO_SETUP_ERROR) from exc
    return {"videoDownloader": video_downloader_status(), "message": "已重新检查保存位置和下载依赖。"}


def start_video_dependency_install(payload: object = None) -> dict:
    if payload not in (None, {}):
        raise RequestError(400, "自动安装不接受安装地址或命令参数。")
    with VIDEO_INSTALL_LOCK:
        if VIDEO_INSTALL_STATE["status"] == "installing":
            return {"message": "依赖正在安装，请稍候。"}
        missing = [item["name"] for item in video_downloader_status()["dependencies"] if not item["available"]]
        if not missing:
            return {"message": "所有下载依赖均已就绪。"}
        if VIDEO_SETUP_ERROR:
            raise RequestError(503, VIDEO_SETUP_ERROR)
        VIDEO_INSTALL_STATE.update(status="installing", message="正在准备下载依赖", percent=None, errors=[])
    threading.Thread(target=_install_video_dependencies, args=(missing,), daemon=True).start()
    return {"videoDownloader": video_downloader_status(), "message": "已开始安装缺少的下载依赖。"}


def _install_video_dependencies(missing: list[str]) -> None:
    def progress(message, percent):
        with VIDEO_INSTALL_LOCK:
            VIDEO_INSTALL_STATE.update(message=message, percent=percent)

    def installed(name, path):
        # Reload settings after downloading so an in-page directory change is kept.
        with VIDEO_CONFIG_LOCK:
            config = _read_video_config_for_update()
            tools = dict(config.get("tools") or {})
            tools[name] = path
            config["tools"] = tools
            _save_video_config(config)
            VIDEO_DEPENDENCY_CHECKS[name] = {"path": path, "available": True}

    errors = []
    try:
        errors = dependency_installer().install_missing(
            missing, YDL_CONFIG_PATH.parent / "bin", progress, installed)
        progress("正在检查安装结果", None)
        initialize_video_downloader()
        unavailable = [item["name"] for item in video_downloader_status()["dependencies"] if not item["available"]]
        if unavailable and not errors:
            errors = ["仍未检测到可用程序：" + "、".join(unavailable)]
    except Exception as exc:
        errors.append(str(exc))
    with VIDEO_INSTALL_LOCK:
        VIDEO_INSTALL_STATE.update(
            status="error" if errors else "complete", percent=None, errors=errors,
            message="部分依赖未安装成功，请检查网络后重试。" if errors else "下载依赖已安装完成。")
    emit({"event": "video-dependencies", "status": "error" if errors else "ready", "errors": errors})


def video_downloader_status() -> Dict[str, object]:
    config = video_downloader_config()
    app_path = config.get("appPath")
    app = Path(app_path) if isinstance(app_path, str) and app_path else None
    executable = app / "Contents/MacOS/yt-dlp-gui" if app else None
    installed = bool(sys.platform == "darwin" and executable and executable.is_file() and os.access(executable, os.X_OK))
    version = None
    if installed:
        try:
            with (app / "Contents/Info.plist").open("rb") as handle:
                metadata = plistlib.load(handle)
            installed = metadata.get("CFBundleIdentifier") == "com.imsyy.yt-dlp-gui"
            version = metadata.get("CFBundleShortVersionString")
        except (OSError, ValueError, plistlib.InvalidFileException):
            installed = False
    paths = config.get("tools", {})
    if not isinstance(paths, dict):
        paths = {}
    dependencies = []
    for name in ("yt-dlp", "Deno", "FFmpeg", "FFprobe"):
        path = paths.get(name)
        available = bool(isinstance(path, str) and path and Path(path).is_file() and os.access(path, os.X_OK))
        diagnostic = VIDEO_DEPENDENCY_CHECKS.get(name, {})
        if diagnostic.get("path") == path:
            available = available and diagnostic.get("available", False)
        dependencies.append({"name": name, **diagnostic, "available": available})
    directory = config.get("downloadsDirectory")
    if not isinstance(directory, str) or not Path(directory).is_absolute():
        directory = ""
    directory_available = bool(directory and Path(directory).is_dir() and os.access(directory, os.W_OK))
    return {
        "installed": installed,
        "ready": all(item["available"] for item in dependencies) and directory_available,
        "version": version,
        "dependencies": dependencies,
        "downloadsDirectory": directory,
        "directoryAvailable": directory_available,
        "setupError": VIDEO_SETUP_ERROR,
        "canChooseDirectory": True,
        "platform": sys.platform,
        "installation": dict(VIDEO_INSTALL_STATE),
    }


def validate_video_launch_payload(payload: object) -> str:
    if not isinstance(payload, dict) or set(payload) - {"url"}:
        raise RequestError(400, "只接受视频链接。")
    raw_url = payload.get("url", "")
    if not isinstance(raw_url, str) or len(raw_url) > 8192:
        raise RequestError(400, "请输入有效的视频链接。")
    if any(ord(character) < 32 or ord(character) == 127 for character in raw_url):
        raise RequestError(400, "视频链接包含无效字符。")
    url = raw_url.strip()
    if not url:
        return ""
    if re.search(r"\s", url) or len(re.findall(r"https?://", url, re.IGNORECASE)) > 1:
        raise RequestError(400, "每次只能解析一个视频，请只粘贴一条完整链接。")
    try:
        parsed = urlsplit(url)
        port = parsed.port
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or port == 0:
            raise ValueError()
    except ValueError as exc:
        raise RequestError(400, "请粘贴完整的 http 或 https 视频页面链接。") from exc
    return url


def launch_video_downloader(payload: object) -> Dict[str, object]:
    url = validate_video_launch_payload(payload)
    status = video_downloader_status()
    if not status["installed"]:
        raise RequestError(503, "本机尚未安装或配置 yt-dlp GUI。")
    if url and not status.get("directoryAvailable", True):
        raise RequestError(503, "默认下载目录不可用，请检查保存磁盘是否已连接且可以写入。")
    if url and not status["ready"]:
        raise RequestError(503, "下载依赖尚未配置完成，请在 yt-dlp GUI 的设置中检查。")
    config = video_downloader_config()
    executable = Path(config["appPath"]) / "Contents/MacOS/yt-dlp-gui"
    args = [str(executable)]
    if status["downloadsDirectory"]:
        args.extend(["--dir", status["downloadsDirectory"]])
    if url:
        args.extend(["--url", url])
    # Launch the executable so Tauri's single-instance handler receives arguments
    # even if the app is already running. Never evaluate a supplied URL in a shell.
    try:
        process = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            result = process.wait(timeout=0.3)
        except subprocess.TimeoutExpired:
            result = None
        if result not in (None, 0):
            raise RequestError(502, "yt-dlp GUI 启动失败，请检查本机应用。")
        if result is None:
            threading.Thread(target=process.wait, daemon=True).start()
    except OSError as exc:
        raise RequestError(502, "无法启动 yt-dlp GUI，请检查应用是否可以打开。") from exc
    return {"message": "已将链接发送到 yt-dlp GUI，请在应用内选择格式并下载。" if url else "已打开 yt-dlp GUI。"}


def open_video_download_folder(payload: object) -> Dict[str, object]:
    if payload != {}:
        raise RequestError(400, "此操作不接受路径参数。")
    directory = video_downloader_status()["downloadsDirectory"]
    if not directory or not Path(directory).is_dir():
        raise RequestError(503, "默认下载目录尚未配置。")
    reveal_video_directory(Path(directory))
    return {"message": "已打开默认下载文件夹。"}


def reveal_video_directory(directory: Path, file_path: Optional[Path] = None) -> None:
    try:
        if sys.platform == "win32":
            os.startfile(str(directory))
        else:
            args = (["/usr/bin/open", "-R", str(file_path)] if file_path else ["/usr/bin/open", str(directory)]) \
                if sys.platform == "darwin" else ["xdg-open", str(directory)]
            subprocess.run(args, check=True, timeout=10, stdin=subprocess.DEVNULL,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except (OSError, subprocess.SubprocessError) as exc:
        raise RequestError(502, "无法打开下载文件夹。") from exc


def _video_directory(payload: object, *, allow_empty: bool = False) -> Path:
    if not isinstance(payload, dict) or set(payload) != {"directory"}:
        raise RequestError(400, "请选择保存文件夹。")
    raw = payload["directory"]
    if not isinstance(raw, str) or len(raw) > 4096 or any(ord(c) < 32 for c in raw):
        raise RequestError(400, "文件夹路径无效。")
    if allow_empty and not raw:
        current = video_downloader_status()["downloadsDirectory"]
        raw = current if current and Path(current).is_dir() else str(Path.home())
    directory = Path(raw).expanduser()
    if not raw or not directory.is_absolute() or not directory.is_dir():
        raise RequestError(400, "请选择存在的本机文件夹，或检查磁盘是否已连接。")
    return directory


def list_video_directories(payload: object) -> dict:
    directory = _video_directory(payload, allow_empty=True)
    try:
        folders = []
        for child in directory.iterdir():
            if not child.name.startswith(".") and child.is_dir():
                folders.append({"name": child.name, "directory": str(child)})
            if len(folders) > 500:
                break
        folders.sort(key=lambda item: item["name"].casefold())
        shortcuts = [{"name": "个人文件夹", "directory": str(Path.home())},
                     {"name": "下载", "directory": str(Path.home() / "Downloads")}]
        if sys.platform == "darwin":
            shortcuts.append({"name": "磁盘", "directory": "/Volumes"})
        elif sys.platform == "win32":
            shortcuts.extend(windows_drive_shortcuts())
        return {"directory": str(directory), "parent": str(directory.parent),
                "folders": folders[:500], "truncated": len(folders) > 500,
                "shortcuts": [item for item in shortcuts if Path(item["directory"]).is_dir()]}
    except OSError as exc:
        raise RequestError(403, "无法浏览此文件夹，请检查访问权限。") from exc


def windows_drive_shortcuts() -> list[dict]:
    import ctypes
    mask = ctypes.windll.kernel32.GetLogicalDrives()
    return [{"name": "{}:".format(chr(65 + index)), "directory": "{}:\\".format(chr(65 + index))}
            for index in range(26) if mask & (1 << index)]


def choose_video_download_folder(payload: object) -> dict:
    directory = _video_directory(payload)
    try:
        # Browsing and cancelling never write preferences. Only explicit confirmation does.
        with tempfile.TemporaryFile(dir=directory):
            pass
        with VIDEO_CONFIG_LOCK:
            config = _read_video_config_for_update()
            config["downloadsDirectory"] = str(directory)
            _save_video_config(config)
    except OSError as exc:
        raise RequestError(503, "无法使用所选文件夹或保存设置，请检查写入权限。") from exc
    return {"videoDownloader": video_downloader_status(),
            "message": "保存位置已更新，仅影响之后开始的下载任务。"}


def capabilities_payload() -> Dict[str, object]:
    browsers = discover_browsers()
    public_browsers = [{"id": browser["id"], "name": browser["name"]} for browser in browsers]
    return {
        "mode": "local-source-bridge",
        "videoDownloader": video_downloader_status(),
        "figma": {
            "environmentToken": bool(os.environ.get("FIGMA_ACCESS_TOKEN", "").strip()),
            "acceptedUrlTypes": ["design", "file"],
            "scale": {"min": 0.01, "max": 4},
            "maxExportPixels": 32_000_000,
        },
        "capture": {
            "available": bool(browsers),
            "browsers": public_browsers,
            "limits": CAPTURE_LIMITS,
        },
        "request": {"maxBodyBytes": MAX_JSON_BODY_BYTES, "tokenHeader": TOKEN_HEADER},
    }


def video_engine_args() -> list[str]:
    status = video_downloader_status()
    if not all(item["available"] for item in status["dependencies"]):
        raise RequestError(503, "下载依赖尚未配置完成。")
    tools = video_downloader_config()["tools"]
    return [
        tools["yt-dlp"], "--ignore-config", "--no-playlist", "--playlist-items", "1",
        "--js-runtimes", "deno:" + tools["Deno"],
        "--ffmpeg-location", str(Path(tools["FFmpeg"]).parent),
        "--socket-timeout", "20", "--retries", "2", "--extractor-retries", "1",
        "--no-colors",
    ]


def summarize_video(info: object) -> Dict[str, object]:
    if not isinstance(info, dict) or info.get("_type") in {"playlist", "multi_video"}:
        raise RequestError(400, "请粘贴单个视频的链接，暂不支持整份播放列表。")
    if info.get("is_live"):
        raise RequestError(400, "暂不支持正在直播的视频，请在直播结束后下载。")
    heights = set()
    for item in info.get("formats") or []:
        height = item.get("height") if isinstance(item, dict) else None
        if isinstance(height, (int, float)) and math.isfinite(height) and 0 < height <= 16384:
            heights.add(int(height))
    qualities = [{"id": "best", "label": "最高画质（推荐）"}]
    qualities.extend({"id": str(height), "label": "{}p".format(height)} for height in sorted(heights, reverse=True))
    return {
        "title": str(info.get("title") or "未命名视频")[:500],
        "uploader": str(info.get("uploader") or info.get("channel") or "")[:200],
        "duration": info.get("duration") if isinstance(info.get("duration"), (int, float)) else None,
        "source": str(info.get("extractor_key") or info.get("extractor") or "")[:80],
        "qualities": qualities,
    }


class VideoJobManager:
    """Run fixed yt-dlp commands locally, with cancellable jobs and bounded history."""

    ACTIVE = {"parsing", "downloading", "processing"}

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._jobs: Dict[str, dict] = {}
        self._processes = BrowserProcessRegistry()
        self._closed = False

    def _public(self, job: dict) -> dict:
        with self._lock:
            return json.loads(json.dumps({key: value for key, value in job.items() if not key.startswith("_")}))

    def snapshot(self) -> dict:
        with self._lock:
            return {"jobs": [self._public(job) for job in reversed(list(self._jobs.values()))]}

    def open_folder(self, payload: object) -> dict:
        if not isinstance(payload, dict) or set(payload) != {"id"} or not isinstance(payload["id"], str):
            raise RequestError(400, "请选择已完成的下载任务。")
        with self._lock:
            job = self._jobs.get(payload["id"])
            if not job or job["kind"] != "download" or job["status"] != "complete":
                raise RequestError(409, "此下载任务尚未完成或已不在当前记录中。")
            path = Path(job["filePath"])
            directory = Path(job["directory"])
        if not is_within_root(path.resolve(), directory.resolve()) or not path.is_file():
            raise RequestError(404, "下载文件已移动、删除，或保存磁盘未连接。")
        reveal_video_directory(directory, path)
        return {"message": "已打开此视频的保存文件夹。"}

    def _new(self, kind: str, url: str, **fields: object) -> dict:
        with self._lock:
            if self._closed:
                raise RequestError(503, "本地下载服务正在关闭。")
            if sum(job["status"] in self.ACTIVE for job in self._jobs.values()) >= 3:
                raise RequestError(429, "已有 3 个任务正在运行，请稍后再试。")
            while len(self._jobs) >= 30:
                oldest = next((key for key, job in self._jobs.items() if job["status"] not in self.ACTIVE), None)
                if oldest is None:
                    break
                del self._jobs[oldest]
            job = {"id": secrets.token_hex(12), "kind": kind, "url": url,
                   "status": "parsing" if kind == "parse" else "downloading",
                   "createdAt": time.time(), "percent": None, **fields}
            self._jobs[job["id"]] = job
            return job

    def _update(self, job: dict, **fields: object) -> None:
        with self._lock:
            if job["status"] != "cancelled":
                job.update(fields)

    def _spawn(self, job: dict, args: list[str], **kwargs: object) -> subprocess.Popen:
        with self._lock:
            if self._closed or job["status"] == "cancelled":
                raise RequestError(409, "任务已取消。")
            process = subprocess.Popen(args, stdin=subprocess.DEVNULL, start_new_session=os.name == "posix", **kwargs)
            job["_process"] = process
            if not self._processes.register(process):
                _stop_browser_process(process)
                raise RequestError(503, "本地下载服务正在关闭。")
            return process

    def _release(self, job: dict, process: Optional[subprocess.Popen]) -> None:
        if process is not None:
            if process.poll() is None:
                _stop_browser_process(process)
            self._processes.unregister(process)
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
        with self._lock:
            job.pop("_process", None)

    @staticmethod
    def _error_text(text: str) -> str:
        lines = [line.strip() for line in text.splitlines() if line.strip()]
        errors = [line for line in lines if line.startswith("ERROR:")]
        detail = "\n".join(errors or lines[-3:])[-1600:]
        if "Sign in" in detail or "login" in detail.lower() or "cookies" in detail.lower():
            return "来源平台要求登录验证，当前匿名下载不可用。\n" + detail
        return detail or "下载引擎未能完成任务，请检查链接或网络后重试。"

    def parse(self, payload: object) -> dict:
        url = validate_video_launch_payload(payload)
        if not url:
            raise RequestError(400, "请先输入视频链接。")
        args = video_engine_args()
        job = self._new("parse", url)
        threading.Thread(target=self._parse_worker, args=(job, args), daemon=True).start()
        return {"job": self._public(job)}

    def _parse_worker(self, job: dict, args: list[str]) -> None:
        process = None
        try:
            with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
                process = self._spawn(job, args + ["--skip-download", "--dump-single-json", "--", job["url"]],
                                      stdout=output, stderr=errors)
                try:
                    code = process.wait(timeout=120)
                except subprocess.TimeoutExpired:
                    _stop_browser_process(process)
                    raise RequestError(504, "解析超过两分钟，请检查网络或稍后重试。")
                errors.seek(max(0, errors.tell() - 8192))
                detail = errors.read(8192).decode("utf-8", errors="replace")
                if code != 0:
                    raise RequestError(502, self._error_text(detail))
                if output.tell() > 32 * 1024 * 1024:
                    raise RequestError(502, "视频信息过大，请使用单个视频链接。")
                output.seek(0)
                info = summarize_video(json.load(output))
                self._update(job, status="ready", video=info)
        except RequestError as exc:
            self._update(job, status="error", error=exc.message)
        except (OSError, ValueError) as exc:
            self._update(job, status="error", error="解析失败：" + str(exc)[:500])
        finally:
            self._release(job, process)

    def download(self, payload: object) -> dict:
        if not isinstance(payload, dict) or set(payload) != {"parseId", "quality"}:
            raise RequestError(400, "请选择已解析的视频和清晰度。")
        parse_id, quality = payload["parseId"], payload["quality"]
        if not isinstance(parse_id, str) or not isinstance(quality, str):
            raise RequestError(400, "无效的下载选项。")
        status = video_downloader_status()
        if not status["directoryAvailable"]:
            raise RequestError(503, "保存磁盘不可用，请连接磁盘并确认可以写入。")
        args = video_engine_args()
        with self._lock:
            parsed = self._jobs.get(parse_id)
            if not parsed or parsed["kind"] != "parse" or parsed["status"] != "ready":
                raise RequestError(409, "视频信息已失效，请重新解析。")
            choice = next((item for item in parsed["video"]["qualities"] if item["id"] == quality), None)
            if choice is None:
                raise RequestError(400, "请选择列表中的清晰度。")
            if any(job["kind"] == "download" and job["url"] == parsed["url"] and job["status"] in self.ACTIVE
                   for job in self._jobs.values()):
                raise RequestError(409, "这个视频正在下载中。")
            selector = "bv*+ba/b" if quality == "best" else "bv*[height<={0}]+ba/b[height<={0}]".format(int(quality))
            job = self._new("download", parsed["url"], title=parsed["video"]["title"],
                            quality=choice["label"], directory=status["downloadsDirectory"])
        threading.Thread(target=self._download_worker, args=(job, args, selector), daemon=True).start()
        return {"job": self._public(job)}

    def _download_worker(self, job: dict, args: list[str], selector: str) -> None:
        process = None
        try:
            directory = Path(job["directory"])
            if not directory.is_dir() or not os.access(directory, os.W_OK):
                raise RequestError(503, "保存磁盘已断开或无法写入。")
            command = args + [
                "--no-simulate", "--newline", "--progress", "--progress-delta", "0.5",
                "--progress-template", "download:__DT_PROGRESS__%(progress)j",
                "--progress-template", "postprocess:__DT_POST__%(progress)j",
                "--print", "after_move:__DT_FILE__%(filepath)j",
                "--no-overwrites", "--merge-output-format", "mp4",
                "--remux-video", "mp4", "-f", selector,
                "-P", str(directory), "-o", "%(title).160B [%(id)s].%(ext)s",
                "--", job["url"],
            ]
            process = self._spawn(job, command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, encoding="utf-8", errors="replace")
            tail = []
            completed_path = None
            for line in iter(lambda: process.stdout.readline(65536), ""):
                line = line.strip()
                if line.startswith("__DT_PROGRESS__"):
                    try:
                        progress = json.loads(line[len("__DT_PROGRESS__"):])
                        downloaded = progress.get("downloaded_bytes") or 0
                        total = progress.get("total_bytes") or progress.get("total_bytes_estimate") or 0
                        percent = min(100, max(0, downloaded / total * 100)) if total > 0 else None
                        self._update(job, percent=percent, speed=progress.get("speed"), eta=progress.get("eta"))
                    except (ValueError, TypeError, ZeroDivisionError):
                        pass
                elif line.startswith("__DT_POST__"):
                    self._update(job, status="processing", percent=None, speed=None, eta=None)
                elif line.startswith("__DT_FILE__"):
                    try:
                        completed_path = Path(json.loads(line[len("__DT_FILE__"):])).resolve()
                    except (ValueError, TypeError):
                        pass
                elif line:
                    tail = (tail + [line])[-12:]
            code = process.wait()
            if code != 0:
                raise RequestError(502, self._error_text("\n".join(tail)))
            if (completed_path is None or not is_within_root(completed_path, directory.resolve())
                    or not completed_path.is_file() or completed_path.stat().st_size == 0):
                raise RequestError(502, "下载引擎已退出，但未找到完整的视频文件。")
            self._release(job, process)
            process = None
            self._ensure_playable_video(job, completed_path)
            self._update(job, status="complete", percent=100, filename=completed_path.name,
                         filePath=str(completed_path), bytes=completed_path.stat().st_size, speed=None, eta=None)
        except RequestError as exc:
            self._update(job, status="error", error=exc.message)
        except (OSError, ValueError) as exc:
            self._update(job, status="error", error="下载失败：" + str(exc)[:500])
        finally:
            self._release(job, process)

    def _probe_video(self, job: dict, path: Path) -> dict:
        probe = video_downloader_config()["tools"]["FFprobe"]
        process = None
        try:
            process = self._spawn(job, [
                probe, "-v", "error", "-show_entries",
                "stream=codec_type,codec_name,pix_fmt,profile,width,height:format=duration",
                "-of", "json", str(path),
            ], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                output, error = process.communicate(timeout=30)
            except subprocess.TimeoutExpired:
                raise RequestError(504, "视频完整性检查超时。")
            if process.returncode != 0:
                raise RequestError(502, "视频检查失败：" + error.decode("utf-8", errors="replace")[-600:])
            info = json.loads(output)
            streams = info.get("streams", [])
            video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
            audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
            duration = float(info.get("format", {}).get("duration", 0))
            if not video or not math.isfinite(duration) or duration <= 0:
                raise RequestError(502, "输出文件缺少有效的视频画面或时长。")
            return {"video": video, "audio": audio, "duration": duration}
        except (ValueError, TypeError) as exc:
            raise RequestError(502, "无法读取视频编码信息。") from exc
        finally:
            self._release(job, process)

    @staticmethod
    def _compatible_streams(info: dict) -> Tuple[bool, bool]:
        video, audio = info["video"], info["audio"]
        return (
            video.get("codec_name") == "h264" and video.get("pix_fmt") == "yuv420p",
            audio is None or (audio.get("codec_name") == "aac" and audio.get("profile") == "LC"),
        )

    def _ensure_playable_video(self, job: dict, source: Path) -> None:
        """Validate codecs, convert only incompatible streams, retain original bytes."""
        self._update(job, status="processing", stage="正在检查播放兼容性", percent=None, speed=None, eta=None)
        info = self._probe_video(job, source)
        video_ok, audio_ok = self._compatible_streams(info)
        if video_ok and audio_ok:
            return
        self._update(job, stage="正在转换为兼容视频", percent=0)
        executable = video_downloader_config()["tools"]["FFmpeg"]
        handle, raw_path = tempfile.mkstemp(prefix=".video-compatible-", suffix=".mp4", dir=source.parent)
        os.close(handle)
        temporary = Path(raw_path)
        process = None
        try:
            command = [
                executable, "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
                "-i", str(source), "-map", "0:v:0", "-map", "0:a:0?",
            ]
            if video_ok:
                command.extend(["-c:v", "copy"])
            else:
                command.extend(["-c:v", "libx264", "-preset", "fast", "-crf", "18",
                                "-pix_fmt", "yuv420p", "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2"])
            command.extend(["-c:a", "copy"] if audio_ok else ["-c:a", "aac", "-profile:a", "aac_low", "-b:a", "192k"])
            command.extend(["-movflags", "+faststart", "-progress", "pipe:1", "-nostats", "-y", str(temporary)])
            process = self._spawn(job, command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                  text=True, encoding="utf-8", errors="replace")
            tail = []
            for line in iter(lambda: process.stdout.readline(8192), ""):
                line = line.strip()
                if line.startswith("out_time_us="):
                    try:
                        percent = min(99, max(0, float(line.split("=", 1)[1]) / 1_000_000 / info["duration"] * 100))
                        self._update(job, percent=percent)
                    except ValueError:
                        pass
                elif line:
                    tail = (tail + [line])[-12:]
            if process.wait() != 0:
                raise RequestError(502, "兼容格式转换失败，原文件已保留。\n" + "\n".join(tail)[-1000:])
            self._release(job, process)
            process = None
            converted = self._probe_video(job, temporary)
            if (not all(self._compatible_streams(converted))
                    or bool(info["audio"]) != bool(converted["audio"])
                    or abs(converted["duration"] - info["duration"]) > max(0.25, info["duration"] * 0.01)):
                raise RequestError(502, "转换后的编码或时长检查未通过，原文件已保留。")
            # Commit only a verified conversion; cancellation never replaces the source.
            with self._lock:
                if self._closed or job["status"] == "cancelled":
                    raise RequestError(409, "任务已取消，原文件已保留。")
                backup_dir = source.parent / ".originals"
                backup_dir.mkdir(exist_ok=True)
                backup = backup_dir / (source.stem + "-" + secrets.token_hex(6) + source.suffix)
                source.rename(backup)
                try:
                    temporary.replace(source)
                except OSError:
                    backup.rename(source)
                    raise
                job["originalPath"] = str(backup)
                job["converted"] = True
        finally:
            self._release(job, process)
            temporary.unlink(missing_ok=True)

    def cancel(self, payload: object) -> dict:
        if not isinstance(payload, dict) or set(payload) != {"id"} or not isinstance(payload["id"], str):
            raise RequestError(400, "无效的任务。")
        with self._lock:
            job = self._jobs.get(payload["id"])
            if not job:
                raise RequestError(404, "任务不存在。")
            if job["status"] in self.ACTIVE:
                job["status"] = "cancelled"
            process = job.get("_process")
        if process is not None:
            _stop_browser_process(process)
        return {"job": self._public(job)}

    def close(self) -> None:
        with self._lock:
            self._closed = True
            for job in self._jobs.values():
                if job["status"] in self.ACTIVE:
                    job["status"] = "cancelled"
        self._processes.close()


POST_ENDPOINTS = {"/api/figma/import", "/api/capture", "/api/apps/ydl/launch", "/api/apps/ydl/folder",
                  "/api/video/parse", "/api/video/download", "/api/video/cancel",
                  "/api/video/check", "/api/video/install", "/api/video/directory", "/api/video/folder", "/api/video/directories"}


class WorkbenchServer(http.server.ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(
        self,
        server_address: Tuple[str, int],
        handler_class: type[http.server.BaseHTTPRequestHandler],
        *,
        access_token: Optional[str] = None,
    ) -> None:
        self.access_token = access_token or secrets.token_urlsafe(32)
        self.browser_processes = BrowserProcessRegistry()
        self.video_jobs = VideoJobManager()
        super().__init__(server_address, handler_class)

    def shutdown(self) -> None:
        self.browser_processes.close()
        self.video_jobs.close()
        super().shutdown()

    def server_close(self) -> None:
        self.browser_processes.close()
        self.video_jobs.close()
        super().server_close()


class WorkbenchHandler(http.server.BaseHTTPRequestHandler):
    server_version = "UIQualityWorkbench/0.2"
    sys_version = ""
    root = WEB_ROOT.resolve()

    def setup(self) -> None:
        super().setup()
        self.connection.settimeout(REQUEST_IO_TIMEOUT_SECONDS)

    def log_message(self, message: str, *args: object) -> None:
        if getattr(self.server, "verbose", False):
            print("[workbench] " + (message % args), file=sys.stderr, flush=True)

    def end_headers(self) -> None:
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def do_HEAD(self) -> None:
        self._respond(include_body=False)

    def do_GET(self) -> None:
        self._respond(include_body=True)

    def do_POST(self) -> None:
        request_path = unquote(urlsplit(self.path).path)
        if request_path not in POST_ENDPOINTS:
            self._method_not_allowed()
            return
        if not self._host_allowed():
            self._json_error(403, "Invalid Host header")
            return
        if not self._origin_allowed():
            self._json_error(403, "Invalid Origin header")
            return
        if not self._token_allowed():
            self._json_error(401, "Invalid or missing workbench token")
            return
        try:
            payload = self._read_json_body()
            if request_path == "/api/figma/import":
                self._handle_figma_import(payload)
            elif request_path == "/api/apps/ydl/launch":
                self._send_json(200, launch_video_downloader(payload))
            elif request_path == "/api/apps/ydl/folder":
                self._send_json(200, open_video_download_folder(payload))
            elif request_path == "/api/video/parse":
                self._send_json(202, self.server.video_jobs.parse(payload))
            elif request_path == "/api/video/download":
                self._send_json(202, self.server.video_jobs.download(payload))
            elif request_path == "/api/video/cancel":
                self._send_json(200, self.server.video_jobs.cancel(payload))
            elif request_path == "/api/video/check":
                self._send_json(200, initialize_video_downloader(payload))
            elif request_path == "/api/video/install":
                self._send_json(202, start_video_dependency_install(payload))
            elif request_path == "/api/video/directories":
                self._send_json(200, list_video_directories(payload))
            elif request_path == "/api/video/directory":
                self._send_json(200, choose_video_download_folder(payload))
            elif request_path == "/api/video/folder":
                self._send_json(200, self.server.video_jobs.open_folder(payload))
            else:
                self._handle_capture(payload)
        except RequestError as exc:
            self._json_error(exc.status, exc.message)

    def do_PUT(self) -> None:
        self._unsupported_method()

    def do_PATCH(self) -> None:
        self._unsupported_method()

    def do_DELETE(self) -> None:
        self._unsupported_method()

    def do_OPTIONS(self) -> None:
        self._unsupported_method()

    def _unsupported_method(self) -> None:
        request_path = unquote(urlsplit(self.path).path)
        allowed = "POST" if request_path in POST_ENDPOINTS else "GET, HEAD"
        self.send_response(405)
        self.send_header("Allow", allowed)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _method_not_allowed(self) -> None:
        self.send_response(405)
        self.send_header("Allow", "GET, HEAD")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _respond(self, *, include_body: bool) -> None:
        if not self._host_allowed():
            self.send_error(403, "Invalid Host header")
            return

        request_path = unquote(urlsplit(self.path).path)
        if request_path in {"/api/capabilities", "/api/video/jobs"}:
            if not self._token_allowed():
                self._json_error(401, "Invalid or missing workbench token", include_body=include_body)
                return
            payload = self.server.video_jobs.snapshot() if request_path == "/api/video/jobs" else capabilities_payload()
            if request_path == "/api/video/jobs":
                payload["videoDownloader"] = video_downloader_status()
            self._send_json(200, payload, include_body=include_body)
            return
        if request_path == "/health":
            self._send_json(200, {"status": "ok", "mode": "local-source-bridge"}, include_body=include_body)
            return

        resolved = self._resolve_file(request_path)
        if resolved is None:
            self.send_error(404, "Not found")
            return

        try:
            stat = resolved.stat()
            content_type = self._content_type(resolved)
            document = None
            if resolved == self.root / "index.html":
                if (self.headers.get("Origin") and not self._origin_allowed()) or (
                    self.headers.get("Sec-Fetch-Site") == "cross-site"
                    and self.headers.get("Sec-Fetch-Mode") != "navigate"
                ):
                    self._json_error(403, "Cross-origin document access denied", include_body=include_body)
                    return
                # The loopback server supplies its own session, including for a fresh tab
                # opened without the URL fragment. Static builds never contain a token.
                source = resolved.read_text(encoding="utf-8")
                meta = '<meta name="workbench-bridge-token" content="{}">'.format(
                    html.escape(self.server.access_token, quote=True))
                source = source.replace("<head>", "<head>" + meta, 1) if "<head>" in source else meta + source
                document = source.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(document) if document is not None else stat.st_size))
            modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc)
            self.send_header("Last-Modified", format_datetime(modified, usegmt=True))
            self.end_headers()
            if include_body:
                if document is not None:
                    self.wfile.write(document)
                else:
                    with resolved.open("rb") as handle:
                        self._copy(handle)
        except OSError as exc:
            self.send_error(500, "Cannot read bundled asset: {}".format(exc))

    def _handle_figma_import(self, payload: object) -> None:
        if not isinstance(payload, dict):
            raise RequestError(400, "JSON body must be an object")
        file_key, node_id = parse_figma_url(payload.get("url"))
        temporary_token = payload.get("accessToken")
        if temporary_token is not None and not isinstance(temporary_token, str):
            raise RequestError(400, "accessToken must be a string")
        token = (temporary_token or os.environ.get("FIGMA_ACCESS_TOKEN", "")).strip()
        if not token:
            raise RequestError(401, "A temporary accessToken or FIGMA_ACCESS_TOKEN is required")
        if len(token) > 4096:
            raise RequestError(400, "accessToken is too long")
        if not _figma_token_valid(token):
            raise RequestError(400, "accessToken contains unsupported characters")
        scale = payload.get("scale", 2)
        if (
            isinstance(scale, bool)
            or not isinstance(scale, (int, float))
            or not math.isfinite(scale)
            or scale < 0.01
            or scale > 4
        ):
            raise RequestError(400, "scale must be between 0.01 and 4")
        png = fetch_figma_png(file_key, node_id, token, float(scale))
        filename = "figma-{}-{}.png".format(file_key, node_id.replace(":", "-"))
        self._send_png(png, filename, "Figma {} / {}".format(file_key, node_id))

    def _handle_capture(self, payload: object) -> None:
        url, width, height, wait_ms = validate_capture_payload(payload)
        png, browser = capture_webpage(
            url, width, height, wait_ms, getattr(self.server, "browser_processes", None)
        )
        hostname = (urlsplit(url).hostname or "page").encode("idna").decode("ascii")
        filename = "capture-{}-{}x{}.png".format(re.sub(r"[^A-Za-z0-9.-]", "-", hostname), width, height)
        self._send_png(png, filename, "{} capture {}x{}".format(browser["name"], width, height))

    def _read_json_body(self) -> object:
        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            raise RequestError(415, "Content-Type must be application/json")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) != 1:
            raise RequestError(411, "A single Content-Length header is required")
        try:
            length = int(lengths[0])
        except ValueError as exc:
            raise RequestError(400, "Invalid Content-Length header") from exc
        if length <= 0:
            raise RequestError(400, "JSON body is required")
        if length > MAX_JSON_BODY_BYTES:
            raise RequestError(413, "JSON body exceeds the size limit")
        try:
            body = self.rfile.read(length)
        except TimeoutError as exc:
            raise RequestError(408, "Timed out while reading request body") from exc
        if len(body) != length:
            raise RequestError(400, "Incomplete request body")
        try:
            return json.loads(body.decode("utf-8"))
        except (UnicodeError, json.JSONDecodeError) as exc:
            raise RequestError(400, "Request body must contain valid UTF-8 JSON") from exc

    def _send_png(self, payload: bytes, filename: str, source_label: str) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "image/png")
        self.send_header("Content-Disposition", 'attachment; filename="{}"'.format(filename))
        self.send_header("X-Source-Label", source_label)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _send_json(self, status: int, payload: Dict[str, object], *, include_body: bool = True) -> None:
        encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if include_body:
            self.wfile.write(encoded)

    def _json_error(self, status: int, message: str, *, include_body: bool = True) -> None:
        self._send_json(status, {"error": message}, include_body=include_body)

    def _resolve_file(self, request_path: str) -> Optional[Path]:
        if "\0" in request_path:
            return None
        slash_path = request_path.replace("\\", "/")
        segments = [segment for segment in slash_path.split("/") if segment]
        if any(segment == ".." or segment.startswith(".") for segment in segments):
            return None

        normalized = posixpath.normpath(slash_path)
        relative = normalized.lstrip("/")
        candidate = (self.root / relative).resolve()
        if not is_within_root(candidate, self.root):
            return None
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if candidate.is_file():
            return candidate

        # Support client-side routes while keeping missing static assets as 404s.
        accepts_html = "text/html" in self.headers.get("Accept", "").lower()
        first_segment = relative.split("/", 1)[0]
        has_extension = bool(Path(relative).suffix)
        if accepts_html and first_segment not in {"api", "assets"} and not has_extension:
            index = self.root / "index.html"
            return index if index.is_file() else None
        return None

    def _host_allowed(self) -> bool:
        port = self.server.server_address[1]
        supplied = self.headers.get("Host", "").strip().lower()
        return supplied in {"{}:{}".format(HOST, port), "localhost:{}".format(port)}

    def _origin_allowed(self) -> bool:
        port = self.server.server_address[1]
        supplied = self.headers.get("Origin", "").strip().lower()
        return supplied in {"http://{}:{}".format(HOST, port), "http://localhost:{}".format(port)}

    def _token_allowed(self) -> bool:
        supplied = self.headers.get(TOKEN_HEADER, "")
        expected = getattr(self.server, "access_token", "")
        return bool(
            supplied
            and expected
            and supplied.isascii()
            and expected.isascii()
            and secrets.compare_digest(supplied, expected)
        )

    @staticmethod
    def _content_type(path: Path) -> str:
        if path.suffix == ".js":
            return "application/javascript; charset=utf-8"
        if path.suffix == ".mjs":
            return "text/javascript; charset=utf-8"
        if path.suffix == ".wasm":
            return "application/wasm"
        if path.suffix == ".webmanifest":
            return "application/manifest+json; charset=utf-8"
        if path.suffix in {".css", ".html", ".json", ".svg"}:
            guessed, _ = mimetypes.guess_type(str(path))
            return "{}; charset=utf-8".format(guessed or "text/plain")
        guessed, _ = mimetypes.guess_type(str(path))
        return guessed or "application/octet-stream"

    def _copy(self, source: BinaryIO) -> None:
        while True:
            block = source.read(64 * 1024)
            if not block:
                return
            self.wfile.write(block)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the bundled Design Toolbox (设计工具箱) locally.")
    parser.add_argument("--check", action="store_true", help="Verify the bundle and local bridge, then exit.")
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 chooses an available port.")
    parser.add_argument("--verbose", action="store_true", help="Write HTTP access logs to stderr.")
    parser.add_argument("--open", action="store_true", help="Open the authenticated local page in the default browser.")
    parser.add_argument("--no-install", action="store_true", help="Check dependencies without automatically installing missing ones.")
    parser.add_argument("--install-only", action="store_true", help="Install missing video dependencies and exit after verification.")
    return parser.parse_args()


def run_smoke_check() -> int:
    server = WorkbenchServer((HOST, 0), WorkbenchHandler)
    server.verbose = False
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.1}, daemon=True)
    thread.start()
    checks = 0
    required_headers = {
        "content-security-policy",
        "cross-origin-opener-policy",
        "cross-origin-resource-policy",
        "permissions-policy",
        "referrer-policy",
        "x-content-type-options",
        "x-frame-options",
    }
    try:
        connection = http.client.HTTPConnection(HOST, port, timeout=3)
        connection.request("GET", "/", headers={"Accept": "text/html"})
        response = connection.getresponse()
        body = response.read()
        if response.status != 200 or b'id="root"' not in body:
            raise RuntimeError("GET / did not return the bundled app")
        received_headers = {name.lower() for name, _ in response.getheaders()}
        missing_headers = sorted(required_headers - received_headers)
        if missing_headers:
            raise RuntimeError("Missing security headers: {}".format(", ".join(missing_headers)))
        checks += 1

        connection.request("HEAD", "/", headers={"Accept": "text/html"})
        response = connection.getresponse()
        if response.status != 200 or response.read():
            raise RuntimeError("HEAD / failed")
        checks += 1

        connection.request("GET", "/__launcher_check__/deep-link", headers={"Accept": "text/html"})
        response = connection.getresponse()
        if response.status != 200 or b'id="root"' not in response.read():
            raise RuntimeError("SPA fallback failed")
        checks += 1

        connection.request("GET", "/assets/__missing__.js", headers={"Accept": "text/javascript"})
        response = connection.getresponse()
        response.read()
        if response.status != 404:
            raise RuntimeError("Missing static asset did not return 404")
        checks += 1

        connection.request("POST", "/")
        response = connection.getresponse()
        response.read()
        if response.status != 405 or response.getheader("Allow") != "GET, HEAD":
            raise RuntimeError("Write method guard failed")
        checks += 1

        connection.request("GET", "/api/capabilities")
        response = connection.getresponse()
        response.read()
        if response.status != 401:
            raise RuntimeError("Capabilities token guard failed")
        checks += 1

        connection.request("GET", "/api/capabilities", headers={TOKEN_HEADER: server.access_token})
        response = connection.getresponse()
        capabilities = json.loads(response.read().decode("utf-8"))
        if response.status != 200 or capabilities.get("mode") != "local-source-bridge":
            raise RuntimeError("Capabilities endpoint failed")
        checks += 1

        oversized = b"{" + (b" " * MAX_JSON_BODY_BYTES) + b"}"
        connection.request(
            "POST",
            "/api/capture",
            body=oversized,
            headers={
                "Content-Type": "application/json",
                "Origin": "http://{}:{}".format(HOST, port),
                TOKEN_HEADER: server.access_token,
            },
        )
        response = connection.getresponse()
        response.read()
        if response.status != 413:
            raise RuntimeError("POST body limit failed")
        checks += 1
        connection.close()
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=3)
    return checks


def main() -> int:
    args = parse_args()
    if args.port < 0 or args.port > 65535:
        emit({"status": "error", "error": "Port must be between 0 and 65535"}, stream=sys.stderr)
        return 2

    manifest, errors = bundle_manifest(WEB_ROOT)
    if errors:
        emit({"status": "error", "error": "Invalid workbench bundle", "details": errors}, stream=sys.stderr)
        return 1

    if args.check:
        try:
            checks = run_smoke_check()
        except (OSError, RuntimeError, http.client.HTTPException, json.JSONDecodeError) as exc:
            emit({"event": "check", "status": "error", "error": str(exc)}, stream=sys.stderr)
            return 1
        emit({"event": "check", "status": "ok", "checks": checks, "root": str(WEB_ROOT), "bundle": manifest})
        return 0

    try:
        server = WorkbenchServer((HOST, args.port), WorkbenchHandler)
    except OSError as exc:
        emit({"status": "error", "error": "Cannot bind local server", "details": str(exc)}, stream=sys.stderr)
        return 1

    server.verbose = args.verbose
    emit({"event": "starting", "message": "正在检查本机下载依赖，首次启动可能需要约一分钟。"})
    try:
        initialize_video_downloader()
        if not args.no_install:
            start_video_dependency_install()
    except RequestError as exc:
        # A video setup failure must not prevent the other toolbox modules from starting.
        emit({"event": "video-setup", "status": "error", "error": exc.message}, stream=sys.stderr)
    if args.install_only:
        while VIDEO_INSTALL_STATE["status"] == "installing":
            time.sleep(0.2)
        server.server_close()
        available = all(item["available"] for item in video_downloader_status()["dependencies"])
        emit({"event": "installation", "status": "ok" if available else "error",
              "videoDownloader": video_downloader_status()})
        return 0 if available else 1
    port = server.server_address[1]
    url = "http://{}:{}/#token={}".format(HOST, port, quote(server.access_token, safe=""))

    def stop(_signum: int, _frame: object) -> None:
        # shutdown() must run outside the serve_forever thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    emit({"event": "ready", "protocol": 2, "host": HOST, "port": port, "url": url, "pid": os.getpid(), "root": str(WEB_ROOT), "mode": "local-source-bridge"})
    if args.open:
        threading.Thread(target=webbrowser.open, args=(url,), daemon=True).start()
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
