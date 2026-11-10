# P2 视觉效果能力映射

核对来源：`src/engine/effects/catalog.ts`、`src/engine/effects/components.tsx`、`src/engine/storyboard.ts`、`library/techniques/`、`library/styles/`。以下状态以当前编译器能否生成有效 edit-plan 为准，不以卡片名称推测能力。

| 技巧 ID | 实际渲染路径 | 当前可调参数 | edit-plan 写入位置 | 状态 |
| --- | --- | --- | --- | --- |
| `cold-open@1` | 片段重排 | 无 | `footage.segments` 顺序 | 已支持；仅适合开头角色 |
| `hook-big-text@1` | `title-card@1` | `text`, `placement` | `overlays[]` | 已支持；现有入场为淡入，不是弹入 |
| `keyword-punch@1` | 摄像机 `punchIns` | `word`, `zoom` | `footage.segments[].camera.punchIns` | 已支持 |
| `product-fade@1` | `image-card@1` | `word`, `image`, `placement` | `assets` + `overlays[]` | 已支持；需已确认产品图 |
| `product-pip@1` | `image-card@1` | `word`, `image`, `placement` | `assets` + `overlays[]` | 已支持；需已确认产品图 |
| `proof-card@1` | `image-card@1` | `word`, `image`, `placement` | `assets` + `overlays[]` | 已支持；需已确认证据图 |
| `check-list@1` | 尚无组件模板 | 无 | 无 | 待开发 |
| `cta-button@1` | 尚无组件模板 | 无 | 无 | 待开发 |
| `jump-cut@1` | 尚无技巧实现 | 无 | 无 | 待开发 |
| `logo-label@1` | 尚无组件模板 | 无 | 无 | 待开发 |
| `search-bar@1` | 尚无组件模板 | 无 | 无 | 待开发 |
| `sfx-bgm@1` | 尚无音频模板 | 无 | 无 | 待开发 |
| `whip-pan@1` | 尚无转场模板 | 无 | 无 | 待开发 |
| `word-captions@1` | 尚无独立技巧模板 | 无 | 无 | 待开发；现有逐词高亮属于全局字幕系统 |

其他已实现的渲染能力：`alpha-video@1`、`rect@1`、`fade-through-black@1` 均在 effect catalog 中，分别用于透明视频叠层、矩形图形及黑场转场。效果工作台当前开放硬切和黑场转场。逐词高亮字幕及基础画面亮度、对比度、饱和度通过风格包和现有播放器渲染。三个风格包为 `clean-pink@1`、`dark-glass@1`、`warm-life@1`，整体切换 `theme`、`layout.grade`、`captions` 与模板 `parts`；当前方案数据结构不支持分别混搭这些维度。

## 预览与应用边界

- 选择效果后，工作台向现有 storyboard compiler 发送**临时选择数据**，并用现有 Remotion 播放器播放编译出的 edit-plan；此步骤不写项目文件。原方案与应用后使用相同项目素材和时间轴。转场定位至真实片段边界，叠层定位至其生效时间。
- 缓存为前端会话内最多 24 项，键含项目、轮次、方案、技巧版本、段落、参数、当前选择及素材哈希和状态。再次选择相同配置复用编译结果。效果列表缩略图明确是原片画面，真正的效果展示在中央播放器。
- 应用、替换和移除只修改 `selection.draftOption` 或草稿的 `style`、`transitions`。参数与方案由已有 Zod schema 和 compiler 校验；已确认轮次由 UI 禁用写入，服务端也拒绝写入。
- 当前预览是实时 Remotion Player，未生成离线短视频或 `renderStill` 缩略图；第一次打开复杂方案的等待时间取决于编译和媒体加载。字幕、调色目前随整套风格切换，不能单项编辑。
