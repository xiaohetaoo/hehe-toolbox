#!/bin/bash
# 构建产物：便携版单 exe（portable）+ 免安装目录版 zip
#
# 【为什么要 zip】
#   便携版单 exe 每次启动都要把整个 Electron 解压到临时目录，实测 6~16 秒；
#   免安装目录版解压一次后，之后每次启动只要 ~1.15 秒（快约 10 倍）。
#   两者都发：便携版给「拿来就用」的人，zip 给「在意启动速度」的人。
#
# 【zip 为什么由 scripts/pack-zip.js 生成】
#   electron-builder 26 的 schema 没有 root 级 `zip` 配置项，默认产名含中文
#   （GitHub asset 要 ASCII）。打包逻辑放在 pack-zip.js 里，本地构建与
#   GitHub Actions（npm run dist）复用同一份实现，不会两边不一致。
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

mkdir -p "$DEST_SH" 2>/dev/null

pack_zip() {
  # 复用 pack-zip.js：在暂存区里压，直接输出到 dist
  [ -d "$STAGE_SH/win-unpacked" ] || { echo "=== 找不到 win-unpacked，跳过 zip ===" | tee -a "$LOG"; return 1; }
  echo "=== 打包免安装目录版 $ZIP_NAME ===" | tee -a "$LOG"
  if node scripts/pack-zip.js "$STAGE/win-unpacked" "$DEST" >>"$LOG" 2>&1; then
    return 0
  fi
  echo "=== zip 打包失败 ===" | tee -a "$LOG"
  tail -5 "$LOG"
  return 1
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
