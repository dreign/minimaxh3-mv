# -*- coding: utf-8 -*-
"""Build a 6-shot MiniMax H3 music-video workflow from the installed Director r2v template."""
import json, os, uuid, time
from pathlib import Path

HOME = Path.home()
# Director 节点自带的 r2v 示例工作流（可用 COMFY_USER_DIR / SRC 环境变量覆盖）
SRC = os.environ.get(
    "MV_SRC_WORKFLOW",
    str(HOME / "ComfyUI-Installs" / "ComfyUI" / "ComfyUI" / "custom_nodes"
        / "ComfyUI_MiniMaxH3_Director" / "example_workflows" / "minimax_h3_director_r2v.json"),
)
OUT_DIR = str(Path(__file__).resolve().parent / "MV制作交付")
OUT = os.path.join(OUT_DIR, "MV_6镜头_H3参考生视频_工作流.json")

with open(SRC, encoding="utf-8") as f:
    wf = json.load(f)

# 6 shots x ~5s = 124 frames each at 24fps (H3 grid 17n+5).
shots = []
start = 0
for i in range(6):
    sid = "s%02d" % (i + 1)
    length = 124
    prompt = (
        "<Picture 1> is the performer, keep the exact same face, hair, outfit and identity. "
        "Shot %d of a music video. Cinematic close-up, slow dolly-in, moody neon lighting, "
        "subtle head movement in rhythm, natural blink. "
        "overall_soundscape: soft crowd ambience and faint synth pad. "
        "non_diegetic_music: instrumental beat, no vocals, no text, no logo."
    ) % (i + 1)
    shots.append({
        "id": sid,
        "start": str(start),
        "length": str(length),
        "frameCount": str(length),
        "durationSec": str(round(length / 24.0, 2)),
        "prompt": prompt,
        "negativePrompt": "text, watermark, logo, extra people, deformed hands",
        "taskType": "",
        "refs": [{"index": 0, "imageFile": "", "fileName": ""}],
        "refAudios": [],
        "refVideos": [],
        "genImage": {"imageFile": "", "fileName": ""},
    })
    start += length

timeline = {
    "version": 5,
    "editMode": "segment",
    "timelineMode": "prompt_batch",
    "totalFrames": start,
    "frameRate": 24.0,
    "width": 864,
    "height": 480,
    "refMaxSize": 864,
    "output": {
        "mode": "fixed",
        "aspectRatio": "16:9 (宽屏)",
        "megapixels": 0.4,
        "multiple": 32,
        "longEdge": 864,
        "width": 864,
        "height": 480,
        "maxExportFrames": 0,
        "exportMode": "all",
        "audioMode": "generate",
        "continuityEnabled": False,
        "continuityOverlapFrames": 9,
    },
    "videoClips": [],
    "video": {"fileName": "", "videoFile": "", "subfolder": "", "type": "input", "frames": [], "frameMap": []},
    "global": {
        "taskType": "r2v — 参考主体生视频(Reference to Video)",
        "prompt": "<Picture 1> 作为 performer 身份参考，整支 MV 保持同一人物、服装与色调。",
        "refs": [{"index": 0, "imageFile": "", "fileName": ""}],
        "referenceVideo": {},
        "continuousReference": False,
        "genImage": {"imageFile": "", "fileName": ""},
        "refAudios": [],
    },
    "segments": shots,
    "gen": {"defaultFrameCount": 124},
    "runSelectEnabled": False,
    "runSelection": [],
}

for n in wf["nodes"]:
    t = n.get("type")
    if t == "MiniMaxH3Director":
        w = n["widgets_values"]
        # Keep widget positions; replace task/prompt and the embedded UI JSON.
        w[0] = "r2v — 参考主体生视频(Reference to Video)"
        w[1] = "<Picture 1> 作为歌手形象参考，6 个镜头同一人物同一服装，电影感霓虹灯光，24fps。"
        for idx, x in enumerate(w):
            if isinstance(x, str) and x.startswith('{"version"'):
                w[idx] = json.dumps(timeline, ensure_ascii=False)
                break
        n["title"] = "MV导演台 · 6镜头 r2v"
    elif t == "UNETLoader":
        n["widgets_values"] = ["minimax_h3_ref2va_pruned_int8_convrot.safetensors", "default"]
    elif t == "CLIPLoader":
        n["widgets_values"] = ["qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors", "minimax", "default"]
    elif t == "VAELoader":
        # two VAELoader nodes: first video, second audio (per template order)
        if n["widgets_values"] and "audio" in str(n["widgets_values"][0]):
            n["widgets_values"] = ["minimax_h3_audio_vae_fp32.safetensors"]
        else:
            n["widgets_values"] = ["minimax_h3_video_vae_fp16.safetensors"]
    elif t == "SaveVideo":
        n["widgets_values"] = ["video/MV_H3", "auto", "auto"]
    elif t == "MarkdownNote":
        n["widgets_values"] = [
            "## 歌曲 MV · 6 镜头 H3 工作流\n"
            "1. 先在 ComfyUI 网页上传 1 张歌手参考图（input 目录）。\n"
            "2. 在【MV导演台】节点里，为每个 segment 的 refs 槽位上传该参考图（或用全局 refs）。\n"
            "3. 每段提示词用 <Picture 1> 指代歌手；`<d>...</d>` 写唱词。\n"
            "4. 推荐设置：0.4MP 864x480，24fps，每段124帧(约5.17s)，25 steps，res_multistep/simple，shift 12/3。\n"
            "5. 显存 16GB：使用 nvfp4_awq 文本编码器 + CPU offload；如 OOM 先把每段帧数改为 5 帧试跑。\n"
            "6. Queue 生成 6 段；用 VideoHelperSuite / ffmpeg 按歌词时间点拼接，最后叠加原曲音频。\n"
            "7. 生成音频是模型合成的；要对口型请用 T8 音频锁节点或后期替换人声。"
        ]

wf["id"] = "mv-h3-r2v-6shot-" + uuid.uuid4().hex[:8]
wf["revision"] = 1

os.makedirs(OUT_DIR, exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(wf, f, ensure_ascii=False, indent=2)

# validation
with open(OUT, encoding="utf-8") as f:
    check = json.load(f)
assert len(check["nodes"]) == 11 and len(check["links"]) == 11
for n in check["nodes"]:
    if n["type"] == "MiniMaxH3Director":
        ui = [x for x in n["widgets_values"] if isinstance(x, str) and x.startswith('{"version"')][0]
        t = json.loads(ui)
        assert len(t["segments"]) == 6
        assert t["totalFrames"] == 744
print("OK", OUT, os.path.getsize(OUT))
