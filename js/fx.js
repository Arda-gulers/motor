'use strict';
// Soft round particles (dust, mud, splash, exhaust) in one Points draw call, plus camera trauma.

const FX = (() => {
  const MAX = 2600;
  const P = { n: 0, x: new Float32Array(MAX), y: new Float32Array(MAX), z: new Float32Array(MAX),
    vx: new Float32Array(MAX), vy: new Float32Array(MAX), vz: new Float32Array(MAX),
    life: new Float32Array(MAX), max: new Float32Array(MAX), size: new Float32Array(MAX), grow: new Float32Array(MAX),
    r: new Float32Array(MAX), g: new Float32Array(MAX), b: new Float32Array(MAX), a: new Float32Array(MAX),
    drag: new Float32Array(MAX), grav: new Float32Array(MAX) };
  let geo, mat, pts, cursor = 0;
  const F = { trauma: 0 };

  F.init = scene => {
    geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(MAX * 3), 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(MAX), 1));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(new Float32Array(MAX), 1));
    mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uScale: { value: 600 } }]),
      vertexShader: `attribute vec3 aColor; attribute float aSize; attribute float aAlpha; uniform float uScale;
        varying vec3 vColor; varying float vAlpha;
        #include <fog_pars_vertex>
        void main() {
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mvPosition;
          gl_PointSize = aSize * uScale / max(-mvPosition.z, 0.1);
          vColor = aColor; vAlpha = aAlpha;
          #include <fog_vertex>
        }`,
      fragmentShader: `varying vec3 vColor; varying float vAlpha;
        #include <fog_pars_fragment>
        void main() {
          vec2 c = gl_PointCoord - 0.5; float d = length(c);
          if (d > 0.5) discard;
          float a = smoothstep(0.5, 0.1, d) * vAlpha;
          gl_FragColor = vec4(vColor, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
          #include <fog_fragment>
        }`,
      transparent: true, depthWrite: false, fog: true,
    });
    pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 3;
    scene.add(pts);
  };

  // c: linear [r, g, b]
  F.emit = (x, y, z, vx, vy, vz, size, grow, life, c, alpha, drag = 1.5, grav = 0.4) => {
    const i = cursor;
    cursor = (cursor + 1) % MAX;
    P.x[i] = x; P.y[i] = y; P.z[i] = z; P.vx[i] = vx; P.vy[i] = vy; P.vz[i] = vz;
    P.size[i] = size; P.grow[i] = grow; P.life[i] = life; P.max[i] = life;
    P.r[i] = c[0]; P.g[i] = c[1]; P.b[i] = c[2]; P.a[i] = alpha; P.drag[i] = drag; P.grav[i] = grav;
  };

  F.update = (dt, camera, viewH) => {
    mat.uniforms.uScale.value = viewH / (2 * Math.tan((camera.fov * Math.PI) / 360));
    const pa = geo.attributes.position.array, ca = geo.attributes.aColor.array, sa = geo.attributes.aSize.array, aa = geo.attributes.aAlpha.array;
    for (let i = 0; i < MAX; i++) {
      if (P.life[i] <= 0) { aa[i] = 0; sa[i] = 0; continue; }
      P.life[i] -= dt;
      const k = Math.exp(-P.drag[i] * dt);
      P.vx[i] *= k; P.vz[i] *= k; P.vy[i] = P.vy[i] * k - P.grav[i] * 9.8 * dt;
      P.x[i] += P.vx[i] * dt; P.y[i] += P.vy[i] * dt; P.z[i] += P.vz[i] * dt;
      P.size[i] += P.grow[i] * dt;
      const t = P.life[i] / P.max[i];
      pa[i * 3] = P.x[i]; pa[i * 3 + 1] = P.y[i]; pa[i * 3 + 2] = P.z[i];
      ca[i * 3] = P.r[i]; ca[i * 3 + 1] = P.g[i]; ca[i * 3 + 2] = P.b[i];
      sa[i] = P.size[i];
      aa[i] = P.a[i] * Math.min(1, t * 2.2) * Math.min(1, (1 - t) * 8 + 0.2);
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.aColor.needsUpdate = true;
    geo.attributes.aSize.needsUpdate = true;
    geo.attributes.aAlpha.needsUpdate = true;
    F.trauma = Math.max(0, F.trauma - dt * 1.4);
  };

  F.shake = amount => { F.trauma = Math.min(1, F.trauma + amount); };
  F.clear = () => { P.life.fill(0); };

  return F;
})();
