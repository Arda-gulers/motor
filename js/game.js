'use strict';
// Game loop, chase camera, modes (title / free roam / countdown / race / results), skill chains,
// PR stunts (speed trap, danger-sign jump), respawn and per-frame effects.

const Game = (() => {
  const V3 = THREE.Vector3;
  const STEP = 1 / 120;
  const G = { state: 'loading', mode: 'free', t: 0, camMode: 0, manual: false, paused: false, acc: 0, last: 0 };
  let renderer, scene, camera, car, atv;
  const store = {
    get(k, d) { try { const v = localStorage.getItem('motuo.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('motuo.' + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  const stars = (v, t) => '★'.repeat(t.filter(x => v >= x).length) + '☆'.repeat(t.filter(x => v < x).length);

  // ---------------------------------------------------------------- skill chain
  const Skills = {
    count: 0, pts: 0, mult: 1, timer: 0, window: 4, list: [], total: 0,
    award(name, p) {
      if (G.mode === 'countdown' || G.state !== 'play') return;
      this.count++;
      this.pts += p;
      this.mult = Math.min(10, 1 + Math.floor(this.count / 3));
      this.timer = this.window;
      this.list.unshift({ name, pts: p });
      if (this.list.length > 6) this.list.pop();
      Sfx.play('skill');
    },
    update(dt) { if (this.count) { this.timer -= dt; if (this.timer <= 0) this.bank(); } },
    bank() {
      if (!this.count) return;
      const v = Math.round(this.pts * this.mult);
      this.total += v;
      if (G.mode === 'race') Race.skill += v;
      HUD.toast(`技巧连击 <b>+${U.fmtInt(v)}</b>`, 'bank');
      Sfx.play('bank');
      this.reset();
    },
    lose(reason) {
      if (!this.count) return;
      HUD.toast(`${reason} · 连击中断 <s>${U.fmtInt(this.pts * this.mult)}</s>`, 'lost');
      Sfx.play('lost');
      this.reset();
    },
    reset() { this.count = 0; this.pts = 0; this.mult = 1; this.timer = 0; this.list = []; },
  };

  // ---------------------------------------------------------------- detectors
  const Det = { driftPts: 0, driftOff: 0, speedT: 0, offT: 0, near: new Map(), hit: new Set(), pendingAir: null, flipT: 0, waterT: 0, stuckT: 0, jump: null, list: [] };

  function detectSkills(dt) {
    const sp = car.speed, vx = car.vel.x, vz = car.vel.z, vh = Math.hypot(vx, vz);
    const fx = car.fwd.x, fz = car.fwd.z, fh = Math.hypot(fx, fz);
    const ang = vh > 1 && fh > 0.3 ? Math.acos(U.clamp((vx * fx + vz * fz) / (vh * fh), -1, 1)) : 0;
    if (car.grounded >= 3 && vh > 9 && ang > 0.26 && ang < 1.5 && car.vf > 0) {
      Det.driftPts += dt * vh * ang * 14;
      Det.driftOff = 0;
    } else if (Det.driftPts > 0) {
      Det.driftOff += dt;
      if (Det.driftOff > 0.45) {
        if (Det.driftPts > 60) Skills.award(Det.driftPts > 600 ? '超级漂移' : Det.driftPts > 250 ? '大漂移' : '漂移', Math.round(Det.driftPts));
        Det.driftPts = 0;
      }
    }
    if (sp > 25) { Det.speedT += dt; if (Det.speedT > 2.2) { Skills.award('极速狂飙', 150); Det.speedT = 0; } } else Det.speedT = 0;
    Terrain.height(car.pos.x, car.pos.z);
    if (Terrain.q.trail < 0.05 && sp > 14 && car.grounded) { Det.offT += dt; if (Det.offT > 3) { Skills.award('越野', 120); Det.offT = 0; } }
    else if (car.grounded) Det.offT = Math.max(0, Det.offT - dt);
    if (sp > 12) {
      Det.list.length = 0;
      World.queryObstacles(car.pos.x, car.pos.z, 4, Det.list);
      for (const o of Det.list) {
        if (!o.tree && !o.rock) continue;
        const d = Math.hypot(o.x - car.pos.x, o.z - car.pos.z) - o.r;
        if (d < 2.4 && d > 0.8 && !Det.near.has(o.id)) Det.near.set(o.id, { o, t: G.t });
      }
    }
    for (const [id, rec] of Det.near) {
      const rel = (rec.o.x - car.pos.x) * vx + (rec.o.z - car.pos.z) * vz;
      if (rel < -2 * vh) {
        if (!Det.hit.has(id)) Skills.award('擦身而过', 100);
        Det.near.delete(id);
      } else if (G.t - rec.t > 4) Det.near.delete(id);
    }
    if (Det.pendingAir) {
      Det.pendingAir.t -= dt;
      if (Det.pendingAir.t <= 0) { Skills.award(Det.pendingAir.name, Det.pendingAir.pts); Det.pendingAir = null; }
    }
  }

  function handleEvents() {
    for (const e of car.events) {
      if (e.type === 'land') {
        if (e.v > 3) { FX.shake(Math.min(0.55, e.v * 0.045)); Sfx.play('land', e.v / 12); landingDust(e.v); }
        if (G.state === 'play' && e.air > 0.55) Det.pendingAir = { name: e.air > 1.8 ? '大飞跃' : e.air > 1.1 ? '飞跃' : '腾空', pts: Math.round(80 + e.air * 200), t: 0.4 };
        if (Det.jump) {
          const d = Math.hypot(car.pos.x - Det.jump.x, car.pos.z - Det.jump.z);
          if (d > 6 && G.state === 'play') {
            const best = store.get('jump', 0), nb = d > best;
            if (nb) store.set('jump', d);
            HUD.toast(`飞跃距离 <b>${d.toFixed(1)} m</b> ${stars(d, [25, 40, 55])}${nb ? ' · 新纪录' : ''}`, 'pr', 4);
            Sfx.play('trap');
          }
          Det.jump = null;
        }
      } else if (e.type === 'head') {
        Det.pendingAir = null;
        Skills.lose('翻车');
        FX.shake(0.5);
        Sfx.play('hit', 0.8);
      } else if (e.type === 'hit') {
        Det.hit.add(e.obj.id);
        if (e.v > 2) { FX.shake(Math.min(0.7, e.v * 0.07)); Sfx.play('hit', e.v / 10); }
        if (e.v > 5) Skills.lose('撞击');
      } else if (e.type === 'shift') Sfx.play('shift');
    }
    car.events.length = 0;
  }

  function stunts(prev, dt) {
    const st = Terrain.speedTrap;
    const a = (prev.x - st.x) * st.dx + (prev.z - st.z) * st.dz, b = (car.pos.x - st.x) * st.dx + (car.pos.z - st.z) * st.dz;
    if (a < 0 && b >= 0 && Math.abs((car.pos.x - st.x) * -st.dz + (car.pos.z - st.z) * st.dx) < 10) {
      const kmh = car.speed * 3.6, best = store.get('trap', 0), nb = kmh > best;
      if (nb) store.set('trap', kmh);
      HUD.toast(`测速区 <b>${kmh.toFixed(0)} km/h</b> ${stars(kmh, [70, 85, 100])}${nb ? ' · 新纪录' : ''}`, 'pr', 4);
      Sfx.play('trap');
    }
    const r = G.danger;
    const ua = (prev.x - r.x) * r.dx + (prev.z - r.z) * r.dz - r.len, ub = (car.pos.x - r.x) * r.dx + (car.pos.z - r.z) * r.dz - r.len;
    if (ua < 0 && ub >= 0 && Math.abs((car.pos.x - r.x) * -r.dz + (car.pos.z - r.z) * r.dx) < r.wid) Det.jump = { x: car.pos.x, z: car.pos.z, t: 0 };
    if (Det.jump && (Det.jump.t += dt) > 6) Det.jump = null;
  }

  // ---------------------------------------------------------------- race
  const Race = {
    name: '荒原环线赛', n: 0, cps: [], gates: [], beam: null, next: 1, time: 0, best: 0, skill: 0, lastS: 0, count: 0, lastCount: 0,
    init() {
      const tr = Terrain.trail, L = tr.len;
      this.n = Math.max(8, Math.round(L / 260));
      for (let k = 0; k < this.n; k++) {
        const p = tr.at((L * k) / this.n);
        this.cps.push(p);
        if (k === 0) { this.gates.push(null); continue; }
        const g = World.makeGate(p, k);
        g.visible = false;
        scene.add(g);
        this.gates.push(g);
      }
      this.beam = World.beamMesh(0x2de2ff, 1.3, 90, 0.3);
      this.beam.visible = false;
      scene.add(this.beam);
      this.best = store.get('best', 0);
    },
    begin() {
      const tr = Terrain.trail, s = tr.len - 16, p = tr.at(s);
      car.reset(p.x, p.z, Vehicle.Car.yawFromDir(p.dx, p.dz));
      snapCamera();
      this.next = 1; this.time = 0; this.skill = 0; this.lastS = s;
      Skills.reset();
      for (const g of this.gates) if (g) g.visible = true;
      this.placeBeam();
      G.mode = 'countdown';
      this.count = 3; this.lastCount = 4;
      HUD.prompt(null);
      HUD.show('results', false);
    },
    target() { return this.cps[this.next % this.n]; },
    placeBeam() {
      const c = this.target();
      this.beam.position.set(c.x, Terrain.height(c.x, c.z), c.z);
      this.beam.visible = true;
      this.gates.forEach((g, k) => { if (g) g.userData.flagMat.emissiveIntensity = k === this.next ? 2.5 : 0.4; });
    },
    update(dt, prev) {
      if (G.mode === 'countdown') {
        this.count -= dt;
        const c = Math.ceil(this.count);
        if (c !== this.lastCount) {
          this.lastCount = c;
          if (c > 0) { HUD.center(`<span class="count">${c}</span>`, 0.9); Sfx.play('count'); }
          else { HUD.center('<span class="count go">出发!</span>', 1.0); Sfx.play('go'); G.mode = 'race'; }
        }
        return;
      }
      if (G.mode !== 'race') return;
      this.time += dt;
      const c = this.target();
      const a = (prev.x - c.x) * c.dx + (prev.z - c.z) * c.dz, b = (car.pos.x - c.x) * c.dx + (car.pos.z - c.z) * c.dz;
      const lat = Math.abs((car.pos.x - c.x) * -c.dz + (car.pos.z - c.z) * c.dx);
      if (a < 0 && b >= 0 && lat < 16) {
        if (this.next === this.n) { this.finish(); return; }
        this.lastS = c.s;
        HUD.toast(`检查点 ${this.next}/${this.n - 1} · ${U.fmtTime(this.time)}`, 'cp', 2.2);
        Sfx.play('checkpoint');
        this.gates[this.next].visible = false;
        this.next++;
        this.placeBeam();
      }
    },
    finish() {
      Skills.bank();
      G.mode = 'results';
      const t = this.time, nb = !this.best || t < this.best;
      if (nb) { this.best = t; store.set('best', t); }
      this.hide();
      Sfx.play('finish');
      HUD.center('<span class="msg">完赛!</span>', 1.6);
      document.getElementById('results').innerHTML = `<div class="panel"><h2>荒原环线赛 · 完赛</h2>
        <div class="stat"><span>用时</span><b>${U.fmtTime(t)}</b></div>
        <div class="stat"><span>最佳</span><b class="${nb ? 'newbest' : ''}">${U.fmtTime(this.best)}${nb ? ' 新纪录!' : ''}</b></div>
        <div class="stat"><span>本场技巧分</span><b>${U.fmtInt(this.skill)}</b></div>
        <div class="hint"><kbd>E</kbd> 再来一次 &nbsp; <kbd>Esc</kbd> 自由驾驶</div></div>`;
      HUD.show('results', true);
    },
    hide() { for (const g of this.gates) if (g) g.visible = false; this.beam.visible = false; },
    abort() { this.hide(); G.mode = 'free'; HUD.show('results', false); },
    hudInfo() {
      if (G.mode !== 'race' && G.mode !== 'countdown') return null;
      const passed = this.next - 1;
      return { name: this.name, cp: this.next === this.n ? '冲向终点!' : `检查点 ${passed}/${this.n - 1}`, time: this.time, best: this.best };
    },
  };

  // ---------------------------------------------------------------- respawn and safety
  function respawn(msg) {
    const tr = Terrain.trail;
    const s = G.mode === 'race' ? Race.lastS : tr.nearest(car.pos.x, car.pos.z).s;
    const p = tr.at(s);
    car.reset(p.x, p.z, Vehicle.Car.yawFromDir(p.dx, p.dz));
    snapCamera();
    Det.flipT = 0; Det.waterT = 0; Det.jump = null; Det.pendingAir = null; Det.driftPts = 0;
    Skills.lose('复位');
    if (msg) HUD.center(`<span class="msg">${msg}</span>`, 1.6);
  }
  function safety(dt, inp) {
    // pushing on the controls without getting anywhere: offer the reset
    if ((G.mode === 'free' || G.mode === 'race') && car.speed < 1.0 && (inp.throttle || inp.brake)) Det.stuckT += dt; else Det.stuckT = 0;
    if (car.up.y < 0.3 && car.speed < 3) Det.flipT += dt; else Det.flipT = 0;
    if (Det.flipT > 1.6) { respawn('翻车了 · 已复位'); return; }
    const h = Terrain.height(car.pos.x, car.pos.z);
    if (Terrain.q.lake < 1.1 && car.pos.y < Terrain.WATER + 0.1 && h < Terrain.WATER - 0.8) Det.waterT += dt; else Det.waterT = 0;
    if (Det.waterT > 1.0) { respawn('水太深了'); return; }
    if (Math.abs(car.pos.x) > 1000 || Math.abs(car.pos.z) > 1000 || car.pos.y < h - 6) respawn('已复位');
  }

  // ---------------------------------------------------------------- effects
  const dustAcc = [0, 0, 0, 0], tmpC = [0, 0, 0], ex = new V3();
  function emitDust(dt) {
    for (let k = 0; k < 4; k++) {
      const W = car.wheels[k];
      if (!W.contact) continue;
      const surf = W.surf, water = surf === Terrain.SURF.water;
      const roll = Math.abs(W.vLong), slip = Math.abs(W.vLat) * 1.3 + car.wheelspin * 0.25;
      const rate = water ? roll * 4 : (Math.max(0, roll - 4) * 0.9 + slip * 3.2) * surf.dustAmt;
      dustAcc[k] += rate * dt;
      while (dustAcc[k] >= 1) {
        dustAcc[k] -= 1;
        // particles are unlit, so keep them darker than the sunlit ground they kick up
        const j = (0.85 + Math.random() * 0.3) * (water ? 1 : 0.6);
        tmpC[0] = surf.dust[0] * j; tmpC[1] = surf.dust[1] * j; tmpC[2] = surf.dust[2] * j;
        if (water) {
          FX.emit(W.cp.x + (Math.random() - 0.5) * 0.4, W.cp.y + 0.1, W.cp.z + (Math.random() - 0.5) * 0.4,
            -car.vel.x * 0.1 + (Math.random() - 0.5) * 2.5, 2 + Math.random() * 2.5, -car.vel.z * 0.1 + (Math.random() - 0.5) * 2.5,
            0.25 + Math.random() * 0.2, 0.6, 0.6 + Math.random() * 0.4, tmpC, 0.75, 0.6, 1.0);
        } else {
          FX.emit(W.cp.x + (Math.random() - 0.5) * 0.4, W.cp.y + 0.12, W.cp.z + (Math.random() - 0.5) * 0.4,
            -car.vel.x * 0.12 + (Math.random() - 0.5) * 1.4, 0.5 + Math.random() * 1.3, -car.vel.z * 0.12 + (Math.random() - 0.5) * 1.4,
            0.45 + Math.random() * 0.45, 1.7, 1.0 + Math.random() * 1.3, tmpC, 0.24, 1.1, -0.03);
        }
      }
    }
    if (car.throttle > 0 && Math.random() < 0.6) {
      ex.set(0.27, 0.01, 1.14).applyQuaternion(car.quat).add(car.pos);
      tmpC[0] = tmpC[1] = tmpC[2] = 0.35;
      FX.emit(ex.x, ex.y, ex.z, car.vel.x * 0.6, car.vel.y * 0.6 + 0.4, car.vel.z * 0.6, 0.12, 0.9, 0.5, tmpC, 0.16, 2.5, -0.05);
    }
  }
  function landingDust(v) {
    const n = Math.min(40, 8 + v * 3);
    const surf = car.wheels[0].surf;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 3;
      const j = 0.85 + Math.random() * 0.3;
      tmpC[0] = surf.dust[0] * j; tmpC[1] = surf.dust[1] * j; tmpC[2] = surf.dust[2] * j;
      FX.emit(car.pos.x + Math.cos(a) * 0.8, car.pos.y - 0.5, car.pos.z + Math.sin(a) * 0.8, Math.cos(a) * s, 0.4 + Math.random(), Math.sin(a) * s, 0.6, 2.2, 1.2 + Math.random(), tmpC, 0.35, 1.6, -0.02);
    }
    if (surf === Terrain.SURF.water) Sfx.play('splash', v / 8);
  }

  // ---------------------------------------------------------------- camera
  const cam = { pos: new V3(), yaw: 0, fov: 62, shake: new V3() };
  const tmpV = new V3(), look = new V3();
  function camTarget(out, dist, height) {
    out.set(car.pos.x - Math.sin(cam.yaw) * dist, car.pos.y + height, car.pos.z - Math.cos(cam.yaw) * dist);
    const gy = Terrain.height(out.x, out.z) + 1.0;
    if (out.y < gy) out.y = gy;
    return out;
  }
  function snapCamera() {
    cam.yaw = Math.atan2(car.fwd.x, car.fwd.z);
    camTarget(cam.pos, 5.6, 2.0);
  }
  function updateCamera(dt) {
    let fov = 62;
    if (G.state === 'title') {
      // slow sweep in front of the ATV, the start arch behind it
      const a = Math.atan2(car.fwd.x, car.fwd.z) + Math.sin(G.t * 0.15) * 0.9;
      cam.pos.set(car.pos.x + Math.sin(a) * 7.2, 0, car.pos.z + Math.cos(a) * 7.2);
      cam.pos.y = Math.max(car.pos.y + 1.3, Terrain.height(cam.pos.x, cam.pos.z) + 1.0);
      camera.position.copy(cam.pos);
      camera.up.set(0, 1, 0);
      // aim left of the ATV so it sits right of centre, clear of the title block
      const lx = (car.pos.x - cam.pos.x) / 7.2, lz = (car.pos.z - cam.pos.z) / 7.2;
      camera.lookAt(car.pos.x + lz * 2.2, car.pos.y + 0.7, car.pos.z - lx * 2.2);
    } else if (G.camMode === 2) {
      tmpV.set(0, 1.08, 0.02).applyQuaternion(car.quat).add(car.pos);
      camera.position.copy(tmpV);
      camera.up.copy(car.up).lerp(THREE.Object3D.DEFAULT_UP, 0.5).normalize();
      look.copy(tmpV).addScaledVector(car.fwd, 10).addScaledVector(car.up, -0.8);
      camera.lookAt(look);
      fov = 74 + U.clamp(car.speed / 30, 0, 1) * 10;
    } else {
      const far = G.camMode === 1;
      let fx = car.fwd.x, fz = car.fwd.z;
      if (car.grounded === 0 && car.speed > 6) { fx = car.vel.x; fz = car.vel.z; }
      if (Math.hypot(fx, fz) > 0.05) {
        const target = Math.atan2(fx, fz);
        cam.yaw += U.wrapAngle(target - cam.yaw) * (1 - Math.exp(-dt * (car.grounded ? 4.5 : 2.2)));
      }
      const dist = (far ? 8.2 : 5.4) + U.clamp(car.speed / 30, 0, 1) * 0.8, height = far ? 3.0 : 1.95;
      camTarget(tmpV, dist, height);
      cam.pos.x = U.damp(cam.pos.x, tmpV.x, 10, dt);
      cam.pos.z = U.damp(cam.pos.z, tmpV.z, 10, dt);
      cam.pos.y = U.damp(cam.pos.y, tmpV.y, 6, dt);
      const gy = Terrain.height(cam.pos.x, cam.pos.z) + 0.9;
      if (cam.pos.y < gy) cam.pos.y = gy;
      const tr = FX.trauma * FX.trauma, t = G.t * 30;
      cam.shake.set(Noise.simplex(t, 1.3) * tr * 0.35, Noise.simplex(t, 7.7) * tr * 0.35, Noise.simplex(t, 4.1) * tr * 0.35);
      camera.position.copy(cam.pos).add(cam.shake);
      camera.up.set(0, 1, 0);
      look.set(car.pos.x + Math.sin(cam.yaw) * 2.5, car.pos.y + 0.95, car.pos.z + Math.cos(cam.yaw) * 2.5);
      camera.lookAt(look);
      fov = 62 + U.clamp((car.speed - 4) / 26, 0, 1) * 15;
    }
    cam.fov = U.damp(cam.fov, fov, 3, dt);
    if (Math.abs(camera.fov - cam.fov) > 0.01) { camera.fov = cam.fov; camera.updateProjectionMatrix(); }
  }

  // ---------------------------------------------------------------- input, HUD
  function driveInput() {
    if (G.state !== 'play') return { handbrake: 1 };
    if (G.mode === 'countdown') return { handbrake: 1 };
    if (G.mode === 'results') return { brake: 0.5 };
    return Input.drive();
  }
  function mapMarks() {
    const m = [], rm = World.raceMarker, st = Terrain.speedTrap, dr = G.danger;
    m.push({ x: st.x, z: st.z, color: '#1a8cff', r: 9, text: '测' });
    m.push({ x: dr.x, z: dr.z, color: '#f5b800', r: 9, text: '跃' });
    if (G.mode === 'race' || G.mode === 'countdown') {
      Race.cps.forEach((c, k) => {
        if (k === 0 && Race.next !== Race.n) return;
        const isNext = k === Race.next % Race.n;
        if (!isNext && (k < Race.next && k !== 0)) return;
        m.push({ x: c.x, z: c.z, color: isNext ? '#2de2ff' : 'rgba(45,226,255,0.55)', r: isNext ? 10 : 6, text: isNext ? (k === 0 ? '终' : String(k)) : '', ring: isNext, edge: isNext });
      });
    } else m.push({ x: rm.x, z: rm.z, color: '#ff2d8a', r: 11, text: '赛', ring: true, edge: true });
    return m;
  }
  function markerPrompt() {
    if (Det.stuckT > 4) { HUD.prompt('卡住了？按 <kbd>R</kbd> 回到赛道'); return; }
    if (G.mode !== 'free') { HUD.prompt(null); return; }
    const rm = World.raceMarker, d = Math.hypot(car.pos.x - rm.x, car.pos.z - rm.z);
    if (d < rm.r + 1.5) {
      HUD.prompt('<kbd>E</kbd> 开始 · 荒原环线赛' + (Race.best ? ` <span class="dim">最佳 ${U.fmtTime(Race.best)}</span>` : ''));
      if (Input.hit('KeyE', 'Enter')) Race.begin();
    } else HUD.prompt(null);
  }
  function hudUpdate(dt) {
    HUD.update(dt);
    if (G.state !== 'play') return;
    HUD.speedo(car);
    HUD.minimap(car, mapMarks(), G.t);
    HUD.skill(Skills);
    HUD.race(Race.hudInfo());
  }

  function togglePause(on = !G.paused) {
    G.paused = on;
    HUD.show('pause', on);
    document.getElementById('pauseQuit').classList.toggle('hidden', !(G.mode === 'race' || G.mode === 'countdown'));
    if (Sfx.ctx) on ? Sfx.ctx.suspend() : Sfx.ctx.resume();
  }
  function startPlay() {
    G.state = 'play';
    HUD.show('title', false);
    HUD.show('hud', true);
    snapCamera();
    HUD.toast('驶入<b>粉色光圈</b>开始比赛，或自由探索荒原', '', 5);
  }

  // ---------------------------------------------------------------- main step
  const prev = new V3();
  G.tick = dt => {
    G.t += dt;
    if (Input.hit('KeyM')) { Sfx.setMute(!Sfx.mute); HUD.toast(Sfx.mute ? '已静音' : '声音开启', '', 1.2); }
    if (G.state === 'title') {
      if (Input.anyHit()) startPlay();
    } else if (G.state === 'play') {
      if (G.mode === 'results') {
        if (Input.hit('KeyE', 'Enter')) Race.begin();
        else if (Input.hit('Escape')) Race.abort();
      } else if (Input.hit('Escape', 'KeyP')) togglePause();
      if (G.paused) {
        if (Input.hit('KeyQ') && (G.mode === 'race' || G.mode === 'countdown')) { Race.abort(); togglePause(false); }
      } else {
        if (Input.hit('KeyC')) G.camMode = (G.camMode + 1) % 3;
        if (Input.hit('KeyR')) respawn('');
      }
    }
    if (G.paused) { HUD.update(dt); Input.endFrame(); return; }

    prev.copy(car.pos);
    const inp = driveInput();
    G.acc += dt;
    let n = 0;
    while (G.acc >= STEP && n < 8) { car.step(STEP, inp); G.acc -= STEP; n++; }
    if (n === 8) G.acc = 0;
    handleEvents();
    if (G.state === 'play') {
      detectSkills(dt);
      stunts(prev, dt);
      Race.update(dt, prev);
      Skills.update(dt);
      safety(dt, inp);
      markerPrompt();
    }
    if (!G.fastSim) G.visuals(dt);
    Input.endFrame();
  };
  G.visuals = (dt, chunkBudget = 1) => {
    emitDust(dt);
    Terrain.updateChunks(car.pos.x, car.pos.z, chunkBudget);
    atv.pose(car, dt);
    World.update(dt, car.pos, camera);
    updateCamera(dt);
    FX.update(dt, camera, renderer.domElement.height);
    Sfx.update(car, G.state === 'play');
    hudUpdate(dt);
  };
  G.render = () => {
    World.renderShadows(renderer, scene);
    Post.render(renderer, scene, camera);
  };
  // dynamic resolution: steer the scene render scale towards ~55 fps using the measured frame time
  const perf = { acc: 0, n: 0, t: 0 };
  function adaptResolution(rawDt) {
    if (G.state !== 'play' || G.paused || rawDt <= 0 || rawDt > 0.25) return;
    perf.acc += rawDt; perf.n++; perf.t += rawDt;
    if (perf.t < 1.0) return;
    const avg = perf.acc / perf.n;
    perf.acc = perf.n = perf.t = 0;
    if (avg > 1 / 45) Post.setScale(Post.scale - (avg > 1 / 30 ? 0.12 : 0.06));
    else if (avg < 1 / 58) Post.setScale(Post.scale + 0.05);
  }
  G.loop = now => {
    requestAnimationFrame(G.loop);
    if (G.manual) return;
    const raw = (now - G.last) / 1000;
    const dt = U.clamp(raw, 0, 0.05);
    G.last = now;
    G.tick(dt);
    G.render();
    adaptResolution(raw);
  };

  function resize() {
    renderer.setSize(innerWidth, innerHeight);
    const s = renderer.getDrawingBufferSize(new THREE.Vector2());
    Post.setSize(s.x, s.y);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  }

  G.init = async () => {
    await U.yieldNow();
    renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'high-performance', preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
    renderer.toneMapping = THREE.NoToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    document.getElementById('app').appendChild(renderer.domElement);
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.3, 3000);
    Post.init(renderer);
    resize();

    const tex = await World.loadTextures();
    Terrain.init();
    G.danger = Terrain.ramps.find(r => r.danger);
    World.build(scene, renderer, tex);
    await U.yieldNow();
    FX.init(scene);
    car = new Vehicle.Car();
    car.obstacleQuery = World.queryObstacles;
    atv = ATV.build({});
    scene.add(atv.root);
    const p = Terrain.trail.at(6);
    car.reset(p.x, p.z, Vehicle.Car.yawFromDir(p.dx, p.dz));
    for (let i = 0; i < 120; i++) car.step(STEP, { handbrake: 1 });
    car.events.length = 0;
    Terrain.updateChunks(car.pos.x, car.pos.z, 1e9);
    World.grassRefresh(car.pos);
    HUD.init(Terrain.mapCanvas(512));
    Race.init();
    Input.init();
    Input.onAny.push(() => Sfx.unlock());
    addEventListener('resize', resize);
    snapCamera();
    atv.pose(car, 0);
    Object.assign(G, { renderer, scene, camera, car, atv, Race, Skills, Det, store, STEP, respawn, snapCamera, startPlay });
    G.state = 'title';
    HUD.show('loading', false);
    HUD.show('title', true);
    G.last = performance.now();
    requestAnimationFrame(G.loop);
  };

  return G;
})();
