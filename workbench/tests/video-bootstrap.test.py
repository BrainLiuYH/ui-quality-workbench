#!/usr/bin/env python3
import hashlib
import gzip
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock
import zipfile

SCRIPTS = Path(__file__).resolve().parents[1] / 'scripts'
def module(name):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / (name + '.py'))
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result
installer = module('install_video_dependencies')
bridge = module('serve_workbench')

class BootstrapTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.config = self.root / 'video-downloader.json'
        for patch in [mock.patch.object(bridge, 'YDL_CONFIG_PATH', self.config),
                      mock.patch.object(bridge.Path, 'home', return_value=self.root),
                      mock.patch.dict(bridge.VIDEO_DEPENDENCY_CHECKS, {}, clear=True),
                      mock.patch.dict(bridge.VIDEO_INSTALL_STATE, {'status':'idle','message':'','percent':None,'errors':[]}, clear=True),
                      mock.patch.object(bridge,'VIDEO_SETUP_ERROR','')]:
            patch.start();self.addCleanup(patch.stop)

    def test_config_uses_windows_local_app_data_and_keeps_legacy(self):
        with mock.patch.object(bridge.sys, 'platform', 'win32'), mock.patch.dict(os.environ, {'LOCALAPPDATA':str(self.root/'local')}):
            self.assertEqual(bridge.video_config_path(),self.root/'local/DesignToolbox/video-downloader.json')
            legacy=self.root/'Library/Application Support/DesignToolbox/video-downloader.json'
            legacy.parent.mkdir(parents=True);legacy.write_text('{}')
            self.assertEqual(bridge.video_config_path(),legacy)

    def test_windows_candidates_use_exe_and_discover_winget_without_new_path(self):
        installed=self.root/'Microsoft/WinGet/Packages/Gyan.FFmpeg_test/ffmpeg-release/bin/ffprobe.exe'
        installed.parent.mkdir(parents=True);installed.touch()
        with mock.patch.object(bridge.sys,'platform','win32'), mock.patch.dict(os.environ,{'LOCALAPPDATA':str(self.root)}):
            paths=bridge._video_tool_candidates('FFprobe',None,{'FFmpeg':str(installed.with_name('ffmpeg.exe'))})
        self.assertIn(str(installed),paths)
        self.assertIn(str(self.root/'bin/ffprobe.exe'),paths)
        self.assertFalse(any(path.endswith('/ffprobe') for path in paths))

    def test_windows_opens_folder_with_native_shell(self):
        with mock.patch.object(bridge.sys,'platform','win32'), mock.patch.object(bridge.os,'startfile',create=True) as open_folder:
            bridge.reveal_video_directory(self.root,self.root/'test.mp4')
        open_folder.assert_called_once_with(str(self.root))

    @unittest.skipUnless(os.name == 'nt','Native Windows drive discovery')
    def test_native_windows_drive_shortcuts(self):
        self.assertIn(Path.home().anchor,[item['directory'] for item in bridge.windows_drive_shortcuts()])

    def test_mac_and_windows_platform_selection(self):
        for host, arch, expected in [('darwin','arm64',('macos','aarch64')),('darwin','x86_64',('macos','x86_64')),('win32','AMD64',('windows','x86_64'))]:
            with mock.patch.object(installer.sys,'platform',host),mock.patch.object(installer.platform,'machine',return_value=arch):
                self.assertEqual(installer.platform_spec(),expected)
        with mock.patch.object(installer.platform,'machine',return_value='unknown'), self.assertRaises(RuntimeError):
            installer.platform_spec()

    def test_download_rejects_bad_hash_and_untrusted_redirect(self):
        for url in ['http://github.com/file','https://evil.example/file','https://github.com@evil.example/file']:
            with self.assertRaises(RuntimeError):installer.validate_url(url)
        class Response(io.BytesIO):
            headers={'Content-Length':'4'}
        for digest,valid in [('0'*64,False),(hashlib.sha256(b'data').hexdigest(),True)]:
            with mock.patch.object(installer,'open_download',return_value=Response(b'data')):
                if valid:installer.download_verified({'url':'https://github.com/file','sha256':digest},self.root/'download',mock.Mock())
                else:
                    with self.assertRaises(RuntimeError):installer.download_verified({'url':'https://github.com/file','sha256':digest},self.root/'download',mock.Mock())

    def test_gzip_extraction_and_architecture_use_known_release_assets(self):
        archive=self.root/'program.gz'
        with gzip.open(archive,'wb') as handle:handle.write(b'program')
        installer.unpack_gzip(archive,self.root/'program')
        self.assertEqual((self.root/'program').read_bytes(),b'program')
        with mock.patch.object(installer,'github_asset',return_value={}) as asset:
            installer.resolve_asset('FFprobe','macos','aarch64')
            asset.assert_called_with('eugeneware/ffmpeg-static','ffprobe-darwin-arm64.gz')
            installer.resolve_asset('Deno','windows','x86_64')
            asset.assert_called_with('denoland/deno','deno-x86_64-pc-windows-msvc.zip')

    def test_connection_retries_are_bounded(self):
        opener=mock.Mock();opener.open.side_effect=[installer.URLError('timeout'),io.BytesIO(b'ok')]
        with mock.patch.object(installer,'build_opener',return_value=opener),mock.patch.object(installer.time,'sleep'):
            self.assertEqual(installer.open_download('https://github.com/file').read(),b'ok')
            opener.open.side_effect=installer.URLError('offline')
            with self.assertRaises(installer.URLError):installer.open_download('https://github.com/file')
        self.assertEqual(opener.open.call_count,5)

    def test_archive_cannot_write_paths_from_zip(self):
        archive=self.root/'archive.zip'
        with zipfile.ZipFile(archive,'w') as package:
            package.writestr('../../outside','bad');package.writestr('../../deno','program')
        installer.unpack_binary(archive,'deno',self.root/'fixed-binary')
        self.assertEqual((self.root/'fixed-binary').read_bytes(),b'program')
        self.assertFalse((self.root/'outside').exists())
        with zipfile.ZipFile(archive,'a') as package:package.writestr('other/deno','duplicate')
        with self.assertRaises(RuntimeError):installer.unpack_binary(archive,'deno',self.root/'fixed-binary')

    def test_failed_verification_never_replaces_existing_program_or_calls_installed(self):
        (self.root/'deno').write_bytes(b'previous')
        def download(asset,path,progress):
            with zipfile.ZipFile(path,'w') as package:package.writestr('deno',b'new')
        with mock.patch.object(installer,'platform_spec',return_value=('macos','aarch64')),mock.patch.object(installer,'resolve_asset',return_value={'url':'https://github.com/tool.zip'}),mock.patch.object(installer,'download_verified',side_effect=download),mock.patch.object(installer,'verify_binary',side_effect=RuntimeError('invalid architecture')):
            callback=mock.Mock();errors=installer.install_missing(['Deno'],self.root,mock.Mock(),callback)
        self.assertIn('invalid architecture',errors[0]);callback.assert_not_called()
        self.assertEqual((self.root/'deno').read_bytes(),b'previous')
        self.assertFalse(list(self.root.glob('.setup-*')))

    def test_install_preserves_latest_directory_and_other_tools(self):
        initial={'downloadsDirectory':str(self.root/'disk'),'tools':{'yt-dlp':'original'}}
        self.config.write_text(json.dumps(initial))
        def install(missing,destination,progress,installed):
            # Simulate a user changing the folder while a dependency downloads.
            changed={**initial,'downloadsDirectory':str(self.root/'changed')}
            self.config.write_text(json.dumps(changed))
            installed('Deno',str(self.root/'bin/deno'));return []
        fake=mock.Mock();fake.install_missing.side_effect=install
        with mock.patch.object(bridge,'dependency_installer',return_value=fake),mock.patch.object(bridge,'initialize_video_downloader'),mock.patch.object(bridge,'video_downloader_status',return_value={'dependencies':[]}):
            bridge._install_video_dependencies(['Deno'])
        saved=json.loads(self.config.read_text())
        self.assertEqual(saved['downloadsDirectory'],str(self.root/'changed'))
        self.assertEqual(saved['tools']['yt-dlp'],'original');self.assertEqual(saved['tools']['Deno'],str(self.root/'bin/deno'))
        self.assertEqual(bridge.VIDEO_INSTALL_STATE['status'],'complete')

    def test_existing_healthy_dependencies_and_duplicate_installs_do_not_spawn(self):
        with mock.patch.object(bridge,'video_downloader_status',return_value={'dependencies':[{'name':'Deno','available':True}]}),mock.patch.object(bridge.threading,'Thread') as thread:
            bridge.start_video_dependency_install();thread.assert_not_called()
            bridge.VIDEO_INSTALL_STATE['status']='installing';bridge.start_video_dependency_install();thread.assert_not_called()
        with self.assertRaises(bridge.RequestError):bridge.start_video_dependency_install({'url':'https://attacker.example'})

    def test_two_links_are_rejected_with_actionable_error(self):
        with self.assertRaisesRegex(bridge.RequestError,'一个视频'):
            bridge.validate_video_launch_payload({'url':'https://youtube.com/shorts/one https://youtube.com/shorts/two'})

if __name__=='__main__':unittest.main()
