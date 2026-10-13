'use strict';
// WebAudio synthesis: engine (two oscillators and filtered noise), wind, tyre rumble and one-shots.

const Sfx = (() => {
  const S = { ctx: null, mute: false, ready: false };
  let master, o1, o2, engF, engG, engNoiseG, windG, windF, rumbleG, noiseBuf;
  const VOL = 0.6;

  S.unlock = () => {
    if (S.ctx) { if (S.ctx.state === 'suspended') S.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = (S.ctx = new AC());
    const comp = ctx.createDynamicsCompressor();
    comp.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = S.mute ? 0 : VOL;
    master.connect(comp);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const noise = () => { const s = ctx.createBufferSource(); s.buffer = noiseBuf; s.loop = true; s.start(); return s; };

    engF = ctx.createBiquadFilter(); engF.type = 'lowpass'; engF.frequency.value = 700; engF.Q.value = 2.2;
    engG = ctx.createGain(); engG.gain.value = 0;
    o1 = ctx.createOscillator(); o1.type = 'sawtooth';
    o2 = ctx.createOscillator(); o2.type = 'square';
    const g1 = ctx.createGain(); g1.gain.value = 0.5;
    const g2 = ctx.createGain(); g2.gain.value = 0.28;
    o1.connect(g1).connect(engF);
    o2.connect(g2).connect(engF);
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 900; nf.Q.value = 0.8;
    engNoiseG = ctx.createGain(); engNoiseG.gain.value = 0;
    noise().connect(nf).connect(engNoiseG).connect(engF);
    engF.connect(engG).connect(master);
    o1.start(); o2.start();

    windF = ctx.createBiquadFilter(); windF.type = 'bandpass'; windF.frequency.value = 500; windF.Q.value = 0.6;
    windG = ctx.createGain(); windG.gain.value = 0;
    noise().connect(windF).connect(windG).connect(master);

    const rf = ctx.createBiquadFilter(); rf.type = 'lowpass'; rf.frequency.value = 170;
    rumbleG = ctx.createGain(); rumbleG.gain.value = 0;
    noise().connect(rf).connect(rumbleG).connect(master);
    S.ready = true;
  };

  S.setMute = m => {
    S.mute = m;
    if (master) master.gain.setTargetAtTime(m ? 0 : VOL, S.ctx.currentTime, 0.05);
  };

  S.update = (car, active) => {
    if (!S.ready) return;
    const t = S.ctx.currentTime;
    const rpm = car.rpm, thr = car.throttle, sp = car.speed;
    const f = 22 + (rpm / 60) * 0.75;
    o1.frequency.setTargetAtTime(f, t, 0.03);
    o2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    engF.frequency.setTargetAtTime(280 + rpm * 0.17 + thr * 900, t, 0.05);
    engG.gain.setTargetAtTime(active ? 0.1 + thr * 0.1 + (rpm / 9000) * 0.06 : 0, t, 0.05);
    engNoiseG.gain.setTargetAtTime(active ? thr * 0.35 : 0, t, 0.05);
    windG.gain.setTargetAtTime(active ? Math.min(0.25, (sp / 30) ** 2 * 0.22) : 0, t, 0.1);
    windF.frequency.setTargetAtTime(400 + sp * 25, t, 0.1);
    rumbleG.gain.setTargetAtTime(active && car.grounded ? Math.min(0.35, (sp / 25) * 0.3) : 0, t, 0.05);
  };

  S.play = (name, v = 1) => {
    if (!S.ready || S.mute) return;
    const ctx = S.ctx, t = ctx.currentTime;
    const tone = (freq, type, peak, a, d, when = 0, slide = 0) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t + when);
      if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + when + a + d);
      g.gain.setValueAtTime(0.0001, t + when);
      g.gain.exponentialRampToValueAtTime(peak, t + when + a);
      g.gain.exponentialRampToValueAtTime(0.0001, t + when + a + d);
      o.connect(g).connect(master);
      o.start(t + when); o.stop(t + when + a + d + 0.05);
    };
    const burst = (freq, q, peak, d, type = 'lowpass') => {
      const s = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
      s.buffer = noiseBuf; f.type = type; f.frequency.value = freq; f.Q.value = q;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.005 + d);
      s.connect(f).connect(g).connect(master);
      s.start(t, Math.random()); s.stop(t + d + 0.1);
    };
    v = U.clamp(v, 0.05, 1);
    switch (name) {
      case 'land': burst(320, 0.7, 0.55 * v, 0.35); tone(72, 'sine', 0.5 * v, 0.005, 0.25, 0, 40); break;
      case 'hit': burst(900, 0.8, 0.6 * v, 0.25, 'bandpass'); tone(90, 'triangle', 0.4 * v, 0.003, 0.3, 0, 50); break;
      case 'checkpoint': tone(880, 'sine', 0.25, 0.01, 0.25); tone(1320, 'sine', 0.22, 0.01, 0.35, 0.09); break;
      case 'skill': tone(660, 'triangle', 0.15, 0.01, 0.15); tone(990, 'triangle', 0.13, 0.01, 0.2, 0.06); break;
      case 'bank': [523, 659, 784, 1046].forEach((f, i) => tone(f, 'triangle', 0.17, 0.01, 0.3, i * 0.07)); break;
      case 'lost': tone(320, 'sawtooth', 0.12, 0.01, 0.4, 0, 110); break;
      case 'count': tone(600, 'square', 0.12, 0.005, 0.18); break;
      case 'go': tone(1200, 'square', 0.14, 0.005, 0.5); break;
      case 'finish': [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 'triangle', 0.2, 0.01, 0.45, i * 0.09)); break;
      case 'shift': burst(2400, 1.2, 0.05, 0.06, 'bandpass'); break;
      case 'splash': burst(1500, 0.5, 0.35 * v, 0.5, 'highpass'); break;
      case 'trap': tone(1500, 'sine', 0.2, 0.005, 0.12); tone(1500, 'sine', 0.2, 0.005, 0.12, 0.15); break;
    }
  };

  return S;
})();
