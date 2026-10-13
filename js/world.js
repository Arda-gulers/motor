'use strict';
// Scene dressing: atmosphere (sky, sun, height fog, image-based light), the splatted terrain material,
// the lake, card-crowned trees, rocks, grass and flowers around the player, trail furniture, ramps,
// the festival with its race marker, checkpoint gates, and the obstacle grid used by the physics.
// Everything renders into a linear HDR target (see post.js), so shader colours are linear.

const World = (() => {
  const V3 = THREE.Vector3;
  const W = { time: 0, uTime: { value: 0 }, raceMarker: null, sun: null, tex: null };
  const SUN_DIR = new V3(0.5, 0.48, -0.72).normalize();
  W.SUN_DIR = SUN_DIR;
  const HAZE = {
    hor: new THREE.Color(0xbfd0e2), warm: new THREE.Color(0xf2c591), zenith: new THREE.Color(0x2a5ba6), sun: new THREE.Color(0xffd9a6),
  };
  const PAL = [0xff2d8a, 0x2de2ff, 0xffc83d, 0x9b5cff, 0xff7a1a, 0x3dff9e];
  const v3 = c => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;
  const HAZE_GLSL = `
    const vec3 HZ_HOR = ${v3(HAZE.hor)};
    const vec3 HZ_WARM = ${v3(HAZE.warm)};
    const vec3 HZ_ZEN = ${v3(HAZE.zenith)};
    const vec3 HZ_SUN = ${v3(HAZE.sun)};
    const vec3 HZ_DIR = vec3(${SUN_DIR.x.toFixed(5)}, ${SUN_DIR.y.toFixed(5)}, ${SUN_DIR.z.toFixed(5)});
    vec3 hazeColor(vec3 d) {
      vec2 dh = d.xz / max(length(d.xz), 1e-4);
      float az = max(dot(dh, normalize(HZ_DIR.xz)), 0.0);
      vec3 c = mix(HZ_HOR, HZ_WARM, pow(az, 3.0) * 0.7);
      float sd = max(dot(d, HZ_DIR), 0.0);
      return c + HZ_SUN * (pow(sd, 8.0) * 0.28 + pow(sd, 64.0) * 0.8);
    }
    vec3 skyColor(vec3 d) {
      return mix(hazeColor(d), HZ_ZEN, pow(smoothstep(0.0, 0.75, max(d.y, 0.0)), 0.75));
    }`;

  // height fog with sun-side scattering for every material: thicker low down, warm towards the sun,
  // and equal to the sky colour at the horizon so distant land melts into it
  const FOG_K = 0.011, FOG_BASE = -10;
  THREE.ShaderChunk.fog_pars_vertex = '#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vFogWorld;\n#endif';
  THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\n vFogDepth = - mvPosition.z;\n vFogWorld = cameraPosition + transpose( mat3( viewMatrix ) ) * mvPosition.xyz;\n#endif';
  THREE.ShaderChunk.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor; varying float vFogDepth; varying vec3 vFogWorld;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear; uniform float fogFar;
    #endif
    ${HAZE_GLSL}
  #endif`;
  THREE.ShaderChunk.fog_fragment = `#ifdef USE_FOG
    vec3 fogV = vFogWorld - cameraPosition;
    float fogL = length(fogV);
    #ifdef FOG_EXP2
      float fogDen = fogDensity;
    #else
      float fogDen = 1.0 / max(fogFar, 1.0);
    #endif
    float fogI = abs(fogV.y) > 0.05 ? (1.0 - exp(-${FOG_K.toFixed(4)} * fogV.y)) / (${FOG_K.toFixed(4)} * fogV.y) : 1.0;
    float fogOD = fogDen * exp(-${FOG_K.toFixed(4)} * (cameraPosition.y - (${FOG_BASE.toFixed(1)}))) * fogL * fogI;
    gl_FragColor.rgb = mix(gl_FragColor.rgb, hazeColor(fogV / max(fogL, 1e-4)), 1.0 - exp(-fogOD));
  #endif`;

  // ---------------------------------------------------------------- obstacles
  const OG = { cell: 16, n: 128, cells: [] };
  W.addObstacle = o => {
    const i = U.clamp(Math.floor((o.x + 1024) / OG.cell), 0, OG.n - 1), j = U.clamp(Math.floor((o.z + 1024) / OG.cell), 0, OG.n - 1);
    (OG.cells[j * OG.n + i] || (OG.cells[j * OG.n + i] = [])).push(o);
    o.id = W.obstacleCount = (W.obstacleCount || 0) + 1;
    return o;
  };
  W.queryObstacles = (x, z, r, out) => {
    const i0 = Math.max(0, Math.floor((x - r - 4 + 1024) / OG.cell)), i1 = Math.min(OG.n - 1, Math.floor((x + r + 4 + 1024) / OG.cell));
    const j0 = Math.max(0, Math.floor((z - r - 4 + 1024) / OG.cell)), j1 = Math.min(OG.n - 1, Math.floor((z + r + 4 + 1024) / OG.cell));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const c = OG.cells[j * OG.n + i];
      if (c) for (const o of c) out.push(o);
    }
    return out;
  };

  // ---------------------------------------------------------------- textures
  W.loadTextures = async () => {
    const T = {};
    await Promise.all(Object.entries(TEX_DATA).map(async ([k, uri]) => {
      // onload rather than decode(): decode() waits for a rendered frame, which hidden tabs never produce
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = uri; });
      const t = new THREE.Texture(img);
      const card = k.startsWith('card');
      t.colorSpace = k.endsWith('_a') || card ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.wrapS = t.wrapT = card ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
      t.anisotropy = 8;
      t.needsUpdate = true;
      T[k] = t;
      T[k + '_img'] = img;
    }));
    // CPU copy of the macro map, sampled exactly like the shaders do (repeat, flipY)
    const cv = document.createElement('canvas');
    cv.width = T.macro_img.width; cv.height = T.macro_img.height;
    const g = cv.getContext('2d');
    g.drawImage(T.macro_img, 0, 0);
    W.macroPx = { w: cv.width, h: cv.height, d: g.getImageData(0, 0, cv.width, cv.height).data };
    W.tex = T;
    return T;
  };
  W.macroAt = (u, v, out) => {
    const M = W.macroPx, fx = (u - Math.floor(u)) * M.w - 0.5, fy = (1 - (v - Math.floor(v))) * M.h - 0.5;
    const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    for (let c = 0; c < 3; c++) {
      const s = (x, y) => M.d[((((y % M.h) + M.h) % M.h) * M.w + (((x % M.w) + M.w) % M.w)) * 4 + c] / 255;
      out[c] = U.lerp(U.lerp(s(x0, y0), s(x0 + 1, y0), tx), U.lerp(s(x0, y0 + 1), s(x0 + 1, y0 + 1), tx), ty);
    }
    return out;
  };

  // ---------------------------------------------------------------- sky, image-based light, sun
  function skyMaterial(env) {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: W.uTime, uDisk: { value: env ? 0 : 1 }, tNoise: { value: W.tex.macro } },
      vertexShader: 'varying vec3 vDir; void main() { vDir = position; vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_Position = p.xyww; }',
      fragmentShader: `uniform float uTime, uDisk; uniform sampler2D tNoise; varying vec3 vDir;
        ${HAZE_GLSL}
        float fbm(vec2 p) { return texture2D(tNoise, p * 0.018).r * 0.75 + texture2D(tNoise, p * 0.07 + 0.37).g * 0.25; }
        void main() {
          vec3 d = normalize(vDir);
          vec3 col = skyColor(d);
          if (d.y > 0.0) {
            float sd = max(dot(d, HZ_DIR), 0.0);
            vec2 uv = d.xz / (d.y + 0.12) * 0.8 + vec2(uTime * 0.004, uTime * 0.0015);
            float n = fbm(uv * 1.2);
            float n2 = fbm(uv * 1.2 + normalize(HZ_DIR.xz) * 0.05);
            float c = smoothstep(0.6, 0.84, n) * smoothstep(0.02, 0.28, d.y);
            float lit = clamp(0.5 + (n - n2) * 6.0, 0.0, 1.0);
            vec3 cc = mix(vec3(0.5, 0.55, 0.66), vec3(1.05, 1.0, 0.94), lit) * (0.85 + 0.3 * smoothstep(0.0, 0.5, d.y));
            cc += HZ_SUN * pow(sd, 5.0) * 0.8;
            col = mix(col, cc, c * 0.85);
            col += HZ_SUN * smoothstep(0.99955, 0.9998, sd) * 40.0 * uDisk;
          }
          gl_FragColor = vec4(col, 1.0);
        }`,
      side: THREE.BackSide, depthWrite: false, fog: false, toneMapped: false,
    });
  }
  function environment(renderer, scene) {
    const es = new THREE.Scene();
    es.add(new THREE.Mesh(new THREE.SphereGeometry(500, 48, 24), skyMaterial(true)));
    const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x4a4630 }));
    ground.position.y = -30;
    es.add(ground);
    const pm = new THREE.PMREMGenerator(renderer);
    scene.environment = W.envTex = pm.fromScene(es, 0.03, 0.1, 2000).texture;
    pm.dispose();
  }
  function lights(scene) {
    scene.fog = new THREE.FogExp2(HAZE.hor.clone(), 0.0009);
    const sun = new THREE.DirectionalLight(0xffdcb0, 3.4);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const sc = sun.shadow.camera;
    sc.left = -48; sc.right = 48; sc.top = 48; sc.bottom = -48; sc.near = 1; sc.far = 500;
    sun.shadow.bias = -0.0003;
    sun.shadow.normalBias = 0.035;
    scene.add(sun, sun.target);
    W.sun = sun;
  }

  // ---------------------------------------------------------------- terrain material
  const TRIPLANAR = `
    vec3 tpW = pow(abs(wn), vec3(4.0)); tpW /= (tpW.x + tpW.y + tpW.z);
    vec4 rAx = texture2D(tRockA, wpos.zy * RS), rAy = texture2D(tRockA, wpos.xz * RS), rAz = texture2D(tRockA, wpos.xy * RS);
    vec4 rNx = texture2D(tRockN, wpos.zy * RS), rNy = texture2D(tRockN, wpos.xz * RS), rNz = texture2D(tRockN, wpos.xy * RS);
    vec3 rockCol = rAx.rgb * tpW.x + rAy.rgb * tpW.y + rAz.rgb * tpW.z;
    float rockH = rNx.b * tpW.x + rNy.b * tpW.y + rNz.b * tpW.z;
    vec3 tX = nUnpack(rNx), tY = nUnpack(rNy), tZ = nUnpack(rNz);
    tX = vec3(tX.xy + wn.zy, abs(tX.z) * wn.x);
    tY = vec3(tY.xy + wn.xz, abs(tY.z) * wn.y);
    tZ = vec3(tZ.xy + wn.xy, abs(tZ.z) * wn.z);
    vec3 rockN = normalize(tX.zyx * tpW.x + tY.xzy * tpW.y + tZ.xyz * tpW.z);`;
  const N_UNPACK = 'vec3 nUnpack(vec4 t) { vec2 xy = t.rg * 2.0 - 1.0; return vec3(xy, sqrt(max(1.0 - dot(xy, xy), 0.0))); }';

  function terrainMaterial(T) {
    const m = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0 });
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, {
        tGrassA: { value: T.grass_a }, tGrassN: { value: T.grass_n }, tDirtA: { value: T.dirt_a }, tDirtN: { value: T.dirt_n },
        tRockA: { value: T.rock_a }, tRockN: { value: T.rock_n }, tSandA: { value: T.sand_a }, tSandN: { value: T.sand_n }, tMacro: { value: T.macro },
      });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 splat; attribute vec2 extra;\nvarying vec4 vSplat; varying vec2 vExtra; varying vec3 vWPos; varying vec3 vWNor;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvWNor = normalize(mat3(modelMatrix) * objectNormal);')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSplat = splat; vExtra = extra; vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tGrassA, tGrassN, tDirtA, tDirtN, tRockA, tRockN, tSandA, tSandN, tMacro;
          varying vec4 vSplat; varying vec2 vExtra; varying vec3 vWPos; varying vec3 vWNor;
          ${N_UNPACK}`)
        .replace('#include <map_fragment>', `
          // layers with no weight are skipped and normal maps fade out with distance; gradients are taken
          // before any branch so mip selection stays correct inside them
          vec3 wn = normalize(vWNor);
          vec3 wpos = vWPos;
          vec2 pxz = wpos.xz;
          vec3 dpx = dFdx(wpos), dpy = dFdy(wpos);
          float nearF = 1.0 - smoothstep(90.0, 140.0, distance(wpos, cameraPosition));
          vec3 mac = texture2D(tMacro, pxz / 230.0).rgb;
          vec3 mac2 = texture2D(tMacro, pxz / 41.0 + 0.37).rgb;
          vec4 sw = vSplat;
          const vec4 FLAT = vec4(0.5, 0.5, 0.5, 1.0);
          vec2 ug = pxz / 2.6, gdx = dpx.xz / 2.6, gdy = dpy.xz / 2.6;
          vec3 grassCol = textureGrad(tGrassA, ug, gdx, gdy).rgb;
          vec4 gN = FLAT, dN = FLAT, sN = FLAT;
          if (nearF > 0.0 && sw.x > 0.01) gN = textureGrad(tGrassN, ug, gdx, gdy);
          grassCol *= mix(vec3(0.8, 1.0, 0.74), vec3(1.2, 1.06, 0.68), smoothstep(0.3, 0.78, mac.r));
          grassCol *= 0.8 + 0.4 * mac2.g;
          vec3 dirtCol = vec3(0.4, 0.3, 0.2), sandCol = vec3(0.6, 0.5, 0.35);
          if (sw.y > 0.01) {
            vec2 ud = pxz / 3.4, ddx = dpx.xz / 3.4, ddy = dpy.xz / 3.4;
            dirtCol = textureGrad(tDirtA, ud, ddx, ddy).rgb * (0.88 + 0.24 * mac2.b);
            if (nearF > 0.0) dN = textureGrad(tDirtN, ud, ddx, ddy);
          }
          if (sw.w > 0.01) {
            vec2 us = pxz / 3.0, sdx = dpx.xz / 3.0, sdy = dpy.xz / 3.0;
            sandCol = textureGrad(tSandA, us, sdx, sdy).rgb;
            if (nearF > 0.0) sN = textureGrad(tSandN, us, sdx, sdy);
          }
          vec3 rockCol = vec3(0.45), rockN = wn;
          float rockH = 0.5;
          if (sw.z > 0.01) {
            const float RS = 0.16;
            vec3 tpW = pow(abs(wn), vec3(4.0)); tpW /= (tpW.x + tpW.y + tpW.z);
            vec4 rAx = textureGrad(tRockA, wpos.zy * RS, dpx.zy * RS, dpy.zy * RS);
            vec4 rAy = textureGrad(tRockA, wpos.xz * RS, dpx.xz * RS, dpy.xz * RS);
            vec4 rAz = textureGrad(tRockA, wpos.xy * RS, dpx.xy * RS, dpy.xy * RS);
            rockCol = (rAx.rgb * tpW.x + rAy.rgb * tpW.y + rAz.rgb * tpW.z) * (0.82 + 0.36 * mac.g);
            if (nearF > 0.0) {
              vec4 rNx = textureGrad(tRockN, wpos.zy * RS, dpx.zy * RS, dpy.zy * RS);
              vec4 rNy = textureGrad(tRockN, wpos.xz * RS, dpx.xz * RS, dpy.xz * RS);
              vec4 rNz = textureGrad(tRockN, wpos.xy * RS, dpx.xy * RS, dpy.xy * RS);
              rockH = rNx.b * tpW.x + rNy.b * tpW.y + rNz.b * tpW.z;
              vec3 tX = nUnpack(rNx), tY = nUnpack(rNy), tZ = nUnpack(rNz);
              tX = vec3(tX.xy + wn.zy, abs(tX.z) * wn.x);
              tY = vec3(tY.xy + wn.xz, abs(tY.z) * wn.y);
              tZ = vec3(tZ.xy + wn.xy, abs(tZ.z) * wn.z);
              rockN = normalize(tX.zyx * tpW.x + tY.xzy * tpW.y + tZ.xyz * tpW.z);
            }
          }
          vec4 hgt = vec4(gN.b, dN.b, rockH, sN.b) * 0.6;
          float hmax = max(max(sw.x + hgt.x, sw.y + hgt.y), max(sw.z + hgt.z, sw.w + hgt.w)) - 0.22;
          vec4 lw = max(sw + hgt - hmax, 0.0) * step(0.002, sw);
          lw /= max(lw.x + lw.y + lw.z + lw.w, 1e-4);
          vec3 albedo = grassCol * lw.x + dirtCol * lw.y + rockCol * lw.z + sandCol * lw.w;
          float snow = vExtra.x * smoothstep(0.35, 0.7, wn.y + mac2.r * 0.3);
          albedo = mix(albedo, vec3(0.86, 0.89, 0.94), snow);
          albedo *= 1.0 - 0.4 * vExtra.y;
          diffuseColor.rgb *= albedo;`)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = mix(mix(dot(lw, vec4(0.93, 0.96, 0.8, 0.9)), 0.55, snow), 0.35, vExtra.y);')
        .replace('#include <normal_fragment_maps>', `
          vec3 tn = nUnpack(gN) * lw.x + nUnpack(dN) * lw.y + nUnpack(sN) * lw.w + vec3(0.0, 0.0, 1.0) * (lw.z + snow);
          vec3 Tt = normalize(vec3(1.0, 0.0, 0.0) - wn * wn.x), Bt = normalize(vec3(0.0, 0.0, 1.0) - wn * wn.z);
          vec3 nP = normalize(Tt * tn.x + Bt * tn.y + wn * max(tn.z, 0.05));
          vec3 nW = normalize(mix(wn, normalize(mix(nP, rockN, lw.z * (1.0 - snow))), nearF));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);`);
    };
    return m;
  }

  // ---------------------------------------------------------------- lake
  function water(scene, T) {
    const L = Terrain.lake, R = L.r * 1.6, res = 256;
    const data = new Uint8Array(res * res * 4);
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x = L.x - R + ((i + 0.5) / res) * 2 * R, z = L.z - R + ((j + 0.5) / res) * 2 * R;
      const d = U.clamp((Terrain.WATER - Terrain.height(x, z)) / 8, 0, 1);
      data[(j * res + i) * 4] = d * 255;
      data[(j * res + i) * 4 + 3] = 255;
    }
    const dt = new THREE.DataTexture(data, res, res, THREE.RGBAFormat);
    dt.magFilter = dt.minFilter = THREE.LinearFilter;
    dt.needsUpdate = true;
    const mat = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
        uTime: { value: 0 }, tDepth: { value: null }, tNoise: { value: null }, uRect: { value: new THREE.Vector4(L.x - R, L.z - R, 1 / (2 * R), 1 / (2 * R)) },
      }]),
      vertexShader: `varying vec3 vWorld;
        #include <fog_pars_vertex>
        void main() { vec4 wp = modelMatrix * vec4(position, 1.0); vWorld = wp.xyz; vec4 mvPosition = viewMatrix * wp;
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `uniform float uTime; uniform sampler2D tDepth, tNoise; uniform vec4 uRect; varying vec3 vWorld;
        #include <fog_pars_fragment>
        void main() {
          vec2 p = vWorld.xz; float t = uTime;
          float depth = texture2D(tDepth, (p - uRect.xy) * uRect.zw).r * 8.0;
          vec3 n = normalize(vec3(
            0.045 * sin(p.x * 0.35 + t * 1.3) + 0.03 * sin(p.x * 0.9 - p.y * 0.6 + t * 2.1) + 0.02 * sin(p.x * 2.3 + p.y * 1.7 + t * 3.3) + 0.012 * sin(p.x * 5.1 - p.y * 3.7 + t * 4.4),
            1.0,
            0.045 * cos(p.y * 0.31 - t * 1.1) + 0.03 * cos(p.y * 1.1 + p.x * 0.5 + t * 1.9) + 0.02 * cos(p.y * 2.9 - p.x * 1.3 - t * 2.7) + 0.012 * cos(p.y * 4.7 + p.x * 3.1 - t * 4.0)));
          vec3 v = normalize(cameraPosition - vWorld);
          float fres = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
          vec3 body = mix(vec3(0.05, 0.2, 0.19), vec3(0.01, 0.045, 0.07), 1.0 - exp(-depth * 0.45));
          vec3 refl = skyColor(reflect(-v, n));
          vec3 col = mix(body, refl, fres);
          col += HZ_SUN * pow(max(dot(n, normalize(v + HZ_DIR)), 0.0), 400.0) * 18.0;
          float nz = texture2D(tNoise, p * 0.08 + vec2(t * 0.01, 0.0)).g;
          float foam = smoothstep(0.35, 0.05, depth + (nz - 0.5) * 0.25) * smoothstep(0.0, 0.03, depth);
          col = mix(col, vec3(0.85, 0.88, 0.86), foam * 0.75);
          float a = clamp(smoothstep(0.0, 0.6, depth) * 0.85 + fres * 0.3 + foam, 0.0, 1.0);
          gl_FragColor = vec4(col, a);
          #include <fog_fragment>
        }`,
      transparent: true, fog: true, depthWrite: false,
    });
    mat.uniforms.tDepth.value = dt;
    mat.uniforms.tNoise.value = T.macro;
    const m = new THREE.Mesh(new THREE.CircleGeometry(R, 96).rotateX(-Math.PI / 2), mat);
    m.position.set(L.x, Terrain.WATER, L.z);
    m.renderOrder = 2;
    scene.add(m);
    W.waterMat = mat;
  }

  // ---------------------------------------------------------------- vegetation
  const BARK = [U.lin(0x2f241b), U.lin(0x5b4636)];
  function grad(geo, c0, c1, y0, y1) {
    return U.paint(geo, (x, y) => { const t = U.smooth(y0, y1, y); return [U.lerp(c0[0], c1[0], t), U.lerp(c0[1], c1[1], t), U.lerp(c0[2], c1[2], t)]; });
  }
  // indexed card geometry builder: four vertices per quad
  function cards() {
    const b = { p: [], n: [], c: [], uv: [], idx: [] };
    b.quad = (A, B, C, D, nf, cf) => {
      const base = b.p.length / 3, uv = [[0, 0], [1, 0], [1, 1], [0, 1]], P = [A, B, C, D];
      for (let k = 0; k < 4; k++) {
        const v = P[k], n = nf(v), c = cf(v);
        b.p.push(v.x, v.y, v.z); b.n.push(n.x, n.y, n.z); b.c.push(c, c, c); b.uv.push(uv[k][0], uv[k][1]);
      }
      b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    };
    b.geo = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.p, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.n, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(b.c, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      return g;
    };
    return b;
  }
  // render a tree once into a texture, seen from the side, for distant camera-facing billboards
  function bakeImpostor(renderer, parts, w, y0, y1) {
    const sc = new THREE.Scene();
    sc.environment = W.envTex;
    const sun = new THREE.DirectionalLight(0xffdcb0, 3.4);
    sun.position.set(12, 14, 30);
    sc.add(sun);
    for (const p of parts) sc.add(new THREE.Mesh(p.geo, p.mat));
    const cam = new THREE.OrthographicCamera(-w / 2, w / 2, y1, y0, 0.1, 100);
    cam.position.set(0, 0, 40);
    const res = 512, rt = new THREE.WebGLRenderTarget(res, Math.round((res * (y1 - y0)) / w), {
      type: THREE.HalfFloatType, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    const prevAlpha = renderer.getClearAlpha(), prevColor = renderer.getClearColor(new THREE.Color());
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x2e4422, 0);
    renderer.clear();
    renderer.render(sc, cam);
    renderer.setRenderTarget(null);
    renderer.setClearColor(prevColor, prevAlpha);
    const geo = new THREE.PlaneGeometry(w, y1 - y0).translate(0, (y0 + y1) / 2, 0);
    const mat = new THREE.MeshBasicMaterial({ map: rt.texture, alphaTest: 0.5, side: THREE.DoubleSide });
    mat.onBeforeCompile = sh => {
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', `
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float isx = length(instanceMatrix[0].xyz), isy = length(instanceMatrix[1].xyz);
        vec3 toCam = cameraPosition - ip; toCam.y = 0.0; toCam = normalize(toCam + vec3(1e-4, 0.0, 0.0));
        vec3 rightV = vec3(toCam.z, 0.0, -toCam.x);
        vec4 mvPosition = viewMatrix * vec4(ip + rightV * position.x * isx + vec3(0.0, position.y * isy, 0.0), 1.0);
        gl_Position = projectionMatrix * mvPosition;`);
    };
    return { geo, mat };
  }
  function leafCrownGeo(seed) {
    const r = U.rng(seed), b = cards();
    const C = new V3(0, 4.7, 0), R = new V3(2.7, 2.1, 2.7), q = new THREE.Quaternion(), e = new THREE.Euler(), t = new V3(), up = new V3(0, 1, 0);
    for (let i = 0; i < 32; i++) {
      const dir = new V3(r() * 2 - 1, r() * 2 - 0.75, r() * 2 - 1).normalize();
      const k = 0.4 + 0.6 * Math.sqrt(r());
      const c = new V3(C.x + dir.x * R.x * k, C.y + dir.y * R.y * k, C.z + dir.z * R.z * k);
      const s = 1.8 + r() * 1.2;
      q.setFromEuler(e.set(r() * 6.28, r() * 6.28, r() * 6.28));
      const P = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]].map(([u, v]) => new V3(u * s, v * s, 0).applyQuaternion(q).add(c));
      b.quad(P[0], P[1], P[2], P[3],
        v => t.copy(v).sub(C).divide(R).normalize().lerp(up, 0.2).normalize(),
        v => {
          const hh = U.clamp((v.y - (C.y - R.y)) / (2 * R.y), 0, 1);
          const rad = Math.min(1, t.copy(v).sub(C).divide(R).length());
          return (0.4 + 0.6 * hh) * (0.6 + 0.4 * rad);
        });
    }
    return b.geo();
  }
  function leafTrunkGeo() {
    const parts = [grad(new THREE.CylinderGeometry(0.15, 0.3, 4.4, 8).translate(0, 2.2, 0), BARK[0], BARK[1], 0, 4)];
    for (const [dx, dz, len, tilt] of [[1, 0.3, 1.8, 0.75], [-0.7, 0.8, 1.6, 0.7], [0.2, -1, 1.5, 0.85], [-0.6, -0.5, 1.3, 0.6]]) {
      const dir = new V3(dx * Math.sin(tilt), Math.cos(tilt), dz * Math.sin(tilt)).normalize();
      const g = new THREE.CylinderGeometry(0.04, 0.1, len, 6).translate(0, len / 2, 0);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new V3(0, 1, 0), dir));
      g.translate(0, 2.6 + Math.random() * 0.01, 0);
      parts.push(grad(g, BARK[0], BARK[1], 2.5, 4.5));
    }
    return U.merge(parts);
  }
  function pineCrownGeo(seed) {
    const r = U.rng(seed), b = cards(), H = 10.5, tiers = 9, t = new V3();
    const side = new V3(), along = new V3();
    const nf = v => { const rr = Math.hypot(v.x, v.z) || 1; return t.set(v.x / rr, 0.75, v.z / rr).normalize(); };
    const cf = v => { const rr = Math.hypot(v.x, v.z); return (0.42 + 0.58 * U.clamp(rr / 2.4, 0, 1)) * (0.75 + 0.25 * v.y / H); };
    for (let k = 0; k < tiers; k++) {
      const f = k / (tiers - 1), y = 1.5 + f * (H - 2.4);
      const len = 0.55 + Math.pow(1 - f, 0.85) * 2.9;
      const n = k < tiers - 3 ? 6 : 4;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2 + k * 0.9 + (r() - 0.5) * 0.5, ca = Math.cos(a), sa = Math.sin(a);
        const droop = 0.28 + 0.3 * (1 - f) + (r() - 0.5) * 0.12, w = len * 0.66;
        along.set(ca, -droop, sa).normalize();
        for (const tilt of [-0.5, 0.5]) {
          side.set(-sa, 0, ca).applyAxisAngle(along, tilt);
          const base = new V3(ca * 0.05, y, sa * 0.05), tip = base.clone().addScaledVector(along, len);
          b.quad(base.clone().addScaledVector(side, -w / 2), tip.clone().addScaledVector(side, -w / 2), tip.clone().addScaledVector(side, w / 2), base.clone().addScaledVector(side, w / 2), nf, cf);
        }
      }
    }
    for (const a of [0, Math.PI / 2]) {
      const sx = Math.cos(a) * 0.35, sz = Math.sin(a) * 0.35, y0 = H - 1.5, y1 = H + 0.4;
      b.quad(new V3(-sx, y0, -sz), new V3(-sx, y1, -sz), new V3(sx, y1, sz), new V3(sx, y0, sz), () => t.set(0, 1, 0), () => 0.9);
    }
    return b.geo();
  }
  function pineTrunkGeo() {
    return grad(new THREE.CylinderGeometry(0.1, 0.32, 10.5, 8).translate(0, 5.25, 0), BARK[0], BARK[1], 0, 6);
  }
  function rockGeo() {
    const g = new THREE.IcosahedronGeometry(1, 2);
    const p = g.attributes.position, v = new V3();
    for (let i = 0; i < p.count; i++) {
      v.fromBufferAttribute(p, i);
      const k = 1 + 0.22 * Noise.simplex(v.x * 1.1 + 4, v.z * 1.1 + v.y * 0.9) + 0.08 * Noise.simplex(v.x * 3.3, v.y * 3.1 - v.z);
      v.multiplyScalar(k);
      if (v.y < -0.2) v.y = -0.2 + (v.y + 0.2) * 0.3;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    // the polyhedron is non-indexed: average face normals over coincident vertices
    g.computeVertexNormals();
    const n = g.attributes.normal, acc = new Map(), key = i => `${p.getX(i).toFixed(4)},${p.getY(i).toFixed(4)},${p.getZ(i).toFixed(4)}`;
    for (let i = 0; i < p.count; i++) {
      const k = key(i), a = acc.get(k) || [0, 0, 0];
      a[0] += n.getX(i); a[1] += n.getY(i); a[2] += n.getZ(i);
      acc.set(k, a);
    }
    for (let i = 0; i < p.count; i++) { const a = acc.get(key(i)), l = Math.hypot(a[0], a[1], a[2]); n.setXYZ(i, a[0] / l, a[1] / l, a[2] / l); }
    return g;
  }
  function cardMaterial(map, amount, from) {
    const m = new THREE.MeshStandardMaterial({ map, alphaTest: 0.42, side: THREE.DoubleSide, vertexColors: true, roughness: 0.82, metalness: 0 });
    m.onBeforeCompile = sh => {
      sh.uniforms.uTime = W.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        #else
          vec3 ip = vec3(0.0);
        #endif
        float hw = max(transformed.y - ${from.toFixed(2)}, 0.0);
        float sw = sin(uTime * 1.3 + ip.x * 0.13 + ip.z * 0.11) + 0.4 * sin(uTime * 3.1 + ip.x * 0.31 + transformed.y * 0.7);
        transformed.x += sw * hw * ${amount.toFixed(4)};
        transformed.z += sw * hw * ${(amount * 0.6).toFixed(4)};`);
      // cards are lit by their spherised normals on both sides
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;');
    };
    return m;
  }
  function rockMaterial(T) {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.85, metalness: 0 });
    m.onBeforeCompile = sh => {
      Object.assign(sh.uniforms, { tRockA: { value: T.rock_a }, tRockN: { value: T.rock_n }, tGrassA: { value: T.grass_a }, tMacro: { value: T.macro } });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNor;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          #ifdef USE_INSTANCING
            vWNor = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * objectNormal);
          #else
            vWNor = normalize(mat3(modelMatrix) * objectNormal);
          #endif`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          #ifdef USE_INSTANCING
            vWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
          #else
            vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
          #endif`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D tRockA, tRockN, tGrassA, tMacro; varying vec3 vWPos; varying vec3 vWNor;
          ${N_UNPACK}`)
        .replace('#include <map_fragment>', `
          vec3 wn = normalize(vWNor);
          vec3 wpos = vWPos;
          const float RS = 0.45;
          ${TRIPLANAR}
          float mossN = texture2D(tMacro, wpos.xz / 9.0).g;
          float moss = smoothstep(0.45, 0.8, wn.y + (mossN - 0.5) * 0.6);
          vec3 albedo = mix(rockCol, texture2D(tGrassA, wpos.xz / 1.6).rgb * vec3(0.8, 0.95, 0.7), moss * 0.85);
          diffuseColor.rgb *= albedo;`)
        .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(normalize(mix(rockN, wn, moss * 0.7)), 0.0)).xyz);');
    };
    return m;
  }

  function scatter(scene, T, renderer) {
    const REG = 256, NR = 2048 / REG, half = 1024, F = Terrain.fest;
    const regions = [];
    for (let k = 0; k < NR * NR; k++) regions.push({ pine: [], leaf: [], rock: [], x: -half + ((k % NR) + 0.5) * REG, z: -half + (Math.floor(k / NR) + 0.5) * REG, full: [], imp: [], rocks: [] });
    W.vegRegions = regions;
    const regionOf = (x, z) => regions[U.clamp(Math.floor((z + half) / REG), 0, NR - 1) * NR + U.clamp(Math.floor((x + half) / REG), 0, NR - 1)];
    const surf = new Float32Array(9);
    const cell = 13.5;
    for (let gz = 0; gz < 2048 / cell; gz++) for (let gx = 0; gx < 2048 / cell; gx++) {
      const x = -half + (gx + 0.15 + 0.7 * U.hash2(gx, gz, 1)) * cell, z = -half + (gz + 0.15 + 0.7 * U.hash2(gx, gz, 2)) * cell;
      const forest = Noise.fbm(x / 340 + 100, z / 340, 3);
      const p = U.smooth(-0.05, 0.3, forest) * 0.85 + 0.03;
      if (U.hash2(gx, gz, 3) > p || Math.hypot(x - F.x, z - F.z) < 125) continue;
      Terrain.surfaceAt(x, z, surf);
      const h = surf[8], q = Terrain.q;
      if (q.lat < 10 || h < Terrain.WATER + 0.8 || q.lake < 1.2 || h > 110 || surf[7] < 0.8) continue;
      const pine = Noise.simplex(x / 220 + 7, z / 220) + h / 70 > 0.1;
      const s = 0.75 + U.hash2(gx, gz, 4) * 0.6;
      regionOf(x, z)[pine ? 'pine' : 'leaf'].push([x, h - 0.15, z, s, U.hash2(gx, gz, 5) * Math.PI * 2, 0.78 + U.hash2(gx, gz, 6) * 0.4]);
      W.addObstacle({ kind: 'cyl', x, z, r: (pine ? 0.26 : 0.28) * s + 0.05, y0: h - 1, y1: h + 7 * s, tree: true });
    }
    const rc = 17;
    for (let gz = 0; gz < 2048 / rc; gz++) for (let gx = 0; gx < 2048 / rc; gx++) {
      const x = -half + (gx + U.hash2(gx, gz, 11)) * rc, z = -half + (gz + U.hash2(gx, gz, 12)) * rc;
      Terrain.surfaceAt(x, z, surf);
      const h = surf[8], q = Terrain.q, sl = Math.sqrt(1 - surf[7] * surf[7]) / Math.max(surf[7], 0.1);
      const p = 0.06 + U.smooth(0.3, 0.8, sl) * 0.45 + U.smooth(50, 90, h) * 0.3;
      if (U.hash2(gx, gz, 13) > p || q.lat < 8 || Math.hypot(x - F.x, z - F.z) < 110 || (q.lake < 1.05 && h < Terrain.WATER)) continue;
      const big = U.hash2(gx, gz, 14) > 0.72;
      const s = big ? 1.2 + U.hash2(gx, gz, 15) * 1.8 : 0.3 + U.hash2(gx, gz, 15) * 0.6;
      regionOf(x, z).rock.push([x, h - s * 0.15, z, s, U.hash2(gx, gz, 16) * 6.28, 0.75 + U.hash2(gx, gz, 17) * 0.4]);
      if (big) W.addObstacle({ kind: 'sph', x, y: h - s * 0.15, z, r: s * 0.85, rock: true });
    }

    const barkMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
    const kinds = {
      leaf: [{ geo: leafTrunkGeo(), mat: barkMat }, { geo: leafCrownGeo(31), mat: cardMaterial(T.card_leaves, 0.018, 2.5), map: T.card_leaves }],
      pine: [{ geo: pineTrunkGeo(), mat: barkMat }, { geo: pineCrownGeo(47), mat: cardMaterial(T.card_bough, 0.01, 2.0), map: T.card_bough }],
      rock: [{ geo: rockGeo(), mat: rockMaterial(T) }],
    };
    const imps = {
      pine: bakeImpostor(renderer, kinds.pine, 7.6, -0.4, 11.4),
      leaf: bakeImpostor(renderer, kinds.leaf, 8.4, -0.3, 7.9),
    };
    const dummy = new THREE.Object3D(), col = new THREE.Color();
    let total = 0;
    for (const reg of regions) for (const kind of ['pine', 'leaf', 'rock']) {
      const list = reg[kind];
      if (!list.length) continue;
      const parts = kind === 'rock' ? kinds.rock : [...kinds[kind], { ...imps[kind], imp: true }];
      for (const part of parts) {
        const im = new THREE.InstancedMesh(part.geo, part.mat, list.length);
        list.forEach(([x, y, z, s, rot, tint], i) => {
          dummy.position.set(x, y, z);
          if (kind === 'rock') { dummy.rotation.set(rot * 0.3, rot, rot * 0.2); dummy.scale.set(s * 1.25, s * 0.8, s); }
          else { dummy.rotation.set(0, rot, 0); dummy.scale.set(s, s * (0.9 + tint * 0.2), s); }
          dummy.updateMatrix();
          im.setMatrixAt(i, dummy.matrix);
          if (kind === 'rock') im.setColorAt(i, col.setRGB(tint, tint * 0.98, tint * 0.95));
          else im.setColorAt(i, part.map ? col.setRGB(tint * 0.95, tint, tint * 0.9) : col.setRGB(1, 1, 1));
        });
        im.computeBoundingSphere();
        im.castShadow = kind === 'rock';
        im.receiveShadow = !part.imp;
        (part.imp ? reg.imp : kind === 'rock' ? reg.rocks : reg.full).push(im);
        if (part.map) im.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: part.map, alphaTest: 0.42, side: THREE.DoubleSide });
        scene.add(im);
      }
      total += list.length;
    }
    W.vegCount = total;
    // shadow casters: only trees near the player cast, from instanced copies that live on layer 1,
    // which the sun's shadow camera renders and the view camera does not
    const casters = [];
    for (const kind of ['pine', 'leaf']) for (const part of kinds[kind]) {
      const im = new THREE.InstancedMesh(part.geo, part.mat, 700);
      im.count = 0;
      im.castShadow = true;
      im.layers.set(1);
      if (part.map) im.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: part.map, alphaTest: 0.42, side: THREE.DoubleSide });
      scene.add(im);
      casters.push({ im, kind });
    }
    const m4 = new THREE.Matrix4(), q4 = new THREE.Quaternion(), p4 = new V3(), s4 = new V3(), yAxis = new V3(0, 1, 0);
    let lastX = 1e9, lastZ = 1e9;
    W.updateCasters = (px, pz) => {
      if (Math.hypot(px - lastX, pz - lastZ) < 8) return;
      lastX = px; lastZ = pz;
      for (const c of casters) c.im.count = 0;
      for (const R of regions) {
        if (Math.max(Math.abs(px - R.x), Math.abs(pz - R.z)) > REG / 2 + 75) continue;
        for (const kind of ['pine', 'leaf']) for (const [x, y, z, s, rot, tint] of R[kind]) {
          if ((x - px) ** 2 + (z - pz) ** 2 > 75 * 75) continue;
          m4.compose(p4.set(x, y, z), q4.setFromAxisAngle(yAxis, rot), s4.set(s, s * (0.9 + tint * 0.2), s));
          for (const c of casters) if (c.kind === kind && c.im.count < 700) c.im.setMatrixAt(c.im.count++, m4);
        }
      }
      for (const c of casters) { c.im.instanceMatrix.needsUpdate = true; c.im.computeBoundingSphere(); }
    };
  }

  // instances in cells around the player, recycled through a slot pool
  const poolCells = (cell, radius) => Math.ceil(Math.PI * (radius / cell + 1.5) ** 2) + 30;
  function cellPool(mesh, cell, radius, per, fill) {
    const P = { map: new Map(), free: [], ci: 1e9, cj: 1e9 };
    const R = radius / cell, cells = poolCells(cell, radius);
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < cells * per; i++) mesh.setMatrixAt(i, zero);
    for (let i = cells - 1; i >= 0; i--) P.free.push(i);
    P.capacity = cells * per;
    P.update = (px, pz, force) => {
      const ci = Math.floor(px / cell), cj = Math.floor(pz / cell);
      if (!force && ci === P.ci && cj === P.cj) return;
      P.ci = ci; P.cj = cj;
      const R2 = (R + 0.8) ** 2;
      for (const [key, slot] of P.map) {
        const i = Math.floor(key / 4096) - 2048, j = (key % 4096) - 2048;
        if ((i - ci) ** 2 + (j - cj) ** 2 > R2 + 2 * R) {
          for (let k = 0; k < per; k++) mesh.setMatrixAt(slot * per + k, zero);
          P.map.delete(key);
          P.free.push(slot);
        }
      }
      const r = Math.ceil(R + 1);
      for (let j = cj - r; j <= cj + r; j++) for (let i = ci - r; i <= ci + r; i++) {
        if ((i - ci) ** 2 + (j - cj) ** 2 > R2) continue;
        const key = (i + 2048) * 4096 + (j + 2048);
        if (P.map.has(key) || !P.free.length) continue;
        const slot = P.free.pop();
        P.map.set(key, slot);
        for (let k = 0; k < per; k++) if (!fill(slot * per + k, i, j, k)) mesh.setMatrixAt(slot * per + k, zero);
      }
      let top = -1;
      for (const slot of P.map.values()) if (slot > top) top = slot;
      mesh.count = (top + 1) * per;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    };
    return P;
  }

  const GRASS = { cell: 12, radius: 46, per: 200 };
  function tuftGeo() {
    const pos = [], col = [], idx = [], r = U.rng(7);
    for (let b = 0; b < 9; b++) {
      const a = (b / 9) * Math.PI * 2 + r() * 0.7, h = 0.22 + r() * 0.3, w = 0.022 + r() * 0.014;
      const ox = Math.cos(a) * 0.07 * r(), oz = Math.sin(a) * 0.07 * r(), lx = Math.cos(a) * h * 0.4, lz = Math.sin(a) * h * 0.4;
      const px = -Math.sin(a) * w, pz = Math.cos(a) * w;
      const v = [[ox - px, 0, oz - pz], [ox + px, 0, oz + pz], [ox + lx * 0.45 - px * 0.7, h * 0.55, oz + lz * 0.45 - pz * 0.7], [ox + lx * 0.45 + px * 0.7, h * 0.55, oz + lz * 0.45 + pz * 0.7], [ox + lx, h, oz + lz]];
      const shade = 0.75 + r() * 0.5, base = pos.length / 3;
      for (const p of v) {
        pos.push(p[0], p[1], p[2]);
        const s = (0.35 + 0.65 * (p[1] / h)) * shade;
        col.push(s, s, s);
      }
      for (const t of [[0, 1, 2], [2, 1, 3], [2, 3, 4]]) idx.push(base + t[0], base + t[1], base + t[2]);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const nor = new Float32Array(pos.length);
    for (let i = 1; i < nor.length; i += 3) nor[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setIndex(idx);
    return g;
  }
  function swayFade(mat, radius, bend) {
    mat.onBeforeCompile = sh => {
      sh.uniforms.uTime = W.uTime;
      sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float hw = max(transformed.y, 0.0);
        float sw = sin(uTime * 1.9 + ip.x * 0.23 + ip.z * 0.19) * 0.6 + sin(uTime * 3.1 + ip.x * 0.7) * 0.3;
        transformed.x += sw * hw * ${bend.toFixed(3)};
        transformed.z += sw * hw * ${(bend * 0.5).toFixed(3)};
        transformed *= 1.0 - smoothstep(${(radius - 16).toFixed(1)}, ${(radius - 3).toFixed(1)}, distance(ip, cameraPosition));`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0;\nvec3 normal = normalize( vNormal );\nvec3 nonPerturbedNormal = normal;');
      if (mat.userData.atlas) {
        sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute vec2 aCell;').replace('#include <uv_vertex>', '#include <uv_vertex>\nvMapUv = vMapUv * 0.5 + aCell;');
      }
    };
  }
  function grassInit(scene) {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    swayFade(mat, GRASS.radius, 0.18);
    const mesh = new THREE.InstancedMesh(tuftGeo(), mat, poolCells(GRASS.cell, GRASS.radius) * GRASS.per);
    mesh.frustumCulled = false;
    mesh.receiveShadow = true;
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    const d = new THREE.Object3D(), c = new THREE.Color(), s9 = new Float32Array(9), m3 = [0, 0, 0], m4 = [0, 0, 0], F = Terrain.fest;
    const base = U.lin(0x6f8a3a);
    const fill = (idx, ci, cj, k) => {
      const x = (ci + U.hash2(ci, cj, k * 3)) * GRASS.cell, z = (cj + U.hash2(ci, cj, k * 3 + 1)) * GRASS.cell;
      const dens = Noise.simplex(x / 21, z / 21) * 0.5 + 0.5;
      if (U.hash2(ci, cj, k * 3 + 2) > 0.3 + dens * 0.7) return false;
      Terrain.surfaceAt(x, z, s9);
      if (s9[0] < 0.65 || s9[4] > 0.3 || s9[8] < Terrain.WATER + 0.5 || Math.hypot(x - F.x, z - F.z) < 28) return false;
      const sc = 0.6 + U.hash2(ci, cj, k + 500) * 0.5;
      d.position.set(x, s9[8] - 0.03, z);
      d.rotation.set(0, U.hash2(ci, cj, k + 900) * 6.28, 0);
      d.scale.set(sc, sc * (0.75 + dens * 0.7), sc);
      d.updateMatrix();
      mesh.setMatrixAt(idx, d.matrix);
      W.macroAt(x / 230, z / 230, m3);
      W.macroAt(x / 41 + 0.37, z / 41 + 0.37, m4);
      const dry = U.smooth(0.3, 0.78, m3[0]), br = (0.8 + 0.4 * m4[1]) * 1.15;
      c.setRGB(base[0] * U.lerp(0.8, 1.2, dry) * br, base[1] * U.lerp(1.0, 1.06, dry) * br, base[2] * U.lerp(0.74, 0.68, dry) * br);
      mesh.setColorAt(idx, c);
      return true;
    };
    W.grass = cellPool(mesh, GRASS.cell, GRASS.radius, GRASS.per, fill);
    scene.add(mesh);
  }
  const FLOWERS = { cell: 16, radius: 70, per: 26 };
  function flowersInit(scene, T) {
    const geo = new THREE.BufferGeometry();
    const p = [], n = [], uv = [];
    for (const a of [0, Math.PI / 2]) {
      const cx = Math.cos(a) * 0.32, cz = Math.sin(a) * 0.32;
      const Q = [[-cx, 0, -cz, 0, 0], [cx, 0, cz, 1, 0], [cx, 0.62, cz, 1, 1], [-cx, 0.62, -cz, 0, 1]];
      for (const k of [0, 1, 2, 0, 2, 3]) { p.push(Q[k][0], Q[k][1], Q[k][2]); n.push(0, 1, 0); uv.push(Q[k][3], Q[k][4]); }
    }
    geo.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(n, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    const mat = new THREE.MeshLambertMaterial({ map: T.card_flora, alphaTest: 0.45, side: THREE.DoubleSide });
    mat.userData.atlas = true;
    swayFade(mat, FLOWERS.radius, 0.25);
    const cap = poolCells(FLOWERS.cell, FLOWERS.radius) * FLOWERS.per;
    const mesh = new THREE.InstancedMesh(geo, mat, cap);
    const cellAttr = new THREE.InstancedBufferAttribute(new Float32Array(cap * 2), 2);
    geo.setAttribute('aCell', cellAttr);
    mesh.frustumCulled = false;
    const d = new THREE.Object3D(), s9 = new Float32Array(9), F = Terrain.fest;
    const CELLS = [[0, 0.5], [0.5, 0.5], [0, 0], [0.5, 0]];
    const fill = (idx, ci, cj, k) => {
      const cx = (ci + 0.5) * FLOWERS.cell, cz = (cj + 0.5) * FLOWERS.cell;
      if (Noise.simplex(cx / 60 + 3, cz / 60) < 0.05) return false;
      const a = U.hash2(ci, cj, k * 2) * 6.28, rr = Math.sqrt(U.hash2(ci, cj, k * 2 + 1)) * FLOWERS.cell * 0.55;
      const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
      Terrain.surfaceAt(x, z, s9);
      if (s9[0] < 0.75 || s9[8] < Terrain.WATER + 0.8 || Math.hypot(x - F.x, z - F.z) < 30) return false;
      const sc = 0.7 + U.hash2(ci, cj, k + 300) * 0.6;
      d.position.set(x, s9[8] - 0.04, z);
      d.rotation.set(0, U.hash2(ci, cj, k + 700) * 6.28, 0);
      d.scale.setScalar(sc);
      d.updateMatrix();
      mesh.setMatrixAt(idx, d.matrix);
      const c = CELLS[Math.floor(U.hash2(ci, cj, 77) * 4)];
      cellAttr.setXY(idx, c[0], c[1]);
      cellAttr.needsUpdate = true;
      return true;
    };
    W.flowers = cellPool(mesh, FLOWERS.cell, FLOWERS.radius, FLOWERS.per, fill);
    scene.add(mesh);
  }

  // ---------------------------------------------------------------- trail furniture
  function posts(scene) {
    const tr = Terrain.trail, list = [];
    for (let s = 20, k = 0; s < tr.len - 10; s += 26, k++) {
      const p = tr.at(s), side = k % 2 ? 1 : -1;
      const x = p.x - p.dz * side * (Terrain.TR_HW + 1.4), z = p.z + p.dx * side * (Terrain.TR_HW + 1.4);
      if (Math.hypot(x - Terrain.fest.x, z - Terrain.fest.z) < 70) continue;
      list.push([x, Terrain.height(x, z), z]);
    }
    const geo = U.paint(new THREE.CylinderGeometry(0.06, 0.07, 1.1, 6).translate(0, 0.55, 0), (x, y) => (y > 0.82 && y < 0.98 ? U.lin(0xff6a00) : U.lin(0xf2f2f2)));
    const im = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 }), list.length);
    const d = new THREE.Object3D();
    list.forEach(([x, y, z], i) => { d.position.set(x, y - 0.05, z); d.updateMatrix(); im.setMatrixAt(i, d.matrix); });
    im.computeBoundingSphere();
    im.castShadow = true;
    scene.add(im);
  }

  function ramps(scene) {
    const mat = new THREE.MeshStandardMaterial({ map: W.tex.dirt_a, roughness: 0.95, side: THREE.DoubleSide, color: 0xd8c8b4 });
    const stripe = U.canvasTex(256, 32, (g, w, h) => { for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f5f5f5' : '#e8231e'; g.fillRect((i * w) / 8, 0, w / 8, h); } });
    for (const r of Terrain.ramps) {
      const pos = [], uv = [], hw = r.wid / 2, steps = 14;
      const yAt = u => r.base + r.slope * Math.min(u, r.len) + (u <= r.len ? r.hgt * Math.pow(u / r.len, 1.5) : r.hgt * (1 - (u - r.len) / r.back));
      const us = [];
      for (let k = 0; k <= steps; k++) us.push((k / steps) * r.len);
      us.push(r.len + r.back);
      const bot = r.base - 1.2;
      const quad = (a, b, c, d) => {
        for (const v of [a, c, b, b, c, d]) { pos.push(...v); uv.push((v[0] + v[1] * (Math.abs(v[0]) > hw - 0.01 ? 1 : 0)) / 3.4, v[2] / 3.4); }
      };
      for (let k = 0; k < us.length - 1; k++) {
        const u0 = us[k], u1 = us[k + 1], y0 = yAt(u0), y1 = yAt(u1);
        quad([-hw, y0, u0], [hw, y0, u0], [-hw, y1, u1], [hw, y1, u1]);
        quad([-hw, bot, u0], [-hw, y0, u0], [-hw, bot, u1], [-hw, y1, u1]);
        quad([hw, y0, u0], [hw, bot, u0], [hw, y1, u1], [hw, bot, u1]);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.computeVertexNormals();
      const grp = new THREE.Group();
      grp.position.set(r.x, 0, r.z);
      grp.rotation.y = Math.atan2(r.dx, r.dz);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = true; m.receiveShadow = true;
      grp.add(m);
      const lip = new THREE.Mesh(new THREE.BoxGeometry(r.wid + 0.1, 0.08, 0.35), new THREE.MeshStandardMaterial({ map: stripe, roughness: 0.6 }));
      lip.position.set(0, yAt(r.len) - 0.02, r.len - 0.18);
      grp.add(lip);
      scene.add(grp);
      if (r.danger) dangerSign(scene, r);
    }
  }
  const signBoard = (draw, cw, ch) => new THREE.MeshStandardMaterial({ map: U.canvasTex(cw, ch, draw), roughness: 0.6 });
  function dangerSign(scene, r) {
    const back = 18;
    const x = r.x - r.dx * back - r.dz * (Terrain.TR_HW + 2.5), z = r.z - r.dz * back + r.dx * (Terrain.TR_HW + 2.5);
    const grp = new THREE.Group();
    grp.position.set(x, Terrain.height(x, z), z);
    grp.rotation.y = Math.atan2(r.dx, r.dz) + Math.PI;
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 3.2, 8), new THREE.MeshStandardMaterial({ color: 0x777777, metalness: 0.7, roughness: 0.4 }));
    pole.position.y = 1.6; grp.add(pole);
    const mat = signBoard((g, w, h) => {
      g.translate(w / 2, h / 2); g.rotate(Math.PI / 4);
      g.fillStyle = '#111'; g.fillRect(-88, -88, 176, 176);
      g.fillStyle = '#ffcc00'; g.fillRect(-80, -80, 160, 160);
      g.rotate(-Math.PI / 4);
      g.fillStyle = '#111'; g.font = 'bold 54px "Microsoft YaHei", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('飞跃', 0, 22);
      g.beginPath(); g.moveTo(-50, -18); g.quadraticCurveTo(0, -78, 50, -18); g.lineWidth = 9; g.stroke();
      g.beginPath(); g.moveTo(50, -18); g.lineTo(32, -30); g.lineTo(52, -42); g.fill();
    }, 256, 256);
    mat.alphaTest = 0.5;
    const board = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4), mat);
    board.position.y = 3.4; grp.add(board);
    scene.add(grp);
  }
  function speedTrapGate(scene) {
    const st = Terrain.speedTrap, hw = Terrain.TR_HW + 2;
    const grp = new THREE.Group();
    grp.position.set(st.x, st.y, st.z);
    grp.rotation.y = Math.atan2(st.dx, st.dz);
    const poleM = new THREE.MeshStandardMaterial({ color: 0x23262b, metalness: 0.6, roughness: 0.4 });
    for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 6, 0.3), poleM); p.position.set(sx * hw, 3, 0); grp.add(p); }
    const mat = signBoard((g, w, h) => {
      const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, '#1a6dff'); gr.addColorStop(1, '#00c8ff');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
      g.fillStyle = '#fff'; g.font = 'bold 80px "Microsoft YaHei", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText('测速区  SPEED TRAP', w / 2, h / 2 + 4);
    }, 1024, 128);
    mat.emissive = new THREE.Color(0xffffff); mat.emissiveMap = mat.map; mat.emissiveIntensity = 0.4;
    for (const ry of [0, Math.PI]) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2 + 0.4, 1.1), mat);
      b.position.set(0, 5.6, ry ? 0.16 : -0.16); b.rotation.y = ry; grp.add(b);
    }
    const bar = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 0.6, 1.2, 0.3), poleM); bar.position.y = 5.6; grp.add(bar);
    grp.traverse(o => { if (o.isMesh) o.castShadow = true; });
    scene.add(grp);
    for (const sx of [-1, 1]) W.addObstacle({ kind: 'cyl', x: st.x - st.dz * sx * hw, z: st.z + st.dx * sx * hw, r: 0.25, y0: st.y - 1, y1: st.y + 6 });
  }

  // ---------------------------------------------------------------- festival
  W.label = (text, opt = {}) => {
    const size = opt.size || 1, font = opt.font || 'bold 64px "Microsoft YaHei", sans-serif';
    const cv = document.createElement('canvas'), g = cv.getContext('2d');
    g.font = font;
    const w = Math.ceil(g.measureText(text).width) + 48, h = 96;
    cv.width = w; cv.height = h;
    g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (opt.bg !== false) { g.fillStyle = opt.bg || 'rgba(10,12,20,0.55)'; g.beginPath(); g.roundRect(0, 0, w, h, 20); g.fill(); }
    g.fillStyle = opt.color || '#fff';
    g.fillText(text, w / 2, h / 2 + 3);
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false, fog: true }));
    s.scale.set((w / h) * size, size, 1);
    return s;
  };
  const bannerTex = (title, sub) => U.canvasTex(1024, 192, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, w, 0);
    gr.addColorStop(0, '#ff2d8a'); gr.addColorStop(0.5, '#9b5cff'); gr.addColorStop(1, '#2de2ff');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255,255,255,0.15)';
    for (let i = 0; i < 40; i++) g.fillRect(i * 28 - 20, 0, 10, h);
    g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.font = 'italic bold 96px "Microsoft YaHei", sans-serif'; g.fillText(title, w / 2, h * 0.42);
    g.font = 'bold 34px "Microsoft YaHei", sans-serif'; g.fillText(sub, w / 2, h * 0.82);
  });
  function festival(scene) {
    const fest = new THREE.Group();
    const tr = Terrain.trail, p0 = tr.at(0);
    const lx = -p0.dz, lz = p0.dx;     // right of the driving direction
    const yaw = Math.atan2(-lz, lx);   // rotation that maps local +x onto (lx, lz)
    const hw = Terrain.TR_HW + 2.6;
    const arch = new THREE.Group();
    arch.position.set(p0.x, Terrain.height(p0.x, p0.z), p0.z);
    arch.rotation.y = yaw;
    const dark = new THREE.MeshStandardMaterial({ color: 0x1d1f26, roughness: 0.45, metalness: 0.5 });
    for (const sx of [-1, 1]) {
      const pil = new THREE.Mesh(U.roundBox(1.2, 9, 1.2, 0.15), dark); pil.position.set(sx * hw, 4.5, 0); arch.add(pil);
      const glow = new THREE.Mesh(new THREE.BoxGeometry(0.15, 8.6, 1.25), new THREE.MeshStandardMaterial({ color: 0x000000, emissive: sx < 0 ? 0xff2d8a : 0x2de2ff, emissiveIntensity: 3 }));
      glow.position.set(sx * (hw - 0.62), 4.5, 0); arch.add(glow);
      W.addObstacle({ kind: 'cyl', x: p0.x + lx * sx * hw, z: p0.z + lz * sx * hw, r: 0.8, y0: arch.position.y - 1, y1: arch.position.y + 9 });
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(hw * 2 + 1.2, 2.0, 0.9), dark); beam.position.y = 8.2; arch.add(beam);
    const bt = bannerTex('荒原嘉年华', 'WILDLAND FESTIVAL · 起点 / 终点');
    for (const sz of [-1, 1]) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2 + 1, 1.85), new THREE.MeshStandardMaterial({ map: bt, emissive: 0xffffff, emissiveMap: bt, emissiveIntensity: 0.6, roughness: 0.5 }));
      b.position.set(0, 8.2, sz * 0.46); if (sz < 0) b.rotation.y = Math.PI; arch.add(b);
    }
    const chk = U.canvasTex(512, 64, (g, w, h) => { for (let i = 0; i < 32; i++) for (let j = 0; j < 4; j++) { g.fillStyle = (i + j) % 2 ? '#111' : '#f5f5f5'; g.fillRect((i * w) / 32, (j * h) / 4, w / 32, h / 4); } });
    const line = new THREE.Mesh(new THREE.PlaneGeometry(hw * 2, 1.2), new THREE.MeshStandardMaterial({ map: chk, roughness: 0.8, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.rotation.x = -Math.PI / 2; line.position.y = 0.06; arch.add(line);
    arch.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    fest.add(arch);

    // feather flags along the trail
    const flagGeo = new THREE.PlaneGeometry(0.9, 3.0, 1, 6);
    {
      const p = flagGeo.attributes.position;
      for (let i = 0; i < p.count; i++) { const y = p.getY(i); p.setX(i, p.getX(i) + 0.45 + Math.sin((y + 1.5) * 0.9) * 0.15); p.setZ(i, Math.sin((y + 1.5) * 1.3) * 0.12); }
      flagGeo.computeVertexNormals();
    }
    const poleGeo = new THREE.CylinderGeometry(0.04, 0.05, 5, 6);
    const poleMat = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.7, roughness: 0.3 });
    const flagMats = PAL.map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 0.6, side: THREE.DoubleSide, emissive: c, emissiveIntensity: 0.12 }));
    let fi = 0;
    for (let s = -90; s <= 90; s += 11) {
      if (Math.abs(s) < 6) continue;
      const p = tr.at(s);
      for (const side of [-1, 1]) {
        const x = p.x - p.dz * side * (hw + 1.2), z = p.z + p.dx * side * (hw + 1.2), y = Terrain.height(x, z);
        const pole = new THREE.Mesh(poleGeo, poleMat); pole.position.set(x, y + 2.5, z); pole.castShadow = true; fest.add(pole);
        const fl = new THREE.Mesh(flagGeo, flagMats[fi++ % flagMats.length]);
        fl.position.set(x, y + 3.3, z); fl.rotation.y = Math.atan2(p.dx, p.dz) + Math.PI / 2 + side * 0.4; fl.castShadow = true;
        fest.add(fl);
      }
    }

    // tents, stage and parked ATVs on the plateau beside the trail
    const tentTex = c => U.canvasTex(256, 128, (g, w, h) => { for (let i = 0; i < 8; i++) { g.fillStyle = i % 2 ? '#f6f6f6' : c; g.fillRect((i * w) / 8, 0, w / 8, h); } });
    const tents = [[25, 1, 18], [45, 1, 16], [-20, 1, 17], [-42, 1, 20], [20, -1, 22], [-28, -1, 21]];
    tents.forEach(([s, side, off], i) => {
      const p = tr.at(s);
      const x = p.x - p.dz * side * (hw + off), z = p.z + p.dx * side * (hw + off), y = Terrain.height(x, z);
      const c = '#' + new THREE.Color(PAL[i % PAL.length]).getHexString();
      const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = Math.atan2(p.dx, p.dz);
      const body = new THREE.Mesh(new THREE.BoxGeometry(5, 2.6, 5), new THREE.MeshStandardMaterial({ map: tentTex(c), roughness: 0.7 }));
      body.position.y = 1.3; g.add(body);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(4.2, 2.4, 4), new THREE.MeshStandardMaterial({ color: PAL[i % PAL.length], roughness: 0.6 }));
      roof.position.y = 3.8; roof.rotation.y = Math.PI / 4; g.add(roof);
      g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      fest.add(g);
      W.addObstacle({ kind: 'cyl', x, z, r: 3.2, y0: y - 1, y1: y + 5 });
    });
    {
      const p = tr.at(5), side = 1, off = 48;
      const x = p.x - p.dz * side * (hw + off), z = p.z + p.dx * side * (hw + off), y = Terrain.height(x, z);
      const g = new THREE.Group(); g.position.set(x, y, z); g.rotation.y = Math.atan2(-p.dz * side, p.dx * side) + Math.PI;
      const plat = new THREE.Mesh(new THREE.BoxGeometry(16, 1.4, 9), dark); plat.position.y = 0.7; g.add(plat);
      const screenT = bannerTex('荒原嘉年华', '越野 · 音乐 · 狂欢');
      const scr = new THREE.Mesh(new THREE.PlaneGeometry(13, 3.4), new THREE.MeshStandardMaterial({ map: screenT, emissive: 0xffffff, emissiveMap: screenT, emissiveIntensity: 1.2 }));
      scr.position.set(0, 6.2, -3.9); g.add(scr);
      const truss = new THREE.MeshStandardMaterial({ color: 0xb8bcc4, metalness: 0.8, roughness: 0.3 });
      for (const sx of [-7.5, 7.5]) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.5, 9, 0.5), truss); t.position.set(sx, 4.5, -4); g.add(t);
        const sp = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3.2, 1.4), dark); sp.position.set(sx * 1.12, 3.0, 0); g.add(sp);
      }
      const top = new THREE.Mesh(new THREE.BoxGeometry(16, 0.5, 0.5), truss); top.position.set(0, 9, -4); g.add(top);
      for (let i = 0; i < 6; i++) {
        const c = PAL[i % PAL.length];
        const l = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.28, 0.5, 10), new THREE.MeshStandardMaterial({ color: 0x111111, emissive: c, emissiveIntensity: 4 }));
        l.position.set(-6 + i * 2.4, 8.6, -3.7); l.rotation.x = 0.6; g.add(l);
      }
      g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      fest.add(g);
      for (const k of [-6, -2, 2, 6]) W.addObstacle({ kind: 'cyl', x: x + Math.cos(g.rotation.y) * k, z: z - Math.sin(g.rotation.y) * k, r: 3, y0: y - 1, y1: y + 10 });
    }
    const parkedCols = [[0x2de2ff, 0xff2d8a], [0xffc83d, 0x2d5cff], [0x3dff9e, 0xffffff], [0x9b5cff, 0xffc83d]];
    parkedCols.forEach(([paint, jersey], i) => {
      const p = tr.at(-30 + i * 4.5), side = -1;
      const x = p.x - p.dz * side * (hw + 6), z = p.z + p.dx * side * (hw + 6);
      const a = ATV.parked({ paint, jersey, rider: false, steer: 0.2 });
      a.position.set(x, Terrain.height(x, z) + 0.68, z);
      a.rotation.y = Vehicle.Car.yawFromDir(p.dz * side, -p.dx * side);
      fest.add(a);
      W.addObstacle({ kind: 'cyl', x, z, r: 1.1, y0: a.position.y - 1, y1: a.position.y + 1 });
    });
    scene.add(U.bake(fest, true));

    // event marker for the race, ahead of the start line on the left
    const pm = tr.at(22);
    const mx = pm.x + pm.dz * (hw + 7), mz = pm.z - pm.dx * (hw + 7), my = Terrain.height(mx, mz);
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff2d8a).multiplyScalar(2.5), transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.RingGeometry(3.4, 3.9, 64).rotateX(-Math.PI / 2), ringMat);
    ring.position.set(mx, my + 0.12, mz);
    scene.add(ring);
    const col = beamMesh(0xff2d8a, 3.0, 26, 0.16);
    col.position.set(mx, my, mz);
    scene.add(col);
    const lab = W.label('荒原环线赛', { size: 1.5, color: '#fff', bg: 'rgba(255,45,138,0.8)' });
    lab.position.set(mx, my + 5.2, mz);
    scene.add(lab);
    W.raceMarker = { x: mx, z: mz, r: 4.2, ring, ringMat, col, lab };
  }

  // a soft vertical light column; brightness fades with height and towards the edges
  function beamMesh(color, radius, height, strength = 0.5) {
    const g = new THREE.CylinderGeometry(radius, radius, height, 40, 8, true).translate(0, height / 2, 0);
    const c = new THREE.Color(color);
    U.paint(g, (x, y) => { const k = Math.pow(1 - y / height, 2.0) * strength; return [c.r * k, c.g * k, c.b * k]; });
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    m.renderOrder = 5;
    return m;
  }
  W.beamMesh = beamMesh;

  W.makeGate = (p, n) => {
    const g = new THREE.Group();
    const hw = Terrain.TR_HW + 2.4, y = Terrain.height(p.x, p.z);
    g.position.set(p.x, y, p.z);
    g.rotation.y = Math.atan2(p.dx, p.dz);
    const poleGeo = U.paint(new THREE.CylinderGeometry(0.13, 0.15, 5.5, 8).translate(0, 2.75, 0), (x, yy) => (Math.floor(yy / 0.55) % 2 ? U.lin(0xff7a1a) : U.lin(0xf5f5f5)));
    const pm = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5 });
    const fm = new THREE.MeshStandardMaterial({ color: 0x2de2ff, emissive: 0x2de2ff, emissiveIntensity: 0.6, side: THREE.DoubleSide });
    for (const sx of [-1, 1]) {
      const pole = new THREE.Mesh(poleGeo, pm); pole.position.x = sx * hw; pole.castShadow = true; g.add(pole);
      const fl = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 0.9), fm); fl.position.set(sx * hw - sx * 0.68, 5.0, 0); g.add(fl);
    }
    const lab = W.label(String(n), { size: 1.3, bg: 'rgba(45,226,255,0.85)', color: '#06202a' });
    lab.position.y = 6.6;
    g.add(lab);
    g.userData.flagMat = fm;
    return g;
  };

  // ---------------------------------------------------------------- build / update
  W.build = (scene, renderer, T) => {
    W.sky = new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), skyMaterial(false));
    W.sky.frustumCulled = false;
    W.sky.renderOrder = -10;
    scene.add(W.sky);
    environment(renderer, scene);
    lights(scene);
    W.terrainMat = terrainMaterial(T);
    Terrain.initMeshes(scene, W.terrainMat);
    water(scene, T);
    scatter(scene, T, renderer);
    grassInit(scene);
    flowersInit(scene, T);
    posts(scene);
    ramps(scene);
    speedTrapGate(scene);
    festival(scene);
  };
  W.update = (dt, focus, camera) => {
    W.time += dt;
    W.uTime.value = W.time;
    if (W.waterMat) W.waterMat.uniforms.uTime.value = W.time;
    W.sky.position.copy(camera.position);
    const fx = Math.round(focus.x), fy = Math.round(focus.y), fz = Math.round(focus.z);
    W.sun.position.set(fx + SUN_DIR.x * 250, fy + SUN_DIR.y * 250, fz + SUN_DIR.z * 250);
    W.sun.target.position.set(fx, fy, fz);
    W.sun.target.updateMatrixWorld();
    // full trees in regions near the camera, billboards elsewhere; rocks only nearby
    for (const R of W.vegRegions) {
      const dx = Math.max(Math.abs(camera.position.x - R.x) - 128, 0), dz = Math.max(Math.abs(camera.position.z - R.z) - 128, 0);
      const d = Math.hypot(dx, dz), near = d < 160;
      for (const im of R.full) im.visible = near;
      for (const im of R.imp) im.visible = !near;
      for (const im of R.rocks) im.visible = d < 300;
    }
    W.updateCasters(focus.x, focus.z);
    W.grass.update(focus.x, focus.z, false);
    W.flowers.update(focus.x, focus.z, false);
    const rm = W.raceMarker;
    if (rm) {
      const k = 0.75 + 0.25 * Math.sin(W.time * 3);
      rm.ringMat.opacity = k;
      rm.ring.scale.setScalar(1 + 0.04 * Math.sin(W.time * 3));
    }
  };
  const shadowCam = new THREE.OrthographicCamera(-0.01, 0.01, 0.01, -0.01, 0.1, 0.2);
  shadowCam.position.set(0, -20000, 0);
  shadowCam.layers.enable(1);
  const shadowRT = new THREE.WebGLRenderTarget(1, 1);
  W.renderShadows = (renderer, scene) => {
    const hidden = [];
    for (const o of scene.children) if (o.visible && o.frustumCulled === false && !o.castShadow) { o.visible = false; hidden.push(o); }
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
    renderer.setRenderTarget(shadowRT);
    renderer.render(scene, shadowCam);
    renderer.setRenderTarget(null);
    for (const o of hidden) o.visible = true;
  };
  W.grassRefresh = p => { W.grass.update(p.x, p.z, true); W.flowers.update(p.x, p.z, true); };

  return W;
})();
