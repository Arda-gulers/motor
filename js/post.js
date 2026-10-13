'use strict';
// HDR post-processing: the scene renders into a multisampled half-float target; a bloom chain
// (soft threshold, dual-filter downsample, tent upsample) feeds one final pass that applies
// exposure, ACES tone mapping, colour grading, vignette, sRGB encoding and dither.

const Post = (() => {
  const P = {
    scale: 0.8, exposure: 1.0, bloom: 0.05, threshold: 1.4, knee: 0.7, saturation: 1.08, contrast: 1.07, vignette: 0.32,
    lift: new THREE.Vector3(0.004, 0.008, 0.02), gain: new THREE.Vector3(1.03, 1.0, 0.96),
  };
  const LEVELS = 6;
  let rt, mips = [], fsScene, fsCam, quad, mPre, mDown, mUp, mFinal;
  const VS = 'varying vec2 vUv; void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }';
  const mat = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial(Object.assign({
    uniforms, vertexShader: VS, fragmentShader: frag, depthTest: false, depthWrite: false, toneMapped: false,
  }, extra));

  P.init = renderer => {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    fsScene = new THREE.Scene();
    fsCam = new THREE.Camera();
    quad = new THREE.Mesh(geo);
    quad.frustumCulled = false;
    fsScene.add(quad);
    rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    for (let i = 0; i < LEVELS; i++) mips.push(new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false }));
    const src = () => ({ tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    mPre = mat(`uniform sampler2D tSrc; uniform vec2 uTexel; uniform float uThreshold, uKnee; varying vec2 vUv;
      // half-float overflow writes Inf (sharp clear-coat sun glints); clamp each tap and drop NaN so one
      // bad pixel cannot spread through the whole bloom chain
      vec3 tap(vec2 uv) { vec3 c = texture2D(tSrc, uv).rgb; return any(isnan(c)) ? vec3(0.0) : min(c, vec3(40.0)); }
      void main() {
        vec3 c = tap(vUv + uTexel * vec2(-1.0, -1.0)) + tap(vUv + uTexel * vec2(1.0, -1.0))
               + tap(vUv + uTexel * vec2(-1.0, 1.0)) + tap(vUv + uTexel * vec2(1.0, 1.0));
        c *= 0.25;
        float br = max(c.r, max(c.g, c.b));
        float rq = clamp(br - uThreshold + uKnee, 0.0, 2.0 * uKnee);
        rq = rq * rq / (4.0 * uKnee + 1e-4);
        gl_FragColor = vec4(c * max(rq, br - uThreshold) / max(br, 1e-4), 1.0);
      }`, Object.assign(src(), { uThreshold: { value: P.threshold }, uKnee: { value: P.knee } }));
    mDown = mat(`uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
      void main() {
        vec3 c = texture2D(tSrc, vUv).rgb * 4.0;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, -1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, -1.0)).rgb;
        c += texture2D(tSrc, vUv + uTexel * vec2(-1.0, 1.0)).rgb + texture2D(tSrc, vUv + uTexel * vec2(1.0, 1.0)).rgb;
        gl_FragColor = vec4(c / 8.0, 1.0);
      }`, src());
    mUp = mat(`uniform sampler2D tSrc; uniform vec2 uTexel; varying vec2 vUv;
      void main() {
        vec2 t = uTexel;
        vec3 c = texture2D(tSrc, vUv + vec2(-t.x, -t.y)).rgb + 2.0 * texture2D(tSrc, vUv + vec2(0.0, -t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, -t.y)).rgb
               + 2.0 * texture2D(tSrc, vUv + vec2(-t.x, 0.0)).rgb + 4.0 * texture2D(tSrc, vUv).rgb + 2.0 * texture2D(tSrc, vUv + vec2(t.x, 0.0)).rgb
               + texture2D(tSrc, vUv + vec2(-t.x, t.y)).rgb + 2.0 * texture2D(tSrc, vUv + vec2(0.0, t.y)).rgb + texture2D(tSrc, vUv + vec2(t.x, t.y)).rgb;
        gl_FragColor = vec4(c / 16.0, 1.0);
      }`, src(), { blending: THREE.AdditiveBlending });
    mFinal = mat(`uniform sampler2D tScene, tBloom; uniform float uExposure, uBloom, uSat, uContrast, uVignette; uniform vec3 uLift, uGain; uniform vec2 uPx; varying vec2 vUv;
      vec3 scn(vec2 uv) { vec3 c = texture2D(tScene, uv).rgb; return any(isnan(c)) ? vec3(0.0) : min(c, vec3(64.0)); }
      float lum(vec3 c) { c = c / (1.0 + c); return dot(c, vec3(0.299, 0.587, 0.114)); }
      // FXAA (console variant) on the HDR scene, edge detection on compressed luminance
      vec3 fxaa(vec2 uv) {
        vec3 m = scn(uv), nw = scn(uv + vec2(-1.0, -1.0) * uPx), ne = scn(uv + vec2(1.0, -1.0) * uPx);
        vec3 sw = scn(uv + vec2(-1.0, 1.0) * uPx), se = scn(uv + vec2(1.0, 1.0) * uPx);
        float lm = lum(m), lnw = lum(nw), lne = lum(ne), lsw = lum(sw), lse = lum(se);
        float lmin = min(lm, min(min(lnw, lne), min(lsw, lse))), lmax = max(lm, max(max(lnw, lne), max(lsw, lse)));
        if (lmax - lmin < max(0.04, lmax * 0.12)) return m;
        vec2 dir = vec2(-((lnw + lne) - (lsw + lse)), (lnw + lsw) - (lne + lse));
        float red = max((lnw + lne + lsw + lse) * 0.03125, 1.0 / 128.0);
        dir = clamp(dir / (min(abs(dir.x), abs(dir.y)) + red), vec2(-8.0), vec2(8.0)) * uPx;
        vec3 a = 0.5 * (scn(uv + dir * (1.0 / 3.0 - 0.5)) + scn(uv + dir * (2.0 / 3.0 - 0.5)));
        vec3 b = a * 0.5 + 0.25 * (scn(uv - dir * 0.5) + scn(uv + dir * 0.5));
        float lb = lum(b);
        return (lb < lmin || lb > lmax) ? a : b;
      }
      vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
      vec3 toSRGB(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
      void main() {
        vec3 c = fxaa(vUv) + texture2D(tBloom, vUv).rgb * uBloom;
        c = aces(c * uExposure);
        float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
        c = max(mix(vec3(l), c, uSat), 0.0);
        c = pow(c / 0.18, vec3(uContrast)) * 0.18;
        c = c * uGain + uLift * (1.0 - c);
        vec2 q = vUv - 0.5;
        c *= clamp(1.0 - dot(q, q) * uVignette * 2.2, 0.0, 1.0);
        c = toSRGB(clamp(c, 0.0, 1.0));
        float n = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453);
        gl_FragColor = vec4(c + (n - 0.5) / 255.0, 1.0);
      }`, {
      tScene: { value: null }, tBloom: { value: null }, uExposure: { value: 1 }, uBloom: { value: 1 }, uSat: { value: 1 }, uContrast: { value: 1 },
      uVignette: { value: 0 }, uLift: { value: P.lift }, uGain: { value: P.gain }, uPx: { value: new THREE.Vector2() },
    });
  };

  // the scene renders at `scale` of the canvas; the final pass upsamples to full size
  let fullW = 4, fullH = 4;
  P.setSize = (w, h) => {
    fullW = w; fullH = h;
    const sw = Math.max(1, Math.round(w * P.scale)), sh = Math.max(1, Math.round(h * P.scale));
    rt.setSize(sw, sh);
    mips.forEach((m, i) => m.setSize(Math.max(1, sw >> (i + 1)), Math.max(1, sh >> (i + 1))));
  };
  P.setScale = s => {
    s = U.clamp(s, 0.5, 1);
    if (Math.abs(s - P.scale) < 0.02) return;
    P.scale = s;
    P.setSize(fullW, fullH);
  };

  function pass(renderer, m, src, dst, clear) {
    if (m.uniforms.tSrc) {
      m.uniforms.tSrc.value = src.texture;
      m.uniforms.uTexel.value.set(1 / src.width, 1 / src.height);
    }
    quad.material = m;
    renderer.setRenderTarget(dst);
    if (clear) renderer.clear();
    renderer.render(fsScene, fsCam);
  }

  P.render = (renderer, scene, camera) => {
    renderer.info.autoReset = false;
    renderer.info.reset();
    renderer.setRenderTarget(rt);
    renderer.render(scene, camera);
    const auto = renderer.autoClear;
    renderer.autoClear = false;
    mPre.uniforms.uThreshold.value = P.threshold;
    mPre.uniforms.uKnee.value = P.knee;
    pass(renderer, mPre, rt, mips[0], true);
    for (let i = 0; i < LEVELS - 1; i++) pass(renderer, mDown, mips[i], mips[i + 1], true);
    for (let i = LEVELS - 2; i >= 0; i--) pass(renderer, mUp, mips[i + 1], mips[i], false);
    const u = mFinal.uniforms;
    u.tScene.value = rt.texture; u.tBloom.value = mips[0].texture;
    u.uPx.value.set(1 / rt.width, 1 / rt.height);
    u.uExposure.value = P.exposure; u.uBloom.value = P.bloom; u.uSat.value = P.saturation; u.uContrast.value = P.contrast; u.uVignette.value = P.vignette;
    quad.material = mFinal;
    renderer.setRenderTarget(null);
    renderer.render(fsScene, fsCam);
    renderer.autoClear = auto;
  };

  return P;
})();
