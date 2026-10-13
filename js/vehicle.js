'use strict';
// ATV rigid body on the analytic heightfield: four raycast suspensions, a slip-limited tyre model,
// penalty contacts for the body and rider against the ground, and obstacle collisions.
// Body space: forward = -z, right = +x, up = +y, origin at the centre of mass.

const Vehicle = (() => {
  const V3 = THREE.Vector3;
  const CFG = {
    mass: 330, inertia: [170, 185, 100],         // pitch (x), yaw (y), roll (z)
    gravity: 12,
    wheelR: 0.33, rest: 0.36, k: 9500, c: 900, bumpAt: 0.28, bumpK: 180000,
    mu: 1.05,
    power: 22000, maxForce: 3200, topSpeed: 30.5, revSpeed: 7, revForce: 1500,
    brake: 1900, handbrake: 2600,
    liftLat: 0.6, liftLong: 0.45,                // tyre forces act this fraction of the way up to the COM
    steerLo: 0.6, steerHi: 0.17,
    drag: 0.55, rr: 25,
    airPitch: 6, airPitchDamp: 4.5, airYaw: 1.4, airRoll: 3.0, groundRoll: 1.2,
  };
  const HP = [new V3(-0.5, -0.1, -0.64), new V3(0.5, -0.1, -0.64), new V3(-0.5, -0.1, 0.62), new V3(0.5, -0.1, 0.62)];
  const PROBES = [
    [-0.55, -0.25, -1.0], [0.55, -0.25, -1.0], [-0.55, -0.25, 1.0], [0.55, -0.25, 1.0],
    [-0.55, 0.3, -0.85], [0.55, 0.3, -0.85], [-0.55, 0.3, 0.9], [0.55, 0.3, 0.9], [0, -0.3, 0],
    [0, 1.06, -0.1, 1], [-0.24, 0.74, 0.04, 1], [0.24, 0.74, 0.04, 1],
  ];
  const SPHERES = [[0, 0.15, -0.55], [0, 0.15, 0.55]], SPH_R = 0.7;
  const GEAR_TOP = [8.5, 14, 19.5, 25, 33], GEAR_LO = [0, 6.5, 11.5, 17, 22.5];

  // scratch
  const up = new V3(), fwd = new V3(), right = new V3(), F = new V3(), T = new V3();
  const hp = new V3(), wf = new V3(), f = new V3(), s = new V3(), r = new V3(), vc = new V3(), tmp = new V3(), app = new V3();
  const pp = new V3(), nn = new V3(), vt = new V3(), tb = new V3(), wb = new V3(), sp = new V3(), qi = new THREE.Quaternion();
  const hits = [];

  function addForceAt(force, point, pos) {
    F.add(force);
    r.subVectors(point, pos);
    T.add(tmp.crossVectors(r, force));
  }

  class Car {
    constructor() {
      this.pos = new V3();
      this.quat = new THREE.Quaternion();
      this.vel = new V3();
      this.angVel = new V3();
      this.wheels = HP.map((h, k) => ({
        hp: h, front: k < 2, contact: false, comp: 0, compPrev: 0, len: CFG.rest, spin: 0, spinRate: 0,
        load: 0, slip: 0, surf: Terrain.SURF.grass, cp: new V3(), n: new V3(0, 1, 0), hpw: new V3(), vLong: 0, vLat: 0,
      }));
      this.steer = 0; this.grounded = 0; this.air = 0; this.speed = 0; this.vf = 0; this.vLat = 0;
      this.rpm = 1000; this.gear = 1; this.throttle = 0; this.brakeIn = 0; this.wheelspin = 0;
      this.up = new V3(0, 1, 0); this.fwd = new V3(0, 0, -1); this.right = new V3(1, 0, 0);
      this.waterWheels = 0; this.headContact = false;
      this.events = [];
      this.obstacleQuery = null;   // (x, z, radius, out[]) -> out
    }
    static yawFromDir(dx, dz) { return Math.atan2(-dx, -dz); }

    reset(x, z, yaw) {
      this.pos.set(x, Terrain.phys(x, z) + 0.8, z);
      this.quat.setFromAxisAngle(new V3(0, 1, 0), yaw);
      this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
      this.steer = 0; this.air = 0; this.rpm = 1000; this.gear = 1;
      for (const w of this.wheels) { w.comp = 0; w.compPrev = 0; w.spinRate = 0; w.contact = false; w.len = CFG.rest; }
      this.events.length = 0;
    }

    step(dt, inp) {
      const q = this.quat, pos = this.pos, vel = this.vel, w = this.angVel, M = CFG.mass, I = CFG.inertia;
      up.set(0, 1, 0).applyQuaternion(q); fwd.set(0, 0, -1).applyQuaternion(q); right.set(1, 0, 0).applyQuaternion(q);
      this.up.copy(up); this.fwd.copy(fwd); this.right.copy(right);
      const vf = vel.dot(fwd);
      this.vf = vf; this.vLat = vel.dot(right); this.speed = vel.length();
      const thr = U.clamp(inp.throttle || 0, 0, 1), brk = U.clamp(inp.brake || 0, 0, 1), hb = inp.handbrake ? 1 : 0;
      this.throttle = thr; this.brakeIn = brk;

      // steering, less lock at speed
      const maxSteer = U.lerp(CFG.steerLo, CFG.steerHi, U.clamp(Math.abs(vf) / 26, 0, 1));
      const target = U.clamp(inp.steer || 0, -1, 1) * maxSteer;
      this.steer = U.damp(this.steer, target, Math.abs(target) < Math.abs(this.steer) ? 12 : 7, dt);

      // engine and brakes
      let drive = 0, brake = 0;
      if (thr > 0) {
        drive = Math.min(CFG.maxForce, CFG.power / Math.max(Math.abs(vf), 3)) * thr;
        drive *= U.clamp((CFG.topSpeed - vf) / 3, 0, 1);
        if (vf < -0.5) brake = thr;
      }
      if (brk > 0) {
        if (vf > 0.8) brake = Math.max(brake, brk);
        else if (thr === 0) drive = -CFG.revForce * brk * U.clamp((CFG.revSpeed + vf) / 2, 0, 1);
      }
      const parked = thr === 0 && brk === 0 && this.speed < 0.6;

      F.set(0, -CFG.gravity * M, 0);
      T.set(0, 0, 0);

      // pass 1: suspension rays
      const reach = CFG.rest + CFG.wheelR;
      let nGround = 0;
      for (const W of this.wheels) {
        W.compPrev = W.comp;
        W.hpw.copy(W.hp).applyQuaternion(q).add(pos);
        let t = Infinity;
        if (up.y > 0.2) {
          let g = Terrain.phys(W.hpw.x, W.hpw.z);
          let tt = (W.hpw.y - g) / up.y;
          if (tt < reach + 0.6) {
            for (let it = 0; it < 2; it++) {
              g = Terrain.phys(W.hpw.x - up.x * tt, W.hpw.z - up.z * tt);
              tt = (W.hpw.y - g) / up.y;
            }
            t = tt;
          }
        }
        if (t < reach) {
          W.contact = true; nGround++;
          W.comp = Math.min(reach - t, reach + 0.3);
          W.cp.copy(W.hpw).addScaledVector(up, -t);
          Terrain.normal(W.cp.x, W.cp.z, W.n);
          W.len = Math.max(t - CFG.wheelR, CFG.rest - 0.34);
        } else {
          W.contact = false; W.comp = 0;
          W.len = U.damp(W.len, CFG.rest, 18, dt);
        }
      }

      // pass 2: spring, damper and tyre forces
      const share = nGround > 0 ? 1 / nGround : 0;
      let spinSum = 0, waterW = 0, slideSum = 0;
      for (const W of this.wheels) {
        if (!W.contact) {
          W.load = 0; W.slip = 0;
          W.spinRate = U.damp(W.spinRate, thr * 55 - brk * 20, 2.5, dt);
          W.spin += W.spinRate * dt;
          continue;
        }
        const compVel = (W.comp - W.compPrev) / dt;
        let Fs = CFG.k * W.comp + CFG.c * compVel;
        if (W.comp > CFG.bumpAt) Fs += CFG.bumpK * (W.comp - CFG.bumpAt);
        Fs = U.clamp(Fs, 0, 60000);
        W.load = Fs;
        addForceAt(tmp.copy(up).multiplyScalar(Fs), W.hpw, pos);

        // tyre frame on the ground plane
        if (W.front) wf.copy(fwd).multiplyScalar(Math.cos(this.steer)).addScaledVector(right, Math.sin(this.steer));
        else wf.copy(fwd);
        f.copy(wf).addScaledVector(W.n, -wf.dot(W.n)).normalize();
        s.crossVectors(f, W.n).normalize();
        r.subVectors(W.cp, pos);
        vc.crossVectors(w, r).add(vel);
        const vLong = vc.dot(f), vLat = vc.dot(s);
        W.vLong = vLong; W.vLat = vLat;
        const surf = Terrain.surface(W.cp.x, W.cp.z);
        W.surf = surf;
        if (surf === Terrain.SURF.water) waterW++;
        const mu = CFG.mu * surf.grip, N = Fs;

        let fx = drive * share;
        const bForce = brake * CFG.brake + (hb && !W.front ? CFG.handbrake : 0) + (parked ? CFG.brake * 0.6 : 0);
        if (bForce > 0) fx += U.clamp(-vLong * (M * 0.25) / dt, -bForce, bForce);
        fx -= vLong * CFG.rr * 0.25;
        let latMu = mu;
        if (hb && !W.front) latMu *= 0.42;
        if (Math.abs(vLat) > 2.5) latMu *= 0.88;
        let fy = -vLat * (M * 0.25) / dt * 0.45;
        const maxLat = latMu * N;
        fy = U.clamp(fy, -maxLat, maxLat);
        const maxF = mu * N, fm = Math.hypot(fx, fy);
        let over = 0;
        if (fm > maxF && fm > 0) { over = fm / maxF - 1; fx *= maxF / fm; fy *= maxF / fm; }
        W.slip = Math.min(1, Math.abs(vLat) / 5 + over * 0.5);
        slideSum += Math.abs(vLat);

        const hc = tmp.subVectors(pos, W.cp).dot(W.n);
        app.copy(W.cp).addScaledVector(W.n, hc * CFG.liftLat);
        addForceAt(tmp.copy(s).multiplyScalar(fy), app, pos);
        app.copy(W.cp).addScaledVector(W.n, hc * CFG.liftLong);
        addForceAt(tmp.copy(f).multiplyScalar(fx), app, pos);

        // visual wheel spin, with wheelspin when the drive force was clipped
        const spinExtra = drive > 0 && over > 0 ? Math.min(40, over * 30 + 6) : 0;
        const locked = (hb && !W.front) || (brake > 0.5 && Math.abs(vLong) < 2);
        W.spinRate = locked ? 0 : vLong / CFG.wheelR + spinExtra;
        W.spin += W.spinRate * dt;
        spinSum += spinExtra;
      }
      this.wheelspin = spinSum / 4;
      this.waterWheels = waterW;
      this.slide = nGround ? slideSum / nGround : 0;

      // aero drag, water drag
      F.addScaledVector(vel, -vel.length() * CFG.drag);
      if (waterW) F.addScaledVector(vel, -260 * waterW);

      // attitude control: air control and a gentle roll stabiliser
      if (nGround === 0) {
        // hold a pitch that follows the flight path; W/S bias it nose-down / nose-up
        const vh = Math.hypot(vel.x, vel.z);
        const pathPitch = vh > 2 ? Math.atan2(vel.y, vh) * 0.6 : 0;
        const pitch = Math.asin(U.clamp(fwd.y, -1, 1));
        const want = pathPitch + (brk - thr) * 0.45;
        T.addScaledVector(right, ((want - pitch) * CFG.airPitch - w.dot(right) * CFG.airPitchDamp) * I[0]);
        T.addScaledVector(up, (-(inp.steer || 0) * CFG.airYaw - w.dot(up)) * I[1]);
        T.addScaledVector(fwd, (right.y * CFG.airRoll - w.dot(fwd) * 1.2) * I[2]);
      } else {
        T.addScaledVector(fwd, right.y * CFG.groundRoll * I[2]);
      }

      // pass 3: body and rider against the ground
      let head = false;
      for (const p of PROBES) {
        pp.set(p[0], p[1], p[2]).applyQuaternion(q).add(pos);
        const pen = Terrain.phys(pp.x, pp.z) - pp.y;
        if (pen <= 0) continue;
        Terrain.normal(pp.x, pp.z, nn);
        r.subVectors(pp, pos);
        vc.crossVectors(w, r).add(vel);
        const vn = vc.dot(nn);
        const Fn = U.clamp(70000 * pen - 5000 * vn, 0, 90000);
        vt.copy(vc).addScaledVector(nn, -vn);
        const vtl = vt.length();
        tmp.copy(nn).multiplyScalar(Fn);
        if (vtl > 1e-3) tmp.addScaledVector(vt, -Math.min(0.6 * Fn, vtl * M * 0.15 / dt) / vtl);
        addForceAt(tmp, pp, pos);
        if (p[3]) head = true;
      }
      if (head && !this.headContact) this.events.push({ type: 'head', v: this.speed });
      this.headContact = head;

      // integrate
      vel.addScaledVector(F, dt / M);
      qi.copy(q).invert();
      tb.copy(T).applyQuaternion(qi);
      wb.copy(w).applyQuaternion(qi);
      wb.x += (tb.x / I[0]) * dt; wb.y += (tb.y / I[1]) * dt; wb.z += (tb.z / I[2]) * dt;
      w.copy(wb).applyQuaternion(q).multiplyScalar(1 / (1 + dt * (nGround ? 0.5 : 0.25)));
      pos.addScaledVector(vel, dt);
      const hx = w.x * dt * 0.5, hy = w.y * dt * 0.5, hz = w.z * dt * 0.5;
      const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
      q.set(qx + hx * qw + hy * qz - hz * qy, qy + hy * qw + hz * qx - hx * qz, qz + hz * qw + hx * qy - hy * qx, qw - hx * qx - hy * qy - hz * qz).normalize();

      this.collide();

      // airtime and landing
      const was = this.grounded;
      this.grounded = nGround;
      if (nGround === 0) this.air += dt;
      else {
        if (was === 0 && this.air > 0.25) this.events.push({ type: 'land', air: this.air, v: -vel.y });
        this.air = 0;
      }

      // cosmetic engine speed and gear
      const spd = Math.abs(vf);
      let g = this.gear;
      if (g < 5 && spd > GEAR_TOP[g - 1] * 0.97) { g++; this.events.push({ type: 'shift' }); }
      else if (g > 1 && spd < GEAR_LO[g - 1]) g--;
      this.gear = g;
      const lo = g === 1 ? 0 : GEAR_LO[g - 1] * 0.8;
      let rpm = 1100 + U.clamp((spd - lo) / (GEAR_TOP[g - 1] - lo), 0, 1) * 7400;
      if (nGround === 0 || this.wheelspin > 4) rpm = U.lerp(rpm, 1100 + thr * 8300, 0.75);
      if (thr === 0) rpm = Math.max(1000, rpm * 0.85);
      this.rpm = U.damp(this.rpm, rpm, 12, dt);
    }

    collide() {
      if (!this.obstacleQuery) return;
      const q = this.quat, pos = this.pos, vel = this.vel, w = this.angVel, M = CFG.mass;
      for (const c of SPHERES) {
        sp.set(c[0], c[1], c[2]).applyQuaternion(q).add(pos);
        hits.length = 0;
        this.obstacleQuery(sp.x, sp.z, 4, hits);
        for (const o of hits) {
          let nx, ny = 0, nz, pen;
          if (o.kind === 'cyl') {
            if (sp.y < o.y0 - SPH_R || sp.y > o.y1 + SPH_R) continue;
            const dx = sp.x - o.x, dz = sp.z - o.z, d = Math.hypot(dx, dz);
            pen = SPH_R + o.r - d;
            if (pen <= 0) continue;
            nx = d > 1e-4 ? dx / d : 1; nz = d > 1e-4 ? dz / d : 0;
          } else {
            const dx = sp.x - o.x, dy = sp.y - o.y, dz = sp.z - o.z, d = Math.hypot(dx, dy, dz);
            pen = SPH_R + o.r - d;
            if (pen <= 0) continue;
            nx = dx / d; ny = dy / d; nz = dz / d;
          }
          nn.set(nx, ny, nz);
          pos.addScaledVector(nn, pen);
          r.subVectors(sp, pos).addScaledVector(nn, -SPH_R);
          vc.crossVectors(w, r).add(vel);
          const vn = vc.dot(nn);
          if (vn < 0) {
            const rn = tmp.crossVectors(r, nn);
            const j = (-(1 + 0.2) * vn) / (1 / M + rn.lengthSq() / 175);
            vel.addScaledVector(nn, j / M);
            w.addScaledVector(rn, j / 175);
            vt.copy(vel).addScaledVector(nn, -vel.dot(nn));
            vel.addScaledVector(vt, -0.2);
            this.events.push({ type: 'hit', v: -vn, obj: o });
          }
        }
      }
    }
  }

  return { Car, CFG, HP, PROBES };
})();
