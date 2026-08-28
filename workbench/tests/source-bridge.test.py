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


if __name__ == "__main__":
    unittest.main()
