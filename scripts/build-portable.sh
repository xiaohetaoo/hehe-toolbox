#!/bin/bash
# 便携版构建：带文件锁重试（本机常见 EBUSY：app.asar 被外部进程观察/扫描）
# 用法：build-portable.sh <输出目录> [重试次数]
set -u
OUT="${1:-D:/zcode/hehe-out8}"
RETRIES="${2:-3}"
cd /d/zcode/hehe || exit 1
unset ELECTRON_RUN_AS_NODE
export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

LOG="${LOCALAPPDATA:-/tmp}/Temp/hehe-build.log"
for i in $(seq 1 "$RETRIES"); do
  echo "=== 构建尝试 $i/$RETRIES → $OUT ===" | tee -a "$LOG"
  if npx electron-builder --win portable "--config.directories.output=$OUT" >>"$LOG" 2>&1; then
    echo "=== 构建成功 ===" | tee -a "$LOG"
    ls -lh "$(echo "$OUT" | sed 's|^D:|/d|')"/*.exe 2>/dev/null
    exit 0
  fi
  # 判断是否资源占用：是则等待后重试，否则直接失败
  if grep -qE "EBUSY|EPERM|resource busy or locked|Device or resource busy" "$LOG"; then
    WAIT=$(( i * 10 ))
    echo "=== 资源被占用，${WAIT}s 后重试 ===" | tee -a "$LOG"
    sleep "$WAIT"
  else
    echo "=== 构建失败（非占用问题），终止 ===" | tee -a "$LOG"
    tail -20 "$LOG"
    exit 1
  fi
done
echo "=== 重试 $RETRIES 次仍因资源占用失败 ===" | tee -a "$LOG"
tail -20 "$LOG"
exit 1
