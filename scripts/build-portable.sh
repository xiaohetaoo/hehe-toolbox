#!/bin/bash
# 构建产物：便携版单 exe（portable）+ 免安装目录版 zip
#
# 【为什么要 zip】
#   便携版单 exe 每次启动都要把整个 Electron 解压到临时目录，实测 9.5~16 秒；
#   免安装目录版解压一次后，之后每次启动只要 0.9 秒（快 10 倍）。
#   两者都发：便携版给「拿来就用」的人，zip 给「在意启动速度」的人。
#
# 【为什么不直接用 electron-builder 的 zip target】
#   electron-builder 26 的配置 schema 里没有 root 级 `zip` 配置项，
#   默认产名会是「核核工具箱-0.0.10-win.zip」——含中文，GitHub asset 名要求 ASCII。
#   所以这里用 electron-builder 只出 portable（顺带产出 win-unpacked），
#   再由本脚本用 7za 把 win-unpacked 压成 ASCII 命名的 zip。
#
# 【为什么中间产物不放 dist/】
#   本机 DSH 文件观察器会**持续持有** dist/win-unpacked/resources/app.asar，
#   导致 electron-builder 无法 unlink 旧 asar（EBUSY: resource busy or locked），
#   且该文件在 DSH 运行期间连重命名/删除都做不到。
#   所以：中间产物（win-unpacked）在工作区外的暂存目录构建，
#   只把最终产物（Portable .exe + zip）拷进 dist/ —— 产物位置符合要求，同时绕开文件锁。
#
# 用法：build-portable.sh [产物目录] [重试次数]
set -u
DEST="${1:-D:/zcode/hehe/dist}"
RETRIES="${2:-3}"
# 暂存目录必须在工作区之外，否则同样会被观察器锁住
STAGE="D:/zcode/.hehe-build-stage"
cd /d/zcode/hehe || exit 1
unset ELECTRON_RUN_AS_NODE
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

LOG="${LOCALAPPDATA:-/tmp}/Temp/hehe-build.log"
DEST_SH="$(echo "$DEST" | sed 's|^\([A-Za-z]\):|/\L\1|')"
STAGE_SH="$(echo "$STAGE" | sed 's|^\([A-Za-z]\):|/\L\1|')"

VERSION="$(node -p "require('./package.json').version")"
ZIP_NAME="hehe-toolbox-${VERSION}-win-x64.zip"
SEVENZA="$(node -p "require('7zip-bin').path7za")"

mkdir -p "$DEST_SH" 2>/dev/null

pack_zip() {
  # 把 win-unpacked 压成 zip：-mx=5 兼顾体积与解压速度（解压快才是 zip 的意义）
  local src="$STAGE_SH/win-unpacked"
  [ -d "$src" ] || { echo "=== 找不到 $src，跳过 zip ===" | tee -a "$LOG"; return 1; }
  echo "=== 打包免安装目录版 $ZIP_NAME ===" | tee -a "$LOG"
  rm -f "$DEST_SH/$ZIP_NAME" 2>/dev/null
  # 在暂存目录里跑，保证 zip 内是「顶层直接是 exe」而不是嵌套 win-unpacked 目录
  ( cd "$src" && "$SEVENZA" a -tzip -mx=5 "$DEST_SH/$ZIP_NAME" . >/dev/null ) || {
    echo "=== zip 打包失败 ===" | tee -a "$LOG"; return 1; }
  return 0
}

for i in $(seq 1 "$RETRIES"); do
  echo "=== 构建尝试 $i/$RETRIES ===" | tee -a "$LOG"
  echo "    暂存: $STAGE" | tee -a "$LOG"
  echo "    产物: $DEST" | tee -a "$LOG"
  if npx electron-builder --win portable "--config.directories.output=$STAGE" >>"$LOG" 2>&1; then
    echo "=== 构建成功，拷贝产物到 $DEST ===" | tee -a "$LOG"
    cp -f "$STAGE_SH"/*.exe "$DEST_SH"/ 2>>"$LOG"
    pack_zip
    # 尽力清理暂存目录（被锁也不影响产物）
    rm -rf "$STAGE_SH" 2>/dev/null
    ls -lh "$DEST_SH"/*.exe "$DEST_SH"/*.zip 2>/dev/null
    exit 0
  fi
  # 判断是否资源占用：是则等待后重试，否则直接失败
  if grep -qE "EBUSY|EPERM|resource busy or locked|Device or resource busy" "$LOG"; then
    WAIT=$(( i * 10 ))
    echo "=== 资源被占用，${WAIT}s 后重试 ===" | tee -a "$LOG"
    sleep "$WAIT"
    rm -rf "$STAGE_SH" 2>/dev/null
  else
    echo "=== 构建失败（非占用问题），终止 ===" | tee -a "$LOG"
    tail -20 "$LOG"
    exit 1
  fi
done
echo "=== 重试 $RETRIES 次仍因资源占用失败 ===" | tee -a "$LOG"
tail -20 "$LOG"
exit 1
