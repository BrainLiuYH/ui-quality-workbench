#!/usr/bin/env python3
"""Unit tests for the local Workbench source bridge."""

from __future__ import annotations

import importlib.util
import io
import json
import base64
import http.client
import stat
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "serve_workbench.py"
SPEC = importlib.util.spec_from_file_location("workbench_source_bridge", MODULE_PATH)
assert SPEC and SPEC.loader
bridge = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bridge)
TEST_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class FakeResponse:
    def __init__(self, payload: bytes, final_url: str) -> None:
        self.stream = io.BytesIO(payload)
        self.final_url = final_url

    def read(self, size: int = -1) -> bytes:
        return self.stream.read(size)

    def geturl(self) -> str:
        return self.final_url

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_args: object) -> None:
        return None


class FigmaImportTests(unittest.TestCase):
    def test_parse_design_and_file_urls(self) -> None:
        self.assertEqual(
            bridge.parse_figma_url("https://www.figma.com/design/AbcDEF123/My-screen?node-id=12-34"),
            ("AbcDEF123", "12:34"),
        )
        self.assertEqual(
            bridge.parse_figma_url("https://figma.com/file/ZYX987654/Legacy?node-id=0%3A1"),
            ("ZYX987654", "0:1"),
        )

    def test_rejects_non_figma_or_missing_node(self) -> None:
        invalid = (
            "https://example.com/design/AbcDEF123/X?node-id=1-2",
            "http://www.figma.com/design/AbcDEF123/X?node-id=1-2",
            "https://www.figma.com/board/AbcDEF123/X?node-id=1-2",
            "https://www.figma.com/design/AbcDEF123/X",
            "https://www.figma.com/design/AbcDEF123/X?node-id=1-2\x00",
        )
        for url in invalid:
            with self.subTest(url=url), self.assertRaises(bridge.RequestError):
                bridge.parse_figma_url(url)

    def test_fetches_official_metadata_then_png_without_token_in_url(self) -> None:
        image_url = "https://s3-alpha-sig.figma.com/img/mock.png"
        metadata = json.dumps({"images": {"1:2": image_url}}).encode("utf-8")
        png = TEST_PNG
        calls = []

        def fake_metadata_open(request, timeout):
            calls.append((request, timeout))
            return FakeResponse(metadata, request.full_url)

        def fake_image_open(request, timeout):
            calls.append((request, timeout))
            return FakeResponse(png, image_url)

        with mock.patch.object(bridge, "_open_figma_metadata", side_effect=fake_metadata_open), mock.patch.object(
            bridge, "_open_figma_image", side_effect=fake_image_open
        ):
            result = bridge.fetch_figma_png("AbcDEF123", "1:2", "temporary-secret", 2)

        self.assertEqual(result, png)
        self.assertEqual(len(calls), 2)
        metadata_request = calls[0][0]
        parsed = urlsplit(metadata_request.full_url)
        self.assertEqual(parsed.hostname, "api.figma.com")
        self.assertEqual(parse_qs(parsed.query)["ids"], ["1:2"])
        self.assertNotIn("temporary-secret", metadata_request.full_url)
        headers = {name.lower(): value for name, value in metadata_request.header_items()}
        self.assertEqual(headers["x-figma-token"], "temporary-secret")
        self.assertNotIn("x-figma-token", {name.lower(): value for name, value in calls[1][0].header_items()})

    def test_redirect_policy_never_forwards_token_to_another_host(self) -> None:
        request = bridge.Request(
            "https://api.figma.com/v1/images/AbcDEF123",
            headers={"X-Figma-Token": "temporary-secret"},
        )
        reject = bridge._RejectRedirects()
        self.assertIsNone(reject.redirect_request(request, None, 302, "Found", {}, "https://evil.example"))
        with self.assertRaises(bridge.RequestError):
            bridge._FigmaImageRedirects().redirect_request(
                request, None, 302, "Found", {}, "https://evil.example/image.png"
            )

    def test_upstream_incomplete_read_becomes_safe_request_error(self) -> None:
        class BrokenStream:
            def read(self, _size):
                raise http.client.IncompleteRead(b"partial-secret-response", 100)

        with self.assertRaises(bridge.RequestError) as raised:
            bridge._read_limited(BrokenStream(), 1024)
        self.assertEqual(raised.exception.status, 502)
        self.assertNotIn("partial-secret", raised.exception.message)


class CaptureTests(unittest.TestCase):
    def test_capture_parameter_validation(self) -> None:
        self.assertEqual(
            bridge.validate_capture_payload(
                {"url": "http://127.0.0.1:4310/page", "width": 1440, "height": 1024, "waitMs": 500}
            ),
            ("http://127.0.0.1:4310/page", 1440, 1024, 500),
        )
        invalid_payloads = (
            {"url": "file:///etc/passwd"},
            {"url": "https://user:password@example.com"},
            {"url": "https://example.com", "width": True},
            {"url": "https://example.com", "width": 319},
            {"url": "https://example.com", "waitMs": 30001},
            {"url": "https://example.com", "width": 3840, "height": 10000},
            {"url": "https://example.com/\x00"},
        )
        for payload in invalid_payloads:
            with self.subTest(payload=payload), self.assertRaises(bridge.RequestError):
                bridge.validate_capture_payload(payload)

    def test_browser_discovery_uses_supported_executable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            executable = Path(temp_dir) / "chrome"
            executable.touch()
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
            candidates = (("test-chrome", "Test Chrome", "/not/installed/chrome", "test-chrome"),)
            with mock.patch.object(bridge, "BROWSER_CANDIDATES", candidates), mock.patch.object(
                bridge.shutil, "which", return_value=str(executable)
            ):
                found = bridge.discover_browsers()
        self.assertEqual(found, [{"id": "test-chrome", "name": "Test Chrome", "path": str(executable.resolve())}])

    def test_process_registry_stops_active_processes_and_rejects_new_ones(self) -> None:
        registry = bridge.BrowserProcessRegistry()
        process = object()
        self.assertTrue(registry.register(process))
        with mock.patch.object(bridge, "_stop_browser_process") as stop:
            registry.close()
        stop.assert_called_once_with(process)
        self.assertFalse(registry.register(object()))

    def test_capture_accepts_complete_png_even_when_browser_does_not_exit(self) -> None:
        class FakeProcess:
            pid = 123456

            @staticmethod
            def poll():
                return None

        process = FakeProcess()

        def fake_popen(command, **_kwargs):
            screenshot = next(argument.split("=", 1)[1] for argument in command if argument.startswith("--screenshot="))
            Path(screenshot).write_bytes(TEST_PNG)
            return process

        browser = {"id": "chrome", "name": "Test Chrome", "path": "/fake/chrome"}
        with mock.patch.object(bridge, "discover_browsers", return_value=[browser]), mock.patch.object(
            bridge.subprocess, "Popen", side_effect=fake_popen
        ), mock.patch.object(bridge, "_stop_browser_process") as stop:
            png, selected = bridge.capture_webpage("https://example.com", 640, 400, 0)
        self.assertEqual(png, TEST_PNG)
        self.assertEqual(selected, browser)
        stop.assert_called_once_with(process)

    def test_capture_rejects_incomplete_png_after_browser_exit(self) -> None:
        class FakeProcess:
            pid = 123456

            @staticmethod
            def poll():
                return 1

        process = FakeProcess()

        def fake_popen(command, **_kwargs):
            screenshot = next(argument.split("=", 1)[1] for argument in command if argument.startswith("--screenshot="))
            Path(screenshot).write_bytes(bridge.PNG_SIGNATURE)
            return process

        browser = {"id": "chrome", "name": "Test Chrome", "path": "/fake/chrome"}
        with mock.patch.object(bridge, "discover_browsers", return_value=[browser]), mock.patch.object(
            bridge.subprocess, "Popen", side_effect=fake_popen
        ), mock.patch.object(bridge, "_stop_browser_process") as stop:
            with self.assertRaises(bridge.RequestError) as raised:
                bridge.capture_webpage("https://example.com", 640, 400, 0)
        self.assertEqual(raised.exception.status, 502)
        stop.assert_called_once_with(process)

    def test_capture_timeout_always_cleans_up_browser(self) -> None:
        class FakeProcess:
            pid = 123456

            @staticmethod
            def poll():
                return None

        process = FakeProcess()
        browser = {"id": "chrome", "name": "Test Chrome", "path": "/fake/chrome"}
        with mock.patch.object(bridge, "discover_browsers", return_value=[browser]), mock.patch.object(
            bridge.subprocess, "Popen", return_value=process
        ), mock.patch.object(bridge, "_stop_browser_process") as stop, mock.patch.object(
            bridge.time, "monotonic", side_effect=[0.0, 16.0]
        ):
            with self.assertRaises(bridge.RequestError) as raised:
                bridge.capture_webpage("https://example.com", 640, 400, 0)
        self.assertEqual(raised.exception.status, 504)
        stop.assert_called_once_with(process)


class HandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        (root / "index.html").write_text('<div id="root"></div>', encoding="utf-8")

        class TestHandler(bridge.WorkbenchHandler):
            pass

        TestHandler.root = root.resolve()
        self.token = "unit-test-workbench-token"
        self.server = bridge.WorkbenchServer((bridge.HOST, 0), TestHandler, access_token=self.token)
        self.server.verbose = False
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=3)
        self.temp_dir.cleanup()

    def request(self, method: str, path: str, *, body=None, headers=None):
        import http.client

        connection = http.client.HTTPConnection(bridge.HOST, self.port, timeout=3)
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        payload = response.read()
        result = (response.status, dict(response.getheaders()), payload)
        connection.close()
        return result

    def api_headers(self) -> dict[str, str]:
        return {
            bridge.TOKEN_HEADER: self.token,
            "Origin": "http://{}:{}".format(bridge.HOST, self.port),
            "Content-Type": "application/json",
        }

    def test_capabilities_requires_token(self) -> None:
        status, _, _ = self.request("GET", "/api/capabilities")
        self.assertEqual(status, 401)
        status, _, body = self.request(
            "GET", "/api/capabilities", headers={bridge.TOKEN_HEADER: self.token}
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["mode"], "local-source-bridge")

    def test_post_requires_origin_and_token_and_enforces_body_limit(self) -> None:
        body = json.dumps({"url": "https://example.com"})
        headers = self.api_headers()
        headers["Host"] = "attacker.example"
        status, _, _ = self.request("POST", "/api/capture", body=body, headers=headers)
        self.assertEqual(status, 403)

        status, _, _ = self.request(
            "POST",
            "/api/capture",
            body=body,
            headers={"Content-Type": "application/json", "Origin": "https://attacker.example"},
        )
        self.assertEqual(status, 403)

        headers = self.api_headers()
        headers[bridge.TOKEN_HEADER] = "wrong-token"
        status, _, _ = self.request("POST", "/api/capture", body=body, headers=headers)
        self.assertEqual(status, 401)

        oversized = b"{" + (b" " * bridge.MAX_JSON_BODY_BYTES) + b"}"
        status, _, _ = self.request("POST", "/api/capture", body=oversized, headers=self.api_headers())
        self.assertEqual(status, 413)

        status, response_headers, _ = self.request("POST", "/not-an-api")
        self.assertEqual(status, 405)
        self.assertEqual(response_headers["Allow"], "GET, HEAD")

        status, response_headers, _ = self.request("PUT", "/api/capture", body=body, headers=self.api_headers())
        self.assertEqual(status, 405)
        self.assertEqual(response_headers["Allow"], "POST")

    def test_figma_api_returns_png_with_download_headers(self) -> None:
        png = TEST_PNG
        request_body = json.dumps(
            {
                "url": "https://www.figma.com/design/AbcDEF123/Screen?node-id=1-2",
                "accessToken": "one-request-token",
            }
        )
        with mock.patch.object(bridge, "fetch_figma_png", return_value=png) as fetch:
            status, headers, body = self.request(
                "POST", "/api/figma/import", body=request_body, headers=self.api_headers()
            )
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "image/png")
        self.assertIn("figma-AbcDEF123-1-2.png", headers["Content-Disposition"])
        self.assertEqual(headers["X-Source-Label"], "Figma AbcDEF123 / 1:2")
        self.assertEqual(body, png)
        fetch.assert_called_once_with("AbcDEF123", "1:2", "one-request-token", 2.0)

        invalid_token_body = json.dumps(
            {
                "url": "https://www.figma.com/design/AbcDEF123/Screen?node-id=1-2",
                "accessToken": "secret\r\nInjected: value",
            }
        )
        with mock.patch.object(bridge, "fetch_figma_png") as invalid_fetch:
            status, _, body = self.request(
                "POST", "/api/figma/import", body=invalid_token_body, headers=self.api_headers()
            )
        self.assertEqual(status, 400)
        self.assertNotIn(b"secret", body)
        invalid_fetch.assert_not_called()

    def test_server_tokens_are_per_instance(self) -> None:
        first = bridge.WorkbenchServer((bridge.HOST, 0), bridge.WorkbenchHandler)
        second = bridge.WorkbenchServer((bridge.HOST, 0), bridge.WorkbenchHandler)
        try:
            self.assertNotEqual(first.access_token, second.access_token)
            self.assertGreaterEqual(len(first.access_token), 32)
        finally:
            first.server_close()
            second.server_close()

    def test_desktop_launch_requires_same_origin_and_token(self) -> None:
        for endpoint in ("/api/apps/ydl/launch", "/api/apps/ydl/folder",
                         "/api/video/parse", "/api/video/download", "/api/video/cancel",
                         "/api/video/check", "/api/video/directory", "/api/video/folder", "/api/video/directories"):
            with self.subTest(endpoint=endpoint):
                headers = self.api_headers()
                headers["Origin"] = "https://untrusted.example"
                with mock.patch.object(bridge, "launch_video_downloader") as launch, mock.patch.object(
                    bridge, "open_video_download_folder"
                ) as folder:
                    status, _, _ = self.request("POST", endpoint, body="{}", headers=headers)
                    self.assertEqual(status, 403)
                    headers = self.api_headers()
                    del headers[bridge.TOKEN_HEADER]
                    status, _, _ = self.request("POST", endpoint, body="{}", headers=headers)
                    self.assertEqual(status, 401)
                    launch.assert_not_called()
                    folder.assert_not_called()

        with mock.patch.object(bridge, "launch_video_downloader", return_value={"message": "opened"}) as launch:
            status, _, body = self.request("POST", "/api/apps/ydl/launch",
                                          body='{"url":"https://www.youtube.com/watch?v=test"}',
                                          headers=self.api_headers())
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["message"], "opened")
            launch.assert_called_once_with({"url": "https://www.youtube.com/watch?v=test"})

    def test_video_jobs_are_private_and_parse_rejects_empty_links(self) -> None:
        self.assertEqual(self.request("GET", "/api/video/jobs")[0], 401)
        status, _, body = self.request("GET", "/api/video/jobs", headers={bridge.TOKEN_HEADER: self.token})
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body), {"jobs": []})
        status, _, _ = self.request("POST", "/api/video/parse", body="{}", headers=self.api_headers())
        self.assertEqual(status, 400)


class VideoDownloaderTests(unittest.TestCase):
    def test_missing_download_disk_prevents_ready_status_and_url_launch(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            app = root / "YDL GUI.app"
            binary = app / "Contents/MacOS/yt-dlp-gui"
            binary.parent.mkdir(parents=True)
            binary.write_text("test")
            binary.chmod(0o755)
            with (app / "Contents/Info.plist").open("wb") as handle:
                bridge.plistlib.dump({"CFBundleIdentifier": "com.imsyy.yt-dlp-gui"}, handle)
            directory = root / "mounted-downloads"
            directory.mkdir()
            config = {"appPath": str(app), "downloadsDirectory": str(directory),
                      "tools": {name: str(binary) for name in ("yt-dlp", "Deno", "FFmpeg", "FFprobe")}}
            with mock.patch.object(bridge, "video_downloader_config", return_value=config), mock.patch.object(
                bridge.sys, "platform", "darwin"
            ), mock.patch.object(bridge.subprocess, "Popen") as launch:
                self.assertTrue(bridge.video_downloader_status()["ready"])
                directory.rmdir()
                self.assertFalse(bridge.video_downloader_status()["ready"])
                with self.assertRaises(bridge.RequestError) as raised:
                    bridge.launch_video_downloader({"url": "https://example.com/video"})
                self.assertEqual(raised.exception.status, 503)
                launch.assert_not_called()

    def test_rejects_files_commands_credentials_and_extra_options(self) -> None:
        for payload in ([], {"url": 1}, {"url": "file:///etc/passwd"},
                        {"url": "--exec=command"}, {"url": "https://user:pass@example.com/video"},
                        {"url": "https://example.com/\n--exec=command"},
                        {"url": "https://example.com", "args": ["--exec", "command"]}):
            with self.subTest(payload=payload), self.assertRaises(bridge.RequestError):
                bridge.validate_video_launch_payload(payload)

    def test_launch_passes_url_as_one_argument_without_shell(self) -> None:
        url = "https://www.youtube.com/watch?v=test&list=a$(touch%20/tmp/nope)"
        config = {"appPath": "/Applications/YDL GUI.app"}
        status = {"installed": True, "ready": True, "downloadsDirectory": "/tmp/video downloads"}
        process = mock.Mock()
        process.wait.return_value = 0
        with mock.patch.object(bridge, "video_downloader_config", return_value=config), mock.patch.object(
            bridge, "video_downloader_status", return_value=status
        ), mock.patch.object(bridge.subprocess, "Popen", return_value=process) as launch:
            bridge.launch_video_downloader({"url": url})
        self.assertEqual(launch.call_args.args[0], [
            "/Applications/YDL GUI.app/Contents/MacOS/yt-dlp-gui",
            "--dir", "/tmp/video downloads", "--url", url,
        ])
        self.assertNotIn("shell", launch.call_args.kwargs)

    def test_missing_installation_cannot_report_success(self) -> None:
        with mock.patch.object(bridge, "video_downloader_status", return_value={"installed": False}):
            with self.assertRaises(bridge.RequestError) as raised:
                bridge.launch_video_downloader({})
            self.assertEqual(raised.exception.status, 503)

    def test_folder_action_cannot_open_caller_supplied_paths(self) -> None:
        with self.assertRaises(bridge.RequestError):
            bridge.open_video_download_folder({"path": "/etc"})

    def test_malformed_manifest_returns_unavailable(self) -> None:
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "video-downloader.json"
            path.write_text('{"appPath": 42, "tools": [], "downloadsDirectory": false}')
            with mock.patch.object(bridge, "YDL_CONFIG_PATH", path):
                status = bridge.video_downloader_status()
                self.assertFalse(status["installed"])
                self.assertFalse(status["ready"])
                self.assertTrue(all(not item["available"] for item in status["dependencies"]))


class VideoSettingsTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.config = self.root / "preferences" / "video-downloader.json"
        for patch in (
            mock.patch.object(bridge, "YDL_CONFIG_PATH", self.config),
            mock.patch.object(bridge.Path, "home", return_value=self.root),
            mock.patch.dict(bridge.VIDEO_DEPENDENCY_CHECKS, {}, clear=True),
            mock.patch.object(bridge, "VIDEO_SETUP_ERROR", ""),
            mock.patch.object(bridge.sys, "platform", "darwin"),
        ):
            patch.start()
            self.addCleanup(patch.stop)

    def save(self, config):
        self.config.parent.mkdir(exist_ok=True)
        self.config.write_text(json.dumps(config))

    def test_first_launch_creates_personal_default_and_reports_missing_dependencies(self):
        with mock.patch.object(bridge, "_video_tool_candidates", return_value=[]):
            status = bridge.initialize_video_downloader()["videoDownloader"]
        expected = self.root / "Downloads" / "设计工具箱"
        self.assertEqual(status["downloadsDirectory"], str(expected))
        self.assertTrue(expected.is_dir())
        self.assertTrue(status["directoryAvailable"])
        self.assertFalse(status["ready"])
        self.assertTrue(all(not item["available"] for item in status["dependencies"]))
        self.assertEqual(json.loads(self.config.read_text())["downloadsDirectory"], str(expected))

    def test_existing_offline_disk_and_other_preferences_survive_repeated_startup(self):
        offline = str(self.root / "offline-disk" / "videos")
        self.save({"downloadsDirectory": offline, "appPath": "/Applications/Custom.app"})
        with mock.patch.object(bridge, "_video_tool_candidates", return_value=[]):
            bridge.initialize_video_downloader()
            status = bridge.initialize_video_downloader()["videoDownloader"]
        self.assertEqual(status["downloadsDirectory"], offline)
        self.assertFalse(status["directoryAvailable"])
        self.assertFalse(Path(offline).exists())
        self.assertEqual(json.loads(self.config.read_text())["appPath"], "/Applications/Custom.app")

    def test_detection_executes_version_check_and_persists_working_programs(self):
        executable = self.root / "program with spaces"
        executable.write_text("#!/bin/sh\nprintf 'test-program 1.0\\n'\n")
        executable.chmod(0o755)
        with mock.patch.object(bridge, "_video_tool_candidates", return_value=[str(executable)]):
            result = bridge.initialize_video_downloader()["videoDownloader"]
        self.assertTrue(result["ready"])
        self.assertTrue(all(item["version"] == "test-program 1.0" for item in result["dependencies"]))
        executable.write_text("#!/bin/sh\nexit 1\n")
        with mock.patch.object(bridge, "_video_tool_candidates", return_value=[str(executable)]):
            result = bridge.initialize_video_downloader()["videoDownloader"]
        self.assertFalse(result["ready"])
        self.assertTrue(all(not item["available"] for item in result["dependencies"]))

    def test_candidates_include_path_gui_homebrew_and_adjacent_ffprobe(self):
        with mock.patch.object(bridge.shutil, "which", return_value="/test/path/ffprobe"):
            paths = bridge._video_tool_candidates("FFprobe", "/chosen/ffprobe", {"FFmpeg": "/paired/ffmpeg"})
        self.assertEqual(paths[:3], ["/chosen/ffprobe", "/paired/ffprobe", "/test/path/ffprobe"])
        self.assertIn("/opt/homebrew/bin/ffprobe", paths)
        self.assertIn(str(self.root / "Library/Application Support/com.imsyy.yt-dlp-gui/ffmpeg/ffprobe"), paths)

    def test_damaged_preferences_are_not_overwritten(self):
        self.save({})
        self.config.write_text("{damaged")
        with self.assertRaises(bridge.RequestError):
            bridge.initialize_video_downloader()
        self.assertEqual(self.config.read_text(), "{damaged")

    def test_browsing_does_not_save_preferences_or_expose_files(self):
        self.save({"downloadsDirectory": str(self.root), "tools": {"Deno": "/existing/deno"}})
        (self.root / "visible-folder").mkdir()
        (self.root / ".hidden-folder").mkdir()
        (self.root / "private-file.txt").write_text("not listed")
        original = self.config.read_bytes()
        result = bridge.list_video_directories({"directory": ""})
        names = [item["name"] for item in result["folders"]]
        self.assertIn("visible-folder", names)
        self.assertNotIn(".hidden-folder", names)
        self.assertNotIn("private-file.txt", names)
        self.assertEqual(self.config.read_bytes(), original)
        for payload in ({}, {"directory": "relative/path"}, {"directory": ""}, {"directory": []},
                        {"directory": str(self.root), "extra": True}):
            with self.subTest(payload=payload), self.assertRaises(bridge.RequestError):
                bridge.choose_video_download_folder(payload)
        self.assertEqual(self.config.read_bytes(), original)

    def test_picker_saves_writable_folder_without_changing_dependencies(self):
        selected = self.root / "新目录 ' $(literal)"
        selected.mkdir()
        self.save({"downloadsDirectory": "/old", "tools": {"Deno": "/existing/deno"}})
        result = bridge.choose_video_download_folder({"directory": str(selected)})
        self.assertEqual(result["videoDownloader"]["downloadsDirectory"], str(selected))
        self.assertEqual(json.loads(self.config.read_text())["tools"], {"Deno": "/existing/deno"})

    def test_unwritable_choice_keeps_previous_directory(self):
        self.save({"downloadsDirectory": "/previous"})
        with mock.patch.object(bridge.tempfile, "TemporaryFile", side_effect=PermissionError("read-only")):
            with self.assertRaises(bridge.RequestError):
                bridge.choose_video_download_folder({"directory": str(self.root)})
        self.assertEqual(json.loads(self.config.read_text())["downloadsDirectory"], "/previous")


class VideoJobTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.engine = self.root / "engine.py"
        self.manager = bridge.VideoJobManager()
        self.args_patch = mock.patch.object(bridge, "video_engine_args", return_value=[bridge.sys.executable, str(self.engine)])
        self.status_patch = mock.patch.object(bridge, "video_downloader_status",
                                             return_value={"directoryAvailable": True, "downloadsDirectory": str(self.root)})
        self.args_patch.start()
        self.status_patch.start()

    def tearDown(self) -> None:
        self.manager.close()
        self.status_patch.stop()
        self.args_patch.stop()
        self.temporary.cleanup()

    def wait_finished(self, job_id):
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            job = next(job for job in self.manager.snapshot()["jobs"] if job["id"] == job_id)
            if job["status"] not in self.manager.ACTIVE:
                return job
            time.sleep(0.02)
        self.fail("Job did not complete")

    def test_completed_folder_reveals_actual_file_after_default_changes(self):
        video = self.root / "actual.mp4"
        video.write_bytes(b"saved")
        job = self.manager._new("download", "https://example.com/video", directory=str(self.root),
                                filePath=str(video))
        self.manager._update(job, status="complete")
        with mock.patch.object(bridge, "video_downloader_status",
                               return_value={"downloadsDirectory": "/new/default"}), \
             mock.patch.object(bridge.sys, "platform", "darwin"), \
             mock.patch.object(bridge.subprocess, "run") as run:
            self.manager.open_folder({"id": job["id"]})
            self.assertEqual(run.call_args.args[0], ["/usr/bin/open", "-R", str(video)])
            video.unlink()
            with self.assertRaises(bridge.RequestError) as raised:
                self.manager.open_folder({"id": job["id"]})
            self.assertEqual(raised.exception.status, 404)
            self.assertEqual(run.call_count, 1)

    def test_folder_action_rejects_unfinished_unknown_or_caller_supplied_paths(self):
        job = self.manager._new("download", "https://example.com/video")
        with mock.patch.object(bridge.subprocess, "run") as run:
            for payload in ({}, {"id": []}, {"id": "unknown"}, {"id": job["id"]},
                            {"id": job["id"], "path": "/arbitrary"}):
                with self.subTest(payload=payload), self.assertRaises(bridge.RequestError):
                    self.manager.open_folder(payload)
            run.assert_not_called()

    def test_metadata_offers_real_heights_and_rejects_live_or_playlist(self):
        video = bridge.summarize_video({"title": "test", "formats": [{"height": 1080}, {"height": 720}, {"height": 1080}]})
        self.assertEqual([item["id"] for item in video["qualities"]], ["best", "1080", "720"])
        for info in ({"_type": "playlist"}, {"is_live": True}):
            with self.assertRaises(bridge.RequestError):
                bridge.summarize_video(info)

    def test_parse_then_download_records_only_real_saved_file(self):
        self.engine.write_text(
            "import json, sys\nfrom pathlib import Path\n"
            "if '--dump-single-json' in sys.argv:\n"
            " print(json.dumps({'title':'Sample', 'formats':[{'height':720}]}))\n"
            "else:\n"
            " path=Path(sys.argv[sys.argv.index('-P')+1])/'sample.mp4'\n"
            " path.write_bytes(b'test media')\n"
            " print('__DT_PROGRESS__'+json.dumps({'downloaded_bytes':5,'total_bytes':10,'speed':5,'eta':1}))\n"
            " print('__DT_FILE__'+json.dumps(str(path)))\n")
        parsed = self.manager.parse({"url": "https://example.com/video"})["job"]
        parsed = self.wait_finished(parsed["id"])
        self.assertEqual(parsed["status"], "ready")
        with self.assertRaises(bridge.RequestError):
            self.manager.download({"parseId": parsed["id"], "quality": "720; --exec evil"})
        with self.assertRaises(bridge.RequestError):
            self.manager.download({"parseId": parsed["id"], "quality": "720", "path": "/elsewhere"})
        with mock.patch.object(self.manager, "_probe_video", return_value={
            "video": {"codec_name": "h264", "pix_fmt": "yuv420p"},
            "audio": {"codec_name": "aac", "profile": "LC"}, "duration": 1,
        }):
            download = self.manager.download({"parseId": parsed["id"], "quality": "720"})["job"]
            download = self.wait_finished(download["id"])
        self.assertEqual(download["status"], "complete")
        self.assertEqual(Path(download["filePath"]), (self.root / "sample.mp4").resolve())
        self.assertEqual(download["bytes"], 10)
        self.assertNotIn("_process", download)

    def test_exit_zero_without_output_file_is_not_success(self):
        self.engine.write_text("pass\n")
        job = self.manager._new("download", "https://example.com/video", directory=str(self.root), title="Missing")
        self.manager._download_worker(job, [bridge.sys.executable, str(self.engine)], "bv*+ba/b")
        self.assertEqual(job["status"], "error")
        self.assertIn("未找到完整", job["error"])

    def test_cancel_stops_a_running_parser_and_cannot_be_overwritten(self):
        self.engine.write_text("import time\ntime.sleep(30)\n")
        parsed = self.manager.parse({"url": "https://example.com/video"})["job"]
        deadline = time.monotonic() + 3
        process = None
        while time.monotonic() < deadline:
            with self.manager._lock:
                process = self.manager._jobs[parsed["id"]].get("_process")
            if process is not None:
                break
            time.sleep(0.02)
        self.assertIsNotNone(process)
        self.manager.cancel({"id": parsed["id"]})
        self.assertIsNotNone(process.poll())
        self.assertEqual(self.wait_finished(parsed["id"])["status"], "cancelled")

    def test_mp4_extension_does_not_make_vp9_av1_or_high_bit_depth_compatible(self):
        for codec, pixels, audio, expected in (
            ("h264", "yuv420p", {"codec_name": "aac", "profile": "LC"}, (True, True)),
            ("vp9", "yuv420p", {"codec_name": "aac", "profile": "LC"}, (False, True)),
            ("av1", "yuv420p", {"codec_name": "opus"}, (False, False)),
            ("h264", "yuv420p10le", None, (False, True)),
            ("h264", "yuv420p", {"codec_name": "aac", "profile": "HE-AAC"}, (True, False)),
        ):
            with self.subTest(codec=codec, pixels=pixels, audio=audio):
                self.assertEqual(self.manager._compatible_streams({
                    "video": {"codec_name": codec, "pix_fmt": pixels}, "audio": audio,
                }), expected)

    def test_compatible_file_skips_transcode_and_preserves_original_bytes(self):
        source = self.root / "already-compatible.mp4"
        source.write_bytes(b"original file")
        job = self.manager._new("download", "https://example.com", directory=str(self.root))
        with mock.patch.object(self.manager, "_probe_video", return_value={
            "video": {"codec_name": "h264", "pix_fmt": "yuv420p"},
            "audio": None, "duration": 1,
        }), mock.patch.object(bridge.subprocess, "Popen") as launch:
            self.manager._ensure_playable_video(job, source)
        launch.assert_not_called()
        self.assertEqual(source.read_bytes(), b"original file")
        self.assertFalse((self.root / ".originals").exists())

    def test_failed_conversion_keeps_source_and_removes_only_its_temporary_file(self):
        source = self.root / "vp9.mp4"
        source.write_bytes(b"original VP9 file")
        job = self.manager._new("download", "https://example.com", directory=str(self.root))
        process = mock.Mock()
        process.stdout = io.StringIO("Encoder failed\n")
        process.stderr = None
        process.wait.return_value = 1
        process.poll.return_value = 1
        with mock.patch.object(self.manager, "_probe_video", return_value={
            "video": {"codec_name": "vp9", "pix_fmt": "yuv420p"},
            "audio": None, "duration": 1,
        }), mock.patch.object(bridge, "video_downloader_config", return_value={"tools": {"FFmpeg": "/fake/ffmpeg"}}), mock.patch.object(
            bridge.subprocess, "Popen", return_value=process
        ):
            with self.assertRaises(bridge.RequestError):
                self.manager._ensure_playable_video(job, source)
        self.assertEqual(source.read_bytes(), b"original VP9 file")
        self.assertFalse((self.root / ".originals").exists())
        self.assertEqual(list(self.root.glob(".video-compatible-*")), [])


if __name__ == "__main__":
    unittest.main()
