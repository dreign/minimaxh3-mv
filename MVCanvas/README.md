# MV 无限画布工作台

一个**本地运行**的无限画布软件，专门用来做歌曲 MV：把参考图、MP3、歌词拖进画布，自动分析节拍分镜、逐镜用 ComfyUI H3 生成、再铺原曲和字幕导出成片。

---

## 一、为什么选这套技术

| 层 | 选型 | 理由 |
|---|---|---|
| 画布前端 | **TypeScript + React + Vite** | 无限画布/节点编辑器是典型的高交互 UI，React 生态最成熟；TS 保证节点数据结构可靠；Vite 秒级热更新 |
| 画布引擎 | **React Flow (@xyflow/react)** | 节点拖拽、平移缩放、连线、MiniMap、自动布局开箱即用，是这类工具的事实标准；自己写 SVG 画布会浪费大量时间在交互细节上 |
| 状态 | **Zustand** | 画布节点/边、素材、分镜、任务状态集中管理，比 Context 更轻、重渲染更少 |
| 本地服务 | **Node.js 22 内置 HTTP** | Web 层零第三方依赖，启动快、部署简单；负责上传、任务调度、进度、视频 Range 流 |
| 生成层 | **Python 3.13 + 现有 `auto_mv.py`** | ComfyUI H3 调用、节拍分析、歌词配时、ffmpeg 合成已经在本机跑通，直接复用而不是重写 |
| 样式 | 原生 CSS（浅色主题） | 无 UI 库依赖，视觉可控，和你的 IDE 浅色主题一致 |

**没选什么**：PyQt/Electron（打包重、画布生态弱）、纯 HTML 单文件（状态一复杂就难维护）、FastAPI（本机 Python 没装，Node 内置模块已经够用，少一个环境）。

---

## 二、快速启动

```bash
git clone https://github.com/dreign/minimaxh3-mv.git
cd minimaxh3-mv/MVCanvas

npm install          # 首次
npm run build        # 构建前端（改过 src 后需要重新构建）
npm start            # 启动本地服务
```

浏览器打开 **http://127.0.0.1:8787**

> 开发模式：终端 1 跑 `npm start`，终端 2 跑 `npm run dev`，打开 `http://127.0.0.1:5173`，改动会热更新，API 自动代理到 8787。

**前置条件**：ComfyUI 已启动在 `127.0.0.1:8188`（页面右上角 `C` 绿灯表示连通），ffmpeg 在 PATH（`F` 绿灯）。

**路径配置**（不配也能跑，默认值按 `~` 推断；ComfyUI 装在别处时用环境变量覆盖）：

| 变量 | 作用 | 默认 |
|---|---|---|
| `COMFY_URL` | ComfyUI 地址 | `http://127.0.0.1:8188` |
| `COMFY_INPUT` | ComfyUI 输入目录（参考图/音频拷贝到这里） | `~/ComfyUI-Shared/input` |
| `COMFY_OUTPUT` | ComfyUI 输出目录（读取生成结果） | `~/ComfyUI-Shared/output` |
| `COMFY_USER_DIR` | ComfyUI `user` 目录（扫描工作流） | `~/ComfyUI-Installs/ComfyUI/ComfyUI/user` |
| `COMFY_WORKFLOW_DIRS` | 直接指定工作流目录，分号分隔（优先级最高） | — |
| `PYTHON_BIN` | 生成层 Python 解释器 | `python` |

Windows PowerShell 示例：

```powershell
$env:COMFY_INPUT = "D:\ComfyUI\input"
$env:COMFY_USER_DIR = "D:\ComfyUI\user"
npm start
```

---

## 三、界面与工作流

画布上从左到右 8 类节点，连线约束是 `素材→分析→分镜→首帧图→生成→导出`：

```
① 人物参考图 ┐
② 歌曲 MP3  ├→ ④ 节拍与场景分析 → ⑤ 分镜台 → ⑥ 分镜首帧图 → ⑦ H3 镜头生成 → ⑧ 合成与导出
③ 歌词(选填)┘
```

1. **上传素材**：参考图（正脸照，上传后默认完整显示全图、可用滑块调节预览大小）+ MP3 必填（上传后节点内可直接播放试听）；**歌词可选**（上传 `.lrc`/`.txt` 或直接粘贴）。歌词节点顶部有 **「使用歌词」开关**：关闭后即使已上传歌词也完全不用（分镜无台词、成片无字幕）；关闭后再分析会重新生成不含歌词的分镜。在「节拍与歌词分析」节点填**主题场景**（多行，每行一个场景，如 `舞台，聚光灯，歌手` / `雨夜天桥，霓虹，孤独` / `海边日落，温暖`）
2. **分析**：点「分析节拍 / 自动配时」。脚本用鼓点吸附镜头切点；有歌词时按 LRC 时间或字数配时，无歌词则按节拍 + 主题场景生成画面（无字幕）。**成片时长自动等于歌曲全长**，无需手动设置
3. **改分镜**：在「分镜台」逐镜改提示词、帧数、增删镜头；卡片显示每镜的「变化」标签（同场景内景别/光线/运镜/动作自动错开），点「🎲 重排镜头变化」可在各自场景组内重新分配。底部时间轴同步显示各镜时间和歌词，并可切换显示首帧图 / 镜头视频缩略图（悬停播放）
4. **生成首帧图**：先在节点内的「横屏 16:9 / 竖屏 9:16」选方向（或下拉选具体分辨率），再点「生成 N 张首帧图」。用 H3 Image 以参考人物 + 每镜的**首帧图提示词**（静态，与视频提示词分开写）生成静态首帧，节点内以缩略图网格预览（图片完整显示不裁切，可用「预览大小」滑块调整显示尺寸、网格自动重排，不影响生成分辨率）。H3 Image 的**出图宽高也可配置**（勾选「自定义 H3 Image 出图宽高」后自由填数值，默认跟随视频尺寸），用于更大画布超采样出图。首帧是后续视频的**真实第一帧**
5. **生成镜头**：设置种子，点「生成全部镜头」。步长默认 20；勾选「4步Turbo」会自动锁定为 4 步并加载 Turbo LoRA（快约 5 倍、细节略降），取消勾选恢复 20。有首帧图时自动走 **i2v**（首帧→视频画面一致）；没有则退回 r2v（参考图直生）
6. **导出**：点「拼接 + 铺原曲 + 字幕」（歌词关闭时按钮变为「拼接 + 铺原曲（无字幕）」），完成后节点内直接播放/下载 MP4

顶部还有「⚡ 一键生成 MV」，把 2–6 步连起来自动跑完（含首帧图）。

**六项关键约定**：
- **歌词可选 + 总开关**：没有歌词也能出 MV；即使上传了歌词，也能用歌词节点的「使用歌词」开关一键关闭——关闭后歌词不参与分镜、不烧字幕，后端会忽略一切歌词来源。
- **时长 = 歌曲时长**：后端用 ffprobe 实测整首时长，忽略任何前端截断值；分镜帧数保持 H3 的 `17n+5` 栅格并补足到不短于歌曲，`finalize` 用 `-t 歌曲时长 + -shortest` 精确截断，成片与歌曲等长。
- **主题场景多行输入 + 镜头分组**：每行一个场景，可写环境（海边/舞台）、人物（歌手/观众/乐队）、镜头氛围（霓虹/复古/孤独/聚光灯）。翻译成英文后从 `Setting and environment:` / `Characters and performer styling:` / `Camera style and mood:` 三个维度写入提示词（含首帧图），未写到的维度用「跟随场景」的描述补齐；例如「海边日落，温暖」→ `Setting and environment: seaside sunset. Characters and performer styling: match the setting above. Camera style and mood: warm.`。多个场景时按行把镜头切成**连续组**，一组镜头固定一个场景，不会来回跳场；分析节点显示翻译与分组覆盖范围，⑤ 分镜台每镜显示所属场景。直接填英文则原样使用。
- **一个分镜 = 一个连续镜头，变化只发生在分镜之间**：每个分镜固定 `one continuous take with a single camera setup: no cuts, no camera-angle changes and no inserts inside this shot`，镜内不切镜头、不换机位、不插空镜（避免 H3 在一个分镜里自行切镜）。想要变化就让**不同分镜用不同机位**：每镜按全片序号错开轮换机位与景别（正面 / 左前 3/4 / 右侧 / 背后过肩 / 低角度仰拍 / 高位俯拍 / 侧面 / 远机位…）、光线、运镜、表演动作，副歌偏全景、主歌偏近景；以 `Variation for this shot in the same scene: …` 写入提示词并同时作用于首帧图，场景与人物身份不变。段落只给氛围基调（`Section mood:`，不含机位），全片机位描述只有一套来源，不会互相打架。⑤ 分镜台显示中文变化标签、可「重排镜头变化」；⑦ 的种子 seed 参与轮换，换种子重新分析可得到另一套组合。
- **首帧图提示词与视频提示词分开写**：每镜有两套提示词，互不干扰。首帧图提示词（`shot.framePrompt`，只给 H3 Image）写静态画面——机位/景别前置并补一句构图覆盖（`framing: extreme close-up …, so the eyes fill most of the frame; light: …`）、人物造型、场景、定格动作，末尾 `Still frame, a single frozen moment, no motion blur, sharp focus`；视频提示词（`shot.prompt`，只给 H3 视频）写机位 + 运镜 + 音景 + 镜内不切镜头。首帧不再从视频提示词截取，所以 `dolly-in / push-in / tracking` 这类运镜不会污染静帧（后端对老数据仍保留退化逻辑：剥掉运镜/音景后再补静态尾巴）。⑤ 分镜台每镜有「🖼 首帧图提示词」「🎞 视频提示词」两个文本框分别编辑，「重排镜头变化」会同时替换两套提示词里各自的变化句。

**横屏 / 竖屏**：「分镜首帧图」和「H3 镜头生成」两个节点都有同一个方向选择器（▭ 横屏 16:9 / ▯ 竖屏 9:16），加上分辨率下拉可细分。横屏有 864×480 / 736×416 / 608×352，竖屏 9:16 有 480×864 / 544×960 / 608×1080；⑦ 节点还新增「视频宽高」两个数字框，可**直接填任意宽高**（256–2048，失焦或点「应用」生效，自动对齐到 32 的倍数），不再局限于预设。两处尺寸双向联动（同一份参数），首帧图、视频、最终成片自动贯通。

**H3 Image 出图尺寸可配置**：⑥ 节点默认让 H3 Image 以视频尺寸出图；勾选「自定义 H3 Image 出图宽高」后可单独填写出图宽/高（256–2048，自动对齐到 32 的倍数——ComfyUI 的 H3 节点 width/height 步长就是 32），另带「×2」（按视频尺寸两倍超采样）与「同视频」快捷按钮。自定义尺寸只作用于 `MiniMaxH3ImageConditioning` 与参考图 resize，**保存前会自动缩放回视频尺寸**（`ImageScale`，比例不同时中心裁切），因此 `keyframes_meta.json` 记录的仍是视频尺寸，i2v 校验照常通过。建议与视频保持相同宽高比；尺寸越大细节越好，但更慢、更占显存，改动后需重新生成首帧图。

> 注意：首帧图是视频的真实第一帧，尺寸必须与视频一致。**切换方向/分辨率后，已生成的首帧图会自动作废**（节点会提示「旧首帧图已作废，请重新生成」）；后端也会校验 `keyframes_meta.json` 里的尺寸，不符时退回 r2v，不会出现「选了竖屏却用横屏首帧」的错配。

画布可自由拖动、滚轮缩放、框选、MiniMap 导航；「保存画布 / 加载画布」可把整个工程（含素材路径、分镜、参数）导出为 JSON。

**节点删除**：节点标题栏右侧 `✕` 删除单个节点；选中节点/连线后按 `Delete` / `Backspace`，或点顶部「✕ 删除选中」批量删除。删除节点会连带清理挂在它身上的连线（不留悬空边）。每次删除都会在底部提示条给一次「撤销」（也可 `Ctrl+Z`），节点按原位置恢复、连线一并回来。输入框/下拉框内打字与退格不受影响。实现在 `store.removeNodes/removeEdges/undoDelete`（`lastDeleted` 单步快照），键盘监听在 `App.tsx`。

### ⑨ 其他工作流（把 ComfyUI 里的工作流做成选项）

除了 MV 这条主线，画布右下角还有一个独立节点 **🧩 其他工作流**：它**自动扫描** ComfyUI 的工作流目录，把里面的 `.json` 全部变成下拉选项，选中即可直接跑，不用打开 ComfyUI 界面。

```
默认扫描：ComfyUI/user/default/workflows  +  ComfyUI/user/workflows
覆盖方式：环境变量 COMFY_WORKFLOW_DIRS="D:/wf1;D:/wf2"（分号分隔）
```

- **自动绑定**：扫描时按节点类型识别可供画布填充的槽位——`LoadImage`→参考图、`LoadAudio`→歌曲、文本节点（`text/prompt/value`）→提示词、`seed`→种子、`width/height`→宽高。节点里只显示该工作流**真正有的**槽位，改一下勾选就能决定是否覆盖（图片/音频会自动拷进 ComfyUI 的 input 目录）。
- **可选项**：每个工作流显示节点数、更新时间、缺失插件（如 `SetNode/GetNode`）提示；换工作流不用重启服务，点 `↻` 重新扫描即可（新丢一个 json 进去立刻出现在列表里）。
- **执行**：UI 工作流 → API prompt 自动转换（含 rgthree Label/Note 跳过、seed 的 `control_after_generate` 跳过、VHS 字典式 widgets），提交到 ComfyUI 后轮询 `/history`，输出文件自动拷到 `workspace/outputs/` 并在节点里播放/下载。
- **节点参数面板**：节点下半部分有「⚙ 节点参数」，按 ComfyUI 的 `/object_info` 把工作流里**每个节点**的 widget 参数渲染成表单——下拉（枚举）、数字（带 min/max/step）、勾选框、文本框/多行文本自动区分；只列真正可改的项（连线驱动的输入、已被上方图/音/提示词/种子/宽高接管的项会自动隐藏），支持搜索、按节点折叠、改动项高亮与单项 `↺` 还原、整条工作流「重置」。改完直接点运行，值就以 `patch` 形式提交，并且按工作流分别存 localStorage，刷新/重开还在。
- **兜底**：非常规参数也能用请求里的 `patch`（`{ "节点id": { "输入名": 值 } }`）直接覆盖，等价于手动改节点——面板就是这个 patch 的可视化版本。
- **每个节点独立绑定**：工作流节点也可以自带配置（`node.data.wf = { workflowId, patch, prompt, seed, width, height, outputName, veda }`）。有这份配置时，节点的下拉框与参数面板只读写自己这一份，不再碰全局选中项——所以同一张画布上可以放 4 个都用 `Minimax+H3+bot` 的节点，各自截取歌曲不同的 8 秒，互不干扰。`veda` 是每个节点自己的稀疏注意力开关，默认关。

### ⑩ 拼接成片 + 一键生成 bot MV 画布

顶部工具栏的 **🎬 bot MV 画布** 会用 `GET /api/presets/bot-mv` 拉一套现成流程并替换当前画布（会先弹确认）：

| 节点 | 内容 |
|---|---|
| ① 角色参考图 | 自动指向 `workspace/mv_bot_1125/character.png` |
| ② 歌曲 MP3 | 自动指向 `workspace/assets` 里的《声声慢·戏腔版》 |
| 镜1–镜4 | 4 个「其他工作流」节点，都用 `Minimax+H3+bot`，各自 patch：`AudioCrop` 1:28–1:36 / 1:36–1:44 / 1:44–1:52 / 1:52–2:00、独立 seed、独立 `filename_prefix`，提示词按「中景推近→近景特写→仰拍爆发→拉远全景」写好 |
| ⑩ 拼接成片 | 收口节点：按连线顺序取 4 段输出，铺原曲对应起点，可选片名与淡入淡出 |

- **拼接**：`POST /api/stitch`（`server/stitch.cjs`）用 ffmpeg 把各段先 `scale/pad/fps` 统一到同一规格再 `concat`，音轨按 `start` 截取并补静音到总长，可选 `drawtext` 片名（默认微软雅黑，`MV_FONT_PATH` 可覆盖）与淡入淡出；同步返回 `url/width/height/duration`，节点里直接播放/下载。4×8 秒竖屏实测 **1.4 秒**出片。
- **收片逻辑**：工作流节点跑完会把 `result.primary` 写进 `store.wfResults[nodeId]`，拼接节点顺着入边取（连线顺序即拼接顺序）；没有任何连线结果时，可以手动从 `workspace/outputs` 里挑 MP4，按加入顺序拼。
- **画布持久化**：节点/连线变化会防抖 300ms 写进 `localStorage["mvcanvas.canvas.v1"]`，刷新页面不会再被打回初始流程；`保存画布` 仍然导出完整 JSON（含素材、参数、分镜）。

### ⑪ bot 导演台（按 MP3 时长自动拆分镜 → 逐镜 bot → 一条长视频）

顶部 **🧭 bot 导演台**（`GET /api/presets/bot-mv-auto`）是单节点方案，不用再手摆 4 个镜头节点：

| 能力 | 说明 |
|---|---|
| 真实时长 | 进节点就对 MP3 调 `GET /api/probe`（ffprobe），顶部显示「音频 144.2s / 可用 144s」 |
| 自动拆分 | 点「🧩 按 MP3 拆分镜」，按「截取起点 + 截取时长 + 每镜秒数」算 N 镜；截取时长留空＝做到歌曲结尾，镜数留空＝按每镜秒数铺满，手填镜数则均分 |
| 运镜轮换 | 6 套运镜（中景推近 / 近景特写 / 仰拍爆发 / 拉远全景 / 侧移跟拍 / 过肩注视）按镜序轮换，`{motion}` 占位符替换进提示词模板，每镜还能单独改 |
| 逐镜参数 | 每镜独立 `AudioCrop` 区间、独立 `noise_seed`、独立 `filename_prefix`；节点角色（AudioCrop / ResolutionSelector / noise_seed / VHS_VideoCombine）按**节点类型**定位，工作流改版 id 变了也不怕 |
| 串行执行 | ComfyUI 单队列：逐镜提交 + 1.5s 轮询，单镜进度条实时更新，可 ⏹ 停止，也可只重跑某一镜 |
| 自动合成 | 全部 done 后自动 `POST /api/stitch`（可关），铺原曲起点、片名、淡入淡出，输出一条长视频 |
| 下游可选 | 已完成的分镜会展开给「⑩ 拼接成片」，连过去可换起点/片名再拼一版 |
| 速度档 | 「⚡ 极速 / ⚖ 均衡 / 🎬 高质」一键切「采样步数 + 清晰度」，节点里实时给出「≈ 几分/镜 · 全片多久」 |

- **为什么默认每镜 8 秒**：`AudioCrop` 只吃整秒，H3 长度栅格是 `17n+5`——24fps 下 8 秒 = 192 帧正好对齐，误差 0；换其它秒数会有几帧补偿，长视频里逐镜累计可能导致口型漂移。
- **规模参考**：整首 144 秒 ≈ 18 镜 × 8 秒；单镜 608×1056 约 4.1–4.4 分钟，全片约 **1.3 小时 GPU**（节点里直接显示预估）。

#### 提速（608×1056 / 192 帧实测，同一台 5080 Laptop）

| 档位 | 采样步数 | 清晰度 | 单镜实测 | 相对默认 | 画质 |
|---|---|---|---|---|---|
| 🎬 高质（旧默认） | 8 | 0.6MP（608×1056） | **257s** | 1.00× | 基准 |
| ⚖ 均衡（现默认） | 4 | 0.6MP（608×1056） | **181s** | **1.42×** | 肉眼与 8 步同级 |
| ⚡ 极速 | 4 | 0.45MP（480×864） | **124s** | **2.07×** | 细节略软，适合草稿/远景 |

- 该 LoRA 本身是 `minimax_h3_turbo_4step`（4 步蒸馏），原来跑 8 步等于多算一倍；改 4 步后采样从 186s 降到 93s。
- 单镜还有约 70–88s 的固定开销（TE/权重装载 + VAE 解码 + 封装），它不随步数下降，所以总提速是 1.4×而不是 2×；再往下压只能减分辨率。
- **同一项目别混用步数**：4 步与 8 步是同 seed 不同采样轨迹，服装/色调会变（实测金白 ↔ 银蓝）。整片统一档位，中途换档要重跑前面已出的镜头。
- 工作流 `user/default/workflows/Minimax+H3+bot.json` 的 `BasicScheduler` 已由 8 改为 4（原文件备份为 `Minimax+H3+bot.json.bak-8step`）；导演台仍会按节点里的「采样步数」覆盖，所以画布里选什么就是什么。

---

## 四、数据怎么流

```
浏览器
  │ 上传(base64) / 分析 / 生成 / 合成
  ▼
server/server.js  (Node 内置 http)
  │ 写 workspace/assets、workspace/jobs/<id>
  │ spawn server/pipeline_bridge.py
  ▼
pipeline_bridge.py
  │ importlib 复用 MV制作交付/auto_mv.py 的函数
  ├─ analyze:   probe_duration → analyze_audio → parse_lyrics → build_shots
  ├─ keyframes: build_keyframe_prompt(H3 Image) → submit_and_wait_image → 存 keyframes/*.png
  ├─ generate:  有首帧→build_i2v_prompt(first_frame) 否则 build_shot_prompt(r2v)
  │             → submit_and_wait(ComfyUI H3) → normalize_shot
  └─ compose:   concat_shots → finalize(原曲/ASS字幕)
  ▼
workspace/outputs/<job>_MV.mp4  ← /media/... 以 Range 方式回传给 <video>
```

关键点：

- **分镜可编辑**：画布改过的 `shots` 会作为 `config.shots` 传给 Python 桥，覆盖自动分镜；帧数自动吸附到 H3 的 `17n+5` 栅格。
- **H3 自带音频被丢弃**：最终音轨始终是你的 MP3，避免模型自合成声音干扰。
- **首帧图 → i2v**：`keyframes` 任务把每张首帧复制到 ComfyUI 的 input 目录并写 `keyframes_meta.json`（`width`/`height` 是保存尺寸=视频尺寸，另有 `sourceWidth`/`sourceHeight` 记录 H3 Image 实际出图尺寸）；`generate` 复用同一 jobId，检测到该 meta 且**尺寸与当前参数一致**时用 `MiniMaxH3ImageToVideo` 把首帧设为 `first_frame`，视频第一帧与首帧几乎一致（实测平均像素差 3.1/255）。尺寸不符则退回 r2v 并在日志里说明。
- **自定义出图尺寸**：`build_keyframe_prompt()` 用 `args.keyframe_width/height`（默认等于视频宽高）设置 `MiniMaxH3ImageConditioning` 与参考图 resize；与视频尺寸不同时，在 `VAEDecode` 与 `SaveImage` 之间插入 `ImageScale` 缩放到视频尺寸，保证首帧与 i2v 一致。参数由 `/api/keyframes` 的 `params.keyframeSizeMode` / `keyframeWidth` / `keyframeHeight` 传入，后端收敛到 256–2048。
- **H3 模型分工**：首帧图用 `minimax_h3_image` + `minimax_h3_image_vae`（6 步 euler）；视频用 `minimax_h3_fl2va`（i2v）或 `minimax_h3_ref2va`（r2v）；文本编码器都是 Qwen3-VL-32B nvfp4。
- **任务状态**：Python 桥持续写 `keyframes_state.json` / `state.json` / `compose_state.json`，Node 按阶段优先读取，浏览器每 1.5 秒轮询。
- **素材不重复拷贝**：上传文件落在 `workspace/assets`，路径直接传给 Python；参考图由桥复制到 ComfyUI 的共享 input 目录。

---

## 五、核心文件

| 文件 | 作用 |
|---|---|
| `src/App.tsx` | 主界面、工具栏、时间轴、任务日志轮询 |
| `src/nodes/index.tsx` | 8 种自定义节点及上传/编辑/首帧预览/播放交互 |
| `src/store.ts` | Zustand 状态、初始节点与连线、连接合法性规则 |
| `src/api.ts` | 前端 API 客户端与任务轮询 |
| `server/server.js` | Node 后端：静态托管、上传、任务、进度、视频流 |
| `server/pipeline_bridge.py` | Python 桥：命令分发、状态写入、复用 auto_mv.py |
| `../MV制作交付/auto_mv.py` | 已验证的 H3 生成 + ffmpeg 合成核心（不改动） |

---

## 六、已知限制

- 目前是**单机单用户**工作台，没有账号与权限；监听 `127.0.0.1`，不对外网开放。
- 整首歌约 30+ 镜，16GB 显存下耗时 2–3 小时；建议先用 60 秒样片试跑。
- 画布工程 JSON 保存的是素材**绝对路径**，换机器后需要重新上传素材。
- 生成任务在 Node 服务重启后会继续跑完（子进程 detached），但日志轮询会断开；可在「任务日志」刷新后重选任务。
- T8 音频锁（让画面听着歌演）仍是实验功能，未接入画布；当前走「H3 出画面 + 铺原曲」稳妥路线。

---

## 七、API 一览（便于二次开发）

| 端点 | 说明 |
|---|---|
| `GET /api/health` | ComfyUI / ffmpeg 连通性 |
| `POST /api/upload` | `{kind,name,data(base64)}` 上传素材 |
| `POST /api/save-text` | 粘贴歌词保存为 lrc/txt |
| `POST /api/analyze` | 分析节拍与歌词，返回分镜 |
| `POST /api/assets/verify` | 校验持久化素材文件是否仍在磁盘 |
| `POST /api/keyframes` | 启动逐镜首帧图生成（H3 Image） |
| `GET /api/keyframes/:id` | 读取首帧图结果与 URL |
| `POST /api/generate` | 启动逐镜视频生成（带 jobId 时复用首帧走 i2v） |
| `POST /api/compose` | 拼接 + 铺曲 + 字幕 |
| `GET /api/job/:id` | 任务状态与日志 |
| `GET /api/jobs` | 所有任务 |
| `GET /api/outputs` | 成片列表 |
| `GET /api/workflows` | 扫描 ComfyUI workflows 目录，返回选项 + 可绑定槽位（`?refresh=1` 强制重扫） |
| `GET /api/workflows/:id/nodes` | 该工作流每节点的可编辑参数清单（类型/当前值/枚举/min/max），供参数面板渲染 |
| `POST /api/workflows/run` | 运行指定工作流：`{workflowId,image,audio,prompt,seed,width,height,patch,outputName,veda,vedaOptions}`；`veda:true` 时提交前往 MODEL 链末（LoRA 之后）插 `VedaSparseAttention`，只改这次请求、不动工作流文件 |
| `GET /api/workflows/run/:id` | 工作流运行状态/日志/输出文件 |
| `GET /api/uploads` | 已上传素材清单（供工作流节点挑选） |
| `GET /api/presets/bot-mv` | bot MV 画布预设：带真实素材路径的节点/连线/参数 |
| `GET /api/presets/bot-mv-auto` | bot 导演台画布预设（按 MP3 时长自动拆分镜） |
| `GET /api/probe?path=` | 媒体探测（ffprobe）：时长/分辨率/编码，导演台拆分镜用 |
| `POST /api/stitch` | 拼接成片：`{clips,audio,start,fade,title,outputName}` → 成片 URL |
| `GET /media/...` | 素材/成片文件，支持 Range |
