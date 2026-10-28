#!/usr/bin/env bash
# 一键安装入口（Linux 命令行 / 自解压包内）。等价于运行 setup.sh。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
cd "$HERE"
exec ./setup.sh
