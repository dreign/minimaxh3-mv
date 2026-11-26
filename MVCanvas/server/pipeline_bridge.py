# -*- coding: utf-8 -*-
"""
pipeline_bridge.py — MV 无限画布的 Python 生成桥

由 Node 后端以子进程调用，命令：
  python pipeline_bridge.py <config.json>

config.command:
  analyze   -> 分析节拍/歌词，打印 RESULT <json>
  keyframes -> 逐镜用 H3 Image 生成首帧图（参考人物一致），写 state.json
  generate  -> 逐镜调用 ComfyUI H3 生成（优先用首帧图 i2v），持续写 state.json
  compose   -> ffmpeg 拼接 + 铺原曲 + 字幕，持续写 state.json

复用同工作区已验证的 MV制作交付/auto_mv.py，不重复实现生成逻辑。
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import shutil
import sys
import time
import traceback
import urllib.error
from pathlib import Path
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parent.parent
AUTO_MV_PATH = ROOT.parent / "MV制作交付" / "auto_mv.py"

spec = importlib.util.spec_from_file_location("auto_mv_module", AUTO_MV_PATH)
if spec is None or spec.loader is None:
    raise RuntimeError(f"无法加载 {AUTO_MV_PATH}")
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def write_state(path: str, **updates):
    p = Path(path)
    data = {}
    if p.exists():
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            data = {}
    data.update(updates)
    logs = data.get("logs", [])[-400:]
    data["logs"] = logs
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(tmp, p)


def emit(state_path: str, stage: str, progress: float, log: str | None = None):
    kwargs = {"status": "running", "stage": stage, "progress": round(progress, 4)}
    if log:
        kwargs["logs"] = [log]
    write_state(state_path, **kwargs)
    if log:
        print("LOG " + log, flush=True)


def _dim(v, fallback: int, align32: bool = True) -> int:
    """把宽高收敛到 256–2048；非法值回退到 fallback。

    ComfyUI object_info 显示 H3 Image / 视频节点的 width/height 步长都是 32，
    自定义出图尺寸默认对齐到 32 的倍数，避免非对齐值导致 latent 尺寸异常；
    视频尺寸走 align32=False，保留既有预设（如 608×1080）不被改写。
    """
    try:
        n = int(v)
    except (TypeError, ValueError):
        return fallback
    if n <= 0:
        return fallback
    n = max(256, min(2048, n))
    if align32 and n % 32:
        n = round(n / 32) * 32
    return max(256, min(2048, n))


def args_from_config(cfg: dict, job_id: str) -> SimpleNamespace:
    p = cfg.get("params") or {}
    width = _dim(p.get("width", 864), 864, align32=False)
    height = _dim(p.get("height", 480), 480, align32=False)
    # H3 Image 出图尺寸可独立配置；mode != custom 时跟随视频尺寸。
    # 兼容字段放在 params 内或配置顶层两种传法。
    mode = str(p.get("keyframeSizeMode") or cfg.get("keyframeSizeMode") or "follow")
    kw = _dim(p.get("keyframeWidth") or cfg.get("keyframeWidth"), width)
    kh = _dim(p.get("keyframeHeight") or cfg.get("keyframeHeight"), height)
    if mode != "custom":
        kw, kh = width, height
    return SimpleNamespace(
        name=job_id,
        unet=p.get("unet", m.UNET_R2V),
        clip=p.get("clip", m.CLIP_H3),
        vae_video=p.get("vaeVideo", m.VAE_VIDEO),
        vae_audio=p.get("vaeAudio", m.VAE_AUDIO),
        width=width, height=height,
        keyframe_width=kw, keyframe_height=kh,
        fps=float(p.get("fps", 24)),
        steps=int(p.get("steps", 20)),
        seed=int(p.get("seed", 42)),
        sampler=p.get("sampler", "res_multistep"),
        scheduler=p.get("scheduler", "simple"),
        shift_video=float(p.get("shiftVideo", 12)),
        shift_audio=float(p.get("shiftAudio", 3)),
        turbo=bool(p.get("turbo", False)),
        lora=p.get("lora", m.LORA_TURBO),
        duration=float(cfg.get("duration") or 0) or 0.0,
        cfg=1.0,
    )


# H3 Image / ImageToVideo 本机模型（与 auto_mv 的 r2v 模型分开）
UNET_IMAGE = "minimax_h3_image_pruned_int8_convrot.safetensors"
VAE_IMAGE = "minimax_h3_image_vae_fp16.safetensors"
UNET_I2V = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
VAE_VIDEO_I2V = "minimax_h3_video_vae_int8_convrot.safetensors"


def find_image_outputs(history_entry: dict, output_root: Path):
    found = []
    def walk(obj):
        if isinstance(obj, dict):
            name = obj.get("filename")
            if isinstance(name, str) and name.lower().endswith((".png", ".jpg", ".jpeg", ".webp")):
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


def submit_and_wait_image(prompt: dict, output_root: Path, poll=3, timeout=20 * 60):
    """提交工作流并等待首个图片输出。"""
    client_id = "mvcanvas-img-" + os.urandom(4).hex()
    res = m.queue_prompt(prompt, client_id)
    pid = res.get("prompt_id")
    if not pid:
        raise RuntimeError(f"提交首帧图任务失败：{res}")
    started = time.time()
    while True:
        if time.time() - started > timeout:
            raise TimeoutError(f"等待首帧图超时（{timeout}s）")
        try:
            history = m.api_get(f"/history/{pid}")
            if pid in history:
                entry = history[pid]
                status = entry.get("status", {})
                if status.get("status_str") == "error":
                    raise RuntimeError(f"首帧图生成出错：{str(status.get('messages'))[:1800]}")
                imgs = find_image_outputs(entry, output_root)
                if imgs:
                    return imgs[-1]
                if status.get("completed"):
                    raise RuntimeError("首帧图任务结束但没有图片输出，请查看 ComfyUI 日志")
        except (urllib.error.URLError, ConnectionError, TimeoutError):
            pass
        time.sleep(poll)


def build_keyframe_prompt(shot: dict, args, ref_name: str, frame_prompt: str):
    """用 H3 Image 生成单镜首帧图：参考人物 + 该镜静态画面描述。

    H3 Image 出图尺寸 = args.keyframe_width × args.keyframe_height（可在画布上配置，
    默认跟随视频尺寸）。若自定义出图尺寸与视频尺寸不同，出图后插入 ImageScale
    把画面缩放到视频尺寸再保存，保证首帧图与 i2v 的 first_frame 尺寸一致。
    """
    seed = args.seed + shot["index"] * 7
    gen_w = int(getattr(args, "keyframe_width", 0) or args.width)
    gen_h = int(getattr(args, "keyframe_height", 0) or args.height)
    prompt = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET_IMAGE, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": args.clip, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_IMAGE}},
        "5": {"class_type": "LoadImage", "inputs": {"image": ref_name}},
        "48": {"class_type": "ResizeImageMaskNode", "inputs": {
            "input": ["5", 0], "resize_type": "scale dimensions",
            "resize_type.width": gen_w, "resize_type.height": gen_h,
            "resize_type.crop": "center", "scale_method": "area",
        }},
        "32": {"class_type": "MiniMaxH3ImageConditioning", "inputs": {
            "clip": ["2", 0], "vae": ["3", 0], "prompt": frame_prompt,
            "width": gen_w, "height": gen_h,
            "images.image_1": ["48", 0], "enhance_prompt": False,
        }},
        "33": {"class_type": "ConditioningZeroOut", "inputs": {"conditioning": ["32", 0]}},
        "38": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "seed": seed, "steps": 6, "cfg": 1.0,
            "sampler_name": "euler", "scheduler": "simple",
            "positive": ["32", 0], "negative": ["33", 0],
            "latent_image": ["32", 1], "denoise": 1.0,
        }},
        "42": {"class_type": "VAEDecode", "inputs": {"samples": ["38", 0], "vae": ["3", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {
            "images": ["42", 0],
            "filename_prefix": f"keyframe/{args.name or 'mv'}_{shot['index']:02d}",
        }},
    }
    if (gen_w, gen_h) != (args.width, args.height):
        prompt["43"] = {"class_type": "ImageScale", "inputs": {
            "image": ["42", 0], "width": args.width, "height": args.height,
            "upscale_method": "lanczos", "crop": "center",
        }}
        prompt["9"]["inputs"]["images"] = ["43", 0]
    return prompt


def build_i2v_prompt(shot: dict, args, keyframe_name: str):
    """用首帧图作为 first_frame 生成该镜视频（i2v）。"""
    seed = args.seed + shot["index"]
    return {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET_I2V, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {"clip_name": args.clip, "type": "minimax", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_VIDEO_I2V}},
        "4": {"class_type": "VAELoader", "inputs": {"vae_name": args.vae_audio}},
        "5": {"class_type": "LoadImage", "inputs": {"image": keyframe_name}},
        "6": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["2", 0], "vae": ["3", 0], "prompt": shot["prompt"],
            "width": args.width, "height": args.height, "length": shot["frames"],
            "first_frame": ["5", 0],
        }},
        "7": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": args.sampler}},
        "8": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "9": {"class_type": "BasicGuider", "inputs": {"model": ["1", 0], "conditioning": ["6", 0]}},
        "10": {"class_type": "BasicScheduler", "inputs": {
            "model": ["1", 0], "scheduler": args.scheduler, "steps": args.steps, "denoise": 1.0,
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


def frame_prompt_for(shot: dict) -> str:
    """首帧图提示词：优先用分镜里单独写的 framePrompt。

    首帧图与视频的提示词是分开写的：视频用 shot["prompt"]（含运镜/音景/一镜到底），
    首帧用 shot["framePrompt"]（静态定格，无运镜、无音景）。
    老数据只有视频提示词时，这里剥掉视频专属段落后退化成静态提示词。
    """
    fp = (shot.get("framePrompt") or "").strip()
    if fp:
        return fp

    p = (shot.get("prompt") or "").strip()
    if not p:
        return ""
    p = re.sub(r"This is one continuous take[^.]*\.\s*", "", p, flags=re.I)
    p = re.sub(r"overall_soundscape:.*?(?=non_diegetic_music:)", "", p, flags=re.I | re.S)
    p = re.sub(r"non_diegetic_music:[^.]*\.\s*", "", p, flags=re.I)
    # 变化句是「机位, 光线, 运镜, 表演」，静帧要去掉运镜那一项
    motion_words = (
        r"slow dolly-in|smooth lateral tracking|gentle handheld sway|"
        r"orbiting arc around the performer|slow pull-back reveal|"
        r"locked-off static frame|rack focus from foreground to the face|"
        r"subtle crane-up|quick push-in on the beat"
    )
    p = re.sub(rf"(Variation for this shot in the same scene:[^.]*?),\s*(?:{motion_words})", r"\1", p)
    p = p.replace("natural continuous motion", "a single frozen moment")
    if "still frame" not in p.lower():
        p += " Still frame, no motion blur, sharp focus, cinematic lighting."
    return re.sub(r"\s+", " ", p).strip()


def normalize_shots(raw_shots, cfg, args) -> list[dict]:
    if not raw_shots:
        return []
    out = []
    cursor = 0
    for i, raw in enumerate(raw_shots, 1):
        frames = m.snap_frames(float(raw.get("frames") or 124), args.fps)
        out.append({
            "id": raw.get("id") or f"shot-{i}",
            "index": i,
            "start": round(cursor / args.fps, 3),
            "end": round((cursor + frames) / args.fps, 3),
            "frames": frames,
            "section": raw.get("section", "verse"),
            "lyric": raw.get("lyric", ""),
            "scene": raw.get("scene", ""),
            "sceneEn": raw.get("sceneEn", ""),
            "sceneGroup": raw.get("sceneGroup", 0),
            "variation": raw.get("variation", ""),
            "frameVariation": raw.get("frameVariation", ""),
            "variationLabel": raw.get("variationLabel", ""),
            "prompt": raw.get("prompt", ""),
            "framePrompt": raw.get("framePrompt", ""),
        })
        cursor += frames
    return out


def cmd_analyze(cfg: dict):
    song = Path(cfg["audio"])
    # 歌词总开关：关闭时即使传了歌词文件也完全不用；未传/文件缺失同样按空歌词处理
    use_lyrics = bool(cfg.get("useLyrics", True))
    lyric_path = cfg.get("lyrics")
    lyric_file = Path(lyric_path) if (use_lyrics and lyric_path and Path(lyric_path).is_file()) else None
    full = m.probe_duration(song)
    # MV 时长强制等于歌曲时长：忽略前端传入的 duration 截断值
    duration = full
    energies, onsets = m.analyze_audio(song)
    lyrics = m.parse_lyrics(lyric_file, duration, onsets) if lyric_file else []
    target = m.snap_frames(float(cfg.get("shotSeconds", 5.17)) * 24)
    shots = m.build_shots(duration, onsets, lyrics, energies, target,
                          int(cfg.get("maxShots", 24)), 24, scene=cfg.get("scene", ""),
                          variation_seed=int(cfg.get("seed") or 0))
    for i, s in enumerate(shots, 1):
        s["id"] = s.get("id") or f"shot-{i}"
    # 多行场景：一行一个场景，一组连续镜头共用一个场景；返回分组概览供画布展示
    scene_groups = []
    for gi, line in enumerate(m.parse_scenes(cfg.get("scene", "")), 1):
        scene_groups.append({
            "group": gi,
            "scene": line,
            "sceneEn": m.translate_scene_line(line),
            "shots": [s["index"] for s in shots if s.get("sceneGroup") == gi],
        })
    result = {
        "duration": duration,
        "songDuration": duration,
        "onsets": len(onsets),
        "useLyrics": use_lyrics,
        "sceneEn": m.translate_scene(cfg.get("scene", "")),
        "sceneGroups": scene_groups,
        "lyrics": [{"t": round(t, 3), "text": text} for t, text in lyrics],
        "shots": shots,
    }
    print("RESULT " + json.dumps(result, ensure_ascii=False), flush=True)


def cmd_keyframes(cfg: dict, state_path: str):
    """逐镜生成首帧图，存到 jobDir/keyframes，并复制到 ComfyUI input 供 i2v 引用。"""
    job_id = cfg["jobId"]
    job_dir = Path(cfg["jobDir"])
    kf_dir = job_dir / "keyframes"
    kf_dir.mkdir(parents=True, exist_ok=True)
    args = args_from_config(cfg, job_id)

    emit(state_path, "准备素材", 0.02, f"首帧图任务 {job_id} 启动")
    image = Path(cfg["image"])
    ref_name = f"mvcanvas_{job_id}_{image.name}"
    shutil.copy2(image, m.COMFY_INPUT / ref_name)
    m.api_get("/system_stats")

    shots = normalize_shots(cfg.get("shots"), cfg, args)
    if not shots:
        raise RuntimeError("没有分镜，请先分析")
    gen_w, gen_h = args.keyframe_width, args.keyframe_height
    size_note = (f"{gen_w}×{gen_h} 出图 → 缩放到 {args.width}×{args.height} 保存"
                 if (gen_w, gen_h) != (args.width, args.height)
                 else f"{args.width}×{args.height}")
    emit(state_path, "分镜就绪", 0.05, f"共 {len(shots)} 镜首帧图 · H3 Image {size_note}")

    keyframe_files = []
    total = len(shots)
    resume = bool(cfg.get("resume"))
    reused = 0
    for i, shot in enumerate(shots, 1):
        dst = kf_dir / f"keyframe_{i:02d}.png"
        input_name = f"mvcanvas_{job_id}_kf_{i:02d}.png"
        if resume and dst.is_file() and dst.stat().st_size > 1024:
            # 续跑：图已在 job 目录里，只需保证 ComfyUI input 里也有（i2v 要从 input 读）
            if not (m.COMFY_INPUT / input_name).is_file():
                shutil.copy2(dst, m.COMFY_INPUT / input_name)
            keyframe_files.append({
                "index": i,
                "file": f"keyframes/keyframe_{i:02d}.png",
                "url": f"/media/jobs/{job_id}/keyframes/keyframe_{i:02d}.png",
                "inputName": input_name,
            })
            reused += 1
            emit(state_path, f"跳过首帧 {i}/{total}", 0.05 + 0.9 * i / total,
                 f"复用已生成的 {dst.name}")
            continue
        emit(state_path, f"生成首帧 {i}/{total}", 0.05 + 0.9 * (i - 1) / total,
             f"镜头 #{i} 首帧 · H3 Image {size_note}")
        fp = frame_prompt_for(shot)
        pr = build_keyframe_prompt(shot, args, ref_name, fp)
        img = submit_and_wait_image(pr, m.COMFY_OUTPUT)
        # 复制到 job 目录与 ComfyUI input（i2v 的 LoadImage 从 input 读）
        shutil.copy2(img, dst)
        shutil.copy2(img, m.COMFY_INPUT / input_name)
        keyframe_files.append({
            "index": i,
            "file": f"keyframes/keyframe_{i:02d}.png",
            "url": f"/media/jobs/{job_id}/keyframes/keyframe_{i:02d}.png",
            "inputName": input_name,
        })
        emit(state_path, f"首帧 {i}/{total} 完成", 0.05 + 0.9 * i / total, f"已保存 {dst.name}")

    # width/height 记录的是「保存下来的首帧尺寸」= 视频尺寸，供 cmd_generate 的 i2v 校验；
    # sourceWidth/sourceHeight 记录 H3 Image 实际出图尺寸，供画布显示。
    (job_dir / "keyframes_meta.json").write_text(
        json.dumps({"jobId": job_id, "keyframes": keyframe_files,
                    "width": args.width, "height": args.height,
                    "sourceWidth": gen_w, "sourceHeight": gen_h},
                   ensure_ascii=False, indent=2),
        encoding="utf-8")
    result = {"keyframes": keyframe_files, "count": len(keyframe_files),
              "width": args.width, "height": args.height,
              "sourceWidth": gen_w, "sourceHeight": gen_h}
    write_state(state_path, status="done", stage="首帧图完成", progress=1.0,
                result=result,
                logs=[f"全部 {total} 张首帧图生成完成（H3 Image {size_note}）"
                      + (f"，其中 {reused} 张续跑复用" if reused else "")])
    print("RESULT " + json.dumps(result, ensure_ascii=False), flush=True)


def cmd_generate(cfg: dict, state_path: str):
    job_id = cfg["jobId"]
    job_dir = Path(cfg["jobDir"])
    shot_dir = job_dir / "shots"
    shot_dir.mkdir(parents=True, exist_ok=True)
    args = args_from_config(cfg, job_id)

    emit(state_path, "准备素材", 0.02, f"任务 {job_id} 启动")
    image = Path(cfg["image"])
    ref_name = f"mvcanvas_{job_id}_{image.name}"
    shutil.copy2(image, m.COMFY_INPUT / ref_name)
    emit(state_path, "参考图就绪", 0.05, f"参考图：{ref_name}")

    m.api_get("/system_stats")

    shots = normalize_shots(cfg.get("shots"), cfg, args)
    if not shots:
        raise RuntimeError("没有可生成的镜头，请先分析")
    emit(state_path, "分镜就绪", 0.08, f"共 {len(shots)} 镜 / {sum(s['frames'] for s in shots)} 帧")

    dummy_args = SimpleNamespace(width=args.width, height=args.height, fps=args.fps,
                                 steps=args.steps, seed=args.seed, turbo=args.turbo)
    # 歌词总开关：关闭时连分镜表也不写入歌词来源
    use_lyrics = bool(cfg.get("useLyrics", True))
    lyric_path = cfg.get("lyrics") if use_lyrics else None
    m.write_storyboard(job_dir / "分镜表.md", shots, dummy_args,
                       Path(cfg["audio"]), image,
                       Path(lyric_path) if lyric_path else None,
                       scene=cfg.get("scene", ""))

    # 若该任务已生成首帧图，则用 i2v（首帧即视频第一帧）；否则退回 r2v。
    # 关键：首帧图尺寸必须与当前 width×height 一致，否则 i2v 会把首帧拉伸/裁切，
    # 导致"选了竖屏却用横屏首帧"这类错配，因此尺寸不符时主动退回 r2v。
    use_i2v = False
    keyframe_inputs = {}
    mode_note = "参考图 r2v（无首帧图）"
    kf_meta = job_dir / "keyframes_meta.json"
    if kf_meta.exists():
        try:
            meta = json.loads(kf_meta.read_text(encoding="utf-8"))
            kfs = meta.get("keyframes", [])
            keyframe_inputs = {int(k["index"]): k["inputName"] for k in kfs}
            kf_w = int(meta.get("width", 0))
            kf_h = int(meta.get("height", 0))
            enough = len(keyframe_inputs) >= len(shots)
            size_ok = (kf_w == args.width and kf_h == args.height)
            use_i2v = enough and size_ok
            if not enough:
                mode_note = f"参考图 r2v（首帧图 {len(keyframe_inputs)}/{len(shots)} 不全）"
            elif not size_ok:
                mode_note = (f"参考图 r2v（首帧图 {kf_w}×{kf_h} 与当前 {args.width}×{args.height} 不符，"
                             f"请重新生成首帧图）")
            else:
                mode_note = f"首帧图 i2v · {args.width}×{args.height}"
        except Exception:
            mode_note = "参考图 r2v（首帧图元数据读取失败）"
    emit(state_path, "生成模式", 0.08, mode_note)

    shot_files = []
    total = len(shots)
    # 断点续跑：上次中断时已落盘的镜头直接复用，不再占 GPU 重跑
    resume = bool(cfg.get("resume"))
    reused = 0
    if resume:
        emit(state_path, "断点续跑", 0.08, "已生成的镜头将直接复用，只补做缺失的镜头")
    for i, shot in enumerate(shots, 1):
        dst = shot_dir / f"shot_{i:02d}.mp4"
        rel = dst.relative_to(job_dir).as_posix()
        if resume and dst.is_file() and dst.stat().st_size > 4096:
            shot_files.append(rel)
            reused += 1
            emit(state_path, f"跳过镜头 {i}/{total}", 0.08 + 0.84 * i / total,
                 f"复用已生成的 {dst.name}")
            continue
        emit(state_path, f"生成镜头 {i}/{total}", 0.08 + 0.84 * (i - 1) / total,
             f"镜头 #{i} · {shot['frames']} 帧 · {shot['section']}")
        if use_i2v:
            prompt = build_i2v_prompt(shot, args, keyframe_inputs[i])
        else:
            prompt = m.build_shot_prompt(shot, args, ref_name)
        video = m.submit_and_wait(prompt, m.COMFY_OUTPUT)
        m.normalize_shot(video, dst, args.fps, args.width, args.height)
        shot_files.append(rel)
        emit(state_path, f"镜头 {i}/{total} 完成", 0.08 + 0.84 * i / total,
             f"已保存 {dst.name}")

    duration = sum(s["frames"] for s in shots) / args.fps
    meta = {
        "jobId": job_id, "audio": cfg["audio"],
        "lyrics": (cfg.get("lyrics") or None) if use_lyrics else None,
        "useLyrics": use_lyrics,
        "lyricsData": cfg.get("lyricsData", []) if use_lyrics else [],
        "params": cfg.get("params", {}),
        "duration": duration, "shotFiles": shot_files,
    }
    (job_dir / "generate_meta.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")

    write_state(state_path, status="done", stage="镜头生成完成", progress=1.0,
                result={"shots": shot_files, "duration": duration},
                logs=[f"全部 {total} 镜生成完成" + (f"（其中 {reused} 镜续跑复用）" if reused else "")])
    print("RESULT " + json.dumps({"shots": shot_files, "duration": duration}), flush=True)


def cmd_compose(cfg: dict, state_path: str):
    job_id = cfg["jobId"]
    job_dir = Path(cfg["jobDir"])
    meta_path = job_dir / "generate_meta.json"
    meta = json.loads(meta_path.read_text(encoding="utf-8")) if meta_path.exists() else {}
    audio = Path(cfg.get("audio") or meta.get("audio") or "")
    if not audio.is_file():
        raise RuntimeError("找不到原曲文件")
    params = cfg.get("params") or meta.get("params") or {}
    args = args_from_config({**cfg, "params": params}, job_id)
    shot_files = meta.get("shotFiles") or cfg.get("shotFiles") or []
    if not shot_files:
        raise RuntimeError("没有可拼接的镜头，请先生成")
    shots = [job_dir / p for p in shot_files]
    # MV 时长强制等于整首歌曲时长（ffprobe 实测），不信任任何前端传入的截断值
    duration = m.probe_duration(audio)
    if duration <= 0:
        duration = float(meta.get("duration") or 0) or 60.0

    # 歌词总开关：关闭时忽略一切歌词来源（含 meta 中残留的歌词数据），绝不烧字幕
    use_lyrics = bool(cfg.get("useLyrics", meta.get("useLyrics", True)))
    lyrics = []
    if use_lyrics:
        lyric_raw = cfg.get("lyricsData") or meta.get("lyricsData") or []
        if lyric_raw:
            lyrics = [(float(x["t"]), str(x["text"])) for x in lyric_raw]
        else:
            lyric_file = meta.get("lyrics") or cfg.get("lyrics")
            lyrics = m.parse_lyrics(Path(lyric_file), duration, []) if lyric_file and Path(lyric_file).is_file() else []

    emit(state_path, "准备拼接", 0.05, f"拼接 {len(shots)} 段镜头 · 成片 {duration:.1f}s（整首）"
         + ("" if use_lyrics else " · 歌词已关闭"))
    merged = job_dir / "merged.mp4"
    m.concat_shots(shots, job_dir, merged)

    # 开关关闭或无歌词时不烧字幕，避免空 ASS 字幕轨
    burn = use_lyrics and bool(params.get("burnSubs", True)) and bool(lyrics)
    emit(state_path, "铺原曲与字幕", 0.55,
         "写入原曲音轨 / 烧录歌词" if burn else "写入原曲音轨（无歌词，不烧字幕）")
    final = job_dir / "MV_final.mp4"
    m.finalize(audio, merged, final, duration,
               float(params.get("songOffset", 0)), lyrics, burn, job_dir, fade=1.0)

    out_dir = ROOT / "workspace" / "outputs"
    out_dir.mkdir(parents=True, exist_ok=True)
    target = out_dir / f"{job_id}_MV.mp4"
    shutil.copy2(final, target)
    write_state(state_path, status="done", stage="合成完成", progress=1.0,
                result={"output": f"outputs/{target.name}"},
                logs=[f"成片：{target.name}"])
    print("RESULT " + json.dumps({"output": f"outputs/{target.name}"}), flush=True)


def main():
    if len(sys.argv) < 2:
        raise SystemExit("usage: pipeline_bridge.py <config.json>")
    cfg = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cmd = cfg.get("command")
    state_path = cfg.get("stateFile") or str(Path(cfg.get("jobDir", ".")) / "state.json")
    try:
        if cmd == "analyze":
            cmd_analyze(cfg)
        elif cmd == "keyframes":
            cmd_keyframes(cfg, state_path)
        elif cmd == "generate":
            cmd_generate(cfg, state_path)
        elif cmd == "compose":
            cmd_compose(cfg, state_path)
        else:
            raise RuntimeError(f"未知命令：{cmd}")
    except Exception as exc:
        tb = traceback.format_exc()
        write_state(state_path, status="error", stage="失败", error=str(exc),
                    logs=[f"错误：{exc}", tb[-2000:]])
        print("ERROR " + str(exc), file=sys.stderr, flush=True)
        sys.exit(1)


if __name__ == "__main__":
    main()
