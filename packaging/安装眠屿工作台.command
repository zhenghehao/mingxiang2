#!/bin/zsh
set -e

installer_dir="$(cd "$(dirname "$0")" && pwd)"
runtime="$installer_dir/眠屿工作台.app/Contents/Resources/runtime/node"

if [[ ! -x "$runtime" ]]; then
  /usr/bin/osascript -e 'display alert "安装包不完整" message "找不到 Intel 版运行环境，请重新复制安装包。" as critical'
  exit 1
fi

exec "$runtime" "$installer_dir/installer.mjs" "$installer_dir"
