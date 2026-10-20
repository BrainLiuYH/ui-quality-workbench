"""Opt-in network smoke test, isolated from the user's installed tools/settings."""
import importlib.util
import json
from pathlib import Path
import tempfile
import time

path = Path(__file__).resolve().parents[1] / 'skill-package/scripts/serve_workbench.py'
spec = importlib.util.spec_from_file_location('bootstrap_smoke', path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)

with tempfile.TemporaryDirectory(prefix='toolbox-install-') as temporary:
    root = Path(temporary)
    (root/'downloads').mkdir()
    bridge.YDL_CONFIG_PATH = root/'video-downloader.json'
    bridge.YDL_CONFIG_PATH.write_text(json.dumps({'downloadsDirectory': str(root/'downloads')}), encoding='utf-8')
    suffix = '.exe' if bridge.sys.platform == 'win32' else ''
    binaries = {'yt-dlp':'yt-dlp','Deno':'deno','FFmpeg':'ffmpeg','FFprobe':'ffprobe'}
    bridge._video_tool_candidates = lambda name, *_: [str(root/'bin'/(binaries[name]+suffix))]
    bridge.initialize_video_downloader()
    assert not bridge.video_downloader_status()['ready']
    bridge.start_video_dependency_install()
    while bridge.VIDEO_INSTALL_STATE['status'] == 'installing':
        print(json.dumps(bridge.VIDEO_INSTALL_STATE,ensure_ascii=False),flush=True)
        time.sleep(10)
    status = bridge.video_downloader_status()
    print(json.dumps(status,ensure_ascii=False),flush=True)
    assert status['ready'],status
    assert status['downloadsDirectory'] == str(root/'downloads')
    def no_download():
        raise AssertionError('A repeated launch must reuse installed dependencies')
    bridge.dependency_installer = no_download
    bridge.initialize_video_downloader()
    bridge.start_video_dependency_install()
    assert bridge.video_downloader_status()['ready']
    print('Clean installation and reuse verified.',flush=True)
