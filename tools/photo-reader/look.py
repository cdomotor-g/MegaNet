#!/usr/bin/env python3
"""tools/photo-reader/look.py — help an agent look at field photos closely.

    look.py sheets MANIFEST [--cols 3] [--rows 3] [--tile 512]
        Contact sheets of the fetched photos, numbered: a first look at many
        photos at once, to find the ones with something to read on them — a
        laptop's screen, a logger's label, a radio's plate. Writes
        <out>/sheets/sheet-NNN.jpg and <out>/sheets/index.json, which maps each
        sheet's numbers to photo ids.

    look.py crop PHOTO X0 Y0 X1 Y1 [--out FILE] [--min 1200]
        A part of a photo at its full resolution — X0 Y0 X1 Y1 as fractions of
        its width and height, 0 to 1 — enlarged so its longer side is at least
        --min pixels: a label or a screen too small to read in the whole frame.

    look.py tiles PHOTO [--grid 2]
        The whole photo cut into GRID x GRID overlapping tiles at full
        resolution, for reading small text anywhere in the frame.

Pure Pillow, no network. Every photo is turned upright by its EXIF first, so
"the top left" is where a person looking at it would say. Writes beside the
photos, in the session's own folder; nothing here belongs in the repository.
Run with python3 -I, as anything that opens downloaded files should be.
"""

import argparse
import json
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps

Image.MAX_IMAGE_PIXELS = 200_000_000


def upright(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    return img.convert('RGB')


def font(size):
    for name in ('DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def sheets(args):
    with open(args.manifest) as f:
        man = json.load(f)
    base = os.path.dirname(os.path.abspath(args.manifest))
    out = os.path.join(base, 'sheets')
    os.makedirs(out, exist_ok=True)
    per = args.cols * args.rows
    photos = man['photos']
    index = []
    label = font(max(18, args.tile // 14))
    for s in range(math.ceil(len(photos) / per)):
        part = photos[s * per:(s + 1) * per]
        sheet = Image.new('RGB', (args.cols * args.tile, args.rows * args.tile), (24, 24, 24))
        draw = ImageDraw.Draw(sheet)
        entry = {'sheet': f'sheet-{s + 1:03d}.jpg', 'photos': {}}
        for i, p in enumerate(part):
            n = s * per + i + 1
            try:
                img = upright(os.path.join(base, p['file']))
            except Exception as err:  # a damaged file is a tile that says so
                img = Image.new('RGB', (args.tile, args.tile), (80, 0, 0))
                ImageDraw.Draw(img).text((10, 40), f'unreadable: {err}'[:60], fill=(255, 255, 255))
            img.thumbnail((args.tile - 6, args.tile - 6))
            x, y = (i % args.cols) * args.tile, (i // args.cols) * args.tile
            sheet.paste(img, (x + (args.tile - img.width) // 2, y + (args.tile - img.height) // 2))
            tag = f'#{n}'
            box = draw.textbbox((0, 0), tag, font=label)
            draw.rectangle([x + 4, y + 4, x + 12 + box[2] - box[0], y + 10 + box[3] - box[1]], fill=(255, 210, 0))
            draw.text((x + 8, y + 4), tag, fill=(0, 0, 0), font=label)
            entry['photos'][str(n)] = p['photo_id']
        sheet.save(os.path.join(out, entry['sheet']), quality=82)
        index.append(entry)
    with open(os.path.join(out, 'index.json'), 'w') as f:
        json.dump(index, f, indent=1)
    print(f'{len(index)} sheet(s) of up to {per} in {out}')


def crop(args):
    img = upright(args.photo)
    w, h = img.size
    x0, y0, x1, y1 = (max(0.0, min(1.0, v)) for v in (args.x0, args.y0, args.x1, args.y1))
    if x1 <= x0 or y1 <= y0:
        sys.exit('X1 and Y1 have to be past X0 and Y0')
    part = img.crop((int(x0 * w), int(y0 * h), int(x1 * w), int(y1 * h)))
    longer = max(part.size)
    if longer < args.min:
        k = args.min / longer
        part = part.resize((int(part.width * k), int(part.height * k)), Image.LANCZOS)
    out = args.out or f'{os.path.splitext(args.photo)[0]}.crop-{x0:.2f}-{y0:.2f}-{x1:.2f}-{y1:.2f}.jpg'
    part.save(out, quality=92)
    print(out)


def tiles(args):
    img = upright(args.photo)
    w, h = img.size
    g = args.grid
    stem = os.path.splitext(args.photo)[0]
    # Overlapping by a tenth, so a label on a seam is whole in one of them.
    tw, th = w / g, h / g
    ow, oh = tw * 0.1, th * 0.1
    for r in range(g):
        for c in range(g):
            box = (max(0, int(c * tw - ow)), max(0, int(r * th - oh)), min(w, int((c + 1) * tw + ow)), min(h, int((r + 1) * th + oh)))
            out = f'{stem}.tile-{r + 1}{c + 1}.jpg'
            img.crop(box).save(out, quality=90)
            print(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    s = sub.add_parser('sheets')
    s.add_argument('manifest')
    s.add_argument('--cols', type=int, default=3)
    s.add_argument('--rows', type=int, default=3)
    s.add_argument('--tile', type=int, default=512)
    c = sub.add_parser('crop')
    c.add_argument('photo')
    for k in ('x0', 'y0', 'x1', 'y1'):
        c.add_argument(k, type=float)
    c.add_argument('--out')
    c.add_argument('--min', type=int, default=1200)
    t = sub.add_parser('tiles')
    t.add_argument('photo')
    t.add_argument('--grid', type=int, default=2)
    args = ap.parse_args()
    {'sheets': sheets, 'crop': crop, 'tiles': tiles}[args.cmd](args)


if __name__ == '__main__':
    main()
