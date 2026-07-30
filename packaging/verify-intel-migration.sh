#!/bin/zsh
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
zip_path="/Users/shareit/Desktop/冥想一键工作流2-Intel-完整迁移包-含API.zip"
stage_name="冥想一键工作流2-Intel-完整迁移包-含API"
extract_root="$(/usr/bin/mktemp -d /tmp/meditation-workflow2-verify.XXXXXX)"
test_root="$(/usr/bin/mktemp -d /tmp/meditation-workflow2-runtime.XXXXXX)"
server_pid=""
agnes_pid=""

cleanup() {
  [[ -n "$server_pid" ]] && /bin/kill "$server_pid" >/dev/null 2>&1 || true
  [[ -n "$agnes_pid" ]] && /bin/kill "$agnes_pid" >/dev/null 2>&1 || true
  [[ "$extract_root" == /tmp/meditation-workflow2-verify.* ]] && /bin/rm -rf "$extract_root"
  [[ "$test_root" == /tmp/meditation-workflow2-runtime.* ]] && /bin/rm -rf "$test_root"
}
trap cleanup EXIT

[[ -s "$zip_path" ]] || { print -u2 -- "找不到迁移包：$zip_path"; exit 1; }
/usr/bin/unzip -qq "$zip_path" -d "$extract_root"
package_root="$extract_root/$stage_name"
app="$package_root/眠屿工作台.app"
runtime="$app/Contents/Resources/runtime/node"
app_root="$app/Contents/Resources/app"

/usr/bin/codesign --verify --deep --strict "$app"

for required in \
  "$runtime" \
  "$app_root/node_modules/ffmpeg-static/ffmpeg" \
  "$app_root/node_modules/ffprobe-static/bin/darwin/x64/ffprobe" \
  "$app_root/extensions/draft-publisher/runtime/python/bin/python3.11" \
  "$app_root/extensions/draft-publisher/app/db/database.db" \
  "$package_root/credentials/.minimax-subscription-key" \
  "$package_root/credentials/.minimax-api-key" \
  "$package_root/credentials/.text-provider-api-key" \
  "$package_root/credentials/auth.json" \
  "$package_root/credentials/config.toml" \
  "$package_root/credentials/config.json" \
  "$package_root/credentials/hermes.env"; do
  [[ -s "$required" ]] || { print -u2 -- "迁移包缺少：${required#$package_root/}"; exit 1; }
done

while IFS= read -r -d '' file; do
  description="$(/usr/bin/file -b "$file")"
  if [[ "$description" == *"Mach-O"* && "$description" != *"x86_64"* ]]; then
    print -u2 -- "发现非 x86_64 Mach-O：${file#$package_root/}"
    exit 1
  fi
done < <(/usr/bin/find "$package_root" -type f -print0)

cd "$package_root"
/usr/bin/grep -E '^[0-9a-f]{64}  ' "文件清单与SHA-256.txt" \
  | /usr/bin/shasum -a 256 -c - >/dev/null

config_source="$app_root/data/config.json"
config_test="$test_root/config.json"
APP_PATH="$app" CONFIG_SOURCE="$config_source" CONFIG_TEST="$config_test" TEST_DIR="$test_root" \
  "$runtime" "$project_root/packaging/write-test-config.mjs"

"$runtime" "$app_root/agnes/cors-proxy.js" 8898 >"$test_root/agnes.log" 2>&1 &
agnes_pid=$!
for _attempt in {1..120}; do
  if /usr/bin/curl --silent --fail --max-time 2 http://127.0.0.1:8898/bridge/health >/dev/null; then
    break
  fi
  /bin/sleep 0.25
done

SLEEPFLOW_CONFIG_FILE="$config_test" SLEEPFLOW_DRAFT_PORT=5419 \
  "$runtime" "$app_root/server.mjs" >"$test_root/server.log" 2>&1 &
server_pid=$!
for _attempt in {1..160}; do
  if /usr/bin/curl --silent --fail --max-time 2 \
    http://127.0.0.1:4329/api/status >"$test_root/status.json"; then
    break
  fi
  /bin/sleep 0.25
done

STATUS_FILE="$test_root/status.json" "$runtime" "$project_root/packaging/check-test-status.mjs"
print -r -- "INTEL_PACKAGE_VERIFIED=yes"
