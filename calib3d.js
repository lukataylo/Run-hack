// calib3d.js — live 3D head + AirPods for the calibration screen. Rotates 1:1
// with the AirPods attitude quaternion (full pitch/roll/yaw); falls back to a
// gravity-only orientation (pitch/roll, no yaw) when q* fields are absent.
// Decorative-critical rule applies: dynamic-imported with catch.
import * as THREE from './vendor/three.module.js';
import { RoomEnvironment } from './vendor/three.RoomEnvironment.js';

export function mountCalib3D(el, getSample) {
  if (!el) return { stop() {} };
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch { return { stop() {} }; }
  const rect = el.getBoundingClientRect();
  const w = Math.max(2, rect.width), h = Math.max(2, rect.height);
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 50);
  camera.position.set(0, 0.6, 4.2);
  camera.lookAt(0, 0, 0);
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.add(new THREE.AmbientLight(0x404048, 0.7));
  const key = new THREE.DirectionalLight(0xffd9b8, 1.8);
  key.position.set(2, 3, 2);
  scene.add(key);

  // reference ring so rotation reads spatially
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(1.65, 0.012, 8, 64),
    new THREE.MeshBasicMaterial({ color: 0x26262b })
  );
  ring.rotation.x = Math.PI / 2;
  ring.position.y = -1.2;
  scene.add(ring);

  // stylized head: dark matte with orange nose-direction cone + white pods
  const headMat = new THREE.MeshPhysicalMaterial({ color: 0x2a2a30, roughness: 0.55, clearcoat: 0.6 });
  const white = new THREE.MeshPhysicalMaterial({ color: 0xf6f6f4, roughness: 0.28, clearcoat: 1 });
  const orange = new THREE.MeshStandardMaterial({ color: 0xff5b14, roughness: 0.4 });
  const headGroup = new THREE.Group();
  const skull = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 48), headMat);
  skull.scale.set(0.82, 1, 0.9);
  headGroup.add(skull);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.42, 24), orange);
  nose.position.set(0, -0.08, 0.95);
  nose.rotation.x = Math.PI / 2;
  headGroup.add(nose);
  const podGeo = new THREE.CapsuleGeometry(0.09, 0.34, 6, 16);
  const podL = new THREE.Mesh(podGeo, white);
  podL.position.set(-0.85, -0.28, 0.08);
  podL.rotation.z = 0.15;
  const podR = podL.clone();
  podR.position.x = 0.85;
  podR.rotation.z = -0.15;
  headGroup.add(podL, podR);
  scene.add(headGroup);

  // live accel arrow (shows impacts/bounce as a growing vector)
  const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 0), 0.001, 0xff8a3d, 0.12, 0.08);
  scene.add(arrow);

  const q = new THREE.Quaternion(), target = new THREE.Quaternion();
  const refInv = new THREE.Quaternion(); // "Set level" zero-reference
  const shown = new THREE.Quaternion();
  const gUp = new THREE.Vector3(), devUp = new THREE.Vector3(0, 1, 0);
  const iv = setInterval(() => { // setInterval, never rAF (house rule)
    if (!renderer.domElement.isConnected) { clearInterval(iv); renderer.dispose(); return; }
    if (el.offsetParent === null || document.hidden) return;
    const s = getSample?.();
    if (s) {
      if (typeof s.qw === 'number') {
        // CoreMotion is z-up, three.js y-up. Pitch (x) sign flipped after a
        // real-head test: nod-down previously rendered as nod-up.
        target.set(-s.qx, s.qz, -s.qy, s.qw);
      } else if (typeof s.gx === 'number') {
        // gravity-only fallback: pitch/roll, no yaw (pitch sign matches the
        // quaternion path's real-head fix)
        gUp.set(-s.gx, s.gz, -s.gy).normalize().negate();
        target.setFromUnitVectors(devUp, gUp);
      }
      q.slerp(target, 0.35); // light smoothing, still snappy
      shown.copy(refInv).multiply(q); // render relative to the zeroed pose
      headGroup.quaternion.copy(shown);
      const mag = Math.hypot(s.ax || 0, s.ay || 0, s.az || 0);
      arrow.setLength(Math.max(0.001, Math.min(1.4, mag / 8)), 0.12, 0.08);
      arrow.setDirection(new THREE.Vector3(s.ax || 0, s.az || 0, -(s.ay || 0)).normalize());
    }
    renderer.render(scene, camera);
  }, 33);

  el.appendChild(renderer.domElement);
  return {
    stop() { clearInterval(iv); renderer.dispose(); },
    // "look straight ahead, tap Set level" — current pose becomes zero
    setLevel() { refInv.copy(q).invert(); },
    // relative pitch/roll (deg) for the gauges, after zeroing
    angles() {
      const e = new THREE.Euler().setFromQuaternion(shown, 'YXZ');
      return { pitch: -e.x * 180 / Math.PI, roll: e.z * 180 / Math.PI, yaw: e.y * 180 / Math.PI };
    },
  };
}
