# -*- coding: utf-8 -*-
"""
auto_mv.py — 本机一键歌曲 MV 生成管线（ComfyUI 官方 H3 核心节点版）

输入：人物参考图 + MP3 + 歌词（.txt / .lrc）
输出：最终 MV MP4（原曲音轨 + H3 生成画面 + 可选歌词字幕）

流程：
  1. ffprobe 读时长，ffmpeg 解码 8kHz 单声道 PCM
  2. 纯标准库分析能量/节拍 onset，自动卡点分镜
  3. 歌词解析（LRC 时间戳优先；纯文本按字数 + onset 自动配时）
  4. 自动生成每镜提示词（<Picture 1> 锁人物 + <d>歌词</d>）
  5. 用 ComfyUI 官方 video_minimax_h3_r2v 的核心节点组装 prompt，逐镜提交
  6. ffmpeg 拼接所有镜头 → 铺原曲 → 可选烧录 ASS 歌词 → 输出 MP4

依赖：Python 3.x 标准库 + ffmpeg/ffprobe（PATH 中）+ 运行中的 ComfyUI。
不需要 numpy / librosa / whisper，也不依赖第三方 Director 节点。

示例：
  python auto_mv.py --image singer.png --audio song.mp3 --lyrics lyrics.lrc
  python auto_mv.py --image singer.png --audio song.mp3 --lyrics lyrics.txt --duration 90 --burn-subs
  python auto_mv.py --image singer.png --audio song.mp3 --lyrics lyrics.txt --dry-run
"""

from __future__ import annotations

import argparse
import array
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 本机默认（ComfyUI Desktop 使用共享 input/output 目录）
# 可用环境变量 COMFY_URL / COMFY_INPUT / COMFY_OUTPUT 覆盖，或命令行参数覆盖
# ---------------------------------------------------------------------------
COMFY_URL = os.environ.get("COMFY_URL", "http://127.0.0.1:8188")
COMFY_INPUT = Path(os.environ.get("COMFY_INPUT", str(Path.home() / "ComfyUI-Shared" / "input")))
COMFY_OUTPUT = Path(os.environ.get("COMFY_OUTPUT", str(Path.home() / "ComfyUI-Shared" / "output")))
DEFAULT_OUT_DIR = Path(__file__).resolve().parent / "输出"

UNET_R2V = "minimax_h3_ref2va_pruned_int8_convrot.safetensors"
CLIP_H3 = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VAE_VIDEO = "minimax_h3_video_vae_fp16.safetensors"
VAE_AUDIO = "minimax_h3_audio_vae_fp32.safetensors"
LORA_TURBO = "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors"

FPS = 24.0
FRAME_GRID = 17
FRAME_BASE = 5
NEGATIVE = "text, watermark, logo, extra people, deformed hands, distorted face, blurry"

# 段落基调：只描述氛围 / 光线 / 表演状态，**不写机位与运镜**。
# 机位与景别由 MV_VARIATION 单一来源决定，避免提示词里出现两套互相冲突的镜头描述
# （同一镜里出现两套机位，模型容易在镜内切镜头）。
SECTION_MOOD = {
    "intro": [
        "empty neon alley ambience, haze and soft backlight",
        "empty stage before the performance, drifting haze",
        "rain-soaked street lights, quiet anticipation",
    ],
    "verse": [
        "restrained intimate performance, cool ambient light",
        "quiet contemplative mood, soft ambient fill",
        "warm rim light on <Picture 1>, gentle atmosphere",
    ],
    "prechorus": [
        "<Picture 1> lifts the head as the lights intensify",
        "growing contrast and colored stage lights",
        "<Picture 1> steps forward into a stronger key light",
    ],
    "chorus": [
        "<Picture 1> sings with full emotion, natural blink",
        "strobing neon accents, high energy",
        "<Picture 1> faces the camera, hair and fabric moving with the beat",
    ],
    "bridge": [
        "single spotlight isolating <Picture 1>, dim blue tone",
        "<Picture 1> turns toward camera in a dim blue tone",
        "minimal motion, wind gently moving hair of <Picture 1>",
    ],
    "outro": [
        "<Picture 1> walks toward the light and fades into darkness",
        "lights dimming, quiet decay",
        "<Picture 1> lowers the gaze, soft fade to black",
    ],
}
SOUNDSCAPE = {
    "intro": "distant city hum, light rain, faint air conditioning",
    "verse": "quiet room tone, soft breath, subtle crowd murmur",
    "prechorus": "rising ambience, faint electronic pad, distant thunder",
    "chorus": "energetic crowd ambience, bright synthetic shimmer",
    "bridge": "isolated room tone, faint reverbtail, low wind",
    "outro": "fading crowd noise, gentle wind, long reverb decay",
}

# ---------------------------------------------------------------------------
# 逐镜镜头变化（同一分镜内不切镜头）
# 一个分镜就是一个连续镜头：**单机位、一镜到底，镜内不切不换机位**。
# 变化只发生在分镜之间——不同分镜用不同的机位 / 景别 / 光线 / 运镜 / 表演动作，
# 由 MV_VARIATION 统一给出，是全片唯一的一套机位描述。
# ---------------------------------------------------------------------------
MV_VARIATION = {
    "framing": [
        ("extreme close-up on the eyes from a front camera position", "眼神特写·正面机位"),
        ("tight close-up of the face from the front-left three-quarter angle", "面部特写·左前机位"),
        ("medium close-up from the chest up, camera slightly below eye level", "胸上近景·略低机位"),
        ("waist-up medium shot from the right-hand side", "半身中景·右侧机位"),
        ("full-body wide shot from a camera placed far back", "全身全景·远机位"),
        ("wide establishing shot with the performer small in frame", "环境远景·大远景机位"),
        ("over-the-shoulder shot from behind the performer", "过肩机位·背后"),
        ("low-angle hero framing from below eye level", "低角度仰拍"),
        ("high-angle downward view from above", "高位俯拍"),
        ("side profile from a profile camera position", "侧面剪影·侧机位"),
    ],
    "light": [
        ("soft rim light", "柔和轮廓光"),
        ("warm backlight with subtle lens flare", "逆光暖晕"),
        ("moody low-key lighting", "低调暗光"),
        ("neon reflections on the skin", "霓虹反光"),
        ("silhouette against a bright background", "亮背景剪影"),
        ("golden-hour glow", "金色时段光"),
        ("cool blue tonal grade", "冷蓝调"),
        ("shallow depth of field with bokeh", "浅景深虚化"),
        ("spotlight beam through haze", "光束穿透雾气"),
    ],
    "motion": [
        ("slow dolly-in", "缓推"),
        ("smooth lateral tracking", "横移跟拍"),
        ("gentle handheld sway", "轻微手持"),
        ("orbiting arc around the performer", "环绕运镜"),
        ("slow pull-back reveal", "缓拉揭示"),
        ("locked-off static frame", "固定机位"),
        ("rack focus from foreground to the face", "前景转焦"),
        ("subtle crane-up", "轻微升镜"),
        ("quick push-in on the beat", "卡点快推"),
    ],
    "action": [
        ("singing with eyes closed", "闭眼演唱"),
        ("looking straight into the lens", "直视镜头"),
        ("turning toward the camera", "转身看镜头"),
        ("walking slowly forward", "缓步向前"),
        ("swaying to the rhythm", "随节拍摆动"),
        ("raising a hand toward the light", "抬手向光"),
        ("hair and clothes moving in the wind", "发丝衣摆随风"),
        ("leaning into the microphone", "贴近麦克风"),
        ("glancing off-frame thoughtfully", "望向画外"),
        ("spinning once with the beat", "随拍旋转"),
    ],
}

# 段落决定景别起点：主歌偏近景、副歌/前奏偏全景、桥段偏侧拍
SECTION_FRAMING_START = {
    "intro": 5, "verse": 0, "prechorus": 7, "chorus": 4, "bridge": 6, "outro": 5,
}

# 首帧图专用：静帧对「主体占画面多大」比视频更敏感，按机位补一句覆盖范围说明。
# 顺序与 MV_VARIATION["framing"] 一一对应（仅首帧提示词使用，视频不加）。
FRAMING_COVERAGE = [
    "the eyes fill most of the frame",
    "the face fills the frame",
    "the framing cuts at the chest",
    "the framing cuts at the waist",
    "the full body is visible from head to feet",
    "the performer is small in a wide frame with empty space, the whole location is visible",
    "the performer is seen from behind, over the shoulder",
    "the camera is low near the floor, looking up at the performer",
    "the camera is above, looking down at the performer",
    "the performer is seen in profile from the side",
]


def variation_for(pos: int, section: str, seed: int = 0):
    """第 pos 镜（0-based，用全片序号以便跨场景组也不重复）的镜头变化。

    返回 dict：`video` / `frame` / `label`。只决定「这一镜从哪里拍、怎么拍」：
    四个维度用不同步长错开轮换，相邻分镜的机位 / 景别 / 光线 / 运镜 / 动作都不重复；
    镜内不产生空镜或跳切（同一分镜只有一个机位、一镜到底）。

    `video` 给视频（含运镜），`frame` 给首帧图（去掉运镜、改成静态定格描述），
    两套提示词分开写，避免把「dolly-in / push-in」这类运动词写进静帧提示词。
    """
    v = MV_VARIATION
    f, l, mo, a = v["framing"], v["light"], v["motion"], v["action"]
    start = SECTION_FRAMING_START.get(section, 0)
    fi = (start + pos * 3 + seed) % len(f)
    framing_en, framing_zh = f[fi]
    light_en, light_zh = l[(pos * 4 + seed) % len(l)]
    motion_en, motion_zh = mo[(pos * 2 + seed) % len(mo)]
    action_en, action_zh = a[(pos * 3 + seed) % len(a)]
    coverage_en = FRAMING_COVERAGE[fi] if fi < len(FRAMING_COVERAGE) else ""
    video = (
        f"Variation for this shot in the same scene: {framing_en}, {light_en}, "
        f"{motion_en}, performer {action_en}. "
        "Use a clearly different camera position than the adjacent shots, while keeping "
        "the setting and the performer's identity unchanged. "
    )
    frame = (
        f"Variation for this shot in the same scene: framing: {framing_en}, "
        f"so {coverage_en}; light: {light_en}. "
        f"The performer is {action_en}, frozen at one expressive moment. "
        "Use a clearly different camera position than the adjacent shots, while keeping "
        "the setting and the performer's identity unchanged. "
    )
    label = " · ".join((framing_zh, light_zh, motion_zh, action_zh))
    return {"video": video, "frame": frame, "label": label}


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------
def run(cmd, *, capture=True, cwd=None, check=True):
    if capture:
        cp = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                            encoding="utf-8", errors="replace", check=False)
        if check and cp.returncode != 0:
            raise RuntimeError(f"命令失败：{' '.join(map(str, cmd))}\n{(cp.stderr or cp.stdout)[-2000:]}")
        return cp
    return subprocess.run(cmd, cwd=cwd, check=check)


def log(msg: str) -> None:
    print(f"[AUTO-MV] {msg}", flush=True)


def snap_frames(n: float, fps: float = FPS) -> int:
    n = max(FRAME_BASE, int(round(n)))
    return FRAME_BASE + FRAME_GRID * max(0, int(round((n - FRAME_BASE) / FRAME_GRID)))


def fmt_time(sec: float) -> str:
    m = int(sec // 60)
    return f"{m:02d}:{sec - m * 60:05.2f}"


def probe_duration(path: Path) -> float:
    cp = run(["ffprobe", "-v", "error", "-show_entries", "format=duration",
              "-of", "default=noprint_wrappers=1:nokey=1", str(path)])
    return float(cp.stdout.strip())


# ---------------------------------------------------------------------------
# 音频分析（标准库）
# ---------------------------------------------------------------------------
def decode_pcm(path: Path, rate: int = 8000) -> array.array:
    cp = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-f", "s16le", "-ac", "1", "-ar", str(rate), "pipe:1"],
        capture_output=True, check=True,
    )
    samples = array.array("h")
    samples.frombytes(cp.stdout)
    if sys.byteorder != "little":
        samples.byteswap()
    return samples


def analyze_audio(path: Path, rate: int = 8000, hop: float = 0.05):
    samples = decode_pcm(path, rate)
    frame = max(1, int(rate * hop))
    energies = []
    for i in range(0, len(samples), frame):
        chunk = samples[i:i + frame]
        if not chunk:
            continue
        acc = 0.0
        for x in chunk:
            v = x / 32768.0
            acc += v * v
        energies.append(math.sqrt(acc / len(chunk)))
    window = max(4, int(1.0 / hop))
    onsets = []
    for i in range(window, len(energies) - window):
        local = sum(energies[i - window:i + window]) / (2 * window)
        if energies[i] > local * 1.32 and energies[i] > 0.012:
            t = i * hop
            if not onsets or t - onsets[-1] >= 0.35:
                onsets.append(t)
    return energies, onsets


def section_of(energies, t: float, hop: float = 0.05) -> str:
    if not energies:
        return "verse"
    i = max(0, min(len(energies) - 1, int(t / hop)))
    w = max(1, int(1.0 / hop))
    seg = energies[max(0, i - w):min(len(energies), i + w)]
    cur = sum(seg) / len(seg)
    srt = sorted(energies)
    if cur < srt[int(len(srt) * 0.35)]:
        return "intro"
    if cur > srt[int(len(srt) * 0.70)]:
        return "chorus"
    return "verse"


# ---------------------------------------------------------------------------
# 歌词
# ---------------------------------------------------------------------------
LRC_RE = re.compile(r"^\s*\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]")
META_RE = re.compile(r"^\s*\[(?:ar|ti|al|by|offset|length|re|ve|name)[^]]*\]\s*$", re.I)
SECTION_RE = re.compile(r"^\s*[\[(【]?\s*(intro|verse|pre[- ]?chorus|chorus|bridge|outro|间奏|前奏|主歌|副歌|桥段|尾声)\b[^\])】]*\s*[\])】]?\s*$", re.I)


def parse_lyrics(path: Path, duration: float, onsets):
    raw = path.read_text(encoding="utf-8-sig", errors="replace")
    timed = []
    for line in raw.splitlines():
        s = line.strip()
        if not s or META_RE.match(s):
            continue
        if SECTION_RE.match(s) and not LRC_RE.match(s):
            continue
        stamps, rest = [], s
        while True:
            m = LRC_RE.match(rest)
            if not m:
                break
            frac = m.group(3) or "0"
            stamps.append(int(m.group(1)) * 60 + int(m.group(2)) + float(frac) / (10 ** len(frac)))
            rest = rest[m.end():].strip()
        text = rest.strip()
        if not text:
            continue
        for t in stamps:
            timed.append((min(max(t, 0.0), duration), text))
        if not stamps:
            timed.append((None, text))  # type: ignore[arg-type]
    if not timed:
        raise ValueError(f"歌词文件没有可用文本：{path}")
    if all(t is not None for t, _ in timed):
        timed.sort(key=lambda x: x[0])
        return [(float(t), text) for t, text in timed]

    texts = [text for _, text in timed]
    weights = []
    for text in texts:
        cjk = len(re.findall(r"[\u4e00-\u9fff]", text))
        words = len(re.findall(r"[A-Za-z0-9']+", text))
        weights.append(max(0.6, cjk * 0.32 + words * 0.30))
    total = sum(weights)
    lead = min(4.0, duration * 0.08)
    usable = max(1.0, duration - lead - 1.0)
    out, cursor = [], lead
    for text, w in zip(texts, weights):
        t = cursor
        if onsets:
            near = min(onsets, key=lambda o: abs(o - t))
            if abs(near - t) <= 0.8:
                t = near
        out.append((min(t, max(0.0, duration - 0.5)), text))
        cursor += usable * w / total
    return out


# ---------------------------------------------------------------------------
# 主题场景翻译：中文场景 -> 英文提示词短语
# H3 提示词本身是英文，场景词先翻译成英文再写进每镜提示词，生成更稳定。
# ---------------------------------------------------------------------------
SCENE_EN = {
    # 地点
    "舞台": "stage", "剧场": "theater", "后台": "backstage", "演唱会": "concert",
    "音乐节": "music festival", "街道": "street", "街头": "street", "霓虹街道": "neon-lit street",
    "小巷": "alley", "巷子": "alley", "胡同": "hutong alley", "公路": "highway",
    "海边": "seaside", "海滩": "beach", "沙滩": "beach", "码头": "pier", "港口": "harbor",
    "校园": "campus", "校园天台": "campus rooftop", "天台": "rooftop", "屋顶": "rooftop",
    "教室": "classroom", "图书馆": "library", "博物馆": "museum", "办公室": "office",
    "咖啡馆": "cafe", "酒吧": "bar", "餐厅": "restaurant", "教堂": "church", "城堡": "castle",
    "公园": "park", "花园": "garden", "花海": "flower field", "森林": "forest",
    "竹林": "bamboo forest", "草原": "grassland", "麦田": "wheat field", "稻田": "rice paddy",
    "雪山": "snowy mountain", "山": "mountain", "悬崖": "cliff", "洞穴": "cave",
    "湖": "lake", "河": "river", "瀑布": "waterfall", "海底": "underwater", "沙漠": "desert",
    "城市": "city", "古镇": "ancient town", "村庄": "village", "乡村": "countryside",
    "车站": "station", "地铁站": "subway station", "地铁": "subway", "机场": "airport",
    "列车": "train", "火车": "train", "公交车": "bus", "桥": "bridge", "天桥": "overpass",
    "雨夜天桥": "rainy night overpass", "体育馆": "stadium", "健身房": "gym",
    "摄影棚": "studio", "电影院": "cinema", "游乐园": "amusement park", "马戏团": "circus",
    "家里": "home", "卧室": "bedroom", "客厅": "living room", "厨房": "kitchen",
    "书房": "study room", "房间": "room", "阳台": "balcony", "地下室": "basement",
    "阁楼": "attic", "走廊": "corridor", "楼梯": "staircase", "电梯": "elevator",
    "工厂": "factory", "医院": "hospital", "监狱": "prison", "战场": "battlefield",
    "宇宙": "outer space", "太空": "outer space", "星空": "starry sky",
    # 时间与天气
    "雨夜": "rainy night", "雨天": "rainy day", "夜晚": "night", "夜": "night",
    "白天": "daytime", "清晨": "early morning", "早晨": "morning", "黄昏": "dusk",
    "日落": "sunset", "日出": "sunrise", "海边日落": "seaside sunset", "春天": "spring",
    "夏天": "summer", "秋天": "autumn", "冬天": "winter", "晴天": "sunny day",
    "阴天": "cloudy day", "雨": "rain", "雪": "snow", "雾": "fog", "霓虹": "neon",
    # 氛围与修饰
    "魔法": "magical", "神秘": "mysterious", "浪漫": "romantic", "孤独": "lonely",
    "温暖": "warm", "寒冷": "cold", "复古": "vintage", "现代": "modern",
    "未来": "futuristic", "赛博朋克": "cyberpunk", "梦幻": "dreamy", "安静": "quiet",
    "繁华": "busy", "空旷": "empty", "明亮": "bright", "昏暗": "dim",
    "红色": "red", "蓝色": "blue", "金色": "golden", "紫色": "purple", "白色": "white",
    "古风": "ancient Chinese style", "水墨": "ink wash painting", "月光": "moonlight",
    "烛光": "candlelight", "聚光灯": "spotlight", "烟火": "fireworks", "烟花": "fireworks",
    # 通用
    "室内": "indoor", "室外": "outdoor", "露营": "campsite", "营地": "campsite", "帐篷": "tent",
    # 常见长描述（整句优先匹配，避免逐词翻译丢失"乐队背景"这类细节）
    "带有乐队背景的现代舞台": "modern stage with a live band backdrop",
    "有乐队背景的舞台": "stage with a live band backdrop",
    "乐队背景": "band backdrop", "舞台背景": "stage backdrop",
    "现代舞台": "modern stage", "古风街道": "ancient-style street",
    "带有": "with", "乐队": "band", "背景": "backdrop",
    "歌手": "singer", "观众": "audience", "人群": "crowd",
}


# 场景词在提示词中的角色：未列出的词默认归 environment（环境/场景）
SCENE_ROLE = {
    # 人物 / 表演者 / 现场人物
    "歌手": "subject", "观众": "subject", "人群": "subject", "乐队": "subject",
    # 镜头 / 视觉风格 / 光照 / 情绪氛围
    "霓虹": "camera", "复古": "camera", "现代": "camera", "未来": "camera",
    "赛博朋克": "camera", "魔法": "camera", "神秘": "camera", "浪漫": "camera",
    "孤独": "camera", "温暖": "camera", "寒冷": "camera", "梦幻": "camera",
    "安静": "camera", "繁华": "camera", "空旷": "camera", "明亮": "camera",
    "昏暗": "camera", "古风": "camera", "水墨": "camera", "月光": "camera",
    "烛光": "camera", "聚光灯": "camera",
}
EN_ROLE = {
    "singer": "subject", "performer": "subject", "band": "subject",
    "crowd": "subject", "audience": "subject",
    "neon": "camera", "spotlight": "camera", "moonlight": "camera",
    "vintage": "camera", "cyberpunk": "camera", "dreamy": "camera",
    "magical": "camera", "mysterious": "camera", "romantic": "camera", "lonely": "camera",
}
_SPLIT_SCENE = re.compile(r"[,，、/／\-—+|\s]+")


def parse_scenes(scene) -> list[str]:
    """多行主题场景：一行一个场景，忽略空行与常见列表符号。"""
    out = []
    for line in re.split(r"[\r\n]+", str(scene or "")):
        line = line.strip().lstrip("•·-–—").strip()
        line = re.sub(r"^\d+[.、)]\s*", "", line).strip()
        if line:
            out.append(line)
    return out


def _scene_tokens(raw: str) -> list[tuple[str, str]]:
    """把一行场景翻译成 [(英文短语, 角色)]，角色 ∈ environment/subject/camera。"""
    raw = (raw or "").strip()
    if not raw:
        return []
    keys = sorted(SCENE_EN, key=len, reverse=True)
    out: list[tuple[str, str]] = []
    seen: set[str] = set()

    def add(text: str, role: str):
        text = re.sub(r"\s+", " ", text).strip()
        if text and text.lower() not in seen:
            seen.add(text.lower())
            out.append((text, role))

    if all(ord(c) < 128 for c in raw):  # 英文原样使用；按逗号拆开便于分维度
        for part in re.split(r"[,，、/|]+", raw):
            token = part.strip()
            if token:
                add(token, EN_ROLE.get(token.lower(), "environment"))
        return out

    for part in _SPLIT_SCENE.split(raw):
        if not part:
            continue
        if all(ord(c) < 128 for c in part):
            add(part, EN_ROLE.get(part.lower(), "environment"))
            continue
        i, hit = 0, False
        while i < len(part):
            for k in keys:
                if part.startswith(k, i):
                    add(SCENE_EN[k], SCENE_ROLE.get(k, "environment"))
                    i += len(k)
                    hit = True
                    break
            else:
                i += 1  # 未收录的中文字符跳过，不写进提示词
        if not hit:
            add("cinematic location", "environment")
    return out


def translate_scene_line(line: str) -> str:
    """翻译单行场景为英文短语。"""
    return " ".join(text for text, _ in _scene_tokens(line))


def translate_scene(scene: str) -> str:
    """主题场景翻译为英文；多行用 ' / ' 连接，单行行为与旧版一致。"""
    return " / ".join(translate_scene_line(line) for line in parse_scenes(scene))


def scene_clause_for(line: str) -> str:
    """一行场景 → 同时约束环境、人物、镜头三个维度的英文提示词片段。"""
    tokens = _scene_tokens(line)
    if not tokens:
        return ""
    buckets = {"environment": [], "subject": [], "camera": []}
    for text, role in tokens:
        buckets[role].append(text)
    env = ", ".join(buckets["environment"]) or "cinematic location"
    subject = ", ".join(buckets["subject"])
    camera = ", ".join(buckets["camera"])
    return (
        f"Setting and environment: {env}. "
        f"Characters and performer styling: {subject or 'match the setting above'}. "
        f"Camera style and mood: {camera or 'follow the setting above'}. "
    )


def assign_shot_scenes(n: int, scenes: list[str]) -> list[int]:
    """把 n 个镜头按顺序分成至多 len(scenes) 个连续组，每组共用一个场景；无场景返回 -1。"""
    if n <= 0:
        return []
    if not scenes:
        return [-1] * n
    groups = min(len(scenes), n)
    base, extra = divmod(n, groups)
    out: list[int] = []
    for g in range(groups):
        out.extend([g] * (base + (1 if g < extra else 0)))
    return out


# ---------------------------------------------------------------------------
# 分镜
# ---------------------------------------------------------------------------
def build_shots(duration, onsets, lyrics, energies, target_frames, max_shots, fps=FPS, scene="", variation_seed=0):
    n_target = max(1, int(round(duration / (target_frames / fps))))
    cuts = [0.0]
    for k in range(1, n_target):
        ideal = k * duration / n_target
        if onsets:
            cand = min(onsets, key=lambda o: abs(o - ideal))
            if abs(cand - ideal) <= (target_frames / fps) * 0.45 and cand > cuts[-1] + 1.0:
                ideal = cand
        if ideal > cuts[-1] + 1.0:
            cuts.append(ideal)
    cuts.append(duration)
    while len(cuts) - 1 > max_shots:
        gaps = [(cuts[i + 1] - cuts[i], i) for i in range(len(cuts) - 1)]
        _, idx = min(gaps)
        del cuts[idx + 1 if idx + 1 < len(cuts) - 1 else idx]

    # 主题场景：一行一个场景，先翻译成英文再写入 H3 提示词，保证提示词全英文。
    # 多个场景时按顺序把镜头切成连续组（一组镜头共用一个场景），不会来回跳场。
    scene_lines = parse_scenes(scene)
    scene_ens = [translate_scene_line(line) for line in scene_lines]
    scene_clauses = [scene_clause_for(line) for line in scene_lines]
    scene_assignment = assign_shot_scenes(len(cuts) - 1, scene_lines)

    shots = []
    for i in range(len(cuts) - 1):
        t0, t1 = cuts[i], cuts[i + 1]
        frames = snap_frames((t1 - t0) * fps, fps)
        mid = (t0 + t1) / 2
        section = section_of(energies, mid)
        lines = [text for t, text in lyrics if t0 <= t < t1]
        if not lines and lyrics:
            lines = [min(lyrics, key=lambda x: abs(x[0] - mid))[1]]
        lyric_text = re.sub(r"\s+", " ", " ".join(lines[:2])).strip()
        camera = SECTION_MOOD[section][i % len(SECTION_MOOD[section])]
        dialogue = f" <d>{lyric_text}</d>" if lyric_text else ""
        si = scene_assignment[i]
        scene_clause = scene_clauses[si] if si >= 0 else ""
        # 轮换用全片镜头序号 i：不同场景组之间也不会出现完全相同的镜头组合
        var = variation_for(i, section, variation_seed)
        # 视频提示词：机位 + 运镜 + 音景 + 单镜一镜到底
        prompt = (
            "<Picture 1> is the same performer in every shot: keep the exact same face, "
            "hair, outfit and identity. "
            f"{scene_clause}Section mood: {camera}.{dialogue} "
            "This is one continuous take with a single camera setup: no cuts, "
            "no camera-angle changes and no inserts inside this shot. "
            f"{var['video']}"
            f"overall_soundscape: {SOUNDSCAPE[section]}. "
            "non_diegetic_music: none. cinematic lighting, natural continuous motion, "
            "no text, no watermark, no logo."
        )
        # 首帧图提示词：机位/景别前置（静帧对开头词更敏感），去掉运镜、音景与「连续镜头」
        frame_prompt = (
            "<Picture 1> is the same performer: keep the exact same face, hair, outfit "
            "and identity. "
            f"{var['frame']}"
            f"{scene_clause}"
            "Still frame, a single frozen moment, no motion blur, sharp focus, "
            "photographic detail, cinematic lighting, no text, no watermark, no logo."
        )
        shots.append({"index": i + 1, "start": round(t0, 2), "end": round(t1, 2),
                      "frames": frames, "section": section, "lyric": lyric_text,
                      "scene": scene_lines[si] if si >= 0 else "",
                      "sceneEn": scene_ens[si] if si >= 0 else "",
                      "sceneGroup": si + 1 if si >= 0 else 0,
                      "variation": var["video"].strip(),
                      "frameVariation": var["frame"].strip(),
                      "variationLabel": var["label"],
                      "prompt": prompt,
                      "framePrompt": frame_prompt})
    # 关键：每镜帧数保持 H3 要求的 17n+5 栅格；若各镜吸附后总帧短于歌曲总帧，
    # 给最后一镜补 GRID 帧直到够长。finalize 再用 -t 歌曲时长 + -shortest 精确截断，
    # 从而成片时长 == 歌曲时长，且不破坏 H3 的帧数栅格。
    if shots:
        song_frames = int(round(duration * fps))
        total = sum(s["frames"] for s in shots)
        while total < song_frames:
            shots[-1]["frames"] += FRAME_GRID
            total += FRAME_GRID
        cursor = 0
        for s in shots:
            s["start"] = round(cursor / fps, 3)
            cursor += s["frames"]
            s["end"] = round(cursor / fps, 3)
    return shots


# ---------------------------------------------------------------------------
# ComfyUI API（官方核心节点，逐镜提交）
# ---------------------------------------------------------------------------
def api_get(path: str):
    with urllib.request.urlopen(COMFY_URL + path, timeout=15) as r:
        return json.load(r)


def build_shot_prompt(shot, args, ref_name: str):
    """按 ComfyUI 官方 video_minimax_h3_r2v 模板组装单镜 API prompt。"""
    seed = args.seed + shot["index"]
    model_node = "1"
    prompt = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": args.unet, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": args.clip, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": args.vae_video}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": args.vae_audio}},
        "5": {"class_type": "LoadImage", "inputs": {"image": ref_name}},
        "6": {"class_type": "MiniMaxH3ReferenceToVideo", "inputs": {
            "clip": ["2", 0], "vae": ["3", 0], "audio_vae": ["4", 0],
            "prompt": shot["prompt"],
            "width": args.width, "height": args.height, "length": shot["frames"],
            "ref_image_size": "match", "ref_images.ref_image_0": ["5", 0],
        }},
        "7": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": args.sampler}},
        "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "9": {"class_type": "BasicGuider", "inputs": {"model": [model_node, 0], "conditioning": ["6", 0]}},
        "10": {"class_type": "BasicScheduler", "inputs": {
            "model": [model_node, 0], "scheduler": args.scheduler,
            "steps": args.steps, "denoise": 1.0,
        }},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["8", 0], "guider": ["9", 0], "sampler": ["7", 0],
            "sigmas": ["10", 0], "latent_image": ["6", 1],
        }},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "VAEDecodeAudio", "inputs": {"samples": ["11", 0], "vae": ["4", 0]}},
        "14": {"class_type": "CreateVideo", "inputs": {
            "images": ["12", 0], "fps": args.fps, "audio": ["13", 0], "codec": "auto",
        }},
        "15": {"class_type": "SaveVideo", "inputs": {
            "video": ["14", 0],
            "filename_prefix": f"video/AUTO_MV_{args.name or 'shot'}_{shot['index']:02d}",
            "format": "auto",
        }},
    }
    if args.shift_video or args.shift_audio:
        prompt["16"] = {"class_type": "MiniMaxH3SigmaShift", "inputs": {
            "model": [model_node, 0],
            "shift_video": args.shift_video, "shift_audio": args.shift_audio,
        }}
        prompt["9"]["inputs"]["model"] = ["16", 0]
        prompt["10"]["inputs"]["model"] = ["16", 0]
    if args.turbo:
        prompt["17"] = {"class_type": "LoraLoaderModelOnly", "inputs": {
            "model": [model_node, 0], "lora_name": args.lora, "strength_model": 1.0,
        }}
        upstream = "17"
        if "16" in prompt:
            prompt["16"]["inputs"]["model"] = ["17", 0]
        else:
            prompt["9"]["inputs"]["model"] = ["17", 0]
            prompt["10"]["inputs"]["model"] = ["17", 0]
        del upstream
    return prompt


def queue_prompt(prompt: dict, client_id: str):
    data = json.dumps({"prompt": prompt, "client_id": client_id}, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(COMFY_URL + "/prompt", data=data,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"ComfyUI 拒绝任务：{body[:2000]}") from e


def find_video_outputs(history_entry: dict, output_root: Path):
    found = []
    def walk(obj):
        if isinstance(obj, dict):
            name = obj.get("filename")
            if isinstance(name, str) and name.lower().endswith((".mp4", ".webm", ".mov", ".mkv")):
                p = output_root / str(obj.get("subfolder", "")) / name
                if p.exists() and p not in found:
                    found.append(p)
            for v in obj.values():
                walk(v)
        elif isinstance(obj, list):
            for v in obj:
                walk(v)
    walk(history_entry.get("outputs", {}))
    return found


def submit_and_wait(prompt: dict, output_root: Path, poll=5, timeout=6 * 3600):
    client_id = "auto-mv-" + os.urandom(4).hex()
    res = queue_prompt(prompt, client_id)
    pid = res.get("prompt_id")
    if not pid:
        raise RuntimeError(f"提交失败：{res}")
    started = time.time()
    while True:
        if time.time() - started > timeout:
            raise TimeoutError(f"等待 ComfyUI 超时（{timeout}s）")
        try:
            history = api_get(f"/history/{pid}")
            if pid in history:
                entry = history[pid]
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"ComfyUI 执行出错：{str(status.get('messages'))[:1800]}")
                videos = find_video_outputs(entry, output_root)
                if videos:
                    return videos[-1]
                if status.get("completed"):
                    raise RuntimeError("任务结束但没有找到视频输出，请查看 ComfyUI 日志")
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(poll)


# ---------------------------------------------------------------------------
# 输出：字幕 / 分镜表 / 拼接合成
# ---------------------------------------------------------------------------
def ass_escape(text: str) -> str:
    return text.replace("{", "(").replace("}", ")").replace("\\", "/").replace("\n", " ")


def write_ass(path: Path, lyrics, duration: float) -> None:
    cues = []
    for i, (t, text) in enumerate(lyrics):
        end = lyrics[i + 1][0] if i + 1 < len(lyrics) else min(duration, t + 3.5)
        if end <= t:
            end = t + 2.0
        cues.append((t, end, text))
    def ts(t):
        return f"{int(t // 3600):d}:{int((t % 3600) // 60):02d}:{t % 60:05.2f}"
    content = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 864", "PlayResY: 480", "WrapStyle: 2", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,Microsoft YaHei,34,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,40,40,36,1",
        "", "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for t0, t1, text in cues:
        content.append(f"Dialogue: 0,{ts(t0)},{ts(t1)},Default,,0,0,0,,{ass_escape(text)}")
    path.write_text("\n".join(content) + "\n", encoding="utf-8")


def write_storyboard(path: Path, shots, args, song, image, lyric_file, scene=""):
    scene_lines = parse_scenes(scene)
    scene_md = "（未指定）"
    if scene_lines:
        scene_md = "\n" + "\n".join(
            f"  - 场景 {i}：{line} → {translate_scene_line(line)}（对应第 {i} 组连续镜头）"
            for i, line in enumerate(scene_lines, 1)
        )
    lines = [
        "# 自动生成的 MV 分镜表", "",
        f"- 生成时间：{datetime.now():%Y-%m-%d %H:%M:%S}",
        f"- 原曲：{song}", f"- 歌词：{lyric_file or '（无歌词 · 按节拍与场景生成）'}",
        f"- 主题场景（每行一个场景，一组连续镜头共用一个）：{scene_md}",
        f"- 参考图：{image}",
        f"- 参数：{args.width}×{args.height} / {args.fps}fps / steps={args.steps} / seed={args.seed} / turbo={args.turbo}",
        f"- 镜头数：{len(shots)}，总帧数：{sum(s['frames'] for s in shots)}", "",
        "| # | 时间 | 段落 | 帧数 | 场景 | 镜头变化 | 歌词 |", "|---|---|---|---|---|---|---|",
    ]
    for s in shots:
        scene_label = s.get("scene") or "—"
        variation_label = s.get("variationLabel") or "—"
        lines.append(f"| {s['index']} | {fmt_time(s['start'])}–{fmt_time(s['end'])} | {s['section']} | {s['frames']} | {scene_label.replace('|', '/')} | {variation_label.replace('|', '/')} | {str(s['lyric']).replace('|', '/')[:40]} |")
    lines += ["", "## 每镜提示词", ""]
    for s in shots:
        lines += [f"### 镜头 {s['index']}（{fmt_time(s['start'])}）", "", s["prompt"], ""]
    path.write_text("\n".join(lines), encoding="utf-8")


def normalize_shot(src: Path, dst: Path, fps: float, width: int, height: int):
    """统一帧率/分辨率并去掉 H3 自带音轨，保证多镜头 concat 不漂移。"""
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
         "-vf", f"fps={fps:g},scale={width}:{height}", "-an",
         "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", str(dst)])


def concat_shots(videos, out_dir: Path, merged: Path):
    list_file = out_dir / "concat_list.txt"
    list_file.write_text(
        "".join(f"file '{os.path.relpath(p, out_dir).replace(os.sep, '/')}'\n" for p in videos),
        encoding="utf-8",
    )
    run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", "concat_list.txt", "-c", "copy", merged.name], cwd=str(out_dir))


def finalize(song: Path, merged: Path, out_file: Path, duration: float,
             offset: float, lyrics, burn_subs: bool, out_dir: Path, fade: float):
    if burn_subs:
        write_ass(out_dir / "lyrics_auto.ass", lyrics, duration)
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(merged),
               "-ss", f"{offset:.3f}", "-t", f"{duration:.3f}", "-i", str(song),
               "-vf", "subtitles=lyrics_auto.ass", "-map", "0:v:0", "-map", "1:a:0",
               "-c:v", "libx264", "-crf", "18", "-preset", "medium", "-pix_fmt", "yuv420p",
               "-c:a", "aac", "-b:a", "320k", "-shortest"]
    else:
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(merged),
               "-ss", f"{offset:.3f}", "-t", f"{duration:.3f}", "-i", str(song),
               "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy",
               "-c:a", "aac", "-b:a", "320k", "-shortest"]
    if fade > 0:
        cmd += ["-af", f"afade=t=in:st=0:d={fade},afade=t=out:st={max(0.1, duration - fade)}:d={fade}"]
    cmd.append(str(out_file))
    log("正在拼接原曲与字幕…")
    run(cmd, capture=False, cwd=str(out_dir))


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
def parse_args(argv=None):
    p = argparse.ArgumentParser(description="参考图 + MP3 + 歌词 → 自动生成 MV（本机 ComfyUI H3）")
    p.add_argument("--image", required=True, help="人物参考图路径")
    p.add_argument("--audio", required=True, help="歌曲 MP3/WAV 路径")
    p.add_argument("--lyrics", default="", help="歌词路径（.txt / .lrc），可选；不填则按节拍与场景生成无字幕 MV")
    p.add_argument("--no-lyrics", action="store_true", help="歌词开关：即使提供了 --lyrics 也完全不用（分镜无台词、成片无字幕）")
    p.add_argument("--out-dir", default=str(DEFAULT_OUT_DIR))
    p.add_argument("--name", default="", help="输出名（不含扩展名）")
    p.add_argument("--duration", type=float, default=0.0, help="兼容旧参数；始终按整首歌曲时长出片")
    p.add_argument("--scene", default="", help="主题场景，每行一个（如 舞台 / 街道 / 海边）；可写环境、人物、镜头氛围，多场景时一组连续镜头共用一个场景")
    p.add_argument("--song-offset", type=float, default=0.0, help="从原曲第几秒开始")
    p.add_argument("--burn-subs", action="store_true", help="把歌词烧录进画面")
    p.add_argument("--no-fade", action="store_true")
    p.add_argument("--max-shots", type=int, default=24)
    p.add_argument("--shot-seconds", type=float, default=5.17)
    p.add_argument("--width", type=int, default=864)
    p.add_argument("--height", type=int, default=480)
    p.add_argument("--fps", type=float, default=FPS)
    p.add_argument("--steps", type=int, default=20, help="采样步数（默认 20；turbo 时用 4）")
    p.add_argument("--cfg", type=float, default=1.0, help="保留参数，核心节点由官方模板默认值处理")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--sampler", default="res_multistep")
    p.add_argument("--scheduler", default="simple")
    p.add_argument("--shift-video", type=float, default=12.0)
    p.add_argument("--shift-audio", type=float, default=3.0)
    p.add_argument("--turbo", action="store_true", help="使用 4 步 Turbo LoRA（需配合 --steps 4）")
    p.add_argument("--lora", default=LORA_TURBO)
    p.add_argument("--unet", default=UNET_R2V)
    p.add_argument("--clip", default=CLIP_H3)
    p.add_argument("--vae-video", default=VAE_VIDEO)
    p.add_argument("--vae-audio", default=VAE_AUDIO)
    p.add_argument("--comfy-input", default=str(COMFY_INPUT))
    p.add_argument("--comfy-output", default=str(COMFY_OUTPUT))
    p.add_argument("--dry-run", action="store_true", help="只分析并生成分镜/工作流 JSON")
    return p.parse_args(argv)


def main(argv=None):
    global COMFY_INPUT, COMFY_OUTPUT
    args = parse_args(argv)
    COMFY_INPUT = Path(args.comfy_input).expanduser().resolve()
    COMFY_OUTPUT = Path(args.comfy_output).expanduser().resolve()
    image = Path(args.image).expanduser().resolve()
    song = Path(args.audio).expanduser().resolve()
    lyric_file = Path(args.lyrics).expanduser().resolve() if (args.lyrics and not args.no_lyrics) else None
    out_dir = Path(args.out_dir).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    for label, p in (("参考图", image), ("歌曲", song)):
        if not p.is_file():
            raise SystemExit(f"找不到{label}：{p}")
    if lyric_file and not lyric_file.is_file():
        raise SystemExit(f"找不到歌词：{lyric_file}")

    log(f"参考资料：{image.name} / {song.name} / {lyric_file.name if lyric_file else ('歌词已关闭' if args.no_lyrics else '无歌词')}"
        f" / 场景：{args.scene or '未指定'}" + (f" → {translate_scene(args.scene)}" if args.scene else ""))
    full = probe_duration(song)
    duration = full  # 成片时长始终 = 歌曲时长
    log(f"歌曲总长 {fmt_time(full)}，本次制作 {fmt_time(duration)}（整首）")
    energies, onsets = analyze_audio(song)
    log(f"检测到 {len(onsets)} 个节拍点，用于自动卡点")
    lyrics = parse_lyrics(lyric_file, duration, onsets) if lyric_file else []
    log(f"解析歌词 {len(lyrics)} 行" if lyrics else "无歌词：按节拍与主题场景生成分镜")

    target_frames = snap_frames(args.shot_seconds * args.fps)
    shots = build_shots(duration, onsets, lyrics, energies, target_frames,
                        args.max_shots, args.fps, scene=args.scene,
                        variation_seed=args.seed)
    total_frames = sum(s["frames"] for s in shots)
    log(f"生成 {len(shots)} 个镜头 / {total_frames} 帧 / 约 {fmt_time(total_frames / args.fps)}")

    COMFY_INPUT.mkdir(parents=True, exist_ok=True)
    try:
        inside = image.is_relative_to(COMFY_INPUT)
    except AttributeError:
        inside = str(image).lower().startswith(str(COMFY_INPUT).lower())
    if inside:
        ref_name = image.name
    else:
        ref_name = "auto_mv_ref" + (image.suffix.lower() or ".png")
        shutil.copy2(image, COMFY_INPUT / ref_name)
    log(f"参考图已放入 ComfyUI/input：{ref_name}")

    stem = args.name or (song.stem + "_" + datetime.now().strftime("%m%d_%H%M"))
    sb_path = out_dir / f"{stem}_分镜表.md"
    write_storyboard(sb_path, shots, args, song, image, lyric_file, scene=args.scene)
    prompts = [build_shot_prompt(s, args, ref_name) for s in shots]
    for s, pr in zip(shots, prompts):
        (out_dir / f"{stem}_镜头{s['index']:02d}_工作流.json").write_text(
            json.dumps(pr, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"分镜表：{sb_path}")
    log(f"已写出 {len(prompts)} 份单镜工作流 JSON（可手动导入 ComfyUI）")

    if args.dry_run:
        log("干跑模式：未提交 ComfyUI。去掉 --dry-run 正式生成。")
        return

    try:
        api_get("/system_stats")
    except Exception as e:
        raise SystemExit(f"ComfyUI 未运行或不可访问（{COMFY_URL}）：{e}\n请先启动 ComfyUI Desktop。")

    videos = []
    for i, pr in enumerate(prompts, 1):
        log(f"生成镜头 {i}/{len(prompts)}（{shots[i-1]['frames']} 帧）…")
        videos.append(submit_and_wait(pr, COMFY_OUTPUT))
    log(f"全部镜头生成完毕：{len(videos)} 段")

    shot_dir = out_dir / "镜头原始"
    shot_dir.mkdir(exist_ok=True)
    local_videos = []
    for i, v in enumerate(videos, 1):
        dst = shot_dir / f"shot_{i:02d}.mp4"
        normalize_shot(v, dst, args.fps, args.width, args.height)
        local_videos.append(dst)
    log("镜头帧率/分辨率已统一")

    merged = out_dir / f"{stem}_无声拼接.mp4"
    concat_shots(local_videos, out_dir, merged)
    final = out_dir / f"{stem}_MV.mp4"
    finalize(song, merged, final, duration, args.song_offset,
             lyrics, args.burn_subs and bool(lyrics) and not args.no_lyrics,
             out_dir, 0.0 if args.no_fade else 1.0)
    log(f"完成：{final}")
    print(str(final))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n已取消", file=sys.stderr)
        sys.exit(130)
    except Exception as exc:
        print(f"[AUTO-MV] 失败：{exc}", file=sys.stderr)
        sys.exit(1)
