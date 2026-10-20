#!/usr/bin/env python3
"""Launch the complete local toolbox and optionally open its browser page."""
import runpy
import sys
from pathlib import Path

if sys.version_info < (3, 9):
    raise SystemExit("Design Toolbox requires Python 3.9 or newer.")
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, "reconfigure"):
        stream.reconfigure(encoding="utf-8", errors="replace")
if "--no-open" in sys.argv:
    sys.argv.remove("--no-open")
elif not any(flag in sys.argv for flag in ("--check", "--install-only", "--open")):
    sys.argv.append("--open")
runpy.run_path(str(Path(__file__).resolve().parent / "scripts/serve_workbench.py"), run_name="__main__")
