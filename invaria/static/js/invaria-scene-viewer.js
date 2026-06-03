(function () {
    const REMOTE_PLY_BASE =
        "https://raw.githubusercontent.com/birdy666/assets/main/invaria/ply";
    // When viewing locally (file:// or localhost) try ./static/ply first so you can
    // test without pushing the assets repo. Symlink:
    //   ln -s /Users/birdy/visualization/assets_out/invaria/ply invaria/static/ply
    const IS_LOCAL = location.hostname === "localhost" ||
                     location.hostname === "127.0.0.1" ||
                     location.protocol === "file:";
    const PLY_BASE_URL = IS_LOCAL ? "./static/ply" : REMOTE_PLY_BASE;

    const MODELS = ["spunet", "ptv3", "sonata", "utonia", "ours"];
    const DEFAULT_SCENE = "scene0064_00";

    // Left half: 2cm grid. Right half: 6cm grid (bumped point size so the
    // sparser cloud stays visible).
    const PLY_SUFFIX  = { left: "_2cm_raw", right: "_6cm_raw" };
    const POINT_SIZE  = { left: 2.0,        right: 4.0        };

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

    function loadPLYGeometry(path) {
        return new Promise((resolve, reject) => {
            new THREE.PLYLoader().load(path, resolve, undefined, reject);
        });
    }

    class BaseViewer {
        constructor(containerId, manager) {
            this.containerId = containerId;
            this.manager = manager;
            this.config = {
                camera: { fov: 45, near: 0.01, far: 2000 },
                material: { size: 2.0 },
                bg: 0xffffff,
            };
        }

        getCanvasDimensions() {
            const el = document.getElementById(this.containerId);
            const w = el.clientWidth;
            const h = el.clientHeight || w;
            return { w: Math.max(1, w), h: Math.max(1, h) };
        }

        initThree() {
            const { w, h } = this.getCanvasDimensions();
            this.camera = new THREE.PerspectiveCamera(
                this.config.camera.fov, w / h,
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
            this.controls.minDistance = 0.1;
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
            this.camera.aspect = w / h;
            this.camera.updateProjectionMatrix();
            this.renderer.setSize(w, h);
            this.render();
        }

        resetView(dist) {
            const d = dist || 5;
            this.camera.position.set(d * 0.6, -d * 0.8, d * 0.5);
            this.camera.up.set(0, 0, 1);
            this.controls.target.set(0, 0, 0);
            this.controls.update();
            this.render();
        }
    }

    // Single PLY (used for GT)
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
                geo.computeBoundingBox();
                const center = new THREE.Vector3();
                geo.boundingBox.getCenter(center);
                geo.translate(-center.x, -center.y, -center.z);

                if (this.points) {
                    this.scene.remove(this.points);
                    this.points.geometry.dispose();
                }
                this.points = new THREE.Points(geo, makePointMaterial(this.config.material.size));
                this.scene.add(this.points);

                if (this.manager.isPrimary(this)) {
                    const size = new THREE.Vector3();
                    geo.boundingBox.getSize(size);
                    this.manager.frameAll(size.length() * 0.9);
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

    // Two PLYs in one canvas, split by a draggable vertical slider.
    // Layer 0 = left (2cm); Layer 1 = right (6cm).
    class SplitViewer extends BaseViewer {
        constructor(containerId, plyA, plyB, manager) {
            super(containerId, manager);
            this.plyA = plyA;          // left (2cm)
            this.plyB = plyB;          // right (6cm)
            this.pointsA = null;
            this.pointsB = null;
            this.initThree();
            this.createSplitterUI();
            this.loadPair();
        }

        createSplitterUI() {
            const wrapper = document.getElementById(this.containerId).parentNode;
            const old = wrapper.querySelector(".sv-splitter");
            if (old) old.remove();

            const splitter = document.createElement("div");
            splitter.className = "sv-splitter";
            const handle = document.createElement("div");
            handle.className = "sv-splitter-handle";
            splitter.appendChild(handle);
            wrapper.appendChild(splitter);
            this.splitter = splitter;
            this.wrapper = wrapper;
            this.updateSplitterPosition();

            splitter.addEventListener("pointerdown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.dragging = true;
                this.controls.enabled = false;
                splitter.setPointerCapture?.(e.pointerId);
            });
            window.addEventListener("pointermove", (e) => {
                if (!this.dragging) return;
                const rect = wrapper.getBoundingClientRect();
                const x = e.clientX - rect.left;
                const r = Math.min(0.95, Math.max(0.05, x / Math.max(1, rect.width)));
                this.manager.setSplitRatio(r);
            });
            window.addEventListener("pointerup", (e) => {
                if (!this.dragging) return;
                this.dragging = false;
                this.controls.enabled = true;
                splitter.releasePointerCapture?.(e.pointerId);
            });
        }

        updateSplitterPosition() {
            if (!this.splitter) return;
            this.splitter.style.left = `${this.manager.splitRatio * 100}%`;
        }

        async loadPair() {
            try {
                const [geoA, geoB] = await Promise.all([
                    loadPLYGeometry(this.plyA),
                    loadPLYGeometry(this.plyB),
                ]);
                geoA.computeBoundingBox();
                geoB.computeBoundingBox();
                const union = geoA.boundingBox.clone().union(geoB.boundingBox);
                const center = new THREE.Vector3();
                union.getCenter(center);
                geoA.translate(-center.x, -center.y, -center.z);
                geoB.translate(-center.x, -center.y, -center.z);

                if (this.pointsA) { this.scene.remove(this.pointsA); this.pointsA.geometry.dispose(); }
                if (this.pointsB) { this.scene.remove(this.pointsB); this.pointsB.geometry.dispose(); }

                this.pointsA = new THREE.Points(geoA, makePointMaterial(POINT_SIZE.left));
                this.pointsB = new THREE.Points(geoB, makePointMaterial(POINT_SIZE.right));
                this.pointsA.layers.set(0);
                this.pointsB.layers.set(1);
                this.scene.add(this.pointsA);
                this.scene.add(this.pointsB);

                if (this.manager.isPrimary(this)) {
                    const size = new THREE.Vector3();
                    union.getSize(size);
                    this.manager.frameAll(size.length() * 0.9);
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
            const splitX = Math.max(1, Math.min(w - 1,
                Math.floor(w * this.manager.splitRatio)));

            this.renderer.setScissorTest(false);
            this.renderer.clear(true, true, true);

            this.renderer.setScissorTest(true);
            this.renderer.setViewport(0, 0, w, h);

            this.camera.layers.set(0);
            this.renderer.setScissor(0, 0, splitX, h);
            this.renderer.render(this.scene, this.camera);

            this.camera.layers.set(1);
            this.renderer.setScissor(splitX, 0, w - splitX, h);
            this.renderer.render(this.scene, this.camera);

            this.renderer.setScissorTest(false);
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
            this.lastFrameDist = 5;
            this.splitRatio = 0.5;
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

        setSplitRatio(r) {
            this.splitRatio = r;
            this.viewers.forEach((v) => {
                if (v instanceof SplitViewer) {
                    v.updateSplitterPosition();
                    v.render();
                }
            });
        }
    }

    const plyUrl = (scene, name) => `${PLY_BASE_URL}/${scene}/${name}.ply`;
    const modelPlyUrl = (scene, model, side) =>
        plyUrl(scene, `${model}${PLY_SUFFIX[side]}`);

    let manager, gtViewer;
    const splitViewers = {};

    function initViewers() {
        manager = new ViewerManager();

        gtViewer = new SingleViewer("inv-gt", plyUrl(DEFAULT_SCENE, "gt"), manager);
        manager.addViewer(gtViewer);

        for (const model of MODELS) {
            const v = new SplitViewer(
                `inv-${model}`,
                modelPlyUrl(DEFAULT_SCENE, model, "left"),
                modelPlyUrl(DEFAULT_SCENE, model, "right"),
                manager);
            splitViewers[model] = v;
            manager.addViewer(v);
        }

        renderLegend();

        window.addEventListener("resize", () => {
            manager.adjustCanvasSizes();
            manager.viewers.forEach((v) => {
                if (v instanceof SplitViewer) v.updateSplitterPosition();
            });
            manager.renderAll();
        });

        animate();
    }

    function animate() {
        requestAnimationFrame(animate);
        manager.viewers.forEach((v) => v.controls && v.controls.update());
    }

    function renderLegend() {
        const el = document.getElementById("inv-legend");
        if (!el) return;
        el.innerHTML = CLASS_NAMES.map((name, i) =>
            `<span class="inv-legend-item">
                <span class="inv-swatch" style="background:${CLASS_COLORS[i]}"></span>${name}
            </span>`).join("");
    }

    window.loadInvariaScene = function (scene) {
        if (!manager) return;
        document.querySelectorAll("[data-scene]").forEach((b) =>
            b.classList.toggle("active", b.dataset.scene === scene));

        gtViewer.setPath(plyUrl(scene, "gt"));
        for (const model of MODELS) {
            splitViewers[model].setPaths(
                modelPlyUrl(scene, model, "left"),
                modelPlyUrl(scene, model, "right"));
        }
    };

    document.addEventListener("DOMContentLoaded", initViewers);
})();
