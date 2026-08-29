// pods3d.js — decorative 3D AirPods for the home screen. Dynamic-imported with
// catch from index.html: any failure here must never take the app down.
import * as THREE from './vendor/three.module.js';
import { RoomEnvironment } from './vendor/three.RoomEnvironment.js';

export function mount(el) {
  if (!el) return;
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  } catch {
    return; // no WebGL — leave the quiet placeholder in place
  }
  const rect = el.getBoundingClientRect();
  const w = Math.max(2, rect.width), h = Math.max(2, rect.height);
  renderer.setSize(w, h);
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, w / h, 0.1, 50);
  camera.position.set(0, 0.15, 5);

  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // warm key light
  const key = new THREE.DirectionalLight(0xffd9b8, 2.2);
  key.position.set(2.5, 3, 2);
  scene.add(key);
  scene.add(new THREE.AmbientLight(0x404048, 0.6));

  const group = new THREE.Group();
  scene.add(group);

  const finish = () => {
    el.querySelectorAll('#pods-ph,[data-pods-ph]').forEach((ph) => { ph.style.display = 'none'; });
    el.appendChild(renderer.domElement);
    // slow oscillating rotation — setInterval, never rAF (throttled webviews)
    let t = 0;
    const iv = setInterval(() => {
      // self-dispose when the canvas leaves the DOM (Insights re-renders its hero)
      if (!renderer.domElement.isConnected) {
        clearInterval(iv);
        renderer.dispose();
        return;
      }
      t += 0.03;
      group.rotation.y = 0.45 * Math.sin(t * 0.5);
      group.rotation.x = 0.12 * Math.sin(t * 0.33) - 0.1;
      renderer.render(scene, camera);
    }, 33);
  };

  // primary: procured GLB (a human commits it; may not exist yet)
  new Promise((res, rej) => {
    import('./vendor/three.GLTFLoader.js').then(({ GLTFLoader }) => {
      new GLTFLoader().load('assets/airpods/airpods-pro.glb', res, undefined, rej);
    }).catch(rej);
  }).then((gltf) => {
    const m = gltf.scene;
    // STL-derived GLB carries only a flat PBR white; apply the house finish
    const white = new THREE.MeshPhysicalMaterial({
      color: 0xf6f6f4, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12,
    });
    m.traverse((o) => { if (o.isMesh) o.material = white; });
    const box = new THREE.Box3().setFromObject(m);
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    m.scale.setScalar(3.2 / size);
    box.setFromObject(m);
    m.position.sub(box.getCenter(new THREE.Vector3()));
    group.add(m);
    finish();
  }).catch(() => {
    buildProceduralPods(group);
    finish();
  });
}

// Fallback: procedural buds — spheres for head + angled tip, capsule stem,
// dark grille circle, metallic foot ring; clearcoat white plastic.
function buildProceduralPods(group) {
  const white = new THREE.MeshPhysicalMaterial({
    color: 0xf6f6f4, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12,
  });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1a1c, roughness: 0.6, metalness: 0.2 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xb9b9bd, roughness: 0.25, metalness: 0.9 });

  const bud = new THREE.Group();
  const headS = new THREE.Mesh(new THREE.SphereGeometry(0.42, 48, 48), white);
  headS.scale.set(1, 0.86, 0.92);
  bud.add(headS);

  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.24, 32, 32), white);
  tip.position.set(0.22, 0.1, 0.28);
  bud.add(tip);

  const grille = new THREE.Mesh(new THREE.CircleGeometry(0.13, 24), dark);
  grille.position.set(0.31, 0.14, 0.415);
  grille.lookAt(1.2, 0.55, 1.7);
  bud.add(grille);

  const stem = new THREE.Mesh(new THREE.CapsuleGeometry(0.13, 0.85, 8, 24), white);
  stem.position.set(-0.05, -0.62, 0.05);
  stem.rotation.z = 0.1;
  bud.add(stem);

  const foot = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.03, 12, 32), steel);
  foot.position.set(-0.115, -1.06, 0.055);
  foot.rotation.x = Math.PI / 2;
  bud.add(foot);

  bud.rotation.z = -0.18;
  const left = bud;
  left.position.x = -0.75;
  const right = bud.clone(true);
  right.scale.x = -1; // the right bud is the mirrored left
  right.position.x = 0.75;
  group.add(left, right);
  group.position.y = 0.25;
}
