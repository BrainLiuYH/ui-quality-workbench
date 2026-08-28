#!/usr/bin/env python3
"""Verify and serve UI Quality Workbench with a loopback-only source bridge."""

from __future__ import annotations

import argparse
import hashlib
import http.client
import http.server
import json
import math
import mimetypes
import os
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


def capabilities_payload() -> Dict[str, object]:
    browsers = discover_browsers()
    public_browsers = [{"id": browser["id"], "name": browser["name"]} for browser in browsers]
    return {
        "mode": "local-source-bridge",
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
        super().__init__(server_address, handler_class)

    def shutdown(self) -> None:
        self.browser_processes.close()
        super().shutdown()

    def server_close(self) -> None:
        self.browser_processes.close()
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
        if request_path not in {"/api/figma/import", "/api/capture"}:
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
        allowed = "POST" if request_path in {"/api/figma/import", "/api/capture"} else "GET, HEAD"
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
        if request_path == "/api/capabilities":
            if not self._token_allowed():
                self._json_error(401, "Invalid or missing workbench token", include_body=include_body)
                return
            self._send_json(200, capabilities_payload(), include_body=include_body)
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
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(stat.st_size))
            modified = datetime.fromtimestamp(stat.st_mtime, timezone.utc)
            self.send_header("Last-Modified", format_datetime(modified, usegmt=True))
            self.end_headers()
            if include_body:
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
    parser = argparse.ArgumentParser(description="Serve the bundled UI Quality Workbench locally.")
    parser.add_argument("--check", action="store_true", help="Verify the bundle and local bridge, then exit.")
    parser.add_argument("--port", type=int, default=0, help="Loopback port; 0 chooses an available port.")
    parser.add_argument("--verbose", action="store_true", help="Write HTTP access logs to stderr.")
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
    port = server.server_address[1]
    url = "http://{}:{}/#token={}".format(HOST, port, quote(server.access_token, safe=""))

    def stop(_signum: int, _frame: object) -> None:
        # shutdown() must run outside the serve_forever thread.
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    emit({"event": "ready", "protocol": 2, "host": HOST, "port": port, "url": url, "pid": os.getpid(), "root": str(WEB_ROOT), "mode": "local-source-bridge"})
    try:
        server.serve_forever(poll_interval=0.25)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
