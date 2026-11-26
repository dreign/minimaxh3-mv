# MiniMax H3 歌曲 MV 工作台

用一张人物参考图 + 一首 MP3（+ 可选歌词），在本地 ComfyUI 上自动生成一整支对口型、卡节拍、带字幕的歌曲 MV。

两种用法：

- **MV 无限画布**（`MVCanvas/`）— React Flow 无限画布，拖节点、连线、调参、看进度，适合边做边改。
- **命令行管线**（`MV制作交付/auto_mv.py`）— 纯 Python 标准库，一条命令跑完全程，适合批处理。

![无限画布](MVCanvas/presets/bot-mv-canvas.png)

---

## 工作流长什么样

```
人物参考图 ┐
歌曲 MP3   ├→ 节拍/歌词分析 → 分镜台 → 首帧图 → H3 逐镜生成 → 拼接·铺曲·字幕
歌词(选填) ┘
```

- **卡点**：用鼓点 onset 吸附镜头切点，成片时长自动等于歌曲全长。
- **锁人物**：每镜都带 `<Picture 1>` 参考图；有首帧图时走 i2v，首帧就是成片真实第一帧。
- **镜内不切**：每个分镜固定 `one continuous take`，变化靠不同分镜换机位/景别/光线，避免 H3 自行切镜。
- **长曲拆分**：导演台节点按 MP3 时长自动切成 N 个 8 秒分镜，逐镜生成后自动拼接。

## 目录结构

```
MVCanvas/                     无限画布（前端 TS+React+Vite，后端 Node 内置 HTTP）
  src/                        画布、节点、状态
  server/                     静态托管、任务调度、ComfyUI 桥、ffmpeg 拼接
  presets/                    画布预设与界面截图
  README.md                   画布详细说明（技术选型、节点、参数）
   MV无限画布_使用说明.md      逐节点操作手册 + 接口表 + 速度档
MV制作交付/
  auto_mv.py                  纯脚本一键管线（节拍分析 → 分镜 → 生成 → 合成）
  歌曲MV制作流程.md            命令行版完整流程
  分镜头需求_示例.md           分镜表模板
build_mv_workflow.py          从 Director 模板生成 6 镜工作流的辅助脚本
```

## 快速开始

```bash
git clone https://github.com/dreign/minimaxh3-mv.git
cd minimaxh3-mv/MVCanvas
npm install
npm run build
npm start          # http://127.0.0.1:8787
```

命令行方式：

```bash
cd minimaxh3-mv/MV制作交付
python auto_mv.py --image singer.png --audio song.mp3 --lyrics lyrics.lrc --dry-run
```

`--dry-run` 只分析并输出分镜表，建议首次先跑一次确认分镜，再正式渲染。

## 前置条件

| 项 | 要求 |
|---|---|
| ComfyUI | ≥ 0.38，运行在 `127.0.0.1:8188`（实测 0.46.2） |
| 模型 | MiniMax H3（ref2va / ref2v）、video/audio VAE、qwen3vl 32B 文本编码器 |
| 加速 | 4 步蒸馏 LoRA（Turbo）、KJNodes `MiniMaxH3MemoryEfficientSageAttentionPatch` |
| 可选 | Veda 稀疏注意力（高分辨率/长镜头才划算，见下文） |
| 系统 | Node.js 18+、Python 3.10+、ffmpeg/ffprobe 在 PATH |

## 路径配置

不配也能跑（默认按 `~` 推断）；ComfyUI 装在别处时用环境变量覆盖：

| 变量 | 作用 | 默认 |
|---|---|---|
| `COMFY_URL` | ComfyUI 地址 | `http://127.0.0.1:8188` |
| `COMFY_INPUT` | ComfyUI 输入目录 | `~/ComfyUI-Shared/input` |
| `COMFY_OUTPUT` | ComfyUI 输出目录 | `~/ComfyUI-Shared/output` |
| `COMFY_USER_DIR` | ComfyUI `user` 目录（扫描工作流） | `~/ComfyUI-Installs/ComfyUI/ComfyUI/user` |
| `COMFY_WORKFLOW_DIRS` | 直接指定工作流目录，分号分隔（最高优先级） | — |
| `PYTHON_BIN` | 生成层 Python 解释器 | `python` |

## 实测性能（RTX 5080 Laptop 16GB）

竖屏 MV、4 步蒸馏 LoRA + SageAttention、单镜 8 秒（192 帧）：

| 配置 | 分辨率 / 帧数 | 单镜耗时 |
|---|---|---|
| 4 步 + Sage | 608×1056 / 192 | 130–150s |
| 4 步 + Veda(32) | 608×1056 / 192 | ≈141s（此尺寸无收益） |
| 4 步 无 Veda | 768×1280 / 209 | ≈289s |
| 4 步 + Veda(16) | 768×1280 / 209 | **≈208s（1.39×）** |
| 8 步 + Sage | 608×1056 / 192 | ≈257s |

- **Veda 的收益随分辨率/时长增长**：608 短镜头下 attention 只占约 1/3，开不开差不多；升到 768×1280 才有 1.3–1.4×。
- 768×1280 配 209 帧正好落在 Veda predictor 的规划尺寸上，没有 padding 浪费；608×1056 / 192 帧有约 30% tile 是 padding。
- 3 步能再快 25%，但发丝、纱料、刺绣明显糊化，只适合当草稿预览。

## 已知限制

- 只针对 MiniMax H3 的音视频联合生成管线，换模型要改 `server/workflow_lib.cjs` 与工作流 JSON。
- H3 帧数受 `17n+5` 栅格约束，24fps 下 8 秒正好 192 帧。
- Windows 上 ComfyUI 自定义节点目录名不能带 `-` 或 `@`（否则动态 import 失败），插件需放成合法模块名。

## License

MIT
