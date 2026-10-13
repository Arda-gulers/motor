"""Procedural textures for the ATV game, embedded into js/textures.js as data URIs
(pages opened from file:// cannot upload local image files to WebGL).

Ground layers (tileable, 512^2):
  <name>_a  albedo, sRGB JPEG
  <name>_n  linear JPEG: R,G = tangent normal xy (OpenGL, +Y = +V), B = height
Cards (RGBA PNG, colour bled into clear texels): leaves, pine bough, wildflower atlas.
macro: three independent low-frequency noise channels for world-space variation.

Run: python tools/textures.py
"""
import base64
import io
import math
import os

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage
from scipy.spatial import cKDTree

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_JS = os.path.join(ROOT, 'js', 'textures.js')
PREVIEW = os.environ.get('TEX_PREVIEW')
N = 1024


def norm01(x, lo_pct=0.5, hi_pct=99.5):
    lo, hi = np.percentile(x, lo_pct), np.percentile(x, hi_pct)
    return np.clip((x - lo) / (hi - lo + 1e-9), 0.0, 1.0)


def fnoise(n=N, beta=2.0, seed=0, aniso=(1.0, 1.0), lo=0.0, hi=None):
    r = np.random.default_rng(seed)
    w = r.standard_normal((n, n))
    fy = np.fft.fftfreq(n)[:, None] * n * aniso[1]
    fx = np.fft.fftfreq(n)[None, :] * n * aniso[0]
    f = np.sqrt(fx * fx + fy * fy)
    f[0, 0] = 1.0
    amp = f ** (-beta / 2.0)
    if lo > 0:
        amp *= 1.0 - np.exp(-(f / lo) ** 2)
    if hi is not None:
        amp *= np.exp(-(f / hi) ** 2)
    amp[0, 0] = 0.0
    return norm01(np.real(np.fft.ifft2(np.fft.fft2(w) * amp)))


def worley(count, seed, n=N):
    r = np.random.default_rng(seed)
    pts = r.random((count, 2))
    offs = np.array([(dx, dy) for dx in (-1, 0, 1) for dy in (-1, 0, 1)], float)
    allp = (pts[None, :, :] + offs[:, None, :]).reshape(-1, 2)
    ids = np.tile(np.arange(count), 9)
    tree = cKDTree(allp)
    ys, xs = np.mgrid[0:n, 0:n]
    q = np.stack([(xs.ravel() + 0.5) / n, (ys.ravel() + 0.5) / n], 1)
    d, i = tree.query(q, k=2, workers=-1)
    return d[:, 0].reshape(n, n), d[:, 1].reshape(n, n), ids[i[:, 0]].reshape(n, n)


def blur(x, s):
    if x.ndim == 3:
        return np.stack([ndimage.gaussian_filter(x[..., c], s, mode='wrap') for c in range(x.shape[2])], -1)
    return ndimage.gaussian_filter(x, s, mode='wrap')


def smooth(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def C(hexstr):
    return np.array([int(hexstr[i:i + 2], 16) for i in (0, 2, 4)], float) / 255.0


def mix(a, b, t):
    a, b, t = np.asarray(a, float), np.asarray(b, float), np.asarray(t, float)
    hi = max(a.ndim, b.ndim)
    if t.ndim >= 2 and hi > 0 and hi != t.ndim:
        t = t[..., None]
    return a * (1.0 - t) + b * t


def normal_from_height(h, strength):
    dhdu = (np.roll(h, -1, 1) - np.roll(h, 1, 1)) * 0.5
    dhdv = -(np.roll(h, -1, 0) - np.roll(h, 1, 0)) * 0.5
    nx, ny = -dhdu * strength, -dhdv * strength
    l = np.sqrt(nx * nx + ny * ny + 1.0)
    return np.stack([nx / l, ny / l, 1.0 / l], -1)


def to8(x):
    return (np.clip(x, 0.0, 1.0) * 255.0 + 0.5).astype(np.uint8)


def wrapped_line(d, p0, p1, fill, width, n=N):
    for ox in (-n, 0, n):
        for oy in (-n, 0, n):
            d.line([(p0[0] + ox, p0[1] + oy), (p1[0] + ox, p1[1] + oy)], fill=fill, width=width)


DATA = {}


def uri_jpeg(arr, q=90):
    buf = io.BytesIO()
    Image.fromarray(to8(arr), 'RGB').save(buf, 'JPEG', quality=q, subsampling=0)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def uri_png(img):
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return 'data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode()


def surface(name, albedo, height, nstrength, size=512):
    """Downsample to `size`, store albedo and normal-xy + height."""
    k = albedo.shape[0] // size
    if k > 1:
        albedo = albedo.reshape(size, k, size, k, 3).mean((1, 3))
        hs = height.reshape(size, k, size, k).mean((1, 3))
    else:
        hs = height
    nm = normal_from_height(hs, nstrength)
    packed = np.dstack([nm[..., 0] * 0.5 + 0.5, nm[..., 1] * 0.5 + 0.5, hs])
    DATA[name + '_a'] = uri_jpeg(albedo)
    DATA[name + '_n'] = uri_jpeg(packed, 94)
    if PREVIEW:
        os.makedirs(PREVIEW, exist_ok=True)
        tile = np.tile(to8(albedo), (2, 2, 1))
        Image.fromarray(tile).save(os.path.join(PREVIEW, name + '_a.png'))
    print('surface', name)


# ------------------------------------------------------------------ ground layers

def meadow(seed=100):
    """Short alpine meadow seen from above: soil, clover, thousands of blades, dry straws."""
    r = np.random.default_rng(seed)
    soil = mix(C('5a4a34'), C('7a6446'), fnoise(N, 2.2, seed))
    clover = mix(C('3f5f22'), C('5d7f2e'), fnoise(N, 1.2, seed + 7))
    cov = smooth(0.3, 0.7, fnoise(N, 2.4, seed + 8, lo=3))
    base = mix(soil, clover, 0.55 + 0.45 * cov)
    dens = fnoise(N, 2.6, seed + 1, lo=2)
    img = Image.new('RGB', (N, N), (0, 0, 0))
    him = Image.new('L', (N, N), 0)
    d, dh = ImageDraw.Draw(img), ImageDraw.Draw(him)
    greens = [C('4f6a28'), C('5f7c2e'), C('6f8c34'), C('7f9a3a'), C('8aa242'), C('9aa850'), C('b0a65a'), C('c2b26a')]
    weights = np.array([1.2, 1.4, 1.4, 1.2, 1.0, 0.6, 0.35, 0.2])
    weights /= weights.sum()
    for _ in range(42000):
        x, y = r.random(2) * N
        if r.random() > 0.25 + dens[int(y) % N, int(x) % N] * 0.9:
            continue
        a = r.random() * 2 * np.pi
        l = 4 + r.random() * 12
        c = greens[r.choice(len(greens), p=weights)] * (0.78 + 0.4 * r.random())
        col = tuple(int(v * 255) for v in np.clip(c, 0, 1))
        p1 = (x + math.cos(a) * l, y + math.sin(a) * l)
        wrapped_line(d, (x, y), p1, col, 2)
        wrapped_line(dh, (x, y), p1, int(110 + r.random() * 145), 2)
    blades = np.asarray(img, float) / 255.0
    bh = np.asarray(him, float) / 255.0
    cover = np.clip(bh * 3.0, 0, 1)
    col = mix(base, blades, cover * 0.92)
    col *= (0.9 + 0.2 * fnoise(N, 0.5, seed + 3))[..., None]
    h = 0.3 + 0.6 * bh + 0.1 * cov
    surface('grass', col, np.clip(h, 0, 1), 3.0)


def trail(seed=30):
    """Packed warm earth with pebbles and faint tyre-polished patches."""
    r = np.random.default_rng(seed + 4)
    m1 = fnoise(N, 2.2, seed, lo=5.0)
    m2 = fnoise(N, 1.8, seed + 1, lo=6.0)
    col = mix(C('86684a'), C('a8875f'), m1)
    col = mix(col, col * 0.88, smooth(0.5, 0.8, m2) * 0.6)
    grit = fnoise(N, 0.4, seed + 2)
    col *= (0.88 + 0.18 * grit)[..., None]
    f1, f2, cid = worley(1100, seed + 3)
    tab = r.random((1500, 4))
    rad = (0.0025 + 0.006 * tab[cid, 0]) * (tab[cid, 1] < 0.5)
    peb = smooth(0.0, 0.0014, rad - f1)
    pcol = mix(C('9d9282'), C('c4b69c'), tab[cid, 2])
    pcol = mix(pcol, C('7d776c'), (tab[cid, 3] < 0.25).astype(float))
    pcol *= (0.78 + 0.32 * np.clip(1 - f1 / np.maximum(rad, 1e-4), 0, 1))[..., None]
    rim = smooth(0.0, 0.003, rad + 0.0018 - f1) * (1 - peb) * (tab[cid, 1] < 0.5)
    col = mix(col, col * 0.8, rim * 0.6)
    col = mix(col, pcol, peb)
    g1, g2, _ = worley(70, seed + 5)
    crack = (1.0 - smooth(0.0, 0.002, g2 - g1)) * smooth(0.6, 0.8, fnoise(N, 2.4, seed + 6))
    col = mix(col, col * 0.72, crack * 0.5)
    h = 0.45 + 0.08 * m1 + 0.06 * grit + 0.35 * peb * np.clip(1 - f1 / np.maximum(rad, 1e-4), 0, 1) ** 0.5 - 0.15 * crack
    surface('dirt', col, np.clip(h, 0, 1), 5.0)


def rock(seed=40):
    f1, f2, cid = worley(60, seed)
    r = np.random.default_rng(seed + 1)
    tab = r.random((200, 3))
    mott = fnoise(N, 2.4, seed + 2)
    speck = fnoise(N, 0.7, seed + 3)
    base = mix(C('6c6e6c'), C('929089'), mott)
    base = mix(base, base * np.array([0.96, 1.0, 1.04]), tab[cid, 0])
    base *= (0.92 + 0.12 * speck)[..., None]
    crack = (1.0 - smooth(0.0, 0.0022, f2 - f1)) * smooth(0.4, 0.6, fnoise(N, 2.0, seed + 4))
    c1, c2, _ = worley(240, seed + 5)
    fine = (1.0 - smooth(0.0, 0.0012, c2 - c1)) * smooth(0.6, 0.75, fnoise(N, 2.2, seed + 6))
    col = mix(base, base * 0.6, crack * 0.5 + fine * 0.25)
    patch = fnoise(N, 2.8, seed + 9, lo=2.0)
    col = mix(col, col * np.array([1.1, 1.04, 0.92]), smooth(0.55, 0.8, patch) * 0.6)
    col = mix(col, col * np.array([0.92, 0.97, 1.05]), smooth(0.45, 0.2, patch) * 0.5)
    lich = smooth(0.8, 0.9, fnoise(N, 1.6, seed + 7)) * smooth(0.45, 0.8, fnoise(N, 2.4, seed + 8))
    col = mix(col, C('a7ab76'), lich * 0.5)
    strata = 0.5 + 0.5 * np.sin(np.mgrid[0:N, 0:N][0] / N * 2 * np.pi * 14 + fnoise(N, 2.6, seed + 10) * 8)
    col *= (0.94 + 0.08 * strata)[..., None]
    h = 0.55 + 0.25 * np.sqrt(np.clip(f2 - f1, 0, 1) / np.max(f2 - f1)) + 0.08 * mott + 0.03 * speck - 0.3 * crack - 0.12 * fine
    surface('rock', col, np.clip(h, 0, 1), 4.0)


def sand(seed=60):
    m1 = fnoise(N, 2.4, seed, lo=4.0)
    col = mix(C('b9a47c'), C('d6c39a'), m1)
    grit = fnoise(N, 0.3, seed + 1)
    col *= (0.9 + 0.16 * grit)[..., None]
    ys = np.mgrid[0:N, 0:N][0] / N
    ripple = 0.5 + 0.5 * np.sin(ys * 2 * np.pi * 40 + fnoise(N, 2.8, seed + 2) * 14)
    col *= (0.95 + 0.07 * ripple)[..., None]
    f1, f2, cid = worley(500, seed + 3)
    r = np.random.default_rng(seed + 4)
    tab = r.random((800, 2))
    rad = (0.002 + 0.004 * tab[cid, 0]) * (tab[cid, 1] < 0.3)
    peb = smooth(0.0, 0.001, rad - f1)
    col = mix(col, col * 0.75, peb * 0.7)
    h = 0.5 + 0.12 * ripple + 0.1 * m1 + 0.05 * grit + 0.2 * peb
    surface('sand', col, np.clip(h, 0, 1), 3.0)


def macro(seed=200):
    a = fnoise(512, 3.0, seed)
    b = fnoise(512, 2.2, seed + 1)
    c = fnoise(512, 1.5, seed + 2)
    DATA['macro'] = uri_jpeg(np.dstack([a, b, c]), 92)
    print('macro')


# ------------------------------------------------------------------ cards

def leaf_poly(x, y, ang, L, W, tip=1.6, steps=12):
    pts = []
    for i in range(steps + 1):
        t = i / steps
        w = W * 0.5 * math.sin(math.pi * t) ** 0.85 * (1 - 0.35 * t ** tip)
        pts.append((t * L, w))
    for i in range(steps, -1, -1):
        t = i / steps
        w = W * 0.5 * math.sin(math.pi * t) ** 0.85 * (1 - 0.35 * t ** tip)
        pts.append((t * L, -w))
    ca, sa = math.cos(ang), math.sin(ang)
    return [(x + px * ca - py * sa, y + px * sa + py * ca) for px, py in pts]


def rgb255(c, k=1.0, a=255):
    c = np.clip(np.asarray(c) * k, 0, 1)
    return (int(c[0] * 255), int(c[1] * 255), int(c[2] * 255), a)


def supersample(draw_fn, w, h, ss=2):
    img = Image.new('RGBA', (w * ss, h * ss), (0, 0, 0, 0))
    draw_fn(ImageDraw.Draw(img), ss)
    return img.resize((w, h), Image.LANCZOS)


def bleed(img):
    a = np.asarray(img, float) / 255.0
    rgb, al = a[..., :3], a[..., 3]
    acc = rgb * al[..., None]
    for s in (2, 4, 8, 16, 32):
        acc_b = np.stack([ndimage.gaussian_filter(acc[..., c], s) for c in range(3)], -1)
        w_b = ndimage.gaussian_filter(al, s)
        fill = acc_b / np.maximum(w_b[..., None], 1e-5)
        m = (al < 0.5)[..., None]
        rgb = np.where(m & (w_b[..., None] > 1e-4), np.where(al[..., None] > 0.02, rgb, fill), rgb)
    return Image.fromarray(to8(np.dstack([rgb, al])), 'RGBA')


def card_leaves(seed=220, size=512):
    w = h = 1024
    r = np.random.default_rng(seed)
    greens = [C('3a6422'), C('4f7d2a'), C('679630'), C('82ac3c'), C('9dc04c'), C('2c4f1d')]

    def fn(d, ss):
        cx, cy = w / 2, h / 2
        items = []
        for _ in range(480):
            ang = r.random() * 2 * np.pi
            rad = (r.random() ** 0.55) * 410
            x, y = cx + math.cos(ang) * rad, cy + math.sin(ang) * rad
            la = ang + r.normal(0, 0.6)
            L, W = 78 + r.random() * 44, 38 + r.random() * 16
            shade = 0.72 + 0.4 * (1 - rad / 430) + r.normal(0, 0.06)
            items.append((rad, x, y, la, L, W, greens[int(r.random() * len(greens))], shade))
        items.sort(key=lambda t: -t[0])
        for rad, x, y, la, L, W, g, shade in items:
            bx, by = x - math.cos(la) * L * 0.5, y - math.sin(la) * L * 0.5
            d.polygon([(px * ss, py * ss) for px, py in leaf_poly(bx, by, la, L, W)], fill=rgb255(g, shade))
            tip = (bx + math.cos(la) * L * 0.85, by + math.sin(la) * L * 0.85)
            d.line([(bx * ss, by * ss), (tip[0] * ss, tip[1] * ss)], fill=rgb255(g, shade * 0.72), width=int(2 * ss))
            d.polygon([(px * ss, py * ss) for px, py in leaf_poly(bx, by, la, L * 0.9, W * 0.45)], fill=rgb255(g, shade * 1.12))
    img = supersample(fn, w, h).resize((size, size), Image.LANCZOS)
    DATA['card_leaves'] = uri_png(bleed(img))
    print('card_leaves')


def card_bough(seed=260, size=512):
    """A drooping spruce bough seen from above: twigs off a central branch, dense needles."""
    w = h = 1024
    r = np.random.default_rng(seed)
    greens = [C('1f3d24'), C('2a4e2c'), C('365f34'), C('42703c'), C('5a8448')]

    def fn(d, ss):
        # branch from the left edge (trunk side) to the right tip, gently curved
        L = 960
        pts = [(30 + t * L, h / 2 + math.sin(t * 2.4) * 30 * t) for t in np.linspace(0, 1, 40)]
        twigs = []
        for i in range(2, 38):
            t = i / 39
            for side in (-1, 1):
                if r.random() < 0.15:
                    continue
                x, y = pts[i]
                tl = (1 - t) ** 0.6 * 330 * (0.6 + 0.4 * r.random()) + 40
                a = side * (0.9 + r.normal(0, 0.15)) * (1 - 0.3 * t)
                twigs.append((x, y, a, tl, t))
        for x, y, a, tl, t in twigs:
            n = int(tl / 6)
            for k in range(n):
                u = k / max(1, n - 1)
                px, py = x + math.cos(a) * tl * u, y + math.sin(a) * tl * u
                nl = 26 * (1 - 0.5 * u) + 8
                g = greens[int(r.random() * len(greens))] * (0.85 + 0.35 * (1 - t) * 0.5 + 0.25 * u)
                for na in (a + 0.9, a - 0.9, a + 0.5, a - 0.5):
                    na += r.normal(0, 0.12)
                    d.line([(px * ss, py * ss), ((px + math.cos(na) * nl) * ss, (py + math.sin(na) * nl) * ss)],
                           fill=rgb255(g), width=int(3 * ss))
        for i in range(len(pts) - 1):
            t = i / len(pts)
            d.line([(pts[i][0] * ss, pts[i][1] * ss), (pts[i + 1][0] * ss, pts[i + 1][1] * ss)],
                   fill=rgb255(C('4a3626')), width=max(1, int((10 - 8 * t) * ss)))
    img = supersample(fn, w, h).resize((size, size), Image.LANCZOS)
    DATA['card_bough'] = uri_png(bleed(img))
    print('card_bough')


def card_flora(seed=240, size=512):
    """2x2 atlas: white daisies, blue bells, gold clusters, lupine spikes."""
    w = h = 1024
    r = np.random.default_rng(seed)
    cell = 512

    def stems(d, ss, ox, oy, count, head):
        for _ in range(count):
            x0 = ox + cell / 2 + r.normal(0, 70)
            L = 180 + r.random() * 240
            bend = r.normal(0, 50)
            pts = [((x0 + bend * t * t), (oy + cell - 6 - L * t)) for t in np.linspace(0, 1, 10)]
            gc = mix(C('4c7a2a'), C('7aa23e'), r.random())
            for j in range(len(pts) - 1):
                d.line([(pts[j][0] * ss, pts[j][1] * ss), (pts[j + 1][0] * ss, pts[j + 1][1] * ss)],
                       fill=rgb255(gc), width=max(1, int((4 - j * 0.3) * ss)))
            if r.random() < 0.6:
                lx, ly = pts[int((0.2 + r.random() * 0.4) * 9)]
                la = -math.pi / 2 + (1 if r.random() < 0.5 else -1) * (0.6 + r.random() * 0.5)
                d.polygon([(px * ss, py * ss) for px, py in leaf_poly(lx, ly, la, 60, 18)], fill=rgb255(gc, 0.95))
            head(d, ss, pts[-1][0], pts[-1][1])

    def daisy(d, ss, x, y):
        R = 11 + r.random() * 6
        for k in range(11):
            a = k / 11 * 2 * math.pi + r.random() * 0.2
            d.polygon([(px * ss, py * ss) for px, py in leaf_poly(x, y, a, R * 1.5, R * 0.55)], fill=rgb255(C('f6f2e6'), 0.92 + 0.08 * r.random()))
        d.ellipse([(x - R * 0.35) * ss, (y - R * 0.35) * ss, (x + R * 0.35) * ss, (y + R * 0.35) * ss], fill=rgb255(C('e8b830')))

    def bell(d, ss, x, y):
        for k in range(3):
            bx, by = x + r.normal(0, 10), y + k * 20
            R = 10 + r.random() * 5
            c = mix(C('6f8fe0'), C('a8b8f4'), r.random())
            d.ellipse([(bx - R) * ss, (by - R * 0.8) * ss, (bx + R) * ss, (by + R * 1.1) * ss], fill=rgb255(c))

    def gold(d, ss, x, y):
        R = 9 + r.random() * 6
        for k in range(6):
            a = k / 6 * 2 * math.pi
            px, py = x + math.cos(a) * R * 0.7, y + math.sin(a) * R * 0.7
            d.ellipse([(px - R * 0.6) * ss, (py - R * 0.6) * ss, (px + R * 0.6) * ss, (py + R * 0.6) * ss], fill=rgb255(mix(C('f0a830'), C('ffd060'), r.random())))
        d.ellipse([(x - R * 0.3) * ss, (y - R * 0.3) * ss, (x + R * 0.3) * ss, (y + R * 0.3) * ss], fill=rgb255(C('b0501a')))

    def lupine(d, ss, x, y):
        base = mix(C('9a4fc4'), C('d05aa8'), r.random())
        for k in range(16):
            t = k / 15
            px, py = x + r.normal(0, 1.5), y + t * 120
            R = 5 + 7 * t
            for side in (-1, 1):
                cx = px + side * R * 0.7
                col = mix(mix(base * 1.25, base * 0.8, t), C('f4e6f6'), 0.35 * (1 - t))
                d.ellipse([(cx - R * 0.6) * ss, (py - R * 0.5) * ss, (cx + R * 0.6) * ss, (py + R * 0.5) * ss], fill=rgb255(col))

    def fn(d, ss):
        stems(d, ss, 0, 0, 22, daisy)
        stems(d, ss, cell, 0, 14, bell)
        stems(d, ss, 0, cell, 16, gold)
        stems(d, ss, cell, cell, 9, lupine)
    img = supersample(fn, w, h).resize((size, size), Image.LANCZOS)
    DATA['card_flora'] = uri_png(bleed(img))
    print('card_flora')


if __name__ == '__main__':
    meadow()
    trail()
    rock()
    sand()
    macro()
    card_leaves()
    card_bough()
    card_flora()
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write("'use strict';\n// Generated by tools/textures.py: procedural textures as data URIs.\n")
        f.write('const TEX_DATA = {\n')
        for k, v in DATA.items():
            f.write(f"  {k}: '{v}',\n")
        f.write('};\n')
    print('wrote', OUT_JS, os.path.getsize(OUT_JS) // 1024, 'KB')
