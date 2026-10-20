"""Install missing video engines into a private per-user directory.

Only fixed upstream releases are accepted. Downloads are SHA-256 checked before
execution, archive paths are never extracted, and working system tools are reused.
"""
from __future__ import annotations

import hashlib
import gzip
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import zipfile
from pathlib import Path, PurePosixPath
from urllib.parse import urlsplit
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener

MAX_DOWNLOAD = 400 * 1024 * 1024
ALLOWED_HOSTS = {
    "api.github.com", "github.com", "release-assets.githubusercontent.com",
    "objects.githubusercontent.com",
}


def validate_url(url):
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise RuntimeError("安装源地址不受支持。")
    return url


class TrustedRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        validate_url(newurl)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def open_download(url):
    request = Request(validate_url(url), headers={"User-Agent": "DesignToolbox-DependencyInstaller/1"})
    for attempt in range(3):
        try:
            return build_opener(TrustedRedirects()).open(request, timeout=30)
        except (URLError, TimeoutError) as exc:
            if attempt == 2 or (isinstance(exc, HTTPError) and exc.code < 500 and exc.code != 429):
                raise
            time.sleep(attempt + 1)


def read_metadata(url):
    with open_download(url) as response:
        content = response.read(4 * 1024 * 1024 + 1)
        if len(content) > 4 * 1024 * 1024:
            raise RuntimeError("安装源元数据过大。")
        return content, response.geturl()


def github_asset(repo, name):
    payload, _ = read_metadata("https://api.github.com/repos/{}/releases/latest".format(repo))
    release = json.loads(payload)
    asset = next((item for item in release.get("assets", []) if item.get("name") == name), None)
    if not asset:
        raise RuntimeError("上游尚未提供适用于此系统的安装包：" + name)
    digest = asset.get("digest") or ""
    if not re.fullmatch(r"sha256:[a-fA-F0-9]{64}", digest):
        raise RuntimeError("安装包缺少 SHA-256 校验值，请稍后重试。")
    return {"url": validate_url(asset["browser_download_url"]), "sha256": digest[7:]}


def platform_spec():
    machine = platform.machine().lower()
    architecture = {"arm64": "aarch64", "aarch64": "aarch64",
                    "amd64": "x86_64", "x86_64": "x86_64"}.get(machine)
    if sys.platform == "darwin" and architecture:
        return "macos", architecture
    if sys.platform == "win32" and architecture == "x86_64":
        return "windows", architecture
    raise RuntimeError("自动安装目前支持 macOS（Intel / Apple 芯片）和 Windows x64；此系统请手动安装依赖。")


def resolve_asset(name, system, architecture):
    if name == "yt-dlp":
        return github_asset("yt-dlp/yt-dlp", "yt-dlp.exe" if system == "windows" else "yt-dlp_macos")
    if name == "Deno":
        target = "pc-windows-msvc" if system == "windows" else "apple-darwin"
        return github_asset("denoland/deno", "deno-{}-{}.zip".format(architecture, target))
    if system == "windows":
        return github_asset("yt-dlp/FFmpeg-Builds", "ffmpeg-master-latest-win64-gpl.zip")
    arch = "arm64" if architecture == "aarch64" else "x64"
    return github_asset("eugeneware/ffmpeg-static", "{}-darwin-{}.gz".format(name.lower(), arch))


def download_verified(asset, destination, progress):
    expected = asset["sha256"].lower()
    if not re.fullmatch(r"[a-f0-9]{64}", expected):
        raise RuntimeError("安装包缺少有效校验值。")
    digest = hashlib.sha256()
    received = 0
    deadline = time.monotonic() + 600
    last_percent = -1
    with open_download(asset["url"]) as response, destination.open("wb") as output:
        total = int(response.headers.get("Content-Length") or 0)
        if total > MAX_DOWNLOAD:
            raise RuntimeError("安装包超过允许大小。")
        while True:
            if time.monotonic() > deadline:
                raise RuntimeError("下载超时，请检查网络后重试。")
            chunk = response.read(256 * 1024)
            if not chunk:
                break
            received += len(chunk)
            if received > MAX_DOWNLOAD:
                raise RuntimeError("安装包超过允许大小。")
            digest.update(chunk)
            output.write(chunk)
            percent = min(99, int(received * 100 / total)) if total else None
            if percent != last_percent:
                progress(percent)
                last_percent = percent
    if not received or digest.hexdigest() != expected:
        raise RuntimeError("下载文件校验失败，未安装；请重试。")


def unpack_binary(archive, binary, destination):
    with zipfile.ZipFile(archive) as package:
        matches = [item for item in package.infolist()
                   if PurePosixPath(item.filename).name == binary and not item.is_dir()]
        if len(matches) != 1:
            raise RuntimeError("安装包中未找到唯一的可执行文件：" + binary)
        member = matches[0]
        if member.file_size > MAX_DOWNLOAD or stat.S_ISLNK(member.external_attr >> 16):
            raise RuntimeError("安装包中的可执行文件无效。")
        # Copy only the requested file to a fixed destination; ignore archive paths.
        with package.open(member) as source, destination.open("wb") as output:
            shutil.copyfileobj(source, output, 256 * 1024)


def unpack_gzip(archive, destination):
    with gzip.open(archive, "rb") as source, destination.open("wb") as output:
        copied = 0
        while True:
            chunk = source.read(256 * 1024)
            if not chunk:
                break
            copied += len(chunk)
            if copied > MAX_DOWNLOAD:
                raise RuntimeError("解压后的程序超过允许大小。")
            output.write(chunk)


def verify_binary(name, path):
    args = [str(path), "-version" if name in {"FFmpeg", "FFprobe"} else "--version"]
    if name == "yt-dlp":
        args.insert(1, "--ignore-config")
    result = subprocess.run(args, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                            errors="replace", timeout=60, check=True)
    if not (result.stdout or result.stderr).strip():
        raise RuntimeError(name + " 安装后无法返回版本。")
    if name == "FFmpeg":
        encoders = subprocess.run([str(path), "-hide_banner", "-encoders"], stdin=subprocess.DEVNULL,
                                 capture_output=True, text=True, errors="replace", timeout=15, check=True)
        if not re.search(r"\blibx264\b", encoders.stdout):
            raise RuntimeError("FFmpeg 安装包缺少 H.264 编码器。")


def install_missing(missing, destination, progress, installed):
    """Call installed(name, path) only after verification and atomic replacement."""
    system, architecture = platform_spec()
    destination.mkdir(parents=True, exist_ok=True)
    failures = []
    # Same-user processes cannot install concurrently; no stale lock survives exit.
    lock_file = destination / ".install.lock"
    with lock_file.open("a+b") as lock:
        try:
            if os.name == "nt":
                import msvcrt
                lock.seek(0)
                if not lock.read(1):
                    lock.write(b"0")
                    lock.flush()
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise RuntimeError("另一个工具箱正在安装依赖，请稍后重试。") from exc
        try:
            with tempfile.TemporaryDirectory(prefix=".setup-", dir=destination) as temporary:
                staging = Path(temporary)
                cached = {}
                for index, name in enumerate(missing):
                    try:
                        progress("{}（{}/{}）：获取安装包".format(name, index + 1, len(missing)), None)
                        key = "FFmpeg" if system == "windows" and name == "FFprobe" else name
                        if key not in cached:
                            asset = resolve_asset(key, system, architecture)
                            archive = staging / (key + ".download")
                            download_verified(asset, archive,
                                              lambda value: progress("正在下载 " + name, value))
                            cached[key] = (asset, archive)
                        asset, archive = cached[key]
                        binary = {"yt-dlp": "yt-dlp", "Deno": "deno", "FFmpeg": "ffmpeg", "FFprobe": "ffprobe"}[name]
                        if system == "windows":
                            binary += ".exe"
                        candidate = staging / binary
                        if urlsplit(asset["url"]).path.endswith(".zip"):
                            unpack_binary(archive, binary, candidate)
                        elif urlsplit(asset["url"]).path.endswith(".gz"):
                            unpack_gzip(archive, candidate)
                        else:
                            shutil.copyfile(archive, candidate)
                        candidate.chmod(0o755)
                        progress("正在验证 " + name, None)
                        verify_binary(name, candidate)
                        target = destination / binary
                        os.replace(candidate, target)
                        installed(name, str(target))
                    except Exception as exc:
                        failures.append("{}：{}".format(name, exc))
                        progress(name + " 安装失败，将继续检查其他依赖", None)
        finally:
            if os.name == "nt":
                lock.seek(0)
                msvcrt.locking(lock.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    return failures
