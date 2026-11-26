import {
    _decorator,
    Asset,
    Camera,
    CCObject,
    Color,
    Component,
    director,
    EventKeyboard,
    EventMouse,
    game,
    Game,
    input,
    Input,
    KeyCode,
    Layers,
    Material,
    Mesh,
    MeshRenderer,
    Node,
    ResolutionPolicy,
    screen,
    utils,
    view,
} from 'cc';
import { EDITOR_NOT_IN_PREVIEW } from 'cc/env';

const { ccclass, property, executeInEditMode } = _decorator;

const FIELD_NODE_NAME = 'Battle Field';
const BACKDROP_NODE_NAME = 'Battle Backdrop';

/** 切后台再回到前台时 dt 可能非常大，用它限制单帧位移。 */
const MAX_FRAME_DELTA = 0.05;

interface RenderCamera {
    update(forceUpdate?: boolean): void;
    _aspect: number;
    _isProjDirty: boolean;
}

/**
 * 正方形场地、固定俯角摄像机、画面整体拉伸。
 * 方向键或 WASD 平移视角；鼠标中键（可改为右键）按下拖动也能平移。
 *
 * 画面适配：设计分辨率固定为 referenceWidth × referenceHeight 并用 EXACT_FIT 铺满窗口，
 * 相机投影宽高比也锁成同一比例，所以窗口比例不同时整幅画面被拉伸，不会裁切或留黑边。
 */
@ccclass('BattleScene')
@executeInEditMode
export class BattleScene extends Component {
    @property
    fieldSize = 100;

    /**
     * 视角中心周围这个半径必须完全落在场地内，由此决定平移范围：
     * limit = fieldSize / 2 - centerKeepRadius。
     *
     * 按默认相机参数算，可见地面约为 x ±38.7、z [-26.6, +18.7]，
     * 所以平移到边界时会看到场地外，这部分由更大的深色底板补上。
     */
    @property
    centerKeepRadius = 16;

    /** 相对水平面的固定俯角，单位是度。 */
    @property
    pitch = 55;

    @property
    verticalFov = 28;

    @property
    cameraDistance = 72;

    @property
    panSpeed = 24;

    /** 鼠标中键按下拖动平移视角；没有中键或中键冲突时勾选，改为右键拖动。 */
    @property
    dragWithRightButton = false;

    /** 设计分辨率宽度，同时是相机投影宽高比的基准。 */
    @property
    referenceWidth = 1600;

    @property
    referenceHeight = 900;

    /** 编辑器里是否生成场地预览（只影响编辑器；运行时总是生成）。 */
    @property
    previewFieldInEditor = true;

    private readonly _held = new Set<number>();
    private _centerX = 0;
    private _centerZ = 0;
    private _limit = 0;
    private _dragging = false;
    /** 拖拽时每个像素对应的世界距离，按下时按当前相机参数算一次。 */
    private _dragScaleX = 0.04;
    private _dragScaleZ = 0.05;
    private _camera: Camera | null = null;
    private _canvas: HTMLCanvasElement | null = null;
    private _renderCamera: RenderCamera | null = null;
    private _originalUpdate: ((forceUpdate?: boolean) => void) | null = null;
    private readonly _createdNodes: Node[] = [];
    private readonly _createdAssets: Asset[] = [];

    onLoad(): void {
        // 运行时总是生成；编辑器里由开关决定，方便直接对着场地摆相机。
        if (EDITOR_NOT_IN_PREVIEW && !this.previewFieldInEditor) {
            return;
        }
        this.createStage();
    }

    onEnable(): void {
        if (EDITOR_NOT_IN_PREVIEW) {
            return;
        }
        input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.on(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.on(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
        input.on(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        input.on(Input.EventType.MOUSE_UP, this.onMouseUp, this);
        game.on(Game.EVENT_HIDE, this.resetInputState, this);
        const canvas = game.canvas;
        if (canvas && typeof canvas.addEventListener === 'function') {
            this._canvas = canvas;
            canvas.addEventListener('mouseleave', this.onCanvasMouseLeave);
        }
        this.lockProjectionAspect();
    }

    start(): void {
        if (EDITOR_NOT_IN_PREVIEW) {
            return;
        }
        this._camera = this.getComponent(Camera);
        if (!this._camera) {
            return;
        }
        const half = this.fieldSize * 0.5;
        const radius = Math.max(0, Math.min(this.centerKeepRadius, half));
        this._limit = half - radius;
        this._camera.projection = Camera.ProjectionType.PERSPECTIVE;
        this._camera.fov = this.verticalFov;
        this._camera.fovAxis = Camera.FOVAxis.VERTICAL;
        this._camera.near = 0.5;
        this._camera.far = 800;
        this._camera.clearFlags = Camera.ClearFlag.SOLID_COLOR;
        this._camera.clearColor = new Color(58, 78, 92, 255);
        this.applyDesignResolution();
        this.lockProjectionAspect();
        this.placeCamera();
    }

    update(dt: number): void {
        if (EDITOR_NOT_IN_PREVIEW || !this._camera) {
            return;
        }
        // 相机组件被禁用再启用时 render camera 可能重建，这里补挂一次。
        this.lockProjectionAspect();
        let x = 0;
        let z = 0;
        if (this.held(KeyCode.KEY_A, KeyCode.ARROW_LEFT)) {
            x -= 1;
        }
        if (this.held(KeyCode.KEY_D, KeyCode.ARROW_RIGHT)) {
            x += 1;
        }
        if (this.held(KeyCode.KEY_W, KeyCode.ARROW_UP)) {
            z -= 1;
        }
        if (this.held(KeyCode.KEY_S, KeyCode.ARROW_DOWN)) {
            z += 1;
        }
        const length = Math.hypot(x, z);
        if (length > 0) {
            const step = this.panSpeed * Math.min(dt, MAX_FRAME_DELTA);
            this.panBy((x / length) * step, (z / length) * step);
        }
    }

    onDisable(): void {
        input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.off(Input.EventType.KEY_UP, this.onKeyUp, this);
        input.off(Input.EventType.MOUSE_DOWN, this.onMouseDown, this);
        input.off(Input.EventType.MOUSE_MOVE, this.onMouseMove, this);
        input.off(Input.EventType.MOUSE_UP, this.onMouseUp, this);
        game.off(Game.EVENT_HIDE, this.resetInputState, this);
        this._canvas?.removeEventListener('mouseleave', this.onCanvasMouseLeave);
        this._canvas = null;
        this.resetInputState();
        this.unlockProjectionAspect();
    }

    onDestroy(): void {
        this.unlockProjectionAspect();
        this.destroyStage();
    }

    /** 失焦、切后台或离开画布时，清掉按键与拖拽状态，避免回来时持续平移。 */
    private resetInputState(): void {
        this._held.clear();
        this._dragging = false;
    }

    private held(first: number, second: number): boolean {
        return this._held.has(first) || this._held.has(second);
    }

    private onKeyDown(event: EventKeyboard): void {
        this._held.add(event.keyCode);
    }

    private onKeyUp(event: EventKeyboard): void {
        this._held.delete(event.keyCode);
    }

    private get dragButton(): number {
        return this.dragWithRightButton ? EventMouse.BUTTON_RIGHT : EventMouse.BUTTON_MIDDLE;
    }

    private onMouseDown(event: EventMouse): void {
        if (event.getButton() !== this.dragButton) {
            return;
        }
        this._dragging = true;
        this.refreshDragScale();
    }

    private onMouseMove(event: EventMouse): void {
        if (!this._dragging) {
            return;
        }
        // 在窗口外松开等情况下收不到 MOUSE_UP，用移动事件的按键状态收尾。
        if (event.getButton() === EventMouse.BUTTON_MISSING) {
            this._dragging = false;
            return;
        }
        const delta = event.getDelta();
        if (delta.x === 0 && delta.y === 0) {
            return;
        }
        // 抓地拖动：画面跟着鼠标走，所以相机中心朝相反方向移动。
        this.panBy(-delta.x * this._dragScaleX, delta.y * this._dragScaleZ);
    }

    private onMouseUp(event: EventMouse): void {
        if (this._dragging && event.getButton() === this.dragButton) {
            this._dragging = false;
        }
    }

    /** 光标离开画布时结束拖拽，避免回来后继续平移（以及重新进入时的一次大跳）。 */
    private readonly onCanvasMouseLeave = (): void => {
        this._dragging = false;
    };

    private panBy(deltaX: number, deltaZ: number): void {
        this._centerX = clamp(this._centerX + deltaX, -this._limit, this._limit);
        this._centerZ = clamp(this._centerZ + deltaZ, -this._limit, this._limit);
        this.placeCamera();
    }

    /**
     * 拖拽灵敏度：让光标下的地面大致跟着鼠标走。
     * x 用目标距离处的视野宽度，z 用地面可见深度；鼠标坐标是画布物理像素，这里用同一套单位。
     */
    private refreshDragScale(): void {
        const halfV = this.verticalFov * Math.PI / 360;
        const pitch = this.pitch * Math.PI / 180;
        const eyeHeight = Math.sin(pitch) * this.cameraDistance;
        const nearAngle = pitch + halfV;
        const farAngle = pitch - halfV;
        const near = nearAngle < Math.PI * 0.5 - 0.01 ? eyeHeight / Math.tan(nearAngle) : 0;
        const far = farAngle > 0.01 ? eyeHeight / Math.tan(farAngle) : eyeHeight * 100;
        const viewWidth = 2 * Math.tan(halfV) * this.cameraDistance * this.lockedAspect;
        const depth = Math.max(1, far - near);
        const size = this.canvasPixelSize();
        this._dragScaleX = viewWidth / Math.max(1, size.width);
        this._dragScaleZ = depth / Math.max(1, size.height);
    }

    private canvasPixelSize(): { width: number; height: number } {
        const dpr = Math.max(1e-3, screen.devicePixelRatio || 1);
        const canvas = game.canvas;
        if (canvas && typeof canvas.getBoundingClientRect === 'function') {
            const rect = canvas.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                return { width: rect.width * dpr, height: rect.height * dpr };
            }
        }
        const windowSize = screen.windowSize;
        return {
            width: Math.max(1, windowSize.width),
            height: Math.max(1, windowSize.height),
        };
    }

    private placeCamera(): void {
        const pitch = this.pitch * Math.PI / 180;
        const distance = this.cameraDistance;
        this.node.setRotationFromEuler(-this.pitch, 0, 0);
        this.node.setPosition(
            this._centerX,
            Math.sin(pitch) * distance,
            this._centerZ + Math.cos(pitch) * distance,
        );
    }

    /** 设计分辨率固定为参考分辨率，用 EXACT_FIT 铺满窗口；相机投影使用同一宽高比。 */
    private applyDesignResolution(): void {
        view.setDesignResolutionSize(
            Math.max(1, this.referenceWidth),
            Math.max(1, this.referenceHeight),
            ResolutionPolicy.EXACT_FIT,
        );
    }

    /**
     * 把相机投影的宽高比锁成参考比例：画面整体拉伸铺满窗口，而不是裁切或留黑边。
     *
     * 3.8 的 renderer Camera 只公开了 aspect 的 getter，所以这里改私有字段 _aspect，
     * 并在调用原 update 前置脏，让投影矩阵按锁定比例重新计算。
     */
    private lockProjectionAspect(): void {
        const camera = this._camera;
        if (!camera) {
            return;
        }
        const renderCamera = camera.camera as unknown as RenderCamera | null;
        if (!renderCamera || renderCamera === this._renderCamera) {
            return;
        }
        this.unlockProjectionAspect();
        const original = renderCamera.update.bind(renderCamera);
        this._renderCamera = renderCamera;
        this._originalUpdate = original;
        renderCamera.update = (forceUpdate?: boolean): void => {
            renderCamera._aspect = this.lockedAspect;
            renderCamera._isProjDirty = true;
            original(forceUpdate);
        };
    }

    private unlockProjectionAspect(): void {
        const renderCamera = this._renderCamera;
        const original = this._originalUpdate;
        if (renderCamera && original) {
            renderCamera.update = original;
        }
        this._renderCamera = null;
        this._originalUpdate = null;
    }

    private get lockedAspect(): number {
        return this.referenceWidth / Math.max(1, this.referenceHeight);
    }

    private createStage(): void {
        if (this._createdNodes.length > 0) {
            return;
        }
        if (EDITOR_NOT_IN_PREVIEW) {
            this.discardEditorLeftovers();
        }
        const material = new Material();
        material.initialize({
            effectName: 'builtin-standard',
            defines: { USE_VERTEX_COLOR: true },
        });
        material.setProperty('roughness', 0.92);
        material.setProperty('metallic', 0);
        this._createdAssets.push(material);
        this.spawnMesh(FIELD_NODE_NAME, this.buildFieldMesh(), material);
        this.spawnMesh(BACKDROP_NODE_NAME, this.buildBackdropMesh(), material);
    }

    /** 编辑器里脚本重载可能留下上一次生成的预览节点，先清掉。 */
    private discardEditorLeftovers(): void {
        const scene = this.node.scene ?? director.getScene();
        if (!scene) {
            return;
        }
        for (const child of [...scene.children]) {
            if (child.name !== FIELD_NODE_NAME && child.name !== BACKDROP_NODE_NAME) {
                continue;
            }
            if (child.hideFlags === CCObject.Flags.DontSave) {
                child.destroy();
            }
        }
    }

    private spawnMesh(name: string, mesh: Mesh, material: Material): void {
        const node = new Node(name);
        node.layer = Layers.Enum.DEFAULT;
        if (EDITOR_NOT_IN_PREVIEW) {
            // 编辑器里生成的预览节点不要写进场景文件。
            node.hideFlags = CCObject.Flags.DontSave;
        }
        const renderer = node.addComponent(MeshRenderer);
        renderer.mesh = mesh;
        renderer.material = material;
        const scene = this.node.scene ?? director.getScene();
        scene?.addChild(node);
        this._createdNodes.push(node);
        this._createdAssets.push(mesh);
    }

    private destroyStage(): void {
        for (const node of this._createdNodes) {
            node.destroy();
        }
        this._createdNodes.length = 0;
        for (const asset of this._createdAssets) {
            asset.destroy();
        }
        this._createdAssets.length = 0;
    }

    private buildFieldMesh(): Mesh {
        const segments = 120;
        const size = this.fieldSize;
        const count = segments + 1;
        const positions: number[] = [];
        const normals: number[] = [];
        const colors: number[] = [];
        const indices: number[] = [];
        const step = size / segments;
        const half = size * 0.5;

        for (let row = 0; row < count; row++) {
            const z = -half + row * step;
            for (let col = 0; col < count; col++) {
                const x = -half + col * step;
                const y = fieldHeight(x, z, size);
                positions.push(x, y, z);
                const normal = fieldNormal(x, z, size, step);
                normals.push(normal[0], normal[1], normal[2]);
                const color = fieldColor(x, z, size, y);
                colors.push(color[0], color[1], color[2], 1);
            }
        }

        for (let row = 0; row < segments; row++) {
            for (let col = 0; col < segments; col++) {
                const index = row * count + col;
                // 两个三角形的绕序必须一致且法线朝 +Y，否则会有一半被背面剔除。
                indices.push(index, index + count + 1, index + 1);
                indices.push(index, index + count, index + count + 1);
            }
        }

        return utils.MeshUtils.createMesh({
            positions,
            normals,
            colors,
            indices,
        }, undefined, { calculateBounds: true });
    }

    /** 场地外的一块大平面，避免平移到边界时露出清屏色。 */
    private buildBackdropMesh(): Mesh {
        const half = Math.max(1, this.fieldSize * 2);
        const y = -0.15;
        const positions = [
            -half, y, -half,
            half, y, -half,
            half, y, half,
            -half, y, half,
        ];
        const normals = [
            0, 1, 0,
            0, 1, 0,
            0, 1, 0,
            0, 1, 0,
        ];
        const color = [0.26, 0.33, 0.19, 1];
        const colors = [...color, ...color, ...color, ...color];
        // 与场地相同的绕序约定：从上往下看为逆时针，法线朝 +Y。
        const indices = [0, 2, 1, 0, 3, 2];
        return utils.MeshUtils.createMesh({
            positions,
            normals,
            colors,
            indices,
        }, undefined, { calculateBounds: true });
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function fade(distance: number, inner: number, outer: number): number {
    if (distance <= inner) {
        return 1;
    }
    if (distance >= outer) {
        return 0;
    }
    const t = (distance - inner) / (outer - inner);
    const smooth = t * t * (3 - 2 * t);
    return 1 - smooth;
}

/** 中部沿左上到右下的对角线对称起伏，场地其余位置高度为 0。 */
function fieldHeight(x: number, z: number, size: number): number {
    const along = (x + z) * 0.5;
    const perp = (x - z) * 0.5;
    const alongFade = fade(Math.abs(along), size * 0.12, size * 0.26);
    const perpFade = fade(Math.abs(perp), size * 0.05, size * 0.13);
    if (alongFade === 0 || perpFade === 0) {
        return 0;
    }
    const wave = Math.cos((along / (size * 0.12)) * Math.PI);
    return 4.2 * wave * alongFade * perpFade;
}

function fieldNormal(x: number, z: number, size: number, step: number): [number, number, number] {
    const dx = fieldHeight(x - step, z, size) - fieldHeight(x + step, z, size);
    const dz = fieldHeight(x, z - step, size) - fieldHeight(x, z + step, size);
    const length = Math.hypot(dx, step * 2, dz) || 1;
    return [dx / length, (step * 2) / length, dz / length];
}

/** 顶点色按 sRGB 解释：standard 材质会做 SRGBToLinear 后再参与光照。 */
function fieldColor(x: number, z: number, size: number, height: number): [number, number, number] {
    const rise = clamp(height / 4.2, -1, 1);
    let red = 0.42;
    let green = 0.58;
    let blue = 0.28;
    if (rise >= 0) {
        red += rise * 0.28;
        green -= rise * 0.06;
        blue -= rise * 0.02;
    } else {
        const dip = -rise;
        red -= dip * 0.14;
        green -= dip * 0.16;
        blue -= dip * 0.04;
    }
    const edge = Math.max(Math.abs(x), Math.abs(z)) / (size * 0.5);
    if (edge > 0.94) {
        const shade = 1 - (edge - 0.94) / 0.06 * 0.28;
        red *= shade;
        green *= shade;
        blue *= shade;
    }
    return [red, green, blue];
}
