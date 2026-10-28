#!/bin/bash
# 对**打包产物**跑冒烟：解压 zip 到工作区外，用里头的 exe 真跑一次，
# 确认打包后（asar 内）也一切正常。轮子不在源码树里，能抓到只在打包态暴露的问题。
set -u
cd /d/zcode/hehe || exit 1
VER=$(node -p "require('./package.json').version")
ZIP="dist/hehe-toolbox-${VER}-win-x64.zip"
TESTDIR="/d/zcode/.verify-${VER}"
unset ELECTRON_RUN_AS_NODE

[ -f "$ZIP" ] || { echo "找不到 $ZIP"; exit 1; }

echo "=== 解压到 $TESTDIR ==="
node -e "require('fs').rmSync('$TESTDIR',{recursive:true,force:true})" 2>/dev/null
mkdir -p "$TESTDIR"
node -e "
const AdmZip=require('adm-zip');
const z=new AdmZip(process.argv[1]);
z.extractAllTo(process.argv[2], true);
console.log('extracted', z.getEntries().length, 'entries');
" "$ZIP" "$TESTDIR"

EXE=$(find "$TESTDIR" -maxdepth 1 -name "*.exe" | head -1)
[ -n "$EXE" ] || { echo "解压后没找到 exe"; exit 1; }
echo "=== 冒烟：$EXE ==="
SMOKEDIR="$TESTDIR/data"
mkdir -p "$SMOKEDIR"
HEHE_SMOKE=1 HEHE_TEST_DATA="$SMOKEDIR" HEHE_NOSPLASH=1 "$EXE" > "$TESTDIR/smoke.log" 2>&1
echo "exit=$?"
grep -E "SMOKE_RESULT" "$TESTDIR/smoke.log" || { echo "--- log ---"; tail -20 "$TESTDIR/smoke.log"; exit 1; }

if grep -q "SMOKE_RESULT:.*PASS" "$TESTDIR/smoke.log"; then
  echo "=== 打包态冒烟 PASS ==="
  exit 0
else
  echo "=== 打包态冒烟 FAIL ==="
  exit 1
fi
