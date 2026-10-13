'use strict';
// Playtest driver. Claude-in-Chrome tabs are hidden, so rAF never fires: take() stops the loop from
// stepping and run()/until() advance the game synchronously with fake input. bot() follows the trail.
// shot() posts a JPEG of the canvas (with the speedometer and minimap) to the dev server.

const DBG = {
  log: '', botOn: false, fake: null, msgs: [], stats: null,
  // record HUD messages and per-tick extremes while testing
  hook() {
    this.msgs = [];
    this.stats = { vmax: 0, upMin: 1, airMax: 0, nan: 0, flips: [] };
    if (!HUD._c) {
      HUD._c = HUD.center; HUD._t = HUD.toast;
      HUD.center = (h, l, c) => { DBG.msgs.push(Game.t.toFixed(1) + ' C:' + h.replace(/<[^>]+>/g, '')); return HUD._c(h, l, c); };
      HUD.toast = (h, c, l) => { DBG.msgs.push(Game.t.toFixed(1) + ' T:' + h.replace(/<[^>]+>/g, '')); return HUD._t(h, c, l); };
      const tick = Game.tick;
      Game.tick = dt => {
        tick(dt);
        const c = Game.car, s = DBG.stats;
        s.vmax = Math.max(s.vmax, c.speed * 3.6); s.airMax = Math.max(s.airMax, c.air);
        if (c.up.y < s.upMin) s.upMin = c.up.y;
        if (c.up.y < 0 && (!s.flips.length || Game.t - s.flips[s.flips.length - 1].t > 3)) s.flips.push({ t: +Game.t.toFixed(1), s: Terrain.trail.nearest(c.pos.x, c.pos.z).s | 0, kmh: c.speed * 3.6 | 0 });
        if (!isFinite(c.pos.x)) s.nan++;
      };
    }
    return 'hooked';
  },
  report() { return JSON.stringify(this.stats) + '\n' + this.msgs.join('\n'); },
  take() {
    Game.manual = true;
    Sfx.setMute(true);
    if (Game.state === 'title') Game.startPlay();
    return this.state();
  },
  release() { Game.manual = false; Input.fake = null; this.botOn = false; Game.fastSim = false; Game.last = performance.now(); return 'released'; },
  input(inp) { Input.fake = inp ? Object.assign({ throttle: 0, brake: 0, steer: 0, handbrake: 0 }, inp) : null; },
  run(sec, inp, opt = {}) {
    if (inp !== undefined) this.input(inp);
    const dt = opt.dt || 1 / 60, n = Math.round(sec / dt);
    Game.fastSim = !!opt.fast;
    for (let i = 0; i < n; i++) { if (this.botOn) this.bot(); Game.tick(dt); }
    Game.fastSim = false;
    if (!opt.fast) Game.render();
    return this.state();
  },
  until(cond, limit = 60, opt = {}) {
    const dt = opt.dt || 1 / 60;
    let t = 0;
    Game.fastSim = !!opt.fast;
    while (t < limit && !cond()) { if (this.botOn) this.bot(); Game.tick(dt); t += dt; }
    Game.fastSim = false;
    this.log = (cond() ? 'ok ' : 'timeout ') + t.toFixed(1) + 's';
    if (!opt.fast) Game.render();
    return this.state();
  },
  // stand on the trail at arc length s, optionally driving in for `drive` seconds, then render
  at(s, drive = 0) {
    if (Game.mode !== 'free') Game.Race.abort();
    this.tp(s - drive * 14);
    if (drive) { this.botOn = true; this.run(drive, undefined, { fast: true }); this.botOn = false; this.input(null); }
    return this.refresh();
  },
  // trail arc length where fn(x, z) is largest
  bestS(fn) {
    const tr = Terrain.trail;
    let best = 0, bv = -1e9;
    for (let i = 0; i < tr.n; i += 5) { const v = fn(tr.xs[i], tr.zs[i]); if (v > bv) { bv = v; best = i * tr.step; } }
    return best;
  },
  // after a fast run: rebuild visuals around the player and render one frame
  refresh() {
    Terrain.updateChunks(Game.car.pos.x, Game.car.pos.z, 1e9);
    World.grassRefresh(Game.car.pos);
    Game.snapCamera();
    for (let i = 0; i < 30; i++) Game.visuals(1 / 60, 0);
    Game.render();
    return this.state();
  },
  state() {
    const c = Game.car, R = Game.Race, S = Game.Skills, info = Game.renderer.info.render;
    const f = v => v.toFixed(1);
    return `state=${Game.state} mode=${Game.mode} pos=${f(c.pos.x)},${f(c.pos.y)},${f(c.pos.z)} kmh=${f(c.speed * 3.6)} vf=${c.vf.toFixed(2)} gnd=${c.grounded} up=${c.up.y.toFixed(2)} `
      + `comp=${c.wheels.map(w => w.comp.toFixed(2)).join('/')} steer=${c.steer.toFixed(2)} gear=${c.gear} rpm=${c.rpm | 0} air=${c.air.toFixed(2)} `
      + `race=${R.next}/${R.n} t=${R.time.toFixed(1)} chain=${S.count}:${S.pts | 0}x${S.mult} total=${S.total} lod=${Terrain.lodStats()} calls=${info.calls} tris=${info.triangles} log=${this.log}`;
  },
  tp(s, offset = 0) {
    const p = Terrain.trail.at(s);
    Game.car.reset(p.x - p.dz * offset, p.z + p.dx * offset, Vehicle.Car.yawFromDir(p.dx, p.dz));
    Game.snapCamera();
    return this.state();
  },
  view(px, py, pz, lx, ly, lz) {
    const cam = Game.camera;
    cam.position.set(px, py, pz);
    cam.up.set(0, 1, 0);
    cam.lookAt(lx, ly, lz);
    World.update(0, new THREE.Vector3(lx, ly, lz), cam);
    Game.render();
    return 'view set';
  },
  async shot(name = 'shot', withHud = true) {
    const gl = Game.renderer.domElement;
    const cv = document.createElement('canvas');
    cv.width = gl.width; cv.height = gl.height;
    const g = cv.getContext('2d');
    g.drawImage(gl, 0, 0);
    if (withHud && Game.state === 'play') {
      const k = gl.width / innerWidth;
      for (const id of ['minimap', 'speedo']) {
        const e = document.getElementById(id), r = e.getBoundingClientRect();
        if (r.width) g.drawImage(e, r.left * k, r.top * k, r.width * k, r.height * k);
      }
    }
    const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.88));
    const res = await fetch('/shot?name=' + encodeURIComponent(name), { method: 'POST', body: blob });
    return res.ok ? 'saved ' + name + ' ' + cv.width + 'x' + cv.height : 'failed';
  },
  // follow the trail at a speed limited by the curvature ahead
  bot() {
    const c = Game.car, tr = Terrain.trail;
    if (Game.Det.stuckT > 3) { this.stuck = (this.stuck || 0) + 1; Game.respawn(''); }
    const near = tr.nearest(c.pos.x, c.pos.z);
    const tgt = tr.at(near.s + 7 + c.speed * 0.8);
    const fa = Math.atan2(c.fwd.x, c.fwd.z), ta = Math.atan2(tgt.x - c.pos.x, tgt.z - c.pos.z);
    const steer = U.clamp(-U.wrapAngle(ta - fa) * 2.4, -1, 1);
    // corner speed from curvature (lateral 8 m/s^2), reachable by braking at 7 m/s^2 over the distance to it
    let vmax = 31;
    for (let k = 4; k <= 90; k += 4) {
      const p = tr.at(near.s + k), q = tr.at(near.s + k + 4);
      const kap = Math.abs(U.wrapAngle(Math.atan2(q.dx, q.dz) - Math.atan2(p.dx, p.dz))) / 4;
      const vc = Math.sqrt(8 / Math.max(kap, 1e-4));
      vmax = Math.min(vmax, Math.sqrt(vc * vc + 2 * 7 * k));
    }
    this.input({ throttle: c.speed < vmax ? 1 : 0, brake: c.speed > vmax + 1.5 ? 1 : 0, steer });
  },
  // run the race with the bot; call repeatedly (each call simulates at most `chunk` seconds)
  lap(chunk = 40) {
    if (Game.mode !== 'race' && Game.mode !== 'countdown') { Game.Race.begin(); this.lapLog = { respawns: 0, start: Game.t }; }
    this.botOn = true;
    const t0 = Game.t;
    this.until(() => Game.mode === 'results' || Game.t - t0 > chunk, chunk + 1, { fast: true });
    this.botOn = false;
    this.input(null);
    return this.state();
  },
};
