'use strict';
// Sport ATV and rider built in code: extruded and lathed body panels, tube frame, coil-over shocks,
// knobby tyres on beadlock rims. pose() places it from a Vehicle.Car state each frame.
// Body space matches the physics: forward = -z, right = +x, up = +y, origin at the centre of mass.

const ATV = (() => {
  const V3 = THREE.Vector3, V2 = THREE.Vector2;
  const Y = new V3(0, 1, 0);
  const tA = new V3(), tB = new V3(), tD = new V3();
  const TRACK = 0.6;           // visual wheel offset from the centre line

  function placeBetween(mesh, a, b, stretch) {
    mesh.position.addVectors(a, b).multiplyScalar(0.5);
    tD.subVectors(b, a);
    const len = tD.length();
    mesh.quaternion.setFromUnitVectors(Y, tD.multiplyScalar(1 / (len || 1)));
    if (stretch) mesh.scale.y = len;
  }
  function ik(shoulder, hand, l1, l2, pole, outElbow, outHand) {
    const d = tA.subVectors(hand, shoulder);
    let len = d.length();
    d.multiplyScalar(1 / len);
    len = U.clamp(len, Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
    const a = (l1 * l1 - l2 * l2 + len * len) / (2 * len);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    const p = tB.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
    outElbow.copy(shoulder).addScaledVector(d, a).addScaledVector(p, h);
    outHand.copy(shoulder).addScaledVector(d, len);
  }

  // a side profile (z, y pairs, forward = -z) extruded across the car, centred on x = 0
  function profile(pts, width, bevel = 0.025, smooth = true) {
    const s = new THREE.Shape();
    s.moveTo(pts[0][0], pts[0][1]);
    if (smooth) s.splineThru([...pts.slice(1), pts[0]].map(([z, y]) => new V2(z, y)));
    else for (const [z, y] of pts.slice(1)) s.lineTo(z, y);
    const g = new THREE.ExtrudeGeometry(s, { depth: width - 2 * bevel, bevelEnabled: true, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 6, steps: 1 });
    g.translate(0, 0, -(width - 2 * bevel) / 2);
    g.rotateY(-Math.PI / 2);
    g.computeVertexNormals();
    return g;
  }
  // fender arch around a wheel centre: angles measured from the rear (+z) towards up
  function arch(rIn, rOut, a0, a1, width) {
    const s = new THREE.Shape();
    s.absarc(0, 0, rOut, a0, a1, false);
    s.lineTo(Math.cos(a1) * rIn, Math.sin(a1) * rIn);
    s.absarc(0, 0, rIn, a1, a0, true);
    s.closePath();
    const b = 0.02;
    const g = new THREE.ExtrudeGeometry(s, { depth: width - 2 * b, bevelEnabled: true, bevelThickness: b, bevelSize: b, bevelSegments: 2, curveSegments: 20 });
    g.translate(0, 0, -(width - 2 * b) / 2);
    g.rotateY(-Math.PI / 2);
    return g;
  }
  const tube = (pts, r, closed = false) => new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts.map(p => new V3(...p)), closed), Math.max(12, pts.length * 10), r, 8, closed);
  class Helix extends THREE.Curve {
    constructor(r, turns) { super(); this.r = r; this.turns = turns; }
    getPoint(t, out = new V3()) { const a = t * this.turns * Math.PI * 2; return out.set(Math.cos(a) * this.r, t - 0.5, Math.sin(a) * this.r); }
  }
  const plateTex = (num, bg, fg) => U.canvasTex(256, 192, (g, w, h) => {
    g.fillStyle = bg; g.beginPath(); g.ellipse(w / 2, h / 2, w / 2 - 4, h / 2 - 4, 0, 0, Math.PI * 2); g.fill();
    g.fillStyle = fg; g.font = 'italic 900 120px "Arial Black", "Microsoft YaHei", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(num, w / 2, h / 2 + 6);
  });
  const helmetTex = (c1, c2) => U.canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, w, h);
    g.fillStyle = c1; g.fillRect(0, h * 0.18, w, h * 0.16);
    g.fillStyle = c2; g.fillRect(0, h * 0.36, w, h * 0.05);
    g.fillStyle = c1;
    for (let i = 0; i < 6; i++) { g.beginPath(); g.moveTo(i * w / 6, h * 0.42); g.lineTo(i * w / 6 + 40, h * 0.42); g.lineTo(i * w / 6 + 10, h * 0.75); g.closePath(); g.fill(); }
  });

  function build(opt = {}) {
    const paintCol = opt.paint ?? 0xff5a1f, jerseyCol = opt.jersey ?? 0x16c0d4;
    const css = c => '#' + new THREE.Color(c).getHexString();
    const M = {
      paint: new THREE.MeshPhysicalMaterial({ color: paintCol, roughness: 0.32, clearcoat: 1, clearcoatRoughness: 0.14 }),
      white: new THREE.MeshPhysicalMaterial({ color: 0xeeeeee, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.15 }),
      black: new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.55, metalness: 0.2 }),
      frame: new THREE.MeshStandardMaterial({ color: 0x1e2024, roughness: 0.38, metalness: 0.7 }),
      alloy: new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.32, metalness: 1.0 }),
      chrome: new THREE.MeshStandardMaterial({ color: 0xe8eaee, roughness: 0.12, metalness: 1.0 }),
      gold: new THREE.MeshStandardMaterial({ color: 0xd9a33a, roughness: 0.3, metalness: 1.0 }),
      rubber: new THREE.MeshStandardMaterial({ color: 0x1c1c1d, roughness: 0.92, side: THREE.DoubleSide }),
      rim: new THREE.MeshStandardMaterial({ color: 0x1b1c1f, roughness: 0.35, metalness: 0.6, side: THREE.DoubleSide }),
      seat: new THREE.MeshStandardMaterial({ color: 0x141517, roughness: 0.75 }),
      spring: new THREE.MeshStandardMaterial({ color: 0xffc21a, roughness: 0.3, metalness: 0.6 }),
      light: new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff0c8, emissiveIntensity: 6 }),
      tail: new THREE.MeshStandardMaterial({ color: 0x400000, emissive: 0xff2210, emissiveIntensity: 3 }),
      plateS: new THREE.MeshStandardMaterial({ map: plateTex('07', '#f4f4f4', css(paintCol)), roughness: 0.5 }),
      jersey: new THREE.MeshStandardMaterial({ color: jerseyCol, roughness: 0.75 }),
      jersey2: new THREE.MeshStandardMaterial({ color: 0xf2f2f2, roughness: 0.75 }),
      pants: new THREE.MeshStandardMaterial({ color: 0x24262c, roughness: 0.8 }),
      guard: new THREE.MeshStandardMaterial({ color: 0x2a2c31, roughness: 0.45, metalness: 0.1 }),
      helmet: new THREE.MeshPhysicalMaterial({ map: helmetTex(css(paintCol), css(jerseyCol)), roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.05 }),
      goggle: new THREE.MeshStandardMaterial({ color: 0x0a0c10, roughness: 0.05, metalness: 0.9 }),
      boot: new THREE.MeshStandardMaterial({ color: 0xeaeaea, roughness: 0.45 }),
    };
    const root = new THREE.Group();
    const add = (geo, mat, x = 0, y = 0, z = 0, parent = root) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); parent.add(m); return m; };
    const rb = U.roundBox;
    const HP = Vehicle.HP, R = Vehicle.CFG.wheelR, restY = HP[0].y - 0.25;

    // frame, engine, skid plate
    add(rb(0.34, 0.3, 0.5, 0.05), M.frame, 0, -0.14, 0.0);
    const head = add(new THREE.CylinderGeometry(0.1, 0.12, 0.26, 14), M.alloy, 0, -0.02, -0.16); head.rotation.x = -0.45;
    for (let i = 0; i < 5; i++) add(new THREE.CylinderGeometry(0.135, 0.135, 0.01, 16), M.frame, 0, -0.09 + i * 0.035, -0.13 - i * 0.017).rotation.x = -0.45;
    add(new THREE.BoxGeometry(0.46, 0.03, 1.1), M.alloy, 0, -0.31, -0.05);
    for (const sx of [-1, 1]) {
      add(tube([[sx * 0.2, -0.28, -0.78], [sx * 0.22, -0.08, -0.55], [sx * 0.2, 0.04, -0.2], [sx * 0.18, 0.08, 0.4], [sx * 0.2, -0.04, 0.78]], 0.022), M.frame);
      add(tube([[sx * 0.32, -0.12, -0.34], [sx * 0.44, -0.28, -0.24], [sx * 0.46, -0.3, 0.2], [sx * 0.36, -0.14, 0.34]], 0.018), M.black);
      add(rb(0.13, 0.04, 0.26, 0.015), M.black, sx * 0.4, -0.3, 0.0);
    }
    add(tube([[-0.24, -0.2, -1.05], [-0.22, -0.06, -1.22], [0, 0.0, -1.26], [0.22, -0.06, -1.22], [0.24, -0.2, -1.05]], 0.02), M.chrome);
    const fp = add(new THREE.CircleGeometry(0.15, 24), M.plateS, 0, -0.1, -1.24); fp.rotation.y = Math.PI; fp.scale.set(1.15, 0.85, 1);
    add(tube([[-0.3, 0.06, 0.75], [-0.3, 0.12, 1.02], [-0.2, 0.1, 1.12], [0.2, 0.1, 1.12], [0.3, 0.12, 1.02], [0.3, 0.06, 0.75]], 0.02), M.black);

    // body panels: nose, tank, seat, tail, fender decks and arches, side panels
    add(profile([[-1.22, -0.06], [-1.14, 0.04], [-0.95, 0.1], [-0.62, 0.12], [-0.45, 0.16], [-0.32, 0.06], [-0.45, -0.06], [-0.85, -0.1]], 0.56), M.paint);
    add(profile([[-0.5, 0.06], [-0.44, 0.22], [-0.22, 0.27], [0.0, 0.24], [0.04, 0.06], [-0.22, 0.0]], 0.44, 0.04), M.paint);
    add(profile([[-0.1, 0.19], [0.06, 0.25], [0.5, 0.24], [0.92, 0.22], [1.02, 0.15], [0.88, 0.12], [0.3, 0.14], [-0.06, 0.13]], 0.34, 0.05), M.seat);
    add(profile([[0.25, 0.08], [0.55, 0.16], [1.0, 0.15], [1.1, 0.04], [1.02, -0.06], [0.5, -0.02]], 0.6), M.paint);
    for (const sx of [-1, 1]) {
      add(profile([[-1.0, 0.0], [-0.85, 0.12], [-0.64, 0.16], [-0.42, 0.13], [-0.3, 0.05], [-0.4, 0.0], [-0.85, 0.02]], 0.22, 0.02), M.paint, sx * 0.36, 0, 0);
      add(profile([[0.25, 0.04], [0.4, 0.13], [0.62, 0.15], [0.85, 0.13], [1.0, 0.06], [0.9, 0.02], [0.4, 0.06]], 0.22, 0.02), M.paint, sx * 0.36, 0, 0);
      add(arch(R + 0.05, R + 0.085, 0.45, Math.PI - 0.2, 0.31), M.paint, sx * (TRACK - 0.01), restY + 0.07, HP[0].z);
      add(arch(R + 0.05, R + 0.085, 0.2, Math.PI - 0.5, 0.31), M.paint, sx * (TRACK - 0.01), restY + 0.07, HP[2].z);
      add(profile([[-0.42, 0.06], [-0.3, 0.15], [0.05, 0.15], [0.12, 0.0], [-0.1, -0.08], [-0.34, -0.06]], 0.06, 0.02), M.white, sx * 0.25, 0, 0);
      const sp = add(new THREE.CircleGeometry(0.11, 24), M.plateS, sx * 0.306, 0.04, 0.6);
      sp.rotation.y = sx * Math.PI / 2; sp.scale.set(1.25, 0.8, 1);
      add(profile([[-1.16, 0.0], [-1.08, 0.06], [-1.04, 0.05], [-1.1, -0.01]], 0.12, 0.01, false), M.light, sx * 0.17, 0, 0);
    }
    add(new THREE.BoxGeometry(0.2, 0.05, 0.02), M.tail, 0, 0.08, 1.11);
    add(tube([[0.05, -0.04, -0.28], [0.2, -0.12, -0.15], [0.27, -0.06, 0.25], [0.28, 0.06, 0.6]], 0.026), M.chrome);
    const sil = add(new THREE.CylinderGeometry(0.062, 0.056, 0.38, 16), M.alloy, 0.28, 0.1, 0.78); sil.rotation.x = Math.PI / 2 - 0.25;
    const tip = add(new THREE.CylinderGeometry(0.04, 0.04, 0.05, 12), M.black, 0.28, 0.15, 0.98); tip.rotation.x = Math.PI / 2 - 0.25;

    // handlebars: tilt pivot -> steer
    const barTilt = new THREE.Group(); barTilt.position.set(0, 0.34, -0.36); barTilt.rotation.x = -0.35; root.add(barTilt);
    const bars = new THREE.Group(); barTilt.add(bars);
    add(new THREE.CylinderGeometry(0.024, 0.028, 0.3, 8), M.frame, 0, -0.05, 0, bars);
    add(tube([[-0.38, 0.17, 0.02], [-0.2, 0.13, 0.0], [0, 0.12, 0], [0.2, 0.13, 0.0], [0.38, 0.17, 0.02]], 0.017), M.alloy, 0, 0, 0, bars);
    add(rb(0.17, 0.06, 0.07, 0.025), M.black, 0, 0.14, 0, bars);
    for (const sx of [-1, 1]) {
      const g = add(new THREE.CylinderGeometry(0.03, 0.03, 0.13, 10), M.black, sx * 0.34, 0.16, 0.01, bars); g.rotation.z = Math.PI / 2 - sx * 0.12;
      add(profile([[-0.12, 0.0], [-0.04, 0.07], [0.02, 0.04], [-0.08, -0.02]], 0.09, 0.012), M.paint, sx * 0.39, 0.13, 0, bars);
    }
    const gripL = new THREE.Object3D(); gripL.position.set(-0.33, 0.16, 0.01); bars.add(gripL);
    const gripR = new THREE.Object3D(); gripR.position.set(0.33, 0.16, 0.01); bars.add(gripR);

    // wheels: lathed tyre with knobs, rim with beadlock ring
    const W = 0.27;
    const prof = [[0.2, -0.125], [0.27, -0.135], [0.3, -0.13], [0.318, -0.115], [R - 0.025, -0.085], [R - 0.022, 0], [R - 0.025, 0.085], [0.318, 0.115], [0.3, 0.13], [0.27, 0.135], [0.2, 0.125]];
    const tyre = new THREE.LatheGeometry(prof.map(([r, a]) => new V2(r, a)), 40).rotateZ(Math.PI / 2);
    const knobs = [tyre];
    for (let i = 0; i < 26; i++) {
      const a = (i / 26) * Math.PI * 2;
      for (const off of i % 2 ? [-0.07, 0.05] : [-0.04, 0.08]) {
        const k = new THREE.BoxGeometry(0.06, 0.035, 0.055);
        k.translate(off, R - 0.02, 0);
        k.rotateX(a);
        knobs.push(k);
      }
      for (const side of [-1, 1]) {
        const k = new THREE.BoxGeometry(0.03, 0.03, 0.05);
        k.translate(side * 0.118, R - 0.04, 0);
        k.rotateX(a + 0.12);
        knobs.push(k);
      }
    }
    const tyreGeo = U.merge(knobs);
    const rimGeo = new THREE.LatheGeometry([[0.0, -0.1], [0.07, -0.1], [0.1, -0.06], [0.19, -0.1], [0.205, -0.11], [0.205, 0.11], [0.19, 0.1], [0.1, 0.08], [0.06, 0.1], [0.0, 0.1]].map(([r, a]) => new V2(r, a)), 32).rotateZ(Math.PI / 2);
    const wheels = [];
    HP.forEach((hp, k) => {
      const side = hp.x < 0 ? -1 : 1;
      const g = new THREE.Group(); root.add(g);
      const spin = new THREE.Group(); g.add(spin);
      spin.add(new THREE.Mesh(tyreGeo, M.rubber));
      const rim = new THREE.Mesh(rimGeo, M.rim); spin.add(rim);
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.012, 6, 32), M.gold); ring.rotation.y = Math.PI / 2; ring.position.x = side * 0.11; spin.add(ring);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.012, 6), M.chrome);
        b.rotation.z = Math.PI / 2; b.position.set(side * 0.118, Math.cos(a) * 0.19, Math.sin(a) * 0.19); spin.add(b);
      }
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.065, 0.06, 6).rotateZ(Math.PI / 2), M.alloy); hub.position.x = side * 0.1; spin.add(hub);
      // suspension parts move every frame, so they stay separate meshes
      const dyn = m => { m.userData.dyn = true; return m; };
      const upper = dyn(add(new THREE.CylinderGeometry(0.016, 0.016, 1, 8), M.frame));
      const lower = dyn(add(new THREE.CylinderGeometry(0.02, 0.02, 1, 8), M.frame));
      const spring = dyn(add(new THREE.TubeGeometry(new Helix(0.042, 8), 120, 0.0075, 5, false), M.spring));
      const damper = dyn(add(new THREE.CylinderGeometry(0.024, 0.024, 1, 10), M.alloy));
      const knuckle = dyn(add(rb(0.06, 0.16, 0.08, 0.02), M.frame));
      wheels.push({ g, spin, side, hp, upper, lower, spring, damper, knuckle, front: k < 2 });
    });

    // rider
    let rider = null;
    if (opt.rider !== false) {
      rider = { root: new THREE.Group() };
      rider.root.position.set(0, 0.33, 0.25);
      root.add(rider.root);
      const pel = add(new THREE.CapsuleGeometry(0.12, 0.16, 4, 12), M.pants, 0, 0, 0, rider.root); pel.rotation.z = Math.PI / 2;
      const torso = new THREE.Group(); torso.rotation.x = -0.5; rider.root.add(torso);
      add(new THREE.CapsuleGeometry(0.16, 0.26, 6, 16), M.jersey, 0, 0.27, 0, torso);
      add(rb(0.34, 0.3, 0.2, 0.07), M.guard, 0, 0.34, -0.05, torso);
      add(rb(0.26, 0.12, 0.05, 0.02), M.jersey2, 0, 0.36, -0.15, torso);
      add(new THREE.CylinderGeometry(0.07, 0.08, 0.1, 12), M.guard, 0, 0.53, -0.01, torso);
      const head = new THREE.Group(); head.position.set(0, 0.69, -0.03); torso.add(head);
      const helm = add(new THREE.SphereGeometry(0.155, 28, 18), M.helmet, 0, 0, 0, head); helm.rotation.y = -Math.PI / 2;
      add(profile([[-0.06, -0.15], [-0.17, -0.1], [-0.17, -0.03], [-0.08, -0.05]], 0.17, 0.03), M.helmet, 0, 0, 0, head);
      add(rb(0.22, 0.075, 0.06, 0.03), M.goggle, 0, 0.0, -0.13, head);
      add(new THREE.TorusGeometry(0.152, 0.012, 6, 24), M.black, 0, 0.0, 0, head).rotation.x = Math.PI / 2;
      const peak = add(profile([[-0.24, 0.12], [-0.05, 0.16], [-0.05, 0.12], [-0.2, 0.09]], 0.2, 0.012, false), M.white, 0, 0.0, 0.0, head);
      peak.position.y = 0.0;
      const shL = new THREE.Object3D(); shL.position.set(-0.2, 0.45, 0); torso.add(shL);
      const shR = new THREE.Object3D(); shR.position.set(0.2, 0.45, 0); torso.add(shR);
      const L1 = 0.29, L2 = 0.28;
      const limb = (r, l, mat) => { const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, l - 1.2 * r), 4, 12), mat); root.add(m); return m; };
      const arm = m => { m.userData.dyn = true; return m; };
      rider.arms = [-1, 1].map(sx => ({
        sx, sh: sx < 0 ? shL : shR, grip: sx < 0 ? gripL : gripR,
        upper: arm(limb(0.058, L1, M.jersey)), fore: arm(limb(0.052, L2, M.jersey)),
        cuff: arm((() => { const m = new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.052, 0.06, 10), M.jersey2); root.add(m); return m; })()),
        hand: arm((() => { const m = new THREE.Mesh(rb(0.09, 0.07, 0.1, 0.03), M.black); root.add(m); return m; })()),
        e: new V3(), s: new V3(), h: new V3(), gp: new V3(),
      }));
      rider.L1 = L1; rider.L2 = L2;
      for (const sx of [-1, 1]) {
        const hip = new V3(sx * 0.11, 0.33, 0.25), knee = new V3(sx * 0.3, 0.32, -0.12), foot = new V3(sx * 0.4, -0.25, 0.02);
        placeBetween(limb(0.088, hip.distanceTo(knee) + 0.06, M.pants), hip, knee);
        placeBetween(limb(0.072, knee.distanceTo(foot) - 0.12, M.pants), knee, new V3().lerpVectors(knee, foot, 0.7));
        const kg = add(rb(0.12, 0.2, 0.08, 0.035), M.guard, 0, 0, 0); placeBetween(kg, knee.clone().add(new V3(0, 0.02, -0.06)), new V3().lerpVectors(knee, foot, 0.38).add(new V3(0, 0, -0.06)), false);
        const bt = add(rb(0.12, 0.3, 0.16, 0.04), M.boot, 0, 0, 0); placeBetween(bt, new V3().lerpVectors(knee, foot, 0.55), foot.clone().add(new V3(0, 0.02, 0)), false);
      }
      rider.torso = torso;
      rider.head = head;
    }

    // fold the static pieces of every rigid part into one mesh per material (draw calls, not triangles, cost most)
    U.bake(root);
    for (const w of wheels) U.bake(w.spin);
    U.bake(bars);
    if (rider) { U.bake(rider.root); U.bake(rider.torso); U.bake(rider.head); }
    root.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    const pole = new V3(), p0 = new V3(), p1 = new V3();
    let lean = 0, roll = 0, lift = 0;
    function pose(car, dt) {
      root.position.copy(car.pos);
      root.quaternion.copy(car.quat);
      for (let k = 0; k < 4; k++) {
        const w = wheels[k], cw = car.wheels[k], sx = w.side, z = w.hp.z;
        const wy = w.hp.y - cw.len;
        w.g.position.set(sx * TRACK, wy, z);
        if (w.front) w.g.rotation.y = -car.steer;
        w.spin.rotation.x = -cw.spin;
        const hx = sx * (TRACK - 0.16);
        placeBetween(w.upper, p0.set(sx * 0.17, -0.04, z), p1.set(hx, wy + 0.07, z), true);
        placeBetween(w.lower, p0.set(sx * 0.16, -0.24, z), p1.set(hx, wy - 0.07, z), true);
        w.knuckle.position.set(hx + sx * 0.02, wy, z);
        placeBetween(w.spring, p0.set(sx * 0.24, 0.08, z + 0.03), p1.set(hx - sx * 0.04, wy - 0.04, z + 0.03), true);
        placeBetween(w.damper, p0, p1, true);
      }
      bars.rotation.y = -car.steer;
      if (rider) {
        const a = U.clamp(dt * 6, 0, 1);
        const air = car.grounded === 0 ? 1 : 0;
        lean = U.lerp(lean, -0.5 - 0.14 * car.throttle + 0.18 * car.brakeIn * (car.vf > 1 ? 1 : 0) + 0.1 * air, a);
        roll = U.lerp(roll, -car.steer * 0.9 * U.clamp(car.speed / 8, 0, 1), a);
        lift = U.lerp(lift, air * 0.07, a);
        rider.torso.rotation.x = lean;
        rider.torso.rotation.z = roll;
        rider.head.rotation.x = -lean * 0.85;
        rider.head.rotation.z = -roll * 0.6;
        rider.root.position.y = 0.33 + lift;
        root.updateMatrixWorld(true);
        for (const arm of rider.arms) {
          arm.sh.getWorldPosition(arm.s); root.worldToLocal(arm.s);
          arm.grip.getWorldPosition(arm.gp); root.worldToLocal(arm.gp);
          pole.set(arm.sx * 0.8, -0.6, 0.2);
          ik(arm.s, arm.gp, rider.L1, rider.L2, pole, arm.e, arm.h);
          placeBetween(arm.upper, arm.s, arm.e);
          placeBetween(arm.fore, arm.e, arm.h);
          placeBetween(arm.cuff, p0.lerpVectors(arm.e, arm.h, 0.86), arm.h);
          arm.hand.position.copy(arm.h);
          arm.hand.quaternion.copy(arm.fore.quaternion);
        }
      }
    }
    return { root, pose, M };
  }

  // a parked copy: wheels at rest, no rider animation
  function parked(opt = {}) {
    const a = build(opt);
    const fake = {
      pos: new V3(), quat: new THREE.Quaternion(), steer: opt.steer || 0, throttle: 0, brakeIn: 0, vf: 0, speed: 0, grounded: 4,
      wheels: Vehicle.HP.map(() => ({ len: 0.25, spin: 0 })),
    };
    a.pose(fake, 1);
    return U.bake(a.root, true);
  }

  return { build, parked };
})();
