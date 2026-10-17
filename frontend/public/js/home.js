import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const canvas = document.querySelector("#mars-scene");
const loadingNote = document.querySelector("#loading-note");
const motionToggle = document.querySelector("#motion-toggle");
const motionLabel = motionToggle.querySelector("span:last-child");
const motionIcon = motionToggle.querySelector(".motion-icon");
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
camera.position.set(0, 0, 4.15);

const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;

scene.add(new THREE.HemisphereLight(0xfbd6bd, 0x260c08, 1.6));

const sunLight = new THREE.DirectionalLight(0xffe2c6, 3.1);
sunLight.position.set(-3.5, 4.2, 5);
scene.add(sunLight);

const rimLight = new THREE.DirectionalLight(0xc85227, 2.2);
rimLight.position.set(4, -1, -4);
scene.add(rimLight);

const planetSpin = new THREE.Group();
scene.add(planetSpin);

let isPaused = prefersReducedMotion.matches;
let hasLoaded = false;
let scrollProgress = 0;

function setMotionButton() {
  motionToggle.setAttribute("aria-pressed", String(isPaused));
  motionLabel.textContent = isPaused ? "Resume rotation" : "Pause rotation";
  motionIcon.textContent = isPaused ? "▶" : "Ⅱ";
}

motionToggle.addEventListener("click", () => {
  isPaused = !isPaused;
  setMotionButton();
});

prefersReducedMotion.addEventListener("change", (event) => {
  if (event.matches) {
    isPaused = true;
    setMotionButton();
  }
});

function resizeScene() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.position.z = width < 680 ? 4.75 : 4.15;
  camera.updateProjectionMatrix();
}

function updateScrollState() {
  const travelDistance = Math.max(1, window.innerHeight * 0.82);
  scrollProgress = THREE.MathUtils.clamp(window.scrollY / travelDistance, 0, 1);
  document.querySelector("#landing-screen").classList.toggle("is-revealed", scrollProgress > 0.2);
}

window.addEventListener("resize", resizeScene);
window.addEventListener("scroll", updateScrollState, { passive: true });
resizeScene();
updateScrollState();
setMotionButton();

const loader = new GLTFLoader();
loader.load(
  "./assets/24881_Mars_1_6792.glb",
  (gltf) => {
    const model = gltf.scene;
    const bounds = new THREE.Box3().setFromObject(model);
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const largestDimension = Math.max(size.x, size.y, size.z);

    model.position.sub(center);
    model.scale.setScalar(2.55 / largestDimension);
    planetSpin.add(model);

    // Give the planet a gentle tilt so the rotation reads clearly in the hero.
    planetSpin.rotation.z = THREE.MathUtils.degToRad(-9);
    planetSpin.rotation.x = THREE.MathUtils.degToRad(4);

    hasLoaded = true;
    loadingNote.classList.add("is-hidden");
  },
  undefined,
  (error) => {
    console.error("Could not load the Mars GLB model.", error);
    loadingNote.textContent = "3D model unavailable — check the model file path.";
    loadingNote.classList.add("is-error");
  },
);

const clock = new THREE.Clock();
function animate() {
  requestAnimationFrame(animate);
  const delta = clock.getDelta();
  const targetY = -camera.position.z * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * scrollProgress;
  const slideEase = prefersReducedMotion.matches ? 1 : Math.min(1, delta * 5);
  planetSpin.position.y += (targetY - planetSpin.position.y) * slideEase;

  if (hasLoaded && !isPaused && !document.hidden) {
    // Rotate slowly on the planet's own axis, independent of the frame rate.
    planetSpin.rotation.y += delta * 0.085;
  }

  renderer.render(scene, camera);
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) clock.start();
});

requestAnimationFrame(animate);
