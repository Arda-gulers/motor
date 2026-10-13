'use strict';
// Shared helpers: math, seeded noise, geometry merging, keyboard input.

const U = {
  clamp: (v, a, b) => (v < a ? a : v > b ? b : v),
  lerp: (a, b, t) => a + (b - a) * t,
  smooth(a, b, x) { const t = U.clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); },
  damp: (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt)),
  rng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  },
  hash2(ix, iz, salt = 0) {
    let h = Math.imul(ix | 0, 374761393) + Math.imul(iz | 0, 668265263) + Math.imul(salt | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  },
  wrapAngle(a) { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; },
  fmtTime(t) {
    if (!isFinite(t)) return '--:--.--';
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  },
  fmtInt: n => Math.round(n).toLocaleString('en-US'),
  // a macrotask that is not throttled in hidden tabs
  yieldNow() { return new Promise(r => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); }); },
  // sRGB hex -> linear [r, g, b]
  lin(hex) { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; },
  // colour every vertex of a geometry, fn(x, y, z) -> [r, g, b] (linear)
  paint(geo, fn) {
    const p = geo.attributes.position, a = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const c = fn(p.getX(i), p.getY(i), p.getZ(i)); a[i * 3] = c[0]; a[i * 3 + 1] = c[1]; a[i * 3 + 2] = c[2]; }
    geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
    return geo;
  },
  // merge geometries into one non-indexed geometry (position, normal; colour and uv if every part has them)
  merge(geos) {
    const parts = geos.map(g => (g.index ? g.toNonIndexed() : g));
    const hasColor = parts.every(g => g.attributes.color), hasUv = parts.every(g => g.attributes.uv);
    let n = 0;
    for (const g of parts) n += g.attributes.position.count;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3);
    const col = hasColor ? new Float32Array(n * 3) : null, uv = hasUv ? new Float32Array(n * 2) : null;
    let o = 0;
    for (const g of parts) {
      if (!g.attributes.normal) g.computeVertexNormals();
      pos.set(g.attributes.position.array, o * 3);
      nor.set(g.attributes.normal.array, o * 3);
      if (col) col.set(g.attributes.color.array, o * 3);
      if (uv) uv.set(g.attributes.uv.array, o * 2);
      o += g.attributes.position.count;
    }
    const m = new THREE.BufferGeometry();
    m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    if (col) m.setAttribute('color', new THREE.BufferAttribute(col, 3));
    if (uv) m.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    return m;
  },
  // replace the static meshes under `group` with one mesh per material; `deep` also folds in nested
  // groups (for objects that never move), otherwise only direct children without userData.dyn
  bake(group, deep = false) {
    group.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(group.matrixWorld).invert(), m4 = new THREE.Matrix4();
    const byMat = new Map(), victims = [];
    const visit = o => {
      for (const c of o.children) {
        if (c.isMesh && (deep || !c.userData.dyn)) {
          m4.multiplyMatrices(inv, c.matrixWorld);
          const list = byMat.get(c.material) || [];
          list.push(c.geometry.clone().applyMatrix4(m4));
          byMat.set(c.material, list);
          victims.push(c);
        } else if (deep && !c.isMesh) visit(c);
      }
    };
    visit(group);
    for (const c of victims) c.parent.remove(c);
    for (const [mat, list] of byMat) {
      const mesh = new THREE.Mesh(U.merge(list), mat);
      mesh.castShadow = mesh.receiveShadow = true;
      group.add(mesh);
    }
    return group;
  },
  // rounded box: a subdivided box whose vertices are pulled onto a rounded shell
  roundBox(w, h, d, r, seg = 3) {
    const g = new THREE.BoxGeometry(w, h, d, seg * 2, seg * 2, seg * 2);
    const p = g.attributes.position, v = new THREE.Vector3(), c = new THREE.Vector3();
    const ix = w / 2 - r, iy = h / 2 - r, iz = d / 2 - r;
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      c.set(U.clamp(v.x, -ix, ix), U.clamp(v.y, -iy, iy), U.clamp(v.z, -iz, iz));
      v.sub(c);
      if (v.lengthSq() > 1e-9) v.setLength(r);
      v.add(c);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.computeVertexNormals();
    return g;
  },
  // canvas texture helper
  canvasTex(w, h, draw) {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  },
};

const Noise = (() => {
  const perm = new Uint8Array(512);
  const gx = [1, -1, 1, -1, 1, -1, 0, 0], gy = [1, 1, -1, -1, 0, 0, 1, -1];
  const r = U.rng(20261005);
  const p = [];
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  const F2 = 0.5 * (Math.sqrt(3) - 1), G2 = (3 - Math.sqrt(3)) / 6;

  // 2D simplex noise, roughly [-1, 1]
  function simplex(xin, yin) {
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    const i1 = x0 > y0 ? 1 : 0, j1 = 1 - i1;
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2, x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;
    let n = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 > 0) { const g = perm[ii + perm[jj]] & 7; t0 *= t0; n += t0 * t0 * (gx[g] * x0 + gy[g] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 > 0) { const g = perm[ii + i1 + perm[jj + j1]] & 7; t1 *= t1; n += t1 * t1 * (gx[g] * x1 + gy[g] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 > 0) { const g = perm[ii + 1 + perm[jj + 1]] & 7; t2 *= t2; n += t2 * t2 * (gx[g] * x2 + gy[g] * y2); }
    return 70 * n;
  }
  function fbm(x, y, oct) {
    let s = 0, a = 0.5, norm = 0;
    for (let o = 0; o < oct; o++) { s += a * simplex(x, y); norm += a; x = x * 2.03 + 17.1; y = y * 2.03 - 9.7; a *= 0.5; }
    return s / norm;
  }
  // ridged multifractal in [0, 1]
  function ridged(x, y, oct) {
    let s = 0, a = 0.5, norm = 0;
    for (let o = 0; o < oct; o++) { const n = 1 - Math.abs(simplex(x, y)); s += a * n * n; norm += a; x = x * 2.1 + 3.3; y = y * 2.1 - 5.1; a *= 0.5; }
    return s / norm;
  }
  return { simplex, fbm, ridged };
})();

const Input = {
  keys: Object.create(null),
  hits: Object.create(null),
  fake: null,              // {throttle, brake, steer, handbrake} overrides the keyboard (debug driver)
  onAny: [],
  init() {
    const block = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'Tab']);
    addEventListener('keydown', e => {
      if (block.has(e.code)) e.preventDefault();
      if (!this.keys[e.code]) this.hits[e.code] = true;
      this.keys[e.code] = true;
      for (const f of this.onAny) f(e);
    });
    addEventListener('keyup', e => { this.keys[e.code] = false; });
    addEventListener('blur', () => { this.keys = Object.create(null); });
  },
  down(...codes) { for (const c of codes) if (this.keys[c]) return true; return false; },
  hit(...codes) { let r = false; for (const c of codes) if (this.hits[c]) { this.hits[c] = false; r = true; } return r; },
  press(code) { this.hits[code] = true; },
  anyHit() { for (const k in this.hits) if (this.hits[k]) return true; return false; },
  endFrame() { for (const k in this.hits) this.hits[k] = false; },
  drive() {
    if (this.fake) return this.fake;
    const l = this.down('KeyA', 'ArrowLeft'), r = this.down('KeyD', 'ArrowRight');
    return {
      throttle: this.down('KeyW', 'ArrowUp') ? 1 : 0,
      brake: this.down('KeyS', 'ArrowDown') ? 1 : 0,
      steer: (r ? 1 : 0) - (l ? 1 : 0),
      handbrake: this.down('Space') ? 1 : 0,
    };
  },
};
