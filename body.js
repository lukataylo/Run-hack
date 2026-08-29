// body.js — runner-body heat map. Shaded SVG mannequin (side profile, running
// pose) with heat glows only where we truly measure: head = sway, torso =
// bounce, legs = L/R balance, feet = impact. Dynamic-imported; zero deps.

// Severity 0..1 for each region: 0 at the "green" value, 1 at the "red" value.
// Green/red anchors follow CONFIG thresholds in coach.js — calibration knobs.
function sev(v, green, red) {
  if (typeof v !== 'number' || !isFinite(v)) return null; // no data → no heat
  return Math.max(0, Math.min(1, (v - green) / (red - green)));
}

export function severities(m = {}) {
  return {
    head: m.mode === 'ears' ? sev(m.sway, 0.35, 0.75) : null, // sway is ears-only
    torso: sev(m.bounce, 6, 12),
    frontLeg: sev(m.balance != null ? Math.max(0, m.balance - 0.5) * 2 : m.asym, 0.06, 0.2),
    rearLeg: sev(m.balance != null ? Math.max(0, 0.5 - m.balance) * 2 : m.asym, 0.06, 0.2),
    feet: sev(m.impact, 1.8, 3.5),
  };
}

const heatColor = (s) => // gray → yellow → orange-red, like the reference art
  s == null ? null : `rgba(${Math.round(255 - 40 * (1 - s))},${Math.round(170 - 120 * s)},20,${0.25 + 0.6 * s})`;

// Heat spot anchor points on the figure (viewBox coords)
const SPOTS = {
  head: { x: 128, y: 30, r: 22 },
  torso: { x: 106, y: 86, r: 30 },
  frontLeg: { x: 136, y: 142, r: 24 },
  rearLeg: { x: 74, y: 150, r: 24 },
  feet: { x: 130, y: 188, r: 20 },
  feet2: { x: 44, y: 178, r: 18 },
};

export function mountBody(el, metrics) {
  if (!el) return { update() {} };
  el.innerHTML = `
  <svg viewBox="0 0 210 240" style="width:100%;height:100%;display:block">
    <defs>
      <linearGradient id="bd-shade" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#74747c"/><stop offset="1" stop-color="#4a4a52"/>
      </linearGradient>
      <linearGradient id="bd-legend" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#ff5b14"/><stop offset=".5" stop-color="#ffc23d"/>
        <stop offset="1" stop-color="#4a4a52"/>
      </linearGradient>
      <filter id="bd-blur" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="7"/></filter>
    </defs>
    <g id="bd-heat"></g>
    <g fill="none" stroke-linecap="round" stroke-linejoin="round">
      <!-- rear limbs (darker, behind torso) -->
      <path d="M112 62 88 86 106 103" stroke="#3c3c44" stroke-width="13"/>
      <path d="M101 112 75 150 45 176" stroke="#3c3c44" stroke-width="16"/>
      <path d="M45 176 32 172" stroke="#3c3c44" stroke-width="9"/>
      <!-- torso + head -->
      <path d="M119 50 100 112" stroke="url(#bd-shade)" stroke-width="27"/>
      <circle cx="128" cy="30" r="14" fill="url(#bd-shade)" stroke="none"/>
      <!-- front limbs (lighter, foreground) -->
      <path d="M116 62 141 82 127 104" stroke="#83838c" stroke-width="13"/>
      <path d="M101 112 136 142 130 186" stroke="#83838c" stroke-width="16"/>
      <path d="M130 186 146 190" stroke="#83838c" stroke-width="9"/>
    </g>
    <g font-size="9" fill="#8e8e96" font-family="inherit">
      <rect x="192" y="40" width="8" height="120" rx="4" fill="url(#bd-legend)"/>
      <text x="196" y="32" text-anchor="middle">High</text>
      <text x="196" y="174" text-anchor="middle">Low</text>
    </g>
  </svg>`;
  const heat = el.querySelector('#bd-heat');

  // Futuristic AI render: server-generated per heat signature (cached there).
  // The SVG stays until (and unless) the image arrives — offline-safe.
  const bucket = (v) => (v == null ? 0 : v < 0.33 ? 0 : v < 0.66 ? 1 : 2);
  let aiTries = 0, aiTimer = null;
  function tryAI(m) {
    const s = severities(m || {});
    const sig = `h${bucket(s.head)}-t${bucket(s.torso)}-l${bucket(s.frontLeg)}-r${bucket(s.rearLeg)}-f${bucket(s.feet)}`;
    clearTimeout(aiTimer);
    aiTries = 0;
    const poll = () => {
      fetch(`/bodyimage?sig=${sig}`).then((r) => {
        if (r.status === 200) return r.blob().then((b) => {
          const img = new Image();
          img.src = URL.createObjectURL(b);
          img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
          img.onload = () => { el.replaceChildren(img); };
        });
        // 202 = generating (30-60 s); poll with setInterval-style timeouts
        if (r.status === 202 && aiTries++ < 9) aiTimer = setTimeout(poll, 10000);
      }).catch(() => {}); // offline/404: SVG stays
    };
    poll();
  }
  tryAI(metrics);

  const update = (m) => {
    const s = severities(m || {});
    let h = '';
    for (const [k, spot] of Object.entries(SPOTS)) {
      const v = s[k === 'feet2' ? 'feet' : k];
      const c = heatColor(v);
      if (!c || v < 0.04) continue;
      h += `<circle cx="${spot.x}" cy="${spot.y}" r="${spot.r * (0.7 + 0.5 * v)}" fill="${c}" filter="url(#bd-blur)"/>`;
    }
    heat.innerHTML = h;
  };
  update(metrics);
  return { update };
}
