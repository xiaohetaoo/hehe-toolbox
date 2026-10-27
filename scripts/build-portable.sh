#!/bin/bash
# 便携版构建
#
# 为什么中间产物不放 dist/：
#   本机 DSH 文件观察器会**持续持有** dist/win-unpacked/resources/app.asar，
#   导致 electron-builder 无法 unlink 旧 asar（EBUSY: resource busy or locked），
#   且该文件在 DSH 运行期间连重命名/删除都做不到。
#   所以：中间产物（win-unpacked）在工作区外的暂存目录构建，
#   只把最终的 Portable .exe 拷进 dist/ —— 产物位置符合要求，同时绕开文件锁。
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

mkdir -p "$DEST_SH" 2>/dev/null

for i in $(seq 1 "$RETRIES"); do
  echo "=== 构建尝试 $i/$RETRIES ===" | tee -a "$LOG"
  echo "    暂存: $STAGE" | tee -a "$LOG"
  echo "    产物: $DEST" | tee -a "$LOG"
  if npx electron-builder --win portable "--config.directories.output=$STAGE" >>"$LOG" 2>&1; then
    echo "=== 构建成功，拷贝产物到 $DEST ===" | tee -a "$LOG"
    cp -f "$STAGE_SH"/*.exe "$DEST_SH"/ 2>>"$LOG"
    # 尽力清理暂存目录（被锁也不影响产物）
    rm -rf "$STAGE_SH" 2>/dev/null
    ls -lh "$DEST_SH"/*.exe 2>/dev/null
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
