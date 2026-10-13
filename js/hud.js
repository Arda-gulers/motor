'use strict';
// HUD: speedometer, rotating minimap, skill chain, race panel, toasts, centre messages and overlays.

const HUD = (() => {
  const H = { toasts: [], centerT: 0 };
  const $ = id => document.getElementById(id);

  H.init = mapCanvas => {
    H.sp = $('speedo').getContext('2d');
    H.mm = $('minimap').getContext('2d');
    H.map = mapCanvas;
    H.el = {
      race: $('race'), raceName: $('raceName'), raceCp: $('raceCp'), raceTime: $('raceTime'), raceBest: $('raceBest'),
      skill: $('skill'), skMult: $('skMult'), skPts: $('skPts'), skList: $('skList'), skBar: $('skBar'),
      total: $('skTotal'), toasts: $('toasts'), center: $('center'), prompt: $('prompt'),
    };
  };

  H.show = (id, on) => $(id).classList.toggle('hidden', !on);

  // ---------------------------------------------------------------- speedometer
  H.speedo = car => {
    const g = H.sp, W = 440, cx = 220, cy = 220;
    g.clearRect(0, 0, W, W);
    const kmh = Math.abs(car.vf) * 3.6, MAX = 140;
    const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;
    const bg = g.createRadialGradient(cx, cy, 40, cx, cy, 210);
    bg.addColorStop(0, 'rgba(8,10,20,0.75)'); bg.addColorStop(1, 'rgba(8,10,20,0.15)');
    g.fillStyle = bg; g.beginPath(); g.arc(cx, cy, 205, 0, Math.PI * 2); g.fill();
    g.lineCap = 'round';
    g.lineWidth = 16; g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.beginPath(); g.arc(cx, cy, 178, a0, a0 + sweep); g.stroke();
    const f = U.clamp(kmh / MAX, 0, 1);
    if (f > 0.002) {
      const gr = g.createLinearGradient(40, 400, 400, 40);
      gr.addColorStop(0, '#2de2ff'); gr.addColorStop(0.6, '#9b5cff'); gr.addColorStop(1, '#ff2d8a');
      g.strokeStyle = gr; g.shadowColor = '#ff2d8a'; g.shadowBlur = 18;
      g.beginPath(); g.arc(cx, cy, 178, a0, a0 + sweep * f); g.stroke();
      g.shadowBlur = 0;
    }
    g.fillStyle = 'rgba(255,255,255,0.75)'; g.font = 'bold 22px "Microsoft YaHei", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    for (let v = 0; v <= MAX; v += 10) {
      const a = a0 + (v / MAX) * sweep, major = v % 20 === 0;
      const r1 = 158, r2 = major ? 142 : 150;
      g.strokeStyle = major ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)'; g.lineWidth = major ? 4 : 2;
      g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
      if (major) g.fillText(v, cx + Math.cos(a) * 122, cy + Math.sin(a) * 122);
    }
    const rf = U.clamp((car.rpm - 800) / 8600, 0, 1);
    g.lineWidth = 7; g.strokeStyle = 'rgba(255,255,255,0.1)';
    g.beginPath(); g.arc(cx, cy, 196, a0, a0 + sweep); g.stroke();
    g.strokeStyle = rf > 0.85 ? '#ff3b3b' : '#ffffff';
    g.beginPath(); g.arc(cx, cy, 196, a0, a0 + sweep * rf); g.stroke();
    g.fillStyle = '#fff'; g.font = 'italic bold 112px "Microsoft YaHei", sans-serif';
    g.fillText(Math.round(kmh), cx, cy + 6);
    g.font = 'bold 24px "Microsoft YaHei", sans-serif'; g.fillStyle = 'rgba(255,255,255,0.7)';
    g.fillText('KM/H', cx, cy + 72);
    const gear = car.vf < -0.5 && car.brakeIn ? 'R' : car.speed < 0.5 && !car.throttle ? 'N' : String(car.gear);
    g.fillStyle = '#ff2d8a'; g.beginPath(); g.arc(cx, cy + 128, 30, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = 'italic bold 38px "Microsoft YaHei", sans-serif'; g.fillText(gear, cx, cy + 130);
  };

  // ---------------------------------------------------------------- minimap
  H.minimap = (car, marks, t) => {
    const g = H.mm, W = 440, c = 220, R = 206, scale = 1.5;   // px per metre
    g.clearRect(0, 0, W, W);
    g.save();
    g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.clip();
    g.fillStyle = '#16261a'; g.fillRect(0, 0, W, W);
    const heading = Math.atan2(car.fwd.x, -car.fwd.z);
    g.translate(c, c);
    g.rotate(-heading);
    g.scale(scale, scale);
    g.translate(-car.pos.x, -car.pos.z);
    g.globalAlpha = 0.95;
    g.drawImage(H.map, -1024, -1024, 2048, 2048);
    g.globalAlpha = 1;
    for (const m of marks) {
      const r = (m.r || 6) / scale * 2;
      if (m.ring) { g.strokeStyle = m.color; g.lineWidth = 3 / scale; g.beginPath(); g.arc(m.x, m.z, r * (1.4 + 0.3 * Math.sin(t * 5)), 0, Math.PI * 2); g.stroke(); }
      g.fillStyle = m.color; g.strokeStyle = '#000'; g.lineWidth = 2 / scale;
      g.beginPath(); g.arc(m.x, m.z, r, 0, Math.PI * 2); g.fill(); g.stroke();
      if (m.text) {
        g.save(); g.translate(m.x, m.z); g.scale(1 / scale, 1 / scale); g.rotate(heading);
        g.fillStyle = '#fff'; g.font = 'bold 20px "Microsoft YaHei", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(m.text, 0, 1);
        g.restore();
      }
    }
    g.restore();
    // edge arrow towards an off-map target
    for (const m of marks) {
      if (!m.edge) continue;
      const dx = m.x - car.pos.x, dz = m.z - car.pos.z, d = Math.hypot(dx, dz);
      if (d * scale < R - 12) continue;
      const a = Math.atan2(dz, dx) - heading;
      const ex = c + Math.cos(a) * (R - 16), ez = c + Math.sin(a) * (R - 16);
      g.fillStyle = m.color; g.beginPath(); g.arc(ex, ez, 11, 0, Math.PI * 2); g.fill();
    }
    g.lineWidth = 6; g.strokeStyle = 'rgba(255,255,255,0.85)'; g.beginPath(); g.arc(c, c, R, 0, Math.PI * 2); g.stroke();
    // north marker
    const na = -heading - Math.PI / 2;
    g.fillStyle = '#ff2d8a'; g.beginPath(); g.arc(c + Math.cos(na) * R, c + Math.sin(na) * R, 17, 0, Math.PI * 2); g.fill();
    g.fillStyle = '#fff'; g.font = 'bold 22px "Microsoft YaHei", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('N', c + Math.cos(na) * R, c + Math.sin(na) * R + 1);
    // player arrow
    g.fillStyle = '#fff'; g.strokeStyle = '#ff2d8a'; g.lineWidth = 4;
    g.beginPath(); g.moveTo(c, c - 20); g.lineTo(c + 13, c + 14); g.lineTo(c, c + 7); g.lineTo(c - 13, c + 14); g.closePath(); g.fill(); g.stroke();
  };

  // ---------------------------------------------------------------- skill chain
  let lastListKey = '';
  H.skill = s => {
    const e = H.el;
    e.total.textContent = U.fmtInt(s.total);
    const on = s.count > 0;
    e.skill.classList.toggle('hidden', !on);
    if (!on) return;
    e.skMult.textContent = 'x' + s.mult;
    e.skPts.textContent = U.fmtInt(s.pts);
    e.skBar.style.width = (U.clamp(s.timer / s.window, 0, 1) * 100).toFixed(1) + '%';
    const key = s.list.map(l => l.name + l.pts).join('|');
    if (key !== lastListKey) {
      lastListKey = key;
      e.skList.innerHTML = s.list.slice(0, 4).map((l, i) => `<div class="sk-item${i === 0 ? ' new' : ''}">${l.name} <b>+${U.fmtInt(l.pts)}</b></div>`).join('');
    }
  };

  // ---------------------------------------------------------------- race panel
  H.race = r => {
    const e = H.el;
    e.race.classList.toggle('hidden', !r);
    if (!r) return;
    e.raceName.textContent = r.name;
    e.raceCp.textContent = r.cp;
    e.raceTime.textContent = U.fmtTime(r.time);
    e.raceBest.textContent = r.best ? '最佳 ' + U.fmtTime(r.best) : '最佳 --:--.--';
  };

  // ---------------------------------------------------------------- toasts and messages
  H.toast = (html, cls = '', life = 3.2) => {
    const d = document.createElement('div');
    d.className = 'toast ' + cls;
    d.innerHTML = html;
    H.el.toasts.prepend(d);
    H.toasts.push({ d, life, max: life });
    while (H.toasts.length > 5) H.toasts.shift().d.remove();
  };
  H.center = (html, life = 1.5, cls = '') => {
    const e = H.el.center;
    e.innerHTML = html;
    e.className = cls;
    e.style.opacity = 1;
    H.centerT = life;
  };
  H.prompt = text => {
    const e = H.el.prompt;
    if (text) { e.innerHTML = text; e.classList.remove('hidden'); } else e.classList.add('hidden');
  };
  H.update = dt => {
    for (let i = H.toasts.length - 1; i >= 0; i--) {
      const t = H.toasts[i];
      t.life -= dt;
      t.d.style.opacity = U.clamp(t.life / 0.5, 0, 1);
      if (t.life <= 0) { t.d.remove(); H.toasts.splice(i, 1); }
    }
    if (H.centerT > 0) {
      H.centerT -= dt;
      H.el.center.style.opacity = U.clamp(H.centerT / 0.3, 0, 1);
    }
  };

  return H;
})();
