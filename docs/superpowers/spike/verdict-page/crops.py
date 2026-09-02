import sys
from PIL import Image, ImageDraw
F = 'docs/superpowers/spike/frames'
OUT = '/private/tmp/claude-502/-Users-piotr-Projekty-voxel-diorama/3d544d14-a513-451f-9afb-63d033d4414d/scratchpad/art'

def tile(path, box, label, scale):
    im = Image.open(path).convert('RGB')
    if box: im = im.crop(box)
    if scale != 1: im = im.resize((int(im.width*scale), int(im.height*scale)), Image.LANCZOS)
    if label:
        d = ImageDraw.Draw(im)
        h = max(16, im.height // 26)
        d.rectangle([0, 0, im.width, h], fill=(24, 27, 31))
        d.text((6, max(1, (h-11)//2)), label, fill=(232, 236, 240))
    return im

def strip(name, tiles, target_w, quality=74, gap=6):
    ims = [tile(*t) for t in tiles]
    total = sum(i.width for i in ims) + gap*(len(ims)-1)
    k = target_w / total
    ims = [i.resize((max(1,int(i.width*k)), max(1,int(i.height*k))), Image.LANCZOS) for i in ims]
    h = max(i.height for i in ims)
    out = Image.new('RGB', (sum(i.width for i in ims)+gap*(len(ims)-1), h), (238, 240, 242))
    x = 0
    for i in ims:
        out.paste(i, (x, 0)); x += i.width + gap
    p = f'{OUT}/{name}.jpg'
    out.save(p, quality=quality, optimize=True, progressive=True)
    print(name, out.size, f'{len(open(p,"rb").read())/1024:.0f} KB')

strip('hero', [(f'{F}/hybrid-direct-high-spike-street.jpg', (0, 60, 1440, 830), None, 1)], 1180, 76)
strip('lod0', [
    (f'{F}/voxel-high-spike-overview.jpg', (500, 320, 660, 500), 'produkt (voxel)', 1),
    (f'{F}/hybrid-direct-high-spike-overview.jpg', (500, 320, 660, 500), 'direct', 1),
    (f'{F}/hybrid-greedy-high-spike-overview.jpg', (500, 320, 660, 500), 'greedy', 1),
], 1100, 78)
strip('greedyhole', [(f'{F}/hybrid-greedy-high-spike-overview.jpg', (556, 336, 644, 484), 'greedy, LOD 0', 4)], 620, 80)
strip('markings', [
    (f'{F}/voxel-high-spike-street.jpg', (520, 520, 1260, 820), 'produkt (voxel)', 1),
    (f'{F}/hybrid-direct-high-spike-street.jpg', (520, 520, 1260, 820), 'direct', 1),
    (f'{F}/hybrid-greedy-high-spike-street.jpg', (520, 520, 1260, 820), 'greedy', 1),
], 1180, 76)
strip('props', [
    (f'{F}/hybrid-direct-high-spike-street.jpg', (380, 520, 680, 670), 'direct', 2),
    (f'{F}/hybrid-greedy-high-spike-street.jpg', (380, 520, 680, 670), 'greedy', 2),
], 1100, 78)
strip('glass', [
    (f'{F}/hybrid-direct-high-spike-street.jpg', (60, 330, 470, 620), 'direct', 1.6),
    (f'{F}/hybrid-greedy-high-spike-street.jpg', (60, 330, 470, 620), 'greedy', 1.6),
], 1100, 78)
strip('golden', [
    (f'{F}/voxel-high-spike-golden.jpg', (280, 380, 800, 700), 'produkt (voxel)', 1),
    (f'{F}/hybrid-direct-high-spike-golden.jpg', (280, 380, 800, 700), 'direct', 1),
], 1100, 76)
strip('night', [
    (f'{F}/voxel-high-spike-night-street.jpg', (380, 340, 1120, 780), 'produkt (voxel)', 1),
    (f'{F}/hybrid-direct-high-spike-night-street.jpg', (380, 340, 1120, 780), 'direct', 1),
], 1100, 76)
strip('lowshop', [
    (f'{F}/hybrid-direct-high-spike-street.jpg', (270, 370, 480, 600), 'direct, High', 2),
    (f'{F}/hybrid-direct-low-spike-street.jpg', (270, 370, 480, 600), 'direct, Low', 2),
], 1000, 78)
