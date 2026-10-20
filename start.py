#!/usr/bin/env python3
"""Start the prebuilt local toolbox; no Node.js or frontend build is required."""
import runpy
from pathlib import Path

runpy.run_path(str(Path(__file__).resolve().parent / "workbench/skill-package/start.py"), run_name="__main__")
