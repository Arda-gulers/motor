'use strict';
// Analytic heightfield: rolling hills, border mountains, a lake, the festival plateau,
// a levelled dirt trail loop and kicker ramps. Chunked LOD meshes with skirts, vertex-coloured
// by surface, plus a top-down map image for the minimap.

const Terrain = (() => {
  const SIZE = 2048, HALF = 1024, CH = 128, NCH = SIZE / CH;
  const LOD_SEGS = [128, 64, 32, 16];
  const LOD_DIST = [110, 300, 640];
  const TR_HW = 4.2, TR_SH = 10, TR_SHMAX = 30, TR_INF = TR_HW + TR_SHMAX, TR_CELL = 32, TR_GN = SIZE / TR_CELL;
  const N = Noise;

  const T = {
    SIZE, HALF, CH, TR_HW,
    WATER: 0,
    lake: { x: -470, z: -110, r: 140 },
    fest: { x: 0, z: 0, h: 0 },
    ramps: [],
    speedTrap: null,
    q: { trail: 0, lat: 99, lake: 9, s: 0 },   // side channel of the last height() call
  };

  // trail control points, closed loop, starts at the festival
  const CTRL = [
    [-40, 420], [120, 430], [285, 385], [425, 290], [515, 150], [545, -15], [505, -180],
    [405, -320], [255, -430], [75, -480], [-105, -450], [-245, -360], [-310, -225],
    [-300, -70], [-330, 80], [-430, 190], [-420, 330], [-300, 420], [-170, 445],
  ];

  // ---------------------------------------------------------------- height
  function natural(x, z) {
    // a gentle domain warp keeps ridgelines and valleys from running straight
    const wx = x + N.simplex(x / 300 + 11, z / 300) * 45, wz = z + N.simplex(x / 300, z / 300 - 7) * 45;
    let h = N.fbm(wx / 600, wz / 600, 4) * 40;
    h += N.fbm(wx / 210 + 5.2, wz / 210 - 3.1, 3) * 11;
    h += N.simplex(x / 52, z / 52) * 2.0;
    h += N.simplex(x / 14 + 31.3, z / 14) * 0.45 + N.simplex(x / 5.5, z / 5.5 + 17.7) * 0.12;
    const ex = Math.abs(x) / HALF, ez = Math.abs(z) / HALF;
    const e = Math.pow(ex ** 6 + ez ** 6, 1 / 6);
    if (e > 0.6) {
      const t = U.smooth(0.6, 1.0, e);
      h += t * t * (110 + 230 * N.ridged(wx / 430 + 3.3, wz / 430 - 1.7, 4)) + t * N.fbm(wx / 120, wz / 120, 3) * 16;
    }
    return h;
  }
  function lakeMod(x, z, h) {
    const L = T.lake, dx = x - L.x, dz = z - L.z, d = Math.sqrt(dx * dx + dz * dz);
    if (d > L.r * 3) return h;
    const a = Math.atan2(dz, dx);
    const rr = L.r * (1 + 0.22 * N.simplex(Math.cos(a) * 1.3 + 5.1, Math.sin(a) * 1.3 - 2.7));
    const q = d / rr;
    T.q.lake = q;
    const prof = q < 1 ? T.WATER - 7 * (1 - q * q) : T.WATER + 9 * (q - 1);
    return U.lerp(prof, h, U.smooth(1.0, 2.1, q));
  }
  function festMod(x, z, h) {
    const F = T.fest, d = Math.hypot(x - F.x, z - F.z);
    if (d > 135) return h;
    return U.lerp(F.h, h, U.smooth(55, 135, d));
  }
  function baseNoTrail(x, z) { return festMod(x, z, lakeMod(x, z, natural(x, z))); }

  // ---------------------------------------------------------------- trail
  const TR = { n: 0, len: 0, step: 2, xs: null, zs: null, ys: null, sh: null, dx: null, dz: null, grid: null };
  const near = { d: 0, y: 0, i: 0, t: 0, sh: TR_SH };

  function trailNear(x, z) {
    const ci = Math.floor((x + HALF) / TR_CELL), cj = Math.floor((z + HALF) / TR_CELL);
    if (ci < 0 || cj < 0 || ci >= TR_GN || cj >= TR_GN) return false;
    const list = TR.grid[cj * TR_GN + ci];
    if (!list) return false;
    const xs = TR.xs, zs = TR.zs, n = TR.n;
    let best = 1e18, bi = -1, bt = 0;
    for (let k = 0; k < list.length; k++) {
      const i = list[k], j = i + 1 === n ? 0 : i + 1;
      const ax = xs[i], az = zs[i], bx = xs[j] - ax, bz = zs[j] - az;
      let t = ((x - ax) * bx + (z - az) * bz) / (bx * bx + bz * bz);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + bx * t - x, pz = az + bz * t - z, d2 = px * px + pz * pz;
      if (d2 < best) { best = d2; bi = i; bt = t; }
    }
    if (bi < 0) return false;
    const bj = bi + 1 === n ? 0 : bi + 1;
    near.d = Math.sqrt(best); near.i = bi; near.t = bt;
    near.y = TR.ys[bi] + (TR.ys[bj] - TR.ys[bi]) * bt;
    near.sh = TR.sh[bi] + (TR.sh[bj] - TR.sh[bi]) * bt;
    return true;
  }

  function height(x, z) {
    const q = T.q;
    q.trail = 0; q.lat = 99; q.lake = 9;
    let h = baseNoTrail(x, z);
    if (trailNear(x, z)) {
      q.lat = near.d; q.s = (near.i + near.t) * TR.step;
      if (near.d < TR_HW + near.sh) {
        h = U.lerp(near.y, h, U.smooth(TR_HW, TR_HW + near.sh, near.d));
        q.trail = 1 - U.smooth(TR_HW - 1.0, TR_HW + 1.0, near.d);
      }
    }
    return h;
  }

  function rampH(x, z) {
    let best = -1e9;
    const R = T.ramps;
    for (let k = 0; k < R.length; k++) {
      const r = R[k], ox = x - r.x, oz = z - r.z;
      const u = ox * r.dx + oz * r.dz;
      if (u < 0 || u > r.len + r.back) continue;
      const w = oz * r.dx - ox * r.dz;
      if (w > r.wid * 0.5 || w < -r.wid * 0.5) continue;
      const hh = u <= r.len ? r.hgt * Math.pow(u / r.len, 1.5) : r.hgt * (1 - (u - r.len) / r.back);
      const y = r.base + r.slope * Math.min(u, r.len) + hh;
      if (y > best) best = y;
    }
    return best;
  }

  function computeWater() {
    const L = T.lake;
    let s = 0;
    for (let k = 0; k < 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      s += natural(L.x + Math.cos(a) * L.r * 1.6, L.z + Math.sin(a) * L.r * 1.6);
    }
    T.WATER = s / 48 - 4;
  }

  function buildTrail() {
    const pts = CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z));
    const curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal');
    const len = curve.getLength();
    const n = Math.round(len / 2);
    const sp = curve.getSpacedPoints(n);
    TR.n = n; TR.len = len; TR.step = len / n;
    TR.xs = new Float32Array(n); TR.zs = new Float32Array(n); TR.ys = new Float32Array(n); TR.sh = new Float32Array(n);
    TR.dx = new Float32Array(n); TR.dz = new Float32Array(n);
    for (let i = 0; i < n; i++) { TR.xs[i] = sp[i].x; TR.zs[i] = sp[i].z; }
    for (let i = 0; i < n; i++) {
      const a = (i - 1 + n) % n, b = (i + 1) % n;
      const dx = TR.xs[b] - TR.xs[a], dz = TR.zs[b] - TR.zs[a], l = Math.hypot(dx, dz);
      TR.dx[i] = dx / l; TR.dz[i] = dz / l;
    }
    let a = new Float32Array(n), b = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = baseNoTrail(TR.xs[i], TR.zs[i]);
    const raw = a.slice();
    const W = 7;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        let s = 0;
        for (let k = -W; k <= W; k++) s += a[(i + k + n) % n];
        b[i] = s / (2 * W + 1);
      }
      const t = a; a = b; b = t;
    }
    // keep the trail above the lake only where it runs beside the lake
    const L = T.lake;
    for (let i = 0; i < n; i++) {
      const dl = Math.hypot(TR.xs[i] - L.x, TR.zs[i] - L.z) / L.r;
      TR.ys[i] = dl < 2.2 ? Math.max(a[i], T.WATER + 0.8) : a[i];
    }
    // shoulders widen where the trail sits far above or below the land beside it, so banks stay gentle
    const sh = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let diff = Math.abs(TR.ys[i] - raw[i]);
      for (const side of [-1, 1]) {
        const x = TR.xs[i] - TR.dz[i] * side * 12, z = TR.zs[i] + TR.dx[i] * side * 12;
        diff = Math.max(diff, Math.abs(TR.ys[i] - baseNoTrail(x, z)));
      }
      sh[i] = U.clamp(diff * 3.5, TR_SH, TR_SHMAX);
    }
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (let k = -10; k <= 10; k++) s = Math.max(s, sh[(i + k + n) % n]);
      TR.sh[i] = s;
    }
    TR.grid = new Array(TR_GN * TR_GN);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = Math.min(TR.xs[i], TR.xs[j]) - TR_INF, x1 = Math.max(TR.xs[i], TR.xs[j]) + TR_INF;
      const z0 = Math.min(TR.zs[i], TR.zs[j]) - TR_INF, z1 = Math.max(TR.zs[i], TR.zs[j]) + TR_INF;
      const ci0 = Math.max(0, Math.floor((x0 + HALF) / TR_CELL)), ci1 = Math.min(TR_GN - 1, Math.floor((x1 + HALF) / TR_CELL));
      const cj0 = Math.max(0, Math.floor((z0 + HALF) / TR_CELL)), cj1 = Math.min(TR_GN - 1, Math.floor((z1 + HALF) / TR_CELL));
      for (let cj = cj0; cj <= cj1; cj++) for (let ci = ci0; ci <= ci1; ci++) {
        const k = cj * TR_GN + ci;
        (TR.grid[k] || (TR.grid[k] = [])).push(i);
      }
    }
  }

  function heading(i) { return Math.atan2(TR.dz[i], TR.dx[i]); }

  function buildRamps() {
    const n = TR.n, picks = [];
    for (const f of [0.1, 0.23, 0.37, 0.51, 0.65, 0.79, 0.9]) {
      let best = -1, bestScore = 1e9;
      for (let k = -60; k <= 60; k += 2) {
        const i = (Math.round(f * n) + k + n) % n;
        let turn = 0;
        for (let m = -8; m < 22; m++) {
          const p = (i + m + n) % n, q = (p + 1) % n;
          turn += Math.abs(U.wrapAngle(heading(q) - heading(p)));
        }
        const climb = TR.ys[(i + 5) % n] - TR.ys[i];
        const score = turn * 12 + Math.max(0, climb) * 0.8 + Math.abs(climb) * 0.3;
        if (score < bestScore) { bestScore = score; best = i; }
      }
      picks.push(best);
    }
    // the danger-sign jump is the pick followed by the biggest drop
    let danger = 0, bestDrop = -1e9;
    picks.forEach((i, k) => {
      const drop = TR.ys[(i + 8) % n] - TR.ys[(i + 26) % n];
      if (drop > bestDrop) { bestDrop = drop; danger = k; }
    });
    T.ramps = picks.map((i, k) => {
      const big = k === danger;
      const len = big ? 11 : 9, hgt = big ? 2.5 : 1.7;
      const iL = (i + Math.round(len / TR.step)) % n;
      return {
        i, x: TR.xs[i], z: TR.zs[i], dx: TR.dx[i], dz: TR.dz[i],
        len, wid: big ? 6 : 5.2, hgt, back: 2.2,
        base: TR.ys[i] - 0.05, slope: (TR.ys[iL] - TR.ys[i]) / len,
        danger: big,
      };
    });
    // speed trap: end of the straightest 160 m that is not near a ramp
    let bestI = 0, bestTurn = 1e9;
    for (let i = 0; i < n; i += 4) {
      if (T.ramps.some(r => Math.abs(((i - r.i + n * 1.5) % n) - n * 0.5) < 90)) continue;
      if (i < 100 || i > n - 100) continue;
      let turn = 0;
      for (let m = -80; m < 0; m++) {
        const p = (i + m + n) % n, q = (p + 1) % n;
        turn += Math.abs(U.wrapAngle(heading(q) - heading(p)));
      }
      if (turn < bestTurn) { bestTurn = turn; bestI = i; }
    }
    T.speedTrap = { i: bestI, x: TR.xs[bestI], z: TR.zs[bestI], dx: TR.dx[bestI], dz: TR.dz[bestI], y: TR.ys[bestI] };
  }

  // ---------------------------------------------------------------- queries
  T.height = height;
  T.phys = (x, z) => {
    const h = height(x, z);
    if (!T.ramps.length) return h;
    const r = rampH(x, z);
    return r > h ? r : h;
  };
  T.normal = (x, z, out) => {
    const e = 0.3;
    const hx = T.phys(x + e, z) - T.phys(x - e, z), hz = T.phys(x, z + e) - T.phys(x, z - e);
    return out.set(-hx, 2 * e, -hz).normalize();
  };
  const SURF = {
    dirt: { name: 'dirt', grip: 1.0, dust: U.lin(0xa0835e), dustAmt: 1.0 },
    grass: { name: 'grass', grip: 0.86, dust: U.lin(0x8a8a5a), dustAmt: 0.45 },
    sand: { name: 'sand', grip: 0.76, dust: U.lin(0xd8c9a3), dustAmt: 1.4 },
    water: { name: 'water', grip: 0.7, dust: U.lin(0xdfeef5), dustAmt: 1.0 },
    wood: { name: 'wood', grip: 1.0, dust: U.lin(0x9c8a70), dustAmt: 0.2 },
  };
  T.SURF = SURF;
  T.surface = (x, z) => {
    const h = height(x, z), q = T.q;
    if (T.ramps.length && rampH(x, z) > h + 0.05) return SURF.wood;
    if (q.lake < 1.05 && h < T.WATER) return SURF.water;
    if (q.trail > 0.5) return SURF.dirt;
    if (q.lake < 1.4 && h < T.WATER + 1.8) return SURF.sand;
    return SURF.grass;
  };

  T.trail = {
    get n() { return TR.n; }, get len() { return TR.len; }, get step() { return TR.step; },
    get xs() { return TR.xs; }, get zs() { return TR.zs; }, get ys() { return TR.ys; },
    get dx() { return TR.dx; }, get dz() { return TR.dz; },
    // position and direction at arc length s (wraps)
    at(s, out = {}) {
      const L = TR.len, n = TR.n;
      s = ((s % L) + L) % L;
      const f = s / TR.step, i = Math.floor(f) % n, j = (i + 1) % n, t = f - Math.floor(f);
      out.x = U.lerp(TR.xs[i], TR.xs[j], t); out.z = U.lerp(TR.zs[i], TR.zs[j], t); out.y = U.lerp(TR.ys[i], TR.ys[j], t);
      const dx = U.lerp(TR.dx[i], TR.dx[j], t), dz = U.lerp(TR.dz[i], TR.dz[j], t), l = Math.hypot(dx, dz);
      out.dx = dx / l; out.dz = dz / l; out.s = s;
      return out;
    },
    // index of the nearest trail sample (any distance)
    nearest(x, z) {
      if (trailNear(x, z)) return { i: near.i, d: near.d, s: (near.i + near.t) * TR.step };
      let bi = 0, bd = 1e18;
      for (let i = 0; i < TR.n; i++) { const d = (TR.xs[i] - x) ** 2 + (TR.zs[i] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
      return { i: bi, d: Math.sqrt(bd), s: bi * TR.step };
    },
  };

  // ---------------------------------------------------------------- surface weights
  // grass, dirt, rock, sand blend weights plus snow and wetness; shared by the terrain mesh and grass placement
  function weights(x, z, h, ny, trail, lat, lakeQ, out, o) {
    const rock = Math.max(U.smooth(0.86, 0.66, ny), U.smooth(58, 96, h) * 0.95);
    let sand = 0;
    if (lakeQ < 1.6) sand = U.smooth(T.WATER + 1.9, T.WATER + 0.7, h) * U.smooth(1.6, 1.15, lakeQ);
    if (h < T.WATER && lakeQ < 1.3) sand = 1;
    const patch = U.smooth(0.76, 0.9, N.simplex(x / 24 + 9, z / 24 - 4) * 0.5 + 0.5) * 0.6 * (1 - rock);
    const dirt = Math.max(trail, patch * (1 - sand));
    const grass = Math.max(0, 1 - Math.max(rock, sand, dirt));
    const sum = grass + dirt + rock + sand + 1e-6;
    out[o] = grass / sum; out[o + 1] = dirt / sum; out[o + 2] = rock / sum; out[o + 3] = sand / sum;
    out[o + 4] = U.smooth(120, 150, h + N.simplex(x / 40, z / 40) * 14);
    out[o + 5] = lakeQ < 1.6 ? U.smooth(T.WATER + 0.9, T.WATER - 0.1, h) : 0;
    out[o + 6] = trail * Math.exp(-(((lat - 1.1) / 0.35) ** 2)) * 0.3;
  }
  const wtmp = new Float32Array(7);
  // weights at a point: [grass, dirt, rock, sand, snow, wet, rut, ny, h]
  T.surfaceAt = (x, z, out = new Float32Array(9)) => {
    const e = 0.6;
    const hx = height(x - e, z) - height(x + e, z), hz = height(x, z - e) - height(x, z + e);
    const ny = 2 * e / Math.hypot(hx, 2 * e, hz);
    const h = height(x, z), q = T.q;
    weights(x, z, h, ny, q.trail, q.lat, q.lake, wtmp, 0);
    out.set(wtmp, 0);
    out[7] = ny; out[8] = h;
    return out;
  };

  // ---------------------------------------------------------------- chunk meshes
  function buildChunk(ci, cj, lod) {
    const segs = LOD_SEGS[lod], step = CH / segs, n = segs + 1, g = segs + 3;
    const x0 = -HALF + ci * CH, z0 = -HALF + cj * CH;
    const hs = new Float32Array(g * g);
    const nv = n * n, total = nv + 4 * n;
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), col = new Float32Array(total * 3);
    const spl = new Float32Array(total * 4), ext = new Float32Array(total * 2);
    const trailA = new Float32Array(nv), latA = new Float32Array(nv), lakeA = new Float32Array(nv);
    for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) {
      hs[j * g + i] = height(x0 + (i - 1) * step, z0 + (j - 1) * step);
      if (i >= 1 && i <= n && j >= 1 && j <= n) {
        const k = (j - 1) * n + (i - 1);
        trailA[k] = T.q.trail; latA[k] = T.q.lat; lakeA[k] = T.q.lake;
      }
    }
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const k = j * n + i, gi = (j + 1) * g + (i + 1);
      const x = x0 + i * step, z = z0 + j * step, h = hs[gi];
      const nx = hs[gi - 1] - hs[gi + 1], nz = hs[gi - g] - hs[gi + g], ny = 2 * step;
      const il = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
      pos[k * 3] = x; pos[k * 3 + 1] = h; pos[k * 3 + 2] = z;
      nor[k * 3] = nx * il; nor[k * 3 + 1] = ny * il; nor[k * 3 + 2] = nz * il;
      weights(x, z, h, ny * il, trailA[k], latA[k], lakeA[k], wtmp, 0);
      spl[k * 4] = wtmp[0]; spl[k * 4 + 1] = wtmp[1]; spl[k * 4 + 2] = wtmp[2]; spl[k * 4 + 3] = wtmp[3];
      ext[k * 2] = wtmp[4]; ext[k * 2 + 1] = wtmp[5];
      const rut = wtmp[6];
      col[k * 3] = 1 - rut; col[k * 3 + 1] = 1 - rut * 1.05; col[k * 3 + 2] = 1 - rut * 1.1;
    }
    const edge = [t => t, t => (n - 1) * n + t, t => t * n, t => t * n + n - 1];
    const drop = step * 1.5 + 1.5;
    for (let e = 0; e < 4; e++) for (let t = 0; t < n; t++) {
      const s = edge[e](t), d = nv + e * n + t;
      pos[d * 3] = pos[s * 3]; pos[d * 3 + 1] = pos[s * 3 + 1] - drop; pos[d * 3 + 2] = pos[s * 3 + 2];
      for (let c = 0; c < 3; c++) { nor[d * 3 + c] = nor[s * 3 + c]; col[d * 3 + c] = col[s * 3 + c]; }
      for (let c = 0; c < 4; c++) spl[d * 4 + c] = spl[s * 4 + c];
      ext[d * 2] = ext[s * 2]; ext[d * 2 + 1] = ext[s * 2 + 1];
    }
    const idx = new Uint32Array((segs * segs * 2 + 4 * segs * 4) * 3);
    let o = 0;
    for (let j = 0; j < segs; j++) for (let i = 0; i < segs; i++) {
      const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
      idx[o++] = a; idx[o++] = c; idx[o++] = b;
      idx[o++] = b; idx[o++] = c; idx[o++] = d;
    }
    for (let e = 0; e < 4; e++) for (let t = 0; t < segs; t++) {
      const a = edge[e](t), b = edge[e](t + 1), sa = nv + e * n + t, sb = sa + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = sa; idx[o++] = b; idx[o++] = sb; idx[o++] = sa;
      idx[o++] = a; idx[o++] = sa; idx[o++] = b; idx[o++] = b; idx[o++] = sa; idx[o++] = sb;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('splat', new THREE.BufferAttribute(spl, 4));
    geo.setAttribute('extra', new THREE.BufferAttribute(ext, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  const chunks = [];
  let group = null, material = null;
  T.initMeshes = (scene, mat) => {
    group = new THREE.Group();
    group.name = 'terrain';
    scene.add(group);
    material = mat;
    for (let j = 0; j < NCH; j++) for (let i = 0; i < NCH; i++) chunks.push({ i, j, lod: -1, mesh: null });
  };
  function chunkDist(c, px, pz) {
    const x0 = -HALF + c.i * CH, z0 = -HALF + c.j * CH;
    const dx = Math.max(x0 - px, 0, px - (x0 + CH)), dz = Math.max(z0 - pz, 0, pz - (z0 + CH));
    return Math.sqrt(dx * dx + dz * dz);
  }
  const lodFor = d => (d < LOD_DIST[0] ? 0 : d < LOD_DIST[1] ? 1 : d < LOD_DIST[2] ? 2 : 3);
  // rebuild up to `budget` chunks whose level of detail should change; returns how many are pending
  T.updateChunks = (px, pz, budget) => {
    const todo = [];
    for (const c of chunks) {
      const d = chunkDist(c, px, pz), w = lodFor(d);
      if (w === c.lod) continue;
      if (c.lod >= 0 && w > c.lod && lodFor(Math.max(0, d - 30)) <= c.lod) continue;
      todo.push({ c, w, k: (c.lod < 0 || w < c.lod ? 0 : 1000) + d });
    }
    todo.sort((a, b) => a.k - b.k);
    const m = Math.min(budget, todo.length);
    for (let k = 0; k < m; k++) {
      const { c, w } = todo[k];
      const geo = buildChunk(c.i, c.j, w);
      if (c.mesh) { c.mesh.geometry.dispose(); c.mesh.geometry = geo; }
      else {
        c.mesh = new THREE.Mesh(geo, material);
        c.mesh.receiveShadow = true;
        c.mesh.matrixAutoUpdate = false;
        group.add(c.mesh);
      }
      c.lod = w;
    }
    return todo.length - m;
  };
  T.lodStats = () => { const s = [0, 0, 0, 0]; for (const c of chunks) if (c.lod >= 0) s[c.lod]++; return s; };

  // ---------------------------------------------------------------- minimap image (sRGB)
  T.mapCanvas = (res = 512) => {
    const cv = document.createElement('canvas');
    cv.width = cv.height = res;
    const ctx = cv.getContext('2d'), img = ctx.createImageData(res, res), px = img.data;
    const s = SIZE / res, hs = new Float32Array(res * res), tr = new Float32Array(res * res), lk = new Float32Array(res * res);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const k = j * res + i;
      hs[k] = height(-HALF + (i + 0.5) * s, -HALF + (j + 0.5) * s);
      tr[k] = T.q.trail; lk[k] = T.q.lake;
    }
    const lerpC = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const k = j * res + i;
      const h = hs[k];
      const hl = hs[j * res + Math.max(0, i - 1)], hr = hs[j * res + Math.min(res - 1, i + 1)];
      const hu = hs[Math.max(0, j - 1) * res + i], hd = hs[Math.min(res - 1, j + 1) * res + i];
      const shade = U.clamp(1 + ((hl - hr) + (hu - hd)) * 0.045, 0.55, 1.3);
      let c;
      if (h < T.WATER && lk[k] < 1.1) c = lerpC([70, 140, 180], [40, 95, 140], U.smooth(0, 6, T.WATER - h));
      else {
        c = lerpC([92, 128, 62], [128, 150, 76], U.smooth(-20, 40, h));
        c = lerpC(c, [138, 132, 120], U.smooth(60, 100, h));
        c = lerpC(c, [235, 238, 242], U.smooth(120, 150, h));
        c = [c[0] * shade, c[1] * shade, c[2] * shade];
        if (tr[k] > 0.3) c = lerpC(c, [236, 214, 170], U.smooth(0.3, 0.8, tr[k]));
      }
      px[k * 4] = c[0]; px[k * 4 + 1] = c[1]; px[k * 4 + 2] = c[2]; px[k * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return cv;
  };

  // ---------------------------------------------------------------- init
  T.init = () => {
    computeWater();
    T.fest.x = CTRL[0][0]; T.fest.z = CTRL[0][1];
    T.fest.h = Math.max(lakeMod(T.fest.x, T.fest.z, natural(T.fest.x, T.fest.z)), T.WATER + 3);
    buildTrail();
    buildRamps();
  };

  return T;
})();
