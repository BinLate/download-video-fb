from PIL import Image, ImageDraw, ImageFont
import os

os.makedirs("icons", exist_ok=True)

sizes = [16, 48, 128]

for size in sizes:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    
    # Background rounded rectangle or circle with gradient-like look
    # Main circle with vibrant blue/purple gradient
    margin = int(size * 0.05)
    r = size - margin * 2
    
    # Draw circle background
    draw.ellipse([margin, margin, size - margin, size - margin], fill=(24, 119, 242, 255))
    
    # Inner circle accent
    inner_m = int(size * 0.12)
    draw.ellipse([inner_m, inner_m, size - inner_m, size - inner_m], fill=(13, 80, 200, 255))
    
    # Draw downward download arrow and base
    arrow_color = (255, 255, 255, 255)
    cx = size / 2.0
    cy = size / 2.0
    
    # Scale coordinates
    s = size / 128.0
    
    # Arrow stem
    stem_w = max(2, int(14 * s))
    stem_top = int(32 * s)
    stem_bot = int(68 * s)
    draw.rectangle([cx - stem_w/2, stem_top, cx + stem_w/2, stem_bot], fill=arrow_color)
    
    # Arrow head (triangle)
    head_left = (cx - 28 * s, 64 * s)
    head_right = (cx + 28 * s, 64 * s)
    head_tip = (cx, 90 * s)
    draw.polygon([head_left, head_right, head_tip], fill=arrow_color)
    
    # Bottom tray/bar
    bar_w = int(56 * s)
    bar_h = max(2, int(10 * s))
    bar_top = int(98 * s)
    draw.rounded_rectangle([cx - bar_w/2, bar_top, cx + bar_w/2, bar_top + bar_h], radius=int(4*s), fill=(0, 230, 180, 255))
    
    img.save(f"icons/icon{size}.png")
    print(f"Generated icons/icon{size}.png")
