# PikeDemo0

Cocos Creator 3.8.5 的战场视角 Demo：程序化生成的正方形场地（带对角线起伏）、固定俯角摄像机，以及方向键 / WASD / 鼠标中键拖拽平移。

## 运行

1. 用 Cocos Creator 3.8.5 打开本目录。
2. 打开 `assets/scenes/battle.scene`，点击"预览"。
3. 控制方式：
   - 方向键或 WASD 平移视角；
   - 鼠标中键按下拖动平移视角（抓地式：画面跟着光标走，灵敏度按当前视野自动换算；画布会被引擎阻止默认行为，不会触发浏览器自动滚动）；
   - 没有中键或中键冲突时，勾选组件上的 `dragWithRightButton` 改为右键拖动（画布右键菜单已被引擎屏蔽）。

## 结构

- `assets/scripts/BattleScene.ts` — 场地网格、外围底板、相机与画面拉伸、键盘与鼠标拖拽输入。
- `assets/scenes/battle.scene` — 主场景，`BattleScene` 挂在 `Main Camera` 节点上。
- `assets/resources/models/*.glb` — 低模素材（hero / pike / soldier* / crate / barrel / pine_tree / rock / coin / stone_tile），目前脚本还没有引用。

## 画面适配约定

- 设计分辨率固定为 1600×900，用 `EXACT_FIT` 铺满窗口。
- 相机投影宽高比锁定为 1600/900，所以窗口比例不同时整幅画面被拉伸（不裁切、不留黑边）。
- 场地外由一块更大的深色底板覆盖，平移到边界时不会露出清屏色。

## 已知限制

- 平移范围由 `centerKeepRadius` 决定：`limit = fieldSize / 2 - centerKeepRadius`。默认值下可平移到 ±34，而可见地面约为 x ±38.7、z [-26.6, +18.7]，所以靠近边界时画面里主要是外围底板。
- 脚本在预览时接管相机姿态与设计分辨率；编辑器里通过 `@executeInEditMode` 只生成场地预览（`previewFieldInEditor`，节点标记为不保存），方便摆相机。
- 在编辑器里修改 `fieldSize`、或切换 `previewFieldInEditor` 后，需要重新加载场景（或重编译脚本）才会重新生成预览网格；`pitch` / `cameraDistance` 只在预览运行时生效。
- 拖拽灵敏度按当前视野平均值换算：画面中心几乎完全跟手，上下边缘会有约 ±30% 的差异（透视投影下地面映射是非线性的）。
