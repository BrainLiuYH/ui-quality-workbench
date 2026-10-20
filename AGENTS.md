# Installing and launching Design Toolbox

When a user provides this repository URL and asks to install or open the toolbox:

1. Use the prebuilt local application in `workbench/skill-package`. If installing
   it as a Skill, copy the complete package including `start.py`, launchers,
   `scripts`, `assets`, and `references`; preserve the user's existing preferences.
2. Identify the host operating system. The launcher needs Python 3.9 or newer.
   Run `py -3 start.py --check` on Windows, or `python3 start.py --check` on macOS,
   from the repository root or the installed Skill directory.
3. Start that same `start.py` as a long-running local process. Add `--no-open`
   when you will open its returned URL with a browser tool. Otherwise it opens
   the browser automatically. Windows users can also use `start-windows.cmd`.
4. Wait for the JSON event `ready` and open its URL. Dependency checks may take
   about a minute on a cold start. Keep the process alive. Confirm the video page
   has connected and report any missing dependency by name.
5. The normal launcher automatically installs missing yt-dlp, Deno, FFmpeg and
   FFprobe in the user configuration directory. Keep it alive until all four
   dependencies are available; a ready page alone is not a completed installation.
   For installation before opening, run `start.py --install-only`. If networking
   is restricted, explain the specific failure and retry with authorized access.
   `--no-install` disables automatic installation; `--check` never installs.

`pnpm dev`, a static preview server, hosted previews, or opening `index.html`
only serve the frontend. They cannot run video downloads, local file operations,
or the source bridge, and must not be reported as a complete installation.
Never remove session-token, Host, Origin, or loopback protections to make a
preview appear connected. Preserve machine-specific preferences outside Git.

For implementation work in `workbench/`, also follow `workbench/AGENTS.md`.
