import * as THREE from "three";

const canvas = document.querySelector("#vr-scene");
const statusEl = document.querySelector("#vr-status");
const headingEl = document.querySelector("#heading-value");
const stereoButton = document.querySelector("#stereo-button");
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3b211b);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: "low-power" });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.25;

const camera = new THREE.PerspectiveCamera(76, 1, 0.05, 900);
camera.position.set(0, 2.2, 0);
const leftEye = new THREE.PerspectiveCamera(76, 1, 0.05, 900);
const rightEye = new THREE.PerspectiveCamera(76, 1, 0.05, 900);
const eyeOffset = new THREE.Vector3();
const initialOrientation = new THREE.Quaternion();
const currentOrientation = new THREE.Quaternion();
const relativeOrientation = new THREE.Quaternion();
const sensorEuler = new THREE.Euler();
const sensorQuaternion = new THREE.Quaternion();
const screenQuaternion = new THREE.Quaternion();
const zee = new THREE.Vector3(0, 0, 1);
const cameraCorrection = new THREE.Quaternion(-Math.sqrt(0.5), 0, 0, Math.sqrt(0.5));
const yawEuler = new THREE.Euler(0, 0, 0, "YXZ");

function createSkyTexture() {
  const width = 2048;
  const height = 1024;
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = width;
  textureCanvas.height = height;
  const ctx = textureCanvas.getContext("2d");
  const sky = ctx.createLinearGradient(0, 0, 0, height * 0.65);
  sky.addColorStop(0, "#23141b");
  sky.addColorStop(0.5, "#783d3b");
  sky.addColorStop(1, "#e29a62");
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);
  const sunGlow = ctx.createRadialGradient(width * 0.76, height * 0.47, 4, width * 0.76, height * 0.47, 210);
  sunGlow.addColorStop(0, "rgba(255,218,155,.95)");
  sunGlow.addColorStop(0.18, "rgba(255,177,111,.32)");
  sunGlow.addColorStop(1, "rgba(255,150,90,0)");
  ctx.fillStyle = sunGlow;
  ctx.fillRect(width * 0.55, height * 0.25, width * 0.42, height * 0.46);

  const ridgeLayer = (baseline, amplitude, color, phase, frequency) => {
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let x = 0; x <= width; x += 8) {
      const t = x / width;
      const y = baseline + Math.sin(t * frequency + phase) * amplitude + Math.sin(t * frequency * 2.37 + phase * 1.8) * amplitude * 0.31 + Math.sin(t * frequency * 0.47 + phase) * amplitude * 0.28;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  };
  ridgeLayer(height * 0.59, 65, "#8d4835", 0.3, 13);
  ridgeLayer(height * 0.64, 48, "#a65437", 2.1, 17);
  ridgeLayer(height * 0.70, 38, "#bd6641", 4.4, 11);
  ridgeLayer(height * 0.76, 28, "#d07848", 1.4, 19);

  ctx.globalAlpha = 0.2;
  for (let i = 0; i < 3500; i += 1) {
    const x = Math.random() * width;
    const y = height * 0.48 + Math.random() * height * 0.5;
    ctx.fillStyle = i % 3 ? "#572d28" : "#f0a06a";
    ctx.fillRect(x, y, Math.random() * 2.2 + 0.5, Math.random() * 2.2 + 0.5);
  }
  ctx.globalAlpha = 1;
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  texture.needsUpdate = true;
  return texture;
}

scene.background = createSkyTexture();
scene.add(new THREE.HemisphereLight(0xffd5a6, 0x3c211a, 2.0));
const sun = new THREE.DirectionalLight(0xffc28c, 2.6);
sun.position.set(-35, 65, -45);
scene.add(sun);

const terrainGeometry = new THREE.PlaneGeometry(420, 420, 180, 180);
terrainGeometry.rotateX(-Math.PI / 2);
const positions = terrainGeometry.attributes.position;
function terrainHeight(x, z) {
  let y = 0.12 * Math.sin(x * 0.065) + 0.16 * Math.cos(z * 0.071) + 0.08 * Math.sin((x + z) * 0.11);
  for (const crater of [[-34, -42, 10], [42, -72, 15], [64, 26, 11], [-78, 45, 19], [8, 86, 8], [-110, -10, 13]]) {
    const dx = x - crater[0];
    const dz = z - crater[1];
    const radius = Math.hypot(dx, dz);
    const r = crater[2];
    y += -1.25 * Math.exp(-((radius / (r * 0.68)) ** 2)) + 0.62 * Math.exp(-(((radius - r) / (r * 0.20)) ** 2));
  }
  return y;
}
for (let i = 0; i < positions.count; i += 1) {
  const x = positions.getX(i);
  const z = positions.getZ(i);
  positions.setY(i, terrainHeight(x, z));
}
terrainGeometry.computeVertexNormals();

const groundCanvas = document.createElement("canvas");
groundCanvas.width = 512;
groundCanvas.height = 512;
const groundCtx = groundCanvas.getContext("2d");
groundCtx.fillStyle = "#ae6343";
groundCtx.fillRect(0, 0, 512, 512);
for (let i = 0; i < 16000; i += 1) {
  const light = Math.random() > 0.5;
  groundCtx.fillStyle = light ? "rgba(229,157,104,.18)" : "rgba(66,34,29,.16)";
  groundCtx.fillRect(Math.random() * 512, Math.random() * 512, Math.random() * 3 + 1, Math.random() * 3 + 1);
}
const groundTexture = new THREE.CanvasTexture(groundCanvas);
groundTexture.colorSpace = THREE.SRGBColorSpace;
groundTexture.wrapS = THREE.RepeatWrapping;
groundTexture.wrapT = THREE.RepeatWrapping;
groundTexture.repeat.set(13, 13);
const terrain = new THREE.Mesh(terrainGeometry, new THREE.MeshStandardMaterial({ map: groundTexture, color: 0xffffff, roughness: 1, metalness: 0 }));
terrain.position.y = -0.3;
scene.add(terrain);

const rockMaterial = new THREE.MeshStandardMaterial({ color: 0x59342a, roughness: 1, flatShading: true });
for (let i = 0; i < 38; i += 1) {
  const angle = Math.random() * Math.PI * 2;
  const distance = 12 + Math.random() * 145;
  const size = 0.18 + Math.random() * 1.05;
  const rock = new THREE.Mesh(new THREE.DodecahedronGeometry(size, 0), rockMaterial);
  rock.position.set(Math.cos(angle) * distance, terrainHeight(Math.cos(angle) * distance, Math.sin(angle) * distance) + size * 0.6 - 0.25, Math.sin(angle) * distance);
  rock.rotation.set(Math.random(), Math.random(), Math.random());
  rock.scale.set(1.2, 0.72 + Math.random() * 0.75, 0.9);
  scene.add(rock);
}

function addCraterRing(x, z, radius) {
  const group = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(radius, Math.max(0.16, radius * 0.035), 5, 48), new THREE.MeshStandardMaterial({ color: 0xd38a5e, roughness: 1 }));
  rim.rotation.x = Math.PI / 2;
  group.add(rim);
  group.position.set(x, terrainHeight(x, z) - 0.24, z);
  scene.add(group);
}
addCraterRing(-34, -42, 10);
addCraterRing(42, -72, 15);
addCraterRing(64, 26, 11);
addCraterRing(-78, 45, 19);

// A glowing test beacon gives the viewer an obvious visual reference while turning.
const beacon = new THREE.Group();
const beaconCore = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.18, 2.2, 8), new THREE.MeshBasicMaterial({ color: 0xff6b4a }));
beaconCore.position.y = 1.1;
beacon.add(beaconCore);
const beaconLight = new THREE.PointLight(0xff784b, 5, 18);
beaconLight.position.y = 1.7;
beacon.add(beaconLight);
beacon.position.set(0, -0.25, -32);
scene.add(beacon);

let stereo = false;
let sensorEnabled = false;
let hasOrientation = false;
let mouseLooking = false;
let yaw = 0;
let pitch = 0;
let lastPointerX = 0;
let lastPointerY = 0;
let lastSensorAlpha = null;
let smoothHeading = 0;

function screenAngle() {
  return ((screen.orientation?.angle ?? window.orientation ?? 0) * Math.PI) / 180;
}

function orientationQuaternion(event) {
  if (event.alpha === null || event.beta === null || event.gamma === null) return null;
  const alpha = THREE.MathUtils.degToRad(event.alpha);
  const beta = THREE.MathUtils.degToRad(event.beta);
  const gamma = THREE.MathUtils.degToRad(event.gamma);
  sensorEuler.set(beta, alpha, -gamma, "YXZ");
  sensorQuaternion.setFromEuler(sensorEuler);
  screenQuaternion.setFromAxisAngle(zee, -screenAngle());
  sensorQuaternion.multiply(cameraCorrection).multiply(screenQuaternion);
  return sensorQuaternion.clone();
}

function onDeviceOrientation(event) {
  const orientation = orientationQuaternion(event);
  if (!orientation) return;
  if (!hasOrientation) {
    initialOrientation.copy(orientation);
    hasOrientation = true;
  }
  currentOrientation.copy(orientation);
  relativeOrientation.copy(initialOrientation).invert().multiply(currentOrientation);
  camera.quaternion.copy(relativeOrientation);
  yawEuler.setFromQuaternion(relativeOrientation, "YXZ");
  smoothHeading = THREE.MathUtils.radToDeg(yawEuler.y);
  lastSensorAlpha = event.alpha;
  headingEl.textContent = `${Math.round((smoothHeading + 360) % 360)}°`;
}

async function enableMotion() {
  if (!window.isSecureContext) {
    setStatus("Phone motion sensors need HTTPS or localhost. Connect over USB, run adb reverse, then open http://localhost:5001/vr-test.html on the phone.", true);
    return;
  }
  try {
    if (typeof DeviceOrientationEvent === "undefined") throw new Error("This browser does not expose device orientation sensors.");
    if (typeof DeviceOrientationEvent.requestPermission === "function") {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== "granted") throw new Error("Motion permission was not granted. Allow motion access and try again.");
    }
    window.addEventListener("deviceorientation", onDeviceOrientation, true);
    window.addEventListener("deviceorientationabsolute", onDeviceOrientation, true);
    sensorEnabled = true;
    setStatus("Move the phone slowly. If the view is not centered, tap Recenter view.");
    document.querySelector("#motion-button").textContent = "Motion enabled";
  } catch (error) {
    setStatus(error.message, true);
  }
}

function setStatus(message, error = false, good = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", error);
  statusEl.classList.toggle("is-good", good);
}

function recenter() {
  if (sensorEnabled && lastSensorAlpha !== null) {
    const latest = orientationQuaternion({ alpha: lastSensorAlpha, beta: THREE.MathUtils.radToDeg(sensorEuler.x), gamma: -THREE.MathUtils.radToDeg(sensorEuler.z) });
    if (latest) initialOrientation.copy(latest);
  } else {
    yaw = 0;
    pitch = 0;
    yawEuler.set(pitch, yaw, 0, "YXZ");
    camera.quaternion.setFromEuler(yawEuler);
  }
  headingEl.textContent = "0°";
  setStatus(sensorEnabled ? "View centered. Turn your head to check camera movement." : "View centered. Enable phone motion to test head tracking.", false, true);
}

function setStereo(value) {
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

function renderEye(eye, viewportX, viewportWidth, bufferHeight, eyeShift) {
  eye.position.copy(camera.position);
  eye.quaternion.copy(camera.quaternion);
  eyeOffset.set(eyeShift, 0, 0).applyQuaternion(camera.quaternion);
  eye.position.add(eyeOffset);
  renderer.setViewport(viewportX, 0, viewportWidth, bufferHeight);
  renderer.setScissor(viewportX, 0, viewportWidth, bufferHeight);
  renderer.render(scene, eye);
}

function animate() {
  requestAnimationFrame(animate);
  if (!sensorEnabled && !mouseLooking) {
    yawEuler.set(pitch, yaw, 0, "YXZ");
    camera.quaternion.setFromEuler(yawEuler);
  }
  if (stereo) {
    const fullWidth = window.innerWidth;
    const fullHeight = window.innerHeight;
    const half = Math.floor(fullWidth / 2);
    renderer.setScissorTest(true);
    renderer.clear();
    renderEye(leftEye, 0, half, fullHeight, -0.032);
    renderEye(rightEye, half, fullWidth - half, fullHeight, 0.032);
    renderer.setScissorTest(false);
  } else {
    renderer.setViewport(0, 0, window.innerWidth, window.innerHeight);
    renderer.render(scene, camera);
  }
}

canvas.addEventListener("pointerdown", (event) => {
  if (stereo || sensorEnabled) return;
  mouseLooking = true;
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener("pointermove", (event) => {
  if (!mouseLooking) return;
  yaw -= (event.clientX - lastPointerX) * 0.003;
  pitch = THREE.MathUtils.clamp(pitch - (event.clientY - lastPointerY) * 0.003, -1.25, 1.25);
  lastPointerX = event.clientX;
  lastPointerY = event.clientY;
});
const stopPointer = () => { mouseLooking = false; };
canvas.addEventListener("pointerup", stopPointer);
canvas.addEventListener("pointercancel", stopPointer);

document.querySelector("#motion-button").addEventListener("click", enableMotion);
stereoButton.addEventListener("click", () => setStereo(!stereo));
document.querySelector("#recenter-button").addEventListener("click", recenter);
document.querySelector("#fullscreen-button").addEventListener("click", async () => {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.();
    await screen.orientation?.lock?.("landscape");
  } catch { /* Fullscreen/orientation lock may be unavailable in an installed browser. */ }
  setStereo(true);
  setStatus(sensorEnabled ? "Headset mode on. Put the phone in your viewer and turn your head." : "Split-screen is on. Enable phone motion, then place the phone in your viewer.");
});
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", resize);

const mobileDevice = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
setStereo(mobileDevice);
resize();
animate();

if (!window.isSecureContext) setStatus("Desktop preview: drag to look. For phone sensors, open from HTTPS or phone localhost (USB/ADB steps below).", true);
