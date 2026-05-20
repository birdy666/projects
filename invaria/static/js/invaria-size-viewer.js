(function () {
    const REMOTE_PLY_BASE =
        "https://raw.githubusercontent.com/birdy666/assets/main/invaria/ply_size";
    // For local testing, symlink:
    //   ln -s /Users/birdy/visualization/assets_out/invaria/ply_size invaria/static/ply_size
    const IS_LOCAL = location.hostname === "localhost" ||
                     location.hostname === "127.0.0.1" ||
                     location.protocol === "file:";
    const LOCAL_PLY_BASE = "./static/ply_size";
    const PLY_BASE_URL = IS_LOCAL ? LOCAL_PLY_BASE : REMOTE_PLY_BASE;

    const MODELS = ["mink", "ptv3", "sonata", "utonia", "ours"];
    const SCALES = ["regular", "smaller"];  // regular = left (default), smaller = right (3x smaller)
    const DEFAULT_OBJECT = "scene0064_00_inst8";

    const CLASS_NAMES = [
        "wall", "floor", "cabinet", "bed", "chair",
        "sofa", "table", "door", "window", "bookshelf",
        "picture", "counter", "desk", "curtain", "refrigerator",
        "shower curtain", "toilet", "sink", "bathtub", "otherfurniture",
        "unlabeled",
    ];
    const CLASS_COLORS = [
        "rgb(174,199,232)", "rgb(152,223,138)", "rgb(31,119,180)", "rgb(255,187,120)",
        "rgb(188,189,34)",  "rgb(140,86,75)",   "rgb(255,152,150)", "rgb(214,39,40)",
        "rgb(197,176,213)", "rgb(148,103,189)", "rgb(196,156,148)", "rgb(23,190,207)",
        "rgb(247,182,210)", "rgb(219,219,141)", "rgb(255,127,14)",  "rgb(158,218,229)",
        "rgb(44,160,44)",   "rgb(112,128,144)", "rgb(227,119,194)", "rgb(82,84,163)",
        "rgb(0,0,0)",
    ];

    function makePointMaterial(size) {
        return new THREE.ShaderMaterial({
            uniforms: { pointSize: { value: size } },
            vertexShader: `
                uniform float pointSize;
                varying vec3 vColor;
                void main() {
                    vColor = color;
                    gl_PointSize = pointSize;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }`,
            fragmentShader: `
                varying vec3 vColor;
                void main() { gl_FragColor = vec4(vColor, 1.0); }`,
            vertexColors: true,
        });
    }

    // Load a PLY. On local previews we try ./static first and, if it 404s (e.g.
    // previewing from a remote machine without the symlink), fall back to the
    // public assets repo so the page still works over a forwarded localhost port.
    function loadPLYGeometry(path) {
        const load = (url) => new Promise((resolve, reject) => {
            new THREE.PLYLoader().load(url, resolve, undefined, reject);
        });
        return load(path).catch((err) => {
            if (path.startsWith(LOCAL_PLY_BASE)) {
                return load(path.replace(LOCAL_PLY_BASE, REMOTE_PLY_BASE));
            }
            throw err;
        });
    }

    const TARGET_SIZE = 1.0;   // every cloud is normalized to this max dimension

    // Center a geometry at the origin (no rescaling). Returns its largest dimension
    // so callers can derive a scale factor.
    function centerGeometry(geo) {
        geo.computeBoundingBox();
        const center = new THREE.Vector3();
        const size = new THREE.Vector3();
        geo.boundingBox.getCenter(center);
        geo.boundingBox.getSize(size);
        geo.translate(-center.x, -center.y, -center.z);
        return Math.max(size.x, size.y, size.z) || 1;
    }

    // Center a geometry and scale its largest dimension to TARGET_SIZE.
    function normalizeGeometry(geo) {
        const maxDim = centerGeometry(geo);
        const s = TARGET_SIZE / maxDim;
        geo.scale(s, s, s);
        geo.computeBoundingBox();
    }

    class BaseViewer {
        constructor(containerId, manager) {
            this.containerId = containerId;
            this.manager = manager;
            this.config = {
                camera: { fov: 45, near: 0.01, far: 2000 },
                material: { size: 3.0 },   // single objects look better with slightly bigger points
                bg: 0xffffff,
            };
        }

        getCanvasDimensions() {
            const el = document.getElementById(this.containerId);
            const w = el.clientWidth;
            const h = el.clientHeight || w;
            return { w: Math.max(1, w), h: Math.max(1, h) };
        }

        // Aspect of the area this viewer actually renders into. Overridden by
        // SplitViewer, which renders two half-width viewports.
        getAspect(w, h) { return w / h; }

        initThree() {
            const { w, h } = this.getCanvasDimensions();
            this.camera = new THREE.PerspectiveCamera(
                this.config.camera.fov, this.getAspect(w, h),
                this.config.camera.near, this.config.camera.far);
            this.camera.position.set(3, -5, 3);
            this.camera.up.set(0, 0, 1);

            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(this.config.bg);

            this.renderer = new THREE.WebGLRenderer({ antialias: true });
            this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
            this.renderer.setSize(w, h);
            const container = document.getElementById(this.containerId);
            container.innerHTML = "";
            container.appendChild(this.renderer.domElement);

            this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
            this.controls.minDistance = 0.05;
            this.controls.maxDistance = 200;
            this.controls.enableDamping = false;
            this.controls.addEventListener("change", () =>
                this.manager.synchronizeControls(this));

            this.attachControlButtonListeners();
        }

        attachControlButtonListeners() {
            const wrapper = document.getElementById(this.containerId).parentNode;
            wrapper.querySelector(".sv-zoom-in-button")
                ?.addEventListener("click", () => this.simulateZoom(true));
            wrapper.querySelector(".sv-zoom-out-button")
                ?.addEventListener("click", () => this.simulateZoom(false));
            wrapper.querySelector(".sv-reset-button")
                ?.addEventListener("click", () => this.manager.resetAll());
        }

        simulateZoom(zoomIn) {
            this.renderer.domElement.dispatchEvent(new WheelEvent("wheel", {
                deltaY: zoomIn ? -100 : 100, bubbles: true, cancelable: true }));
        }

        adjustCanvasSize() {
            const { w, h } = this.getCanvasDimensions();
            this.camera.aspect = this.getAspect(w, h);
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
            this.render();
        }

        resetView(dist) {
            const d = dist || 2;
            this.camera.position.set(d * 0.6, -d * 0.8, d * 0.5);
            this.camera.up.set(0, 0, 1);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
            this.render();
        }
    }

    class SingleViewer extends BaseViewer {
        constructor(containerId, plyPath, manager) {
            super(containerId, manager);
            this.plyPath = plyPath;
            this.points = null;
            this.initThree();
            this.loadPLY();
        }

        async loadPLY() {
            try {
                const geo = await loadPLYGeometry(this.plyPath);
                normalizeGeometry(geo);

                if (this.points) {
                    this.scene.remove(this.points);
                    this.points.geometry.dispose();
                }
                this.points = new THREE.Points(geo, makePointMaterial(this.config.material.size));
                this.scene.add(this.points);

                if (this.manager.isPrimary(this)) {
                    this.manager.frameAll(TARGET_SIZE * 2.7);
                }
                this.render();
            } catch (err) {
                console.error(`PLY load error (${this.plyPath}):`, err);
            }
        }

        render() { this.renderer.render(this.scene, this.camera); }

        setPath(path) {
            this.plyPath = path;
            this.loadPLY();
        }
    }

    class SplitViewer extends BaseViewer {
        constructor(containerId, plyA, plyB, manager) {
            super(containerId, manager);
            this.plyA = plyA;          // left  (default scale)
            this.plyB = plyB;          // right (3x smaller)
            this.pointsA = null;
            this.pointsB = null;
            this.initThree();
            this.createDivider();
            this.loadPair();
        }

        // Each half is its own viewport, so use the half-width aspect to keep the
        // two clouds undistorted.
        getAspect(w, h) { return (w * 0.5) / h; }

        // A static, non-interactive divider marking the fixed 50/50 boundary.
        createDivider() {
            const wrapper = document.getElementById(this.containerId).parentNode;
            const old = wrapper.querySelector(".sv-divider");
            if (old) old.remove();

            const divider = document.createElement("div");
            divider.className = "sv-divider";
            wrapper.appendChild(divider);
            this.divider = divider;
            this.wrapper = wrapper;
        }

        async loadPair() {
            try {
                const [geoA, geoB] = await Promise.all([
                    loadPLYGeometry(this.plyA),
                    loadPLYGeometry(this.plyB),
                ]);
                // Center each cloud, then scale BOTH by the same factor (sized so the
                // default object fills the panel). The 3x-smaller input therefore keeps
                // its true ~1/3 proportion, so the scale change stays visible.
                const maxDefault = centerGeometry(geoA);
                centerGeometry(geoB);
                const s = TARGET_SIZE / maxDefault;
                geoA.scale(s, s, s);
                geoB.scale(s, s, s);
                geoA.computeBoundingBox();
                geoB.computeBoundingBox();

                if (this.pointsA) { this.scene.remove(this.pointsA); this.pointsA.geometry.dispose(); }
                if (this.pointsB) { this.scene.remove(this.pointsB); this.pointsB.geometry.dispose(); }

                this.pointsA = new THREE.Points(geoA, makePointMaterial(this.config.material.size));
                this.pointsB = new THREE.Points(geoB, makePointMaterial(this.config.material.size));
                this.pointsA.layers.set(0);
                this.pointsB.layers.set(1);
                this.scene.add(this.pointsA);
                this.scene.add(this.pointsB);

                if (this.manager.isPrimary(this)) {
                    this.manager.frameAll(TARGET_SIZE * 2.7);
                }
                this.render();
            } catch (err) {
                console.error(`PLY load error (split: ${this.plyA} | ${this.plyB}):`, err);
            }
        }

        render() {
            if (!this.renderer || !this.camera) return;
            const size = this.renderer.getSize(new THREE.Vector2());
            const w = Math.max(1, Math.floor(size.x));
            const h = Math.max(1, Math.floor(size.y));
            const splitX = Math.floor(w * 0.5);

            this.renderer.setScissorTest(false);
            this.renderer.clear(true, true, true);
            this.renderer.setScissorTest(true);

            // Left half: default scale (layer 0), framed in its own viewport.
            this.camera.layers.set(0);
            this.renderer.setViewport(0, 0, splitX, h);
            this.renderer.setScissor(0, 0, splitX, h);
            this.renderer.render(this.scene, this.camera);

            // Right half: 3x smaller (layer 1), framed in its own viewport.
            this.camera.layers.set(1);
            this.renderer.setViewport(splitX, 0, w - splitX, h);
            this.renderer.setScissor(splitX, 0, w - splitX, h);
            this.renderer.render(this.scene, this.camera);

            this.renderer.setScissorTest(false);
            this.renderer.setViewport(0, 0, w, h);
        }

        setPaths(plyA, plyB) {
            this.plyA = plyA;
            this.plyB = plyB;
            this.loadPair();
        }
    }

    class ViewerManager {
        constructor() {
            this.viewers = [];
            this.syncing = false;
            this.lastFrameDist = 2;
        }

        addViewer(v) { this.viewers.push(v); }
        isPrimary(v) { return this.viewers[0] === v; }

        synchronizeControls(active) {
            if (this.syncing) return;
            this.syncing = true;
            this.viewers.forEach((v) => {
                if (v !== active) {
                    v.camera.position.copy(active.camera.position);
                    v.camera.rotation.copy(active.camera.rotation);
                    v.camera.up.copy(active.camera.up);
                    v.controls.target.copy(active.controls.target);
                    v.controls.update();
                }
                v.render();
            });
            this.syncing = false;
        }

        frameAll(dist) {
            this.lastFrameDist = dist;
            this.viewers.forEach((v) => v.resetView(dist));
        }

        resetAll() { this.frameAll(this.lastFrameDist); }

        adjustCanvasSizes() { this.viewers.forEach((v) => v.adjustCanvasSize()); }
        renderAll() { this.viewers.forEach((v) => v.render()); }
    }

    const plyUrl = (key, name) => `${PLY_BASE_URL}/${key}/${name}.ply`;

    let manager, gtViewer;
    const splitViewers = {};

    function initViewers() {
        // Bail quietly if this section isn't on the page.
        if (!document.getElementById("inv-size-gt")) return;

        manager = new ViewerManager();

        gtViewer = new SingleViewer("inv-size-gt",
            plyUrl(DEFAULT_OBJECT, "gt"), manager);
        manager.addViewer(gtViewer);

        for (const model of MODELS) {
            const v = new SplitViewer(
                `inv-size-${model}`,
                plyUrl(DEFAULT_OBJECT, `${model}_regular`),
                plyUrl(DEFAULT_OBJECT, `${model}_smaller`),
                manager);
            splitViewers[model] = v;
            manager.addViewer(v);
        }

        renderLegend();

        window.addEventListener("resize", () => {
            manager.adjustCanvasSizes();
            manager.renderAll();
        });

        animate();
    }

    function animate() {
        requestAnimationFrame(animate);
        manager.viewers.forEach((v) => v.controls && v.controls.update());
    }

    function renderLegend() {
        const el = document.getElementById("inv-size-legend");
        if (!el) return;
        el.innerHTML = CLASS_NAMES.map((name, i) =>
            `<span class="inv-legend-item">
                <span class="inv-swatch" style="background:${CLASS_COLORS[i]}"></span>${name}
            </span>`).join("");
    }

    window.loadInvariaObject = function (key) {
        if (!manager) return;
        document.querySelectorAll("[data-object]").forEach((b) =>
            b.classList.toggle("active", b.dataset.object === key));

        gtViewer.setPath(plyUrl(key, "gt"));
        for (const model of MODELS) {
            splitViewers[model].setPaths(
                plyUrl(key, `${model}_regular`),
                plyUrl(key, `${model}_smaller`));
        }
    };

    document.addEventListener("DOMContentLoaded", initViewers);
})();
