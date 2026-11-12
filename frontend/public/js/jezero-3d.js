import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const canvas = document.querySelector("#jezero-scene");
const statusEl = document.querySelector("#viewer-status");
const loadingCover = document.querySelector("#loading-cover");
const stereoButton = document.querySelector("#stereo-button");
const headingValue = document.querySelector("#heading-value");
const positionValue = document.querySelector("#position-value");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x332019);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "low-power" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
renderer.setClearColor(0x332019, 1);

const camera = new THREE.PerspectiveCamera(72, 1, 0.1, 20000);
const leftEye = new THREE.PerspectiveCamera(72, 1, 0.1, 20000);
const rightEye = new THREE.PerspectiveCamera(72, 1, 0.1, 20000);
const eyeOffset = new THREE.Vector3();
const light = new THREE.HemisphereLight(0xffd9b2, 0x39241d, 1.7);
scene.add(light);
const sun = new THREE.DirectionalLight(0xffc28d, 2.1);
sun.position.set(-500, 1200, -400);
scene.add(sun);

const SENSOR_CORRECTION = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const sensorEuler = new THREE.Euler();
const sensorQuaternion = new THREE.Quaternion();
const screenQuaternion = new THREE.Quaternion();
const cameraBase = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.38, Math.PI, 0, "YXZ"));
const deviceStart = new THREE.Quaternion();
const deviceCurrent = new THREE.Quaternion();
const deviceRelative = new THREE.Quaternion();
const finalOrientation = new THREE.Quaternion();
const controllerOffset = new THREE.Quaternion();
const zee = new THREE.Vector3(0, 0, 1);
const forward = new THREE.Vector3();
const right = new THREE.Vector3();
const yawEuler = new THREE.Euler(-0.38, Math.PI, 0, "YXZ");
const keys = new Set();
const touchMoves = new Set();

let stereo = false;
let headsetMode = false;
let motionEnabled = false;
let hasOrientation = false;
let mouseLooking = false;
let yaw = Math.PI;
let pitch = -0.38;
let lastX = 0;
let lastY = 0;
let previousFrame = performance.now();
let lastGamepadLook = 0;
let controllerYaw = 0;
let controllerPitch = 0;
let terrainRoot;
let terrainBounds;
let sceneWidth;
let sceneLength;
const terrainRaycaster = new THREE.Raycaster();
const downDirection = new THREE.Vector3(0, -1, 0);
let walkedMeters = 0;

function setStatus(message, kind = "") {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", kind === "error");
  statusEl.classList.toggle("is-good", kind === "good");
}

function currentScreenAngle() {
  return THREE.MathUtils.degToRad(screen.orientation?.angle ?? window.orientation ?? 0);
}

function makeSensorQuaternion(event) {
  if (event.alpha === null || event.beta === null || event.gamma === null) return null;
  sensorEuler.set(THREE.MathUtils.degToRad(event.beta), THREE.MathUtils.degToRad(event.alpha), -THREE.MathUtils.degToRad(event.gamma), "YXZ");
  sensorQuaternion.setFromEuler(sensorEuler);
  screenQuaternion.setFromAxisAngle(zee, -currentScreenAngle());
  return sensorQuaternion.multiply(SENSOR_CORRECTION).multiply(screenQuaternion).clone();
}

function onOrientation(event) {
  const orientation = makeSensorQuaternion(event);
  if (!orientation) return;
  deviceCurrent.copy(orientation);
  if (!hasOrientation) {
    deviceStart.copy(orientation);
    hasOrientation = true;
  }
  deviceRelative.copy(deviceStart).invert().multiply(deviceCurrent);
  finalOrientation.copy(cameraBase).multiply(deviceRelative);
  camera.quaternion.copy(finalOrientation);
  const displayEuler = new THREE.Euler().setFromQuaternion(finalOrientation, "YXZ");
  headingValue.textContent = `${Math.round((THREE.MathUtils.radToDeg(displayEuler.y) + 360) % 360)}°`;
}

function surfaceHeightAt(x, z) {
  if (!terrainRoot || !terrainBounds) return null;
  terrainRaycaster.set(new THREE.Vector3(x, terrainBounds.max.y + 5, z), downDirection);
  const hit = terrainRaycaster.intersectObject(terrainRoot, true)[0];
  return hit?.point.y ?? null;
}

async function loadScene() {
  const gltf = await new GLTFLoader().loadAsync("./assets/source/jezero.gltf");
  terrainRoot = gltf.scene;
  const originalBounds = new THREE.Box3().setFromObject(terrainRoot);
  const originalCenter = originalBounds.getCenter(new THREE.Vector3());
  terrainRoot.position.x -= originalCenter.x;
  terrainRoot.position.y -= originalBounds.min.y;
  terrainRoot.position.z -= originalCenter.z;
  scene.add(terrainRoot);
  terrainRoot.updateMatrixWorld(true);

  const bounds = new THREE.Box3().setFromObject(terrainRoot);
  terrainBounds = bounds.clone();
  const dimensions = bounds.getSize(new THREE.Vector3());
  sceneWidth = dimensions.x;
  sceneLength = dimensions.z;
  terrainRaycaster.far = dimensions.y + 10;
  let vertexCount = 0;
  terrainRoot.traverse((object) => {
    if (object.isMesh) vertexCount += object.geometry.attributes.position?.count ?? 0;
  });

  // Try several candidate spawn positions and pick the one with the highest
  // ground — that lands on the crater rim with a dramatic view across the floor.
  const candidates = [
    [0,               -sceneLength * 0.38],  // south edge
    [0,                sceneLength * 0.38],  // north edge
    [-sceneWidth * 0.38,  0],               // west edge
    [ sceneWidth * 0.38,  0],               // east edge
    [-sceneWidth * 0.25, -sceneLength * 0.25], // SW
    [ sceneWidth * 0.25, -sceneLength * 0.25], // SE
  ];
  let bestX = 0, bestZ = 0, bestH = -Infinity;
  for (const [cx, cz] of candidates) {
    const h = surfaceHeightAt(cx, cz);
    if (h !== null && h > bestH) { bestH = h; bestX = cx; bestZ = cz; }
  }
  if (bestH === -Infinity) { bestX = 0; bestZ = -sceneLength * 0.32; bestH = surfaceHeightAt(bestX, bestZ) ?? dimensions.y / 2; }

  // Step 15% inward from the rim toward the centre so the crater floor
  // opens up ahead rather than a slope filling the whole frame.
  const inwardFrac = 0.15;
  const spawnX = bestX * (1 - inwardFrac);
  const spawnZ = bestZ * (1 - inwardFrac);
  const spawnH = surfaceHeightAt(spawnX, spawnZ) ?? bestH;

  camera.position.set(spawnX, spawnH + 1.7, spawnZ);
  // Face toward the terrain centre so the crater floor is ahead.
  controllerYaw = Math.atan2(-spawnX, -spawnZ);
  controllerPitch = -0.12; // ~7° down — horizon visible with terrain below
  document.querySelector("#data-resolution").textContent = `${(sceneWidth/1000).toFixed(1)} × ${(sceneLength/1000).toFixed(1)} km footprint · ${dimensions.y.toFixed(0)} m relief · ${vertexCount.toLocaleString()} vertices.`;
  loadingCover.classList.add("is-hidden");
  setTimeout(() => loadingCover.remove(), 450);
  setStatus("Your Jezero glTF model is loaded. Look around and walk with keys, touch arrows, or a gamepad.", "good");
  resize();
}

function updateCameraRotation() {
  controllerOffset.setFromEuler(new THREE.Euler(controllerPitch, controllerYaw, 0, "YXZ"));
  if (motionEnabled && hasOrientation) {
    deviceRelative.copy(deviceStart).invert().multiply(deviceCurrent);
    finalOrientation.copy(cameraBase).multiply(deviceRelative).multiply(controllerOffset);
    camera.quaternion.copy(finalOrientation);
  } else {
    yawEuler.set(pitch, yaw, 0, "YXZ");
    camera.quaternion.setFromEuler(yawEuler).multiply(controllerOffset);
  }
}

function recenter() {
  if (hasOrientation) deviceStart.copy(deviceCurrent);
  yaw = Math.PI;
  pitch = -0.38;
  controllerYaw = 0;
  controllerPitch = 0;
  controllerOffset.identity();
  updateCameraRotation();
  headingValue.textContent = "0°";
  setStatus("View centered toward the Jezero terrain. Turn your head to look around.", "good");
}

async function enableMotion() {
  if (!window.isSecureContext) {
    setStatus("Phone motion needs HTTPS or localhost. Use USB/ADB and open this page at http://localhost:5000/jezero-3d.html.", "error");
    return;
  }
  try {
    if (typeof DeviceOrientationEvent === "undefined") throw new Error("This browser does not expose phone orientation sensors.");
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") throw new Error("Motion permission was not granted.");
    }
    window.addEventListener("deviceorientation", onOrientation, true);
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    motionEnabled = true;
    document.querySelector("#motion-button").textContent = "Phone motion enabled";
    setStatus("Phone head tracking is on. Turn slowly; press Recenter if the view drifts.", "good");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function toggleStereo(value = !stereo) {
  stereo = value;
  document.body.classList.toggle("stereo", stereo);
  stereoButton.setAttribute("aria-pressed", String(stereo));
  stereoButton.textContent = `Split-screen: ${stereo ? "on" : "off"}`;
  resize();
}

function resize() {
  const width = Math.max(1, window.innerWidth);
  const height = Math.max(1, window.innerHeight);
  renderer.setSize(width, height, false);
  const eyeWidth = stereo ? width / 2 : width;
  camera.aspect = eyeWidth / height;
  camera.updateProjectionMatrix();
  leftEye.aspect = camera.aspect;
  rightEye.aspect = camera.aspect;
  leftEye.updateProjectionMatrix();
  rightEye.updateProjectionMatrix();
}

function readGamepad(delta) {
  const gamepad = [...(navigator.getGamepads?.() ?? [])].find((pad) => pad?.connected);
  if (!gamepad) return { x: 0, z: 0 };
  const deadzone = 0.16;
  const axis = (value) => Math.abs(value) > deadzone ? value : 0;
  const moveX = axis(gamepad.axes[0] || 0) + Number(Boolean(gamepad.buttons[15]?.pressed)) - Number(Boolean(gamepad.buttons[14]?.pressed));
  const moveZ = axis(gamepad.axes[1] || 0) + Number(Boolean(gamepad.buttons[12]?.pressed)) - Number(Boolean(gamepad.buttons[13]?.pressed));
  const lookX = axis(gamepad.axes[2] || 0);
  const lookY = axis(gamepad.axes[3] || 0);
  controllerYaw -= lookX * delta * 1.8;
  controllerPitch = THREE.MathUtils.clamp(controllerPitch - lookY * delta * 1.4, -0.55, 0.55);
  return { x: moveX, z: moveZ };
}

function movementInput() {
  let x = Number(keys.has("KeyD") || keys.has("ArrowRight") || touchMoves.has("right")) - Number(keys.has("KeyA") || keys.has("ArrowLeft") || touchMoves.has("left"));
  let z = Number(keys.has("KeyS") || keys.has("ArrowDown") || touchMoves.has("back")) - Number(keys.has("KeyW") || keys.has("ArrowUp") || touchMoves.has("forward"));
  const gamepad = readGamepad(Math.min((performance.now() - lastGamepadLook) / 1000, 0.05));
  lastGamepadLook = performance.now();
  x += gamepad.x;
  z += gamepad.z;
  const length = Math.hypot(x, z);
  if (length > 1) { x /= length; z /= length; }
  return { x, z };
}

function moveCamera(delta) {
  if (!terrainRoot) return;
  const movement = movementInput();
  if (Math.abs(movement.x) < 0.001 && Math.abs(movement.z) < 0.001) return;
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() > 0) forward.normalize();
  right.set(forward.z, 0, -forward.x).normalize();
  const previousX = camera.position.x;
  const previousZ = camera.position.z;
  const speed = keys.has("ShiftLeft") || keys.has("ShiftRight") ? 50 : 8;
  camera.position.addScaledVector(forward, -movement.z * speed * delta);
  camera.position.addScaledVector(right, movement.x * speed * delta);
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -sceneWidth / 2 + 0.5, sceneWidth / 2 - 0.5);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -sceneLength / 2 + 0.5, sceneLength / 2 - 0.5);
  const floor = surfaceHeightAt(camera.position.x, camera.position.z);
  if (floor === null) {
    camera.position.x = previousX;
    camera.position.z = previousZ;
    return;
  }
  camera.position.y = floor + 1.7;
  const distance = Math.hypot(camera.position.x - previousX, camera.position.z - previousZ);
  walkedMeters += distance;
  if (distance > 0) positionValue.textContent = `Jezero · moved ${(walkedMeters / 1000).toFixed(2)} km`;
}

function renderEye(eye, x, width, height, offset) {
  eye.position.copy(camera.position);
  eye.quaternion.copy(camera.quaternion);
  eyeOffset.set(offset, 0, 0).applyQuaternion(camera.quaternion);
  eye.position.add(eyeOffset);
  renderer.setViewport(x, 0, width, height);
  renderer.setScissor(x, 0, width, height);
  renderer.render(scene, eye);
}

function animate(now) {
  requestAnimationFrame(animate);
  const delta = Math.min((now - previousFrame) / 1000, 0.05);
  previousFrame = now;
  updateCameraRotation();
  moveCamera(delta);
  if (stereo) {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const half = Math.floor(width / 2);
    renderer.setScissorTest(true);
    renderer.clear();
    renderEye(leftEye, 0, half, height, -0.032);
    renderEye(rightEye, half, width - half, height, 0.032);
    renderer.setScissorTest(false);
  } else {
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.render(scene, camera);
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (headsetMode && !document.body.classList.contains("controls-visible")) {
    document.body.classList.add("controls-visible");
    setTimeout(() => document.body.classList.remove("controls-visible"), 5000);
  }
  if (stereo || motionEnabled) return;
  mouseLooking = true;
  lastX = event.clientX;
  lastY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!mouseLooking) return;
  yaw -= (event.clientX - lastX) * 0.003;
  pitch = THREE.MathUtils.clamp(pitch - (event.clientY - lastY) * 0.003, -1.3, 0.35);
  lastX = event.clientX;
  lastY = event.clientY;
});
const stopPointer = () => { mouseLooking = false; };
canvas.addEventListener("pointerup", stopPointer);
canvas.addEventListener("pointercancel", stopPointer);

window.addEventListener("keydown", (event) => {
  if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) event.preventDefault();
  keys.add(event.code);
});
window.addEventListener("keyup", (event) => keys.delete(event.code));
window.addEventListener("blur", () => { keys.clear(); touchMoves.clear(); });
document.querySelectorAll("[data-move]").forEach((button) => {
  const direction = button.dataset.move;
  button.addEventListener("pointerdown", (event) => { event.preventDefault(); touchMoves.add(direction); button.setPointerCapture(event.pointerId); });
  const release = () => touchMoves.delete(direction);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
});

document.querySelector("#motion-button").addEventListener("click", enableMotion);
stereoButton.addEventListener("click", () => toggleStereo());
document.querySelector("#recenter-button").addEventListener("click", recenter);
document.querySelector("#headset-button").addEventListener("click", async () => {
  if (headsetMode) {
    headsetMode = false;
    document.body.classList.remove("headset-mode", "controls-visible");
    toggleStereo(false);
    try { if (document.fullscreenElement) await document.exitFullscreen?.(); } catch { /* Fullscreen exit may be unavailable. */ }
    setStatus("Viewer mode is off. Use the controls panel to continue exploring.");
    return;
  }
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.("landscape");
  } catch { /* Browser fullscreen or orientation locking may be unavailable. */ }
  toggleStereo(true);
  headsetMode = !headsetMode;
  document.body.classList.toggle("headset-mode", headsetMode);
  document.body.classList.remove("controls-visible");
  setStatus("Viewer mode is on. Put the phone in the headset and turn your head.", "good");
});
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", resize);

if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) toggleStereo(true);
resize();
requestAnimationFrame(animate);
loadScene().catch((error) => {
  loadingCover.innerHTML = `<strong>Could not open Jezero terrain</strong><span>${error.message}</span>`;
  setStatus(error.message, "error");
});
