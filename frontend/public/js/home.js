import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

const MODEL_URL = "./assets/24881_Mars_1_6792.glb";

/* The hero planet and chapter 01's globe are the same object. It is positioned
   by screen rectangle rather than by world coordinates: the hero defines a
   start rect, #planet-dock defines an end rect, and scroll interpolates
   between them. Because the dock rect is re-measured every frame, the planet
   stays glued to the section once it has landed, however the page reflows. */

// Hero anchor, as a share of the viewport. Reproduces where the planet used
// to sit: centred horizontally and low enough to clear the headline.
const HERO_DIAMETER_VW = 1.15;
const HERO_DIAMETER_VH = 0.68;
const HERO_CENTRE_Y = 0.735;

/* Intro. On arrival the planet holds the screen on its own, centred, with no
   headline. The first scroll floats it down to the seated position above and
   brings the copy in. Vertical only — the diameter does not change — which is
   what makes it read as the planet settling rather than receding. */
const INTRO_CENTRE_Y = 0.5;
// Share of the hero's copy travel spent on the intro.
const INTRO_END = 0.22;
// Where in that travel the headline starts arriving. Kept close to INTRO_END
// so the planet has almost finished settling first — reveal much earlier and
// the subtitle and button land on the planet's lit limb and stop being legible.
const COPY_REVEAL = 0.19;
// The copy holds still between the intro and this point, then leaves.
const EXIT_START = 0.42;

// The planet fills most, not all, of the dock box so the annotation has room.
const DOCK_FILL = 0.9;

// Flight begins this far into the hero's pinned scroll range — lined up with
// EXIT_START so the planet leaves as the copy does, not during the hold.
const FLIGHT_START = 0.42;

// Axis tilt eases between the two framings over the course of the flight.
const HERO_TILT = { z: -9, x: 4 };
const DOCK_TILT = { z: -14, x: 6 };

// Reveal styling is gated on this class so a script failure leaves the page
// fully readable instead of blank.
document.documentElement.classList.add("js");

const loadingNote = document.querySelector("#loading-note");
const motionToggle = document.querySelector("#motion-toggle");
const motionLabel = motionToggle.querySelector("span:last-child");
const motionIcon = motionToggle.querySelector(".motion-icon");
const landingScreen = document.querySelector("#landing-screen");
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

let isPaused = prefersReducedMotion.matches;
// The intro is scroll-driven, so visitors who have asked for less motion get
// the headline straight away rather than having to scroll to uncover it.
let revealCopyImmediately = prefersReducedMotion.matches;
let scrollProgress = 0;
// 0 = planet alone and centred, 1 = settled low with the headline in place.
let introProgress = 0;
// Remapped from scrollProgress so the copy's fade only starts after the intro
// has finished. Sharing one curve would have the headline fading out before it
// had finished arriving.
let exitProgress = 0;

/* ------------------------------------------------------------------
   Shared model load
   The GLB is 3.9 MB, so it is fetched and parsed once and then cloned
   for each globe on the page. Cloning shares geometry and textures.
   ------------------------------------------------------------------ */
let modelPromise = null;

function loadMarsModel() {
  modelPromise ||= new Promise((resolve, reject) => {
    new GLTFLoader().load(
      MODEL_URL,
      (gltf) => {
        const source = gltf.scene;
        const bounds = new THREE.Box3().setFromObject(source);
        const size = bounds.getSize(new THREE.Vector3());
        resolve({
          source,
          center: bounds.getCenter(new THREE.Vector3()),
          largestDimension: Math.max(size.x, size.y, size.z),
        });
      },
      undefined,
      reject,
    );
  });
  return modelPromise;
}

/* ------------------------------------------------------------------
   Globe factory
   ------------------------------------------------------------------ */
const globes = [];

function createGlobe(canvas, options = {}) {
  const {
    fov = 38,
    distance = 4.15,
    fit = 2.55,
    spin = 0.085,
    tiltZ = -9,
    tiltX = 4,
    exposure = 1.15,
    resize,
    update,
  } = options;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
  camera.position.set(0, 0, distance);

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: true,
    powerPreference: "high-performance",
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = exposure;

  scene.add(new THREE.HemisphereLight(0xfbd6bd, 0x260c08, 1.6));

  const sunLight = new THREE.DirectionalLight(0xffe2c6, 3.1);
  sunLight.position.set(-3.5, 4.2, 5);
  scene.add(sunLight);

  const rimLight = new THREE.DirectionalLight(0xc85227, 2.2);
  rimLight.position.set(4, -1, -4);
  scene.add(rimLight);

  const group = new THREE.Group();
  scene.add(group);

  const globe = {
    canvas,
    scene,
    camera,
    renderer,
    group,
    spin,
    baseDistance: distance,
    ready: false,
    // Rendering is gated on visibility, so a first frame is always needed.
    dirty: true,
    visible: true,
    resize,
    update,
  };

  resizeGlobe(globe);
  globes.push(globe);

  loadMarsModel()
    .then(({ source, center, largestDimension }) => {
      const model = source.clone(true);
      model.position.sub(center);
      model.scale.setScalar(fit / largestDimension);
      group.add(model);

      // A gentle tilt so the rotation axis reads clearly.
      group.rotation.z = THREE.MathUtils.degToRad(tiltZ);
      group.rotation.x = THREE.MathUtils.degToRad(tiltX);

      globe.ready = true;
      globe.dirty = true;
      loadingNote.classList.add("is-hidden");
      // Deliberately does NOT reveal the headline: the opening shot is the
      // planet alone, and the copy arrives on the visitor's first scroll.
    })
    .catch((error) => {
      console.error("Could not load the Mars GLB model.", error);
      loadingNote.textContent = "3D model unavailable — check the model file path.";
      loadingNote.classList.add("is-error");
    });

  return globe;
}

function resizeGlobe(globe) {
  const width = globe.canvas.clientWidth;
  const height = globe.canvas.clientHeight;
  if (width < 2 || height < 2) return;
  globe.renderer.setSize(width, height, false);
  globe.camera.aspect = width / height;
  if (globe.resize) globe.resize(globe, width, height);
  globe.camera.updateProjectionMatrix();
  globe.dirty = true;
}

/* ------------------------------------------------------------------
   The shared planet — hero to chapter 01
   ------------------------------------------------------------------ */
const flightCanvas = document.querySelector("#planet-flight");
const planetDock = document.querySelector("#planet-dock");
const heroTrack = document.querySelector(".hero-track");
const heroBackdrop = document.querySelector(".hero-backdrop");

const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (t) => t * t * (3 - 2 * t);

/* Pixels per world unit at the model plane. The planet's clone is normalised
   to radius 1, so a group scale of r renders a sphere r * pxPerUnit pixels in
   radius. That inversion is what lets a CSS rect drive a 3D object. */
function pixelsPerUnit(globe) {
  const halfHeight =
    globe.camera.position.z * Math.tan(THREE.MathUtils.degToRad(globe.camera.fov / 2));
  return globe.canvas.clientHeight / 2 / halfHeight;
}

/* The hero's own two-stage framing: centred on arrival, seated low once the
   headline is in. Returns the blend for the current intro progress, which the
   flight then treats as its starting rect. */
function heroAnchor() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const d = Math.min(vw * HERO_DIAMETER_VW, vh * HERO_DIAMETER_VH);
  const settle = smoothstep(introProgress);
  return {
    cx: vw / 2,
    cy: lerp(vh * INTRO_CENTRE_Y, vh * HERO_CENTRE_Y, settle),
    d,
  };
}

function dockAnchor() {
  const r = planetDock.getBoundingClientRect();
  return {
    cx: r.left + r.width / 2,
    cy: r.top + r.height / 2,
    d: Math.min(r.width, r.height) * DOCK_FILL,
  };
}

/* 0 while the hero holds the planet, 1 once it has landed in the dock. The
   end point is the scroll offset that centres the dock in the viewport, so
   the planet touches down exactly as its slot reaches the middle of the
   screen — and clamping at 1 leaves it docked for the rest of the page. */
let flight = 0;

function updateFlight() {
  const r = planetDock.getBoundingClientRect();
  const dockCentreInDocument = r.top + window.scrollY + r.height / 2;
  const end = dockCentreInDocument - window.innerHeight / 2;
  const pinnedRange = Math.max(1, heroTrack.offsetHeight - window.innerHeight);
  const start = pinnedRange * FLIGHT_START;
  flight = THREE.MathUtils.clamp((window.scrollY - start) / Math.max(1, end - start), 0, 1);
}

const planet = !flightCanvas ? null : createGlobe(flightCanvas, {
  fov: 38,
  distance: 6,
  fit: 2, // normalises the clone to radius 1
  spin: 0.07,
  // Position is set from screen rects every frame, so there is nothing to ease
  // toward and no per-frame interpolation: the planet tracks scroll exactly.
  // That keeps it pixel-locked to its slot once docked, with the motion's
  // weight coming from the smoothstep curve instead of from temporal lag.
  update: (globe) => {
    const unit = pixelsPerUnit(globe);
    if (!unit || !Number.isFinite(unit)) return false;

    const t = smoothstep(flight);
    const from = heroAnchor();
    const to = dockAnchor();
    const cx = lerp(from.cx, to.cx, t);
    const cy = lerp(from.cy, to.cy, t);
    const d = lerp(from.d, to.d, t);

    const x = (cx - globe.canvas.clientWidth / 2) / unit;
    const y = (globe.canvas.clientHeight / 2 - cy) / unit;
    const scale = d / 2 / unit;

    const moved =
      Math.abs(globe.group.position.x - x) > 0.0002 ||
      Math.abs(globe.group.position.y - y) > 0.0002 ||
      Math.abs(globe.group.scale.x - scale) > 0.0002;

    globe.group.position.set(x, y, 0);
    globe.group.scale.setScalar(scale);
    globe.group.rotation.z = THREE.MathUtils.degToRad(lerp(HERO_TILT.z, DOCK_TILT.z, t));
    globe.group.rotation.x = THREE.MathUtils.degToRad(lerp(HERO_TILT.x, DOCK_TILT.x, t));

    // Skip the draw entirely once the planet has scrolled past the viewport.
    globe.onScreen = cy + d / 2 > -120 && cy - d / 2 < window.innerHeight + 120;

    // Keep the bloom pinned to the planet, in the same viewport coordinates.
    heroBackdrop?.style.setProperty("--glow-x", `${cx.toFixed(1)}px`);
    heroBackdrop?.style.setProperty("--glow-y", `${cy.toFixed(1)}px`);
    heroBackdrop?.style.setProperty("--glow-d", `${(d * 1.35).toFixed(1)}px`);

    return moved;
  },
});

const surfaceCanvas = document.querySelector("#globe-surface");
if (surfaceCanvas) {
  createGlobe(surfaceCanvas, { fov: 34, distance: 3.3, fit: 1.84, spin: 0.04, tiltZ: -6, tiltX: 10 });
}

const regionCanvas = document.querySelector("#globe-region");
if (regionCanvas) {
  createGlobe(regionCanvas, { fov: 34, distance: 3.4, fit: 1.9, spin: 0.07, tiltZ: -10, tiltX: 4 });
}

/* ------------------------------------------------------------------
   Only render globes that are on screen
   ------------------------------------------------------------------ */
if ("IntersectionObserver" in window) {
  const visibility = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const globe = globes.find((item) => item.canvas === entry.target);
        if (!globe) continue;
        globe.visible = entry.isIntersecting;
        if (entry.isIntersecting) globe.dirty = true;
      }
    },
    { rootMargin: "120px" },
  );
  // The flight canvas is viewport-fixed, so it always intersects and the
  // observer tells us nothing. Its own update() sets `onScreen` from the
  // planet's rect instead.
  globes
    .filter((globe) => globe.canvas !== flightCanvas)
    .forEach((globe) => visibility.observe(globe.canvas));
}

if ("ResizeObserver" in window) {
  const sizes = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const globe = globes.find((item) => item.canvas === entry.target);
      if (globe) resizeGlobe(globe);
    }
  });
  globes.forEach((globe) => sizes.observe(globe.canvas));
} else {
  window.addEventListener("resize", () => globes.forEach(resizeGlobe));
}

/* ------------------------------------------------------------------
   Motion toggle — pauses every globe and the CSS sweep animations
   ------------------------------------------------------------------ */
function setMotionButton() {
  motionToggle.setAttribute("aria-pressed", String(isPaused));
  motionLabel.textContent = isPaused ? "Resume rotation" : "Pause rotation";
  motionIcon.textContent = isPaused ? "▶" : "Ⅱ";
  document.body.classList.toggle("is-motion-paused", isPaused);
}

motionToggle.addEventListener("click", () => {
  isPaused = !isPaused;
  setMotionButton();
});

prefersReducedMotion.addEventListener("change", (event) => {
  if (!event.matches) return;
  isPaused = true;
  revealCopyImmediately = true;
  updateScrollState();
  setMotionButton();
});

/* ------------------------------------------------------------------
   Hero reveal on scroll
   ------------------------------------------------------------------ */
function updateScrollState() {
  const travelDistance = Math.max(1, window.innerHeight * 0.82);
  scrollProgress = THREE.MathUtils.clamp(window.scrollY / travelDistance, 0, 1);
  introProgress = THREE.MathUtils.clamp(scrollProgress / INTRO_END, 0, 1);
  exitProgress = THREE.MathUtils.clamp(
    (scrollProgress - EXIT_START) / (1 - EXIT_START),
    0,
    1,
  );

  // Set on :root, not on the hero, because the backdrop and the bloom that
  // read this now live outside .landing — they have to sit behind the planet.
  document.documentElement.style.setProperty("--hero-exit", exitProgress.toFixed(4));
  landingScreen.classList.toggle("is-scrolled", window.scrollY > 24);
  // Hands the hero chrome off to the next chapter once the copy has left.
  landingScreen.classList.toggle("is-exiting", exitProgress > 0.52);
  // Toggled rather than added once, so scrolling back to the top restores the
  // opening shot of the planet on its own.
  landingScreen.classList.toggle(
    "is-revealed",
    revealCopyImmediately || scrollProgress > COPY_REVEAL,
  );

  updateFlight();
  if (planet) planet.dirty = true;
}

window.addEventListener("scroll", updateScrollState, { passive: true });
// The dock rect moves on reflow, so the flight has to be remeasured too.
window.addEventListener("resize", updateScrollState);

/* ------------------------------------------------------------------
   Chapter reveals
   ------------------------------------------------------------------ */
const chapters = document.querySelectorAll(".chapter, .closing");

if ("IntersectionObserver" in window) {
  const reveal = new IntersectionObserver(
    (entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
  );
  chapters.forEach((chapter) => reveal.observe(chapter));
} else {
  chapters.forEach((chapter) => chapter.classList.add("is-visible"));
}

/* ------------------------------------------------------------------
   Frame loop
   ------------------------------------------------------------------ */
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.1);
  if (document.hidden) return;

  for (const globe of globes) {
    if (!globe.visible) continue;
    // update() runs first so the flying planet can report itself off-screen
    // before we decide whether drawing it is worth the cost.
    let changed = globe.dirty;
    if (globe.update && globe.update(globe, delta)) changed = true;
    if (globe.onScreen === false) continue;
    if (globe.ready && !isPaused) {
      // Rotate on the planet's own axis, independent of frame rate.
      globe.group.rotation.y += delta * globe.spin;
      changed = true;
    }
    if (!changed) continue;
    globe.renderer.render(globe.scene, globe.camera);
    globe.dirty = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  clock.getDelta();
  globes.forEach((globe) => { globe.dirty = true; });
});

updateScrollState();
setMotionButton();
requestAnimationFrame(animate);

// Guard against the hero note lingering if the model is served from cache
// before this listener attaches.
if (planet?.ready) loadingNote.classList.add("is-hidden");
