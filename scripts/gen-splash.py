"""生成便携版解压阶段的启动画面（NSIS splashImage 需要 BMP）。

对应 main.js 里应用内启动窗的视觉：白卡片 + 主色进度条 + 品牌图标。
NSIS 的 BgImage 插件把这张图铺成安装器窗口背景，所以用不透明底，
不能像应用内启动窗那样用圆角透明。
"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 396, 188
BG = (255, 255, 255)
TEXT = (29, 33, 41)
SUB = (134, 144, 156)
TRACK = (229, 230, 235)
PRIMARY = (22, 93, 255)

FONT = r"C:\Windows\Fonts\msyh.ttc"
FONT_B = r"C:\Windows\Fonts\msyhbd.ttc"
if not os.path.exists(FONT_B):
    FONT_B = FONT


def f(size, bold=False):
    return ImageFont.truetype(FONT_B if bold else FONT, size)


img = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(img)

# 图标（用现成的 64px 图标缩到 40px）
icon = Image.open("assets/icon.png").convert("RGBA").resize((40, 40), Image.LANCZOS)
img.paste(icon, (30, 32), icon)

d.text((82, 36), "核核工具箱", font=f(17, True), fill=TEXT)
# 解压阶段（NSIS BgImage 显示的这张静态图）实测约 14 秒。
# 原文案写「正在解压运行环境…」不带时长，用户盯着不动的画面会以为程序卡死。
# 如实写出 10–20 秒，并说明之后每次仍要解压一次，避免误判。
d.text((82, 64), "正在解压运行环境，约需 10–20 秒…", font=f(11), fill=SUB)

# 进度条：BgImage 只显示静态图，画不出走动的进度，
# 所以画成「已走了一段」的中间态，避免被误读成 0% 卡住。
bar_y, bar_h = 104, 6
d.rounded_rectangle([30, bar_y, W - 30, bar_y + bar_h], radius=3, fill=TRACK)
d.rounded_rectangle([30, bar_y, W - 30, bar_y + bar_h], radius=3, fill=(236, 240, 250))
d.rounded_rectangle([30, bar_y, int(W * 0.55), bar_y + bar_h], radius=3, fill=(120, 165, 255))

d.text((30, 126), "这一步每次启动都要做一次", font=f(10), fill=SUB)
d.text((30, 146), "想秒开请用 zip 免安装版", font=f(10), fill=SUB)

img.save("assets/splash.bmp", "BMP")
print("saved", os.path.getsize("assets/splash.bmp"), "bytes", img.size)
