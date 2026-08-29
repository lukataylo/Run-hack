// runner3d.js — articulated 3D running human for the Form Map card. A jointed
// skeleton (every pivot is a THREE.Group rotation — no baked geometry rotations)
// driven by a procedural gait cycle whose phase advances at the runner's real
// step frequency. Decorative module: dynamic-imported with catch from body.js —
// any failure here must never take the app down.
//
// Metric → rig mapping (all smoothed toward targets; see retune()):
//   cadence  → gait phase speed (exact: cadence/60 steps per second)
//   estKmh   → stride amplitude + forward lean (cadence proxy when absent)
//   bounce   → vertical pelvis oscillation (2× per stride, min after contact)
//   asym / balance → per-side amplitude (weak side visibly shorter, flatter)
//   sway     → lateral chest/head roll at step frequency (ears mode only)
//   tiltDev  → static head-forward droop
//   moving:false → amplitudes and phase rate blend to a standing pose
import * as THREE from './vendor/three.module.js';
import { RoomEnvironment } from './vendor/three.RoomEnvironment.js';

const D = Math.PI / 180;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
// Raised-cosine bump on the phase circle, centred at c with half-width w —
// the piecewise building block for the joint-angle curves.
function bump(x, c, w) {
  const d = Math.atan2(Math.sin(x - c), Math.cos(x - c));
  return Math.abs(d) >= w ? 0 : Math.cos((d / w) * (Math.PI / 2)) ** 2;
}

// el → live handle. WebGL contexts are scarce (see pods3d.js) — repeated
// mountBody calls on the same element must reuse the running instance.
const mounted = new WeakMap();

export function mountRunner(el, metrics) {
  if (!el) return null;
  const prev = mounted.get(el);
  if (prev && prev.alive()) { prev.update(metrics); return prev; }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch { return null; } // no WebGL — caller falls back
  const rect = el.getBoundingClientRect();
  const w = Math.max(2, rect.width || el.clientWidth || 300);
  const h = Math.max(2, rect.height || el.clientHeight || 300);
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 50);
  // slightly low 3/4 side view (below the pelvis look-at point)
  camera.position.set(1.7, 0.72, 2.6);
  camera.lookAt(0, 0.95, 0);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight(0xffd9b8, 2.0); // warm key
  key.position.set(2.5, 3, 2);
  scene.add(key, new THREE.AmbientLight(0x404048, 0.5));

  /* ---------- materials: one per heat region so emissive glows per region ---------- */
  const mkMat = () => new THREE.MeshPhysicalMaterial({
    color: 0x2a2a30, roughness: 0.38, metalness: 0.12, // dark carbon
    clearcoat: 1, clearcoatRoughness: 0.25,
    emissive: 0xff5b14, emissiveIntensity: 0, // heat = accent orange burn
  });
  const mats = {
    head: mkMat(), torso: mkMat(), leftLeg: mkMat(),
    rightLeg: mkMat(), feet: mkMat(), arms: mkMat(),
  };

  /* ---------- rig: joints are Groups at the pivots; meshes hang off them ---------- */
  // ~1.75 m figure. Forward = +z. Segment helper: capsule extending -y from joint.
  const seg = (len, r, mat) => {
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r, Math.max(0.01, len - 2 * r), 6, 16), mat);
    m.position.y = -len / 2;
    return m;
  };
  const joint = (parent, x, y, z) => {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    parent.add(g);
    return g;
  };

  const figure = new THREE.Group();
  scene.add(figure);
  const BASE_Y = 0.94; // pelvis height

  const pelvis = joint(figure, 0, BASE_Y, 0);
  const pelvisMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.105, 0.05, 6, 16), mats.torso);
  pelvisMesh.scale.set(1.45, 1, 0.95);
  pelvis.add(pelvisMesh);

  const spine = joint(pelvis, 0, 0.12, 0); // lumbar pivot: lean + twist
  const spineMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.095, 0.1, 6, 16), mats.torso);
  spineMesh.position.y = 0.08;
  spine.add(spineMesh);

  const chest = joint(spine, 0, 0.2, 0); // thoracic pivot: counter-twist + sway roll
  const chestMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.125, 0.16, 6, 16), mats.torso);
  chestMesh.position.y = 0.11;
  chestMesh.scale.set(1.3, 1, 0.8);
  chest.add(chestMesh);

  const neck = joint(chest, 0, 0.25, 0); // droop pivot
  const neckMesh = new THREE.Mesh(new THREE.CapsuleGeometry(0.045, 0.04, 6, 12), mats.torso);
  neckMesh.position.y = 0.03;
  neck.add(neckMesh);
  const head = joint(neck, 0, 0.09, 0);
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.105, 24, 20), mats.head);
  headMesh.scale.y = 1.15;
  headMesh.position.set(0, 0.07, 0.01);
  head.add(headMesh);

  const mkArm = (side) => { // side: -1 left, +1 right
    const shoulder = joint(chest, side * 0.205, 0.17, 0);
    shoulder.add(seg(0.3, 0.047, mats.arms));
    const elbow = joint(shoulder, 0, -0.3, 0);
    elbow.add(seg(0.26, 0.04, mats.arms));
    const wrist = joint(elbow, 0, -0.26, 0);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.048, 16, 12), mats.arms);
    hand.scale.set(0.85, 1.25, 0.9);
    hand.position.y = -0.045;
    wrist.add(hand);
    return { shoulder, elbow, wrist, side };
  };
  const mkLeg = (side, mat) => {
    const hip = joint(pelvis, side * 0.1, -0.03, 0);
    hip.add(seg(0.44, 0.066, mat));
    const knee = joint(hip, 0, -0.44, 0);
    knee.add(seg(0.43, 0.05, mat));
    const ankle = joint(knee, 0, -0.43, 0);
    const foot = new THREE.Mesh(new THREE.BoxGeometry(0.085, 0.055, 0.24), mats.feet);
    foot.position.set(0, -0.035, 0.06);
    ankle.add(foot);
    return { hip, knee, ankle, side };
  };
  const armL = mkArm(-1), armR = mkArm(1);
  const legL = mkLeg(-1, mats.leftLeg), legR = mkLeg(1, mats.rightLeg);

  // grounding disc
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(0.85, 40),
    new THREE.MeshStandardMaterial({ color: 0x121216, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  figure.add(ground);

  /* ---------- gait parameters: current (P) eased toward targets (T) ---------- */
  const P = { cad: 168, stride: 1, lean: 0.12, bob: 0.03, sway: 0, droop: 0, sideL: 1, sideR: 1, run: 1 };
  const T = { ...P };
  function retune(m = {}) {
    const cad = clamp(num(m.cadence, 168), 100, 230);
    // speed: real estimate when present, else a stride proxy from cadence
    const kmh = clamp(num(m.estKmh, (cad - 100) * 0.16), 4, 24);
    T.cad = cad;
    T.stride = clamp(kmh / 11, 0.55, 1.35);
    T.lean = clamp(0.04 + kmh * 0.011, 0.05, 0.22);
    T.bob = clamp(0.012 + (num(m.bounce, 7) - 4) * 0.006, 0.012, 0.06);
    T.sway = m.mode && m.mode !== 'ears' ? 0 : clamp((num(m.sway, 0) - 0.3) * 0.35, 0, 0.17);
    T.droop = clamp(num(m.tiltDev, 0) * 0.018, 0, 0.45);
    // per-side amplitude: balance (fraction-left) when present, else the
    // Robinson index with left assumed weak — same uncalibrated heuristic as coach.js
    let dl = 0;
    if (typeof m.balance === 'number' && isFinite(m.balance)) dl = (m.balance - 0.5) * 2;
    else if (typeof m.asym === 'number' && isFinite(m.asym)) dl = -clamp(m.asym, 0, 0.4);
    dl = clamp(dl, -0.5, 0.5);
    T.sideL = 1 + dl * 0.85;
    T.sideR = 1 - dl * 0.85;
    T.run = m.moving === false ? 0 : 1; // frozen/absent metrics still jog
  }
  retune(metrics);
  Object.assign(P, T); // first paint lands on target, no swim-in

  /* ---------- heat: region emissive targets, eased ---------- */
  const heatT = { head: 0, torso: 0, leftLeg: 0, rightLeg: 0, feet: 0, arms: 0 };
  const heatC = { ...heatT };
  function setHeat(hm = {}) {
    for (const k in heatT) heatT[k] = clamp(num(hm[k], 0), 0, 1);
  }

  /* ---------- gait curves (cartoon-grade approximations of running gait) ---------- */
  // p = 0 at that foot's initial contact; stance ≈ [0, 0.8π], swing the rest.
  function poseLeg(L, p, s) {
    const r = P.run;
    const hip = (35 * D * P.stride * s * r) * Math.cos(p) + 6 * D * r; // ±35° flexion/extension
    const knee = r * s * (6 * D
      + 22 * D * bump(p, 0.35 * Math.PI, 0.7 * Math.PI)                 // stance absorption ~25°
      + 95 * D * P.stride * bump(p, 1.3 * Math.PI, 0.75 * Math.PI));   // swing flexion ~90°
    const ankle = r * (-6 * D
      + 30 * D * s * bump(p, 0.85 * Math.PI, 0.5 * Math.PI)            // toe-off plantarflexion
      - 14 * D * bump(p, 1.45 * Math.PI, 0.55 * Math.PI));             // swing dorsiflexion (clearance)
    L.hip.rotation.x = -hip;   // -x rotation = thigh forward (+z)
    L.knee.rotation.x = knee;  // +x = heel toward hip
    L.ankle.rotation.x = ankle; // +x = toes down
  }
  function poseArm(A, p) { // p already counter-phase to the same-side leg
    const r = P.run;
    const amp = 30 * D * P.stride * r; // ~60° total swing
    A.shoulder.rotation.x = -amp * Math.cos(p);
    A.shoulder.rotation.z = -A.side * (7 * D * r + 2 * D); // slight abduction, clears the hips
    A.elbow.rotation.x = -(r * (85 * D + 15 * D * Math.cos(p)) + (1 - r) * 8 * D); // ~90° carry
    A.wrist.rotation.x = -r * 10 * D;
  }

  let phase = Math.random() * Math.PI * 2; // stride phase (2π = one full stride = two steps)
  let t = 0;
  function step(dt) {
    // ease params + heat
    const k = Math.min(1, dt * 3);
    for (const key in P) P[key] += (T[key] - P[key]) * k;
    for (const key in heatC) {
      heatC[key] += (heatT[key] - heatC[key]) * k;
      mats[key].emissiveIntensity = 1.7 * heatC[key];
    }
    // phase advances at the REAL step frequency: cadence/60 steps/s, 2 steps per stride
    phase += dt * Math.PI * 2 * (P.cad / 120) * P.run;
    t += dt;

    const pL = phase, pR = phase + Math.PI; // legs anti-phase
    poseLeg(legL, pL, P.sideL);
    poseLeg(legR, pR, P.sideR);
    poseArm(armL, pR); // arms counter-phase to their own leg
    poseArm(armR, pL);

    const r = P.run;
    pelvis.rotation.y = 8 * D * r * P.stride * Math.cos(pL);   // pelvis rotates with the legs
    chest.rotation.y = -13 * D * r * P.stride * Math.cos(pL);  // shoulders counter-rotate
    spine.rotation.x = -P.lean;                                 // forward lean from speed
    const roll = P.sway * Math.sin(2 * pL + 0.9);               // lateral rock, 2× per stride
    chest.rotation.z = roll;
    head.rotation.z = 0.6 * roll;
    neck.rotation.x = -(P.droop + 0.05 * r);                    // posture droop (+ a natural nod)
    // pelvis bobs 2× per stride, lowest just after each contact
    pelvis.position.y = BASE_Y - 0.035 * r + P.bob * r * Math.cos(2 * pL - 0.7);
    pelvis.position.x = 0.018 * r * Math.sin(pL);
    figure.rotation.y = -0.28 + 0.16 * Math.sin(t * 0.25);      // slow orbit oscillation
  }

  el.appendChild(renderer.domElement);

  // ONE setInterval ~30 fps — never rAF (throttled/occluded webviews freeze it)
  let stopped = false;
  const iv = setInterval(() => {
    if (stopped) return;
    // self-dispose when the canvas leaves the DOM (card re-renders)
    if (!renderer.domElement.isConnected) { dispose(); return; }
    // skip work while invisible: hidden screen or backgrounded tab
    if (el.offsetParent === null || document.hidden) return;
    step(1 / 30);
    renderer.render(scene, camera);
  }, 33);
  function dispose() {
    if (stopped) return;
    stopped = true;
    clearInterval(iv);
    try { renderer.dispose(); renderer.forceContextLoss?.(); } catch { /* decorative */ }
    mounted.delete(el);
  }

  const handle = {
    update(m) { if (m) retune(m); },
    setHeat,
    stop() { try { renderer.domElement.remove(); } catch {} dispose(); },
    alive: () => !stopped && renderer.domElement.isConnected,
    // test hooks (test-runner3d.html reads joint state to verify the gait)
    _debug: { joints: { legL, legR, armL, armR, pelvis, spine, chest, neck, head }, phase: () => phase, params: P, heat: heatC },
  };
  mounted.set(el, handle);
  return handle;
}
