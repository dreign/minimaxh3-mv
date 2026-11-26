# 本地 ComfyUI 一键制作歌曲 MV（MiniMax H3 · 自动化版）

> 作者本机参考：ComfyUI 安装在 `%USERPROFILE%\ComfyUI-Installs\ComfyUI`（核心 0.46.2 / Desktop 0.29.0，Python 3.13，torch 2.12+cu130）
> GPU：RTX 5080 Laptop **16GB 显存**；内存约 64GB；ffmpeg 8.1 已在 PATH
> ComfyUI 实际输入/输出目录用 `COMFY_INPUT` / `COMFY_OUTPUT` 指定（作者本机为 `%USERPROFILE%\ComfyUI-Shared\input` / `...\output`）

---

## 一、最短用法：三个输入，一条命令

把三样东西准备好：

| 输入 | 说明 |
|---|---|
| **人物参考图** | 1 张清晰正面/半身照，_face_ 占比大、光线均匀、无遮挡。png/jpg/webp 均可 |
| **MP3** | 你的歌曲。wav 也行 |
| **歌词** | `.lrc`（带 `[mm:ss.xx]` 时间戳，最准）或 `.txt`（每行一句，脚本按字数+鼓点自动配时） |

然后执行（脚本只用 Python 标准库，**无需安装任何依赖**）：

```bash
cd "minimaxh3-mv/MV制作交付"

python auto_mv.py ^
  --image  "D:\你的素材\singer.png" ^
  --audio  "D:\你的素材\song.mp3" ^
  --lyrics "D:\你的素材\lyrics.lrc" ^
  --burn-subs
```

跑完在 `MV制作交付\输出` 里得到：

- `song_MV.mp4` —— **最终成片**（H3 画面 + 你的原曲 + 烧录歌词）
- `song_分镜表.md` —— 自动生成的分镜与每镜提示词（方便复盘/微调）
- `song_镜头01_工作流.json` … —— 每镜的 ComfyUI API 工作流，可单独导入手动重跑
- `镜头原始\shot_01.mp4` … —— 各镜头原始素材
- `lyrics_auto.ass` —— 自动生成的歌词字幕文件

> 想先看它会怎么剪、不实际渲染：加 `--dry-run`。它会分析音频/歌词并写出分镜表和工作流 JSON，但**不提交 ComfyUI**。

---

## 二、脚本替你做了什么

```
参考图 ─┐
MP3 ────┼→ ① 音频分析（节拍 onset + 能量段落）
歌词 ───┘      ↓
           ② 歌词配时（LRC 时间戳 / 纯文本自动估算）
              ↓
           ③ 自动分镜（按鼓点吸附切点，5.17s/镜）
              ↓
           ④ 提示词生成（<Picture 1> 锁人物 + <d>歌词</d> + 镜头语言）
              ↓
           ⑤ 逐镜提交 ComfyUI（官方 H3 核心节点，非云端 API）
              ↓
           ⑥ ffmpeg：统一帧率 → 拼接 → 铺原曲 → 烧歌词 → 输出 MP4
```

要点：

- **用的是 ComfyUI 官方 `video_minimax_h3_r2v` 模板的核心节点**（`MiniMaxH3ReferenceToVideo` → `SamplerCustomAdvanced` → `VAEDecode`/`VAEDecodeAudio` → `SaveVideo`），不依赖有版本兼容问题的第三方 Director 节点，也不需要 Cloud/API 额度。
- **H3 生成的音频会被丢弃**：最终音轨始终是你的 MP3（用 `-map 0:v:0 -map 1:a:0` 精确替换）。所以不用纠结 H3 自己合成的声音像不像你的歌。
- **角色一致性**：每镜提示词首句固定 `<Picture 1> is the same performer...`，参考图通过 ComfyUI 的 `ref_images` 输入注入；脚本会自动把你的图片复制到 ComfyUI-Shared\input。
- **自动卡点**：8kHz 单声道 RMS 能量 + 1 秒局部窗口检测节拍突变，镜头切点吸附到最近的鼓点；能量高低决定用 intro/verse/chorus/bridge/outro 的镜头语言。

---

## 三、常用参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--duration` | `60` | 制作歌曲前 N 秒；`0` = 整首歌（**慎用**，见下） |
| `--song-offset` | `0` | 从原曲第几秒开始截取，配合 `--duration` |
| `--burn-subs` | 关 | 把歌词烧进画面；不加则只输出外挂 `lyrics_auto.ass` |
| `--max-shots` | `24` | 最多镜头数，超出会合并短镜 |
| `--shot-seconds` | `5.17` | 单镜目标时长（124 帧 @24fps，符合 H3 的 17n+5 栅格） |
| `--width` / `--height` | `864` / `480` | 输出分辨率（0.4MP，16GB 舒服档） |
| `--steps` | `20` | 采样步数。官方模板默认 20，稳但慢 |
| `--turbo` | 关 | 启用 4 步 Turbo LoRA；配合 `--steps 4`（需实测你的 INT8 r2v 是否兼容） |
| `--shift-video` / `--shift-audio` | `12` / `3` | H3 sigma shift，默认值已调好 |
| `--seed` | `42` | 种子。每镜自动 +1 |
| `--name` | 歌曲名+时间戳 | 输出文件名前缀 |
| `--dry-run` | 关 | 只分析、不渲染 |
| `--comfy-input` / `--comfy-output` | 共享目录 | ComfyUI 输入/输出目录，换实例时改这里 |

**整首歌的成本提醒**：3 分钟歌 ≈ 35 个镜头。20 步时单镜约 3–6 分钟，整首要 2–3 小时；16GB 显存建议先用 `--duration 60` 出 60 秒样片，满意再放长。

---

## 四、歌词格式建议

### 4.1 LRC（推荐）

```lrc
[00:00.00]前奏
[00:05.20]霓虹灯亮起我站在街角
[00:10.80]你的名字在风里飘
[00:16.30]副歌来了大声唱出来
```

带时间戳时，字幕和分镜都严格按你的歌词时间走。

### 4.2 纯文本

```
霓虹灯亮起我站在街角
你的名字在风里飘
副歌来了大声唱出来
```

脚本按每行字数估算时长，并把每句起点吸附到最近鼓点（±0.8s 内）。想更准就用 LRC。

---

## 五、显存与排障

| 现象 | 原因 | 处理 |
|---|---|---|
| `CUDA out of memory` | 文本编码器用了 int8 27GB 版 / 有程序占显存 | 脚本默认用 `qwen3vl_32b_minimax_h3_nvfp4_awq`（15.7GB）；渲染前关浏览器/其他 AI 应用 |
| ComfyUI 未运行 | 脚本连不上 `127.0.0.1:8188` | 先启动 ComfyUI Desktop，再运行脚本 |
| `找不到参考图/歌曲/歌词` | 路径写错或含引号 | 用绝对路径；路径里有空格时保留引号 |
| 人物每镜不一致 | 参考图遮挡/太小，或提示词被改 | 用清晰正脸图；不要删 `<Picture 1>` 首句 |
| 帧数报错 | 不是 `17n+5` 栅格 | 用默认 `--shot-seconds 5.17`；脚本会自动吸附 |
| 字幕乱码 | 歌词含特殊字符 | 脚本已过滤 `{}` 和 `\`；字体用 Microsoft YaHei |
| 音画不同步 | 各镜帧率不一致 | 脚本已统一到 24fps 再拼接；若手动拼接请照做 |
| 想把 H3 声音也用上 | 目前故意丢弃 | 进阶可看旧的 T8 音频锁方案（下方附录） |

---

## 六、手动模式与旧版说明

### 6.1 想手动调某一镜

脚本输出的 `xxx_镜头NN_工作流.json` 是 ComfyUI **API 格式**，不能直接拖进画布；但你可以：

1. 打开 ComfyUI 网页 → Workflow → Import，选择分镜表里记录的提示词；
2. 或直接用旧的 UI 工作流 `MV_6镜头_H3参考生视频_工作流.json` 作为画布骨架，手动改提示词后 Queue。

### 6.2 关于旧的 Director 工作流

`MV_6镜头_H3参考生视频_工作流.json` 基于 `ComfyUI_MiniMaxH3_Director` 示例改造。**当前 ComfyUI 0.46.2 与该节点的 r2v 调用签名不兼容**（会报 `height // 16` 的 TypeError），因此自动脚本已改走官方核心节点，不再依赖它。旧文件保留仅作参考，不建议直接跑。

### 6.3 T8 音频锁（实验性）

本机装有 `comfyui-minimax-h3-audio-T8-main`，可把人声锁进 latent 让画面"听着歌演"：参考 `examples/H3_Turbo_Stable_4V4A（AV各4步）.json`，用 `MiniMax H3 Audio Latent Control (T8)` + Dual-Clock Sampler（video shift 12 / audio shift 3）。不稳就退回本流程的"生成画面 + 铺原曲"路线。

### 6.4 官方模板库

`workflow_templates` 里所有 MV/对口型相关模板都是 `api_` 开头的**云端付费模板**，本地模板只有 `audio_minimax_music_3`、`audio_ace_step_*`、`audio_melbandroformer_audio_separation` 等，你本机都已装好。所以模板库无法补上本地 MV 缺口——这也是为什么我们自建了这条核心节点管线。

---

## 七、合规提醒

- 音乐版权：确保你有权使用这首歌；公开发布前确认授权。
- 肖像权：真人参考图需本人同意；AI 虚拟人物无此问题。
- 模型许可：MiniMax H3 权重遵循其自身许可；生成内容按平台要求标注 AI 生成。

---

## 八、TL;DR

```bash
cd "minimaxh3-mv/MV制作交付"
python auto_mv.py --image 参考图.png --audio 歌曲.mp3 --lyrics 歌词.lrc --burn-subs
```

先在 `输出\song_MV.mp4` 看样片；要改镜头就编辑 `输出\song_分镜表.md` 后重跑，或用 `--duration 0` 做整首。
