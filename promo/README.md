# 核核工具箱 · 宣传片（30s / 1080p / 中文）

成片：`promo/out/promo.mp4`（12.16 MB，30.00s，1920×1080@30fps，AAC 192k）

## 规格

| 项 | 值 |
|---|---|
| 时长 / 画幅 | 30.00s（900 帧）/ 1920×1080 @30fps |
| 语言 | 中文界面 + 中文字幕，无旁白 |
| 音频 | tech-house BGM（124 BPM，实测拍间隔 0.484s）+ 22 处电影系 SFX |
| 素材 | 真实 UI 截图（2x 纹理，1441×810 视口）+ layout.json 坐标表 |
| 数据合规 | `HEHE_TEST_DATA` 隔离启动；路径脱敏为 `D:\演示素材` / `C:\Users\用户`；高危页展示「默认未启用」状态 |
| 视觉 | 浅色 #F2F3F5 底 / #165DFF 强调 / Segoe UI + 微软雅黑 / 细网格 + 柔和投影 |

## 分镜（10 段）

| # | 帧区间 | 段 | 内容 |
|---|---|---|---|
| 1 | 0–126 | 开场 | 首页全景 → 聚光卡片 → 主标语 |
| 2 | 126–186 | 搜索 | 搜索框高亮 + 键入「压缩」→ 结果下拉 |
| 3 | 186–261 | 日常三连 | 压缩 / 图片格式转换 / 番茄钟 满屏交叉切 |
| 4 | 261–342 | 磁盘 | 分区条与大文件 TOP 推近 |
| 5 | 342–426 | 重命名 | 预览表高亮（先预览，再动手） |
| 6 | 426–504 | 垃圾清理 | 三类清理项逐行高亮 |
| 7 | 504–579 | 还原点 | 还原点列表逐行高亮 |
| 8 | 579–651 | 高危门禁 | 扫描框锁定「默认未启用」卡 |
| 9 | 651–726 | 设置 | 高危开关逐个点亮 |
| 10 | 726–900 | 收尾 | 数字滚到 111 → 字标 → 标语 → 1.2s hold |

## 制作中修掉的问题（保留备查）

1. **CDP 模拟分辨率导致界面变形** —— 早期用 `Emulation.setDeviceMetricsOverride` 改逻辑分辨率，
   Electron 按 1440 重排但真实窗口没变，布局错位。改为「真实改窗口尺寸 + clip scale=2」。
2. **选择器抓错** —— 首页搜索框真实类是 `.hs-input`（不是 `.search-input`，后者在首页是
   `search-wrap hidden`，rect 全 0）；模块卡是 `.home-cat`（不是 `.mod-card`）。抓错会让相机
   取景飞到 (0,0)。
3. **取景过度放大截断内容** —— 搜索页 zoom 1.55 时框宽超出画面。改为从 rect 反解 cx/cy，
   zoom 取「框宽 1635px < 1920」的值（1.05）。
4. **叠加层与真实界面重影** —— 垃圾清理/还原点段原本手工叠「✓ + 名称 + 数量」/「可恢复」卡片，
   压住原生文字两边都读不清。改为只留高亮框，信息交给真实界面。
5. **三卡并排太小** —— 日常三连原本三张 520px 小卡并排，文字糊成灰块。改为满屏单张交叉切。
6. **SFX 文件名写错** —— `whoosh-quick` 应为 `swoosh-quick`，渲染直接 404。
7. **ffmpeg `normalize` 不支持** —— 本机 ffmpeg 是 2018 构建，`amix` 无 normalize 参数；
   改 `amix + volume 补偿 + alimiter`。
8. **Remotion 音频混流权限报错** —— `remotion-audio-mixing\0.wav` 父目录不存在导致
   Permission denied。改用 `--muted` 渲视频轨 + ffmpeg 外部混流（音轨电平实测
   mean -26.4 dB / peak -8.5 dB，无削波）。

## 声音设计

- BGM：`assets/audio/bgm/bgm-tech-house.mp3`，取前 30s，volume 0.42，29.4s 起 0.6s 淡出
- SFX 22 处，钉在分段起点与关键动作（whoosh/impact/riser/sparkle/pop/click-camera 等）
- 结尾固定句式：riser（24.27s）→ impact（25.93s）→ sparkle（26.67s）

## 重新生成

```bash
cd promo
npm install
npx remotion render src/index.ts HehePromo out/video-only.mp4 --muted
node ../.tmp-video/mix-audio.js        # 混入 BGM + SFX
```

改文案/字号/颜色：`src/Main.tsx` 里各段的 `T`（theme）与 `CAPTIONS` 表。
改界面素材：`public/textures/*.png` + `layout.json`（重跑 `.tmp-video/capture-*.js`）。