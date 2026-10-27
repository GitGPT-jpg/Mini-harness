#!/usr/bin/env python3
"""Validate the loop-ui goal: loop-ui.txt must contain exactly 'OK'."""
import sys
from pathlib import Path

def main() -> int:
    target = Path(__file__).parent / "loop-ui.txt"
    if not target.exists():
        print(f"FAIL: {target.name} does not exist")
        return 1
    content = target.read_text(encoding="utf-8").strip()
    if content != "OK":
        print(f"FAIL: expected 'OK', got {content!r}")
        return 1
    print("PASS: loop-ui.txt contains OK")
    return 0

if __name__ == "__main__":
    sys.exit(main())
