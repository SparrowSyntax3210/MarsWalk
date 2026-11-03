import * as THREE from "three";

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
let sceneData;
let elevationValues;
let validValues;
let gridColumns = 256;
let gridRows = 588;
let sceneWidth;
let sceneLength;
let crop = null;
let groundHeightAtStart = 0;
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

function heightAtGrid(column, row) {
  const x = THREE.MathUtils.clamp(Math.round(column), 0, gridColumns - 1);
  const y = THREE.MathUtils.clamp(Math.round(row), 0, gridRows - 1);
  const index = y * gridColumns + x;
  if (!validValues[index]) return groundHeightAtStart;
  return elevationValues[index];
}

function terrainY(column, row) {
  return (heightAtGrid(column, row) - sceneData.elevation_min_m) * sceneData.horizontal_scene_scale * sceneData.vertical_exaggeration;
}

function buildTerrain(heightPixels, texture) {
  const imgWidth = heightPixels.width;
  const imgHeight = heightPixels.height;
  const requestedSizeM = Math.min(sceneData.region_size_m ?? 5000, sceneData.width_m, sceneData.height_m);
  const pixelsPerMeterX = (imgWidth - 1) / sceneData.width_m;
  const pixelsPerMeterY = (imgHeight - 1) / sceneData.height_m;
  const cropWidth = Math.min(imgWidth - 1, Math.max(2, Math.round(requestedSizeM * pixelsPerMeterX)));
  const cropHeight = Math.min(imgHeight - 1, Math.max(2, Math.round(requestedSizeM * pixelsPerMeterY)));
  const cropX = Math.floor((imgWidth - cropWidth) / 2);
  const cropY = Math.floor((imgHeight - cropHeight) / 2);
  crop = { x: cropX, y: cropY, width: cropWidth, height: cropHeight };
  gridRows = cropHeight + 1;
  gridColumns = cropWidth + 1;
  const sampleCanvas = document.createElement("canvas");
  sampleCanvas.width = imgWidth;
  sampleCanvas.height = imgHeight;
  const context = sampleCanvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(heightPixels, 0, 0);
  const pixels = context.getImageData(0, 0, imgWidth, imgHeight).data;
  const vertexCount = gridColumns * gridRows;
  const positions = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  elevationValues = new Float32Array(vertexCount);
  validValues = new Uint8Array(vertexCount);
  sceneWidth = (cropWidth / (imgWidth - 1)) * sceneData.width_m * sceneData.horizontal_scene_scale;
  sceneLength = (cropHeight / (imgHeight - 1)) * sceneData.height_m * sceneData.horizontal_scene_scale;

  for (let row = 0; row < gridRows; row += 1) {
    const sourceRow = cropY + row;
    for (let column = 0; column < gridColumns; column += 1) {
      const sourceColumn = cropX + column;
      const sourceIndex = (sourceRow * imgWidth + sourceColumn) * 4;
      const index = row * gridColumns + column;
      const normalized = pixels[sourceIndex] * 256 + pixels[sourceIndex + 1];
      elevationValues[index] = sceneData.elevation_min_m + (normalized / 65535) * (sceneData.elevation_max_m - sceneData.elevation_min_m);
      validValues[index] = pixels[sourceIndex + 2] > 127 ? 1 : 0;
      positions[index * 3] = (column / (gridColumns - 1) - 0.5) * sceneWidth;
      positions[index * 3 + 1] = terrainY(column, row);
      positions[index * 3 + 2] = (0.5 - row / (gridRows - 1)) * sceneLength;
      uvs[index * 2] = sourceColumn / (imgWidth - 1);
      uvs[index * 2 + 1] = 1 - sourceRow / (imgHeight - 1);
    }
  }

  const indices = [];
  for (let row = 0; row < gridRows - 1; row += 1) {
    for (let column = 0; column < gridColumns - 1; column += 1) {
      const northwest = row * gridColumns + column;
      const northeast = northwest + 1;
      const southwest = northwest + gridColumns;
      const southeast = southwest + 1;
      if (validValues[northwest] && validValues[northeast] && validValues[southwest]) indices.push(northwest, southwest, northeast);
      if (validValues[northeast] && validValues[southwest] && validValues[southeast]) indices.push(northeast, southwest, southeast);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  const terrain = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0, side: THREE.DoubleSide }));
  scene.add(terrain);

  const centerElevation = heightAtGrid(Math.floor(gridColumns / 2), Math.floor(gridRows / 2));
  groundHeightAtStart = (centerElevation - sceneData.elevation_min_m) * sceneData.horizontal_scene_scale * sceneData.vertical_exaggeration;
  const startColumn = Math.floor(gridColumns / 2);
  const startRow = Math.floor(gridRows * 0.72);
  camera.position.set(0, terrainY(startColumn, startRow) + 2, (0.5 - startRow / (gridRows - 1)) * sceneLength);
  positionValue.textContent = "Jezero · CTX stereo DTM";
}

async function loadScene() {
  const [manifestResponse] = await Promise.all([fetch("./data/jezero3d/scene.json")]);
  if (!manifestResponse.ok) throw new Error("The compact Jezero terrain files were not found. Run the Jezero web terrain export script first.");
  sceneData = await manifestResponse.json();
  const textureLoader = new THREE.TextureLoader();
  const [surfaceTexture, heightPixels] = await Promise.all([
    new Promise((resolve, reject) => textureLoader.load(sceneData.texture, resolve, undefined, reject)),
    new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not load the Jezero heightmap image."));
      image.src = sceneData.heightmap;
    }),
  ]);
  surfaceTexture.colorSpace = THREE.SRGBColorSpace;
  surfaceTexture.anisotropy = Math.min(renderer.capabilities.getMaxAnisotropy(), 4);
  buildTerrain(heightPixels, surfaceTexture);
  const renderedSpacing = Math.round(Math.max(sceneWidth / (gridColumns - 1), sceneLength / (gridRows - 1)));
  document.querySelector("#data-resolution").textContent = `~${Math.round(sceneData.source_resolution_m[0])} m DTM source · ~${renderedSpacing} m rendered mesh · ${(sceneWidth / 1000).toFixed(1)} × ${(sceneLength / 1000).toFixed(1)} km playable patch.`;
  loadingCover.classList.add("is-hidden");
  setTimeout(() => loadingCover.remove(), 450);
  setStatus("Jezero terrain loaded. Turn your head to look around; use keys, touch arrows, or a gamepad to move.", "good");
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
  if (!elevationValues) return;
  const movement = movementInput();
  camera.getWorldDirection(forward);
  forward.y = 0;
  if (forward.lengthSq() > 0) forward.normalize();
  right.set(forward.z, 0, -forward.x).normalize();
  const previousX = camera.position.x;
  const previousZ = camera.position.z;
  const speed = (keys.has("ShiftLeft") || keys.has("ShiftRight") ? 12 : 4.5) * sceneData.horizontal_scene_scale;
  camera.position.addScaledVector(forward, -movement.z * speed * delta);
  camera.position.addScaledVector(right, movement.x * speed * delta);
  camera.position.x = THREE.MathUtils.clamp(camera.position.x, -sceneWidth / 2, sceneWidth / 2);
  camera.position.z = THREE.MathUtils.clamp(camera.position.z, -sceneLength / 2, sceneLength / 2);
  const column = ((camera.position.x / sceneWidth) + 0.5) * (gridColumns - 1);
  const row = (0.5 - camera.position.z / sceneLength) * (gridRows - 1);
  const floor = terrainY(column, row);
  camera.position.y = floor + 1.7 * sceneData.horizontal_scene_scale;
  const distance = Math.hypot(camera.position.x - previousX, camera.position.z - previousZ);
  walkedMeters += distance / sceneData.horizontal_scene_scale;
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
