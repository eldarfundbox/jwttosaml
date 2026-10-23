"""
One-command launcher for the Python MCP -> JWT -> SAML 2.0 -> SAP Demo.
Usage:
  python run_demo.py          # Starts SAP + Flow Studio UI and opens browser
  python run_demo.py --cli    # Runs the CLI demo in the terminal and exits
"""
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
VENV_PYTHON = (
    ROOT / ".venv" / "Scripts" / "python.exe"
    if os.name == "nt"
    else ROOT / ".venv" / "bin" / "python"
)


def ensure_venv_and_run() -> None:
    # Re-exec inside .venv automatically if invoked with system Python
    if VENV_PYTHON.exists() and Path(sys.executable).resolve() != VENV_PYTHON.resolve():
        cmd = [str(VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]]
        raise SystemExit(subprocess.call(cmd, cwd=str(ROOT)))

    if "--cli" in sys.argv:
        from src.demo import run_demo
        import asyncio

        asyncio.run(run_demo())
    else:
        if "--open" not in sys.argv:
            sys.argv.append("--open")
        import runpy

        runpy.run_module("src.sap_service", run_name="__main__")


if __name__ == "__main__":
    ensure_venv_and_run()

