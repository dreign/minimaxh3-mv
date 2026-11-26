import React, { useEffect, useRef, useState } from 'react';
import { Handle, Position, useNodeId, useReactFlow } from '@xyflow/react';
import { api, pollJob } from '../api';
import { useCanvas, missingAssets, songTitleFromAsset, type WfNodeConfig } from '../store';
import type { Shot, WorkflowNodeInfo, WorkflowParam, WorkflowRun } from '../types';
import {
  buildMotions, fillTemplate, DEFAULT_BOT_PROMPT,
  MOTION_STYLES, MOTION_ENERGY, MOTION_COMBOS,
  type Motion, type MotionStyle,
} from '../motion';

const SECTION_COLOR: Record<string, string> = {
  intro: '#94a3b8', verse: '#60a5fa', prechorus: '#a78bfa',
  chorus: '#f472b6', bridge: '#fbbf24', outro: '#34d399',
};

const RES_PRESETS = [
  { label: '横 864×480', w: 864, h: 480 },
  { label: '横 736×416', w: 736, h: 416 },
  { label: '横 608×352', w: 608, h: 352 },
  { label: '竖 480×864', w: 480, h: 864 },
  { label: '竖 544×960', w: 544, h: 960 },
  { label: '竖 608×1080', w: 608, h: 1080 },
];

/**
 * 片名跟随 MP3：默认空；上传/切换歌曲后自动填成文件名（去扩展名）。
 * 用户一旦手填就不再覆盖；把手填内容清空则恢复自动跟随。
 * 两个「片名」入口（导演台 / 拼接成片）共用，避免各写一套规则。
 */
function useAutoTitle(nodeId: string | null, saved: unknown, savedEdited: unknown) {
  const song = songTitleFromAsset(useCanvas((s) => s.assets.audio));
  const [title, setTitle] = useState(String(saved ?? ''));
  const [edited, setEdited] = useState(savedEdited === true);

  useEffect(() => {
    if (edited || title === song) return;
    setTitle(song);
    if (nodeId) useCanvas.getState().setNodeData(nodeId, { title: song, titleEdited: false });
  }, [song, edited, title, nodeId]);

  const onChange = (v: string) => {
    const nextEdited = v.trim() !== '';
    setTitle(v);
    setEdited(nextEdited);
    if (nodeId) useCanvas.getState().setNodeData(nodeId, { title: v, titleEdited: nextEdited });
  };

  return { title, onChange };
}

/** 宽高收敛到 256–2048 并对齐到 32 的倍数（ComfyUI H3 节点 width/height 步长=32）。 */
function clampDim(n: number, fallback: number): number {
  const base = Number.isFinite(n) && n > 0 ? n : fallback;
  const aligned = Math.round(Math.max(256, Math.min(2048, base)) / 32) * 32;
  return Math.max(256, Math.min(2048, aligned));
}

/** 把任务结果里的相对路径（如 outputs/xxx.mp4）转成可播放的 /media URL；
 *  兼容历史数据里可能残留的相对路径。 */
export function mediaUrl(p?: string): string {
  if (!p) return '';
  if (/^https?:\/\//i.test(p) || p.startsWith('/')) return p;
  const rel = p.replace(/\\/g, '/').replace(/^\/+/, '');
  return rel.startsWith('media/') ? '/' + rel : '/media/' + rel;
}

/**
 * 横竖 / 分辨率选择器。首帧图与镜头共用同一组尺寸（params.width/height），
 * 因为首帧图就是 i2v 的第一帧，尺寸必须和视频一致。
 * 非紧凑模式额外提供自由宽高输入，不再局限于预设下拉。
 */
export function OrientationPicker({ compact = false }: { compact?: boolean }) {
  const params = useCanvas((s) => s.params);
  const setSize = useCanvas((s) => s.setSize);
  const [notice, setNotice] = useState('');
  const [wText, setWText] = useState(String(params.width));
  const [hText, setHText] = useState(String(params.height));
  const isPortrait = params.height > params.width;
  const value = `${params.width}x${params.height}`;
  const isPreset = RES_PRESETS.some((p) => `${p.w}x${p.h}` === value);

  useEffect(() => {
    setWText(String(params.width));
    setHText(String(params.height));
  }, [params.width, params.height]);

  const apply = (w: number, h: number) => {
    const invalidated = setSize(w, h);
    setNotice(invalidated ? '尺寸已切换：旧首帧图已作废，请重新生成' : '');
  };

  const commitCustom = () => {
    const w = clampDim(Number(wText), params.width);
    const h = clampDim(Number(hText), params.height);
    if (w !== params.width || h !== params.height) apply(w, h);
    setWText(String(w));
    setHText(String(h));
  };

  const dimInputProps = {
    className: 'dim-input nodrag', type: 'number' as const, min: 256, max: 2048,
    onBlur: commitCustom,
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') e.currentTarget.blur();
    },
  };

  return (
    <div className="orient-picker">
      <div className="orient-row">
        <button type="button"
          className={`orient-btn ${!isPortrait ? 'active' : ''}`}
          onClick={() => apply(864, 480)}>▭ 横屏 16:9</button>
        <button type="button"
          className={`orient-btn ${isPortrait ? 'active' : ''}`}
          onClick={() => apply(480, 864)}>▯ 竖屏 9:16</button>
      </div>
      {!compact && (
        <>
          <div className="row gap8 mt8">
            <select value={isPreset ? value : 'custom'} onChange={(e) => {
              if (e.target.value === 'custom') return;
              const p = RES_PRESETS.find((x) => `${x.w}x${x.h}` === e.target.value);
              if (p) apply(p.w, p.h);
            }}>
              {RES_PRESETS.map((p) => <option key={p.label} value={`${p.w}x${p.h}`}>{p.label}</option>)}
              {!isPreset && <option value="custom">自定义 {params.width}×{params.height}</option>}
            </select>
            <span className="muted tiny-text">{params.width}×{params.height}</span>
          </div>
          <div className="row gap8 mt8 dim-input-row"
            title="自定义视频宽高，输入值自动对齐到 32 的倍数（H3 节点步长）">
            <span className="muted tiny-text" style={{ whiteSpace: 'nowrap' }}>视频宽高</span>
            <input {...dimInputProps} value={wText} aria-label="视频宽度"
              onChange={(e) => setWText(e.target.value)} />
            <span className="muted tiny-text">×</span>
            <input {...dimInputProps} value={hText} aria-label="视频高度"
              onChange={(e) => setHText(e.target.value)} />
            <button className="btn tiny ghost" onClick={commitCustom}>应用</button>
          </div>
        </>
      )}
      {notice && <div className="mode-hint mt8">{notice}</div>}
    </div>
  );
}

function NodeShell({ label, icon, children, accent = '#60a5fa', width }: {
  label: string; icon: string; children: React.ReactNode; accent?: string; width?: number;
}) {
  const id = useNodeId();
  const removeNodes = useCanvas((s) => s.removeNodes);
  return (
    <div className="node-card" style={{ borderTopColor: accent, ...(width ? { width } : null) }}>
      <div className="node-head">
        <span className="node-icon">{icon}</span>
        <span className="node-title">{label}</span>
        {id && (
          <button type="button" className="node-del nodrag nopan" title="删除此节点（选中后按 Delete 也可删除）"
            aria-label="删除节点"
            onClick={(e) => { e.stopPropagation(); removeNodes([id]); }}>✕</button>
        )}
      </div>
      <div className="node-body">{children}</div>
    </div>
  );
}

function useUpload(kind: 'image' | 'audio' | 'lyrics') {
  const setAsset = useCanvas((s) => s.setAsset);
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const accept = kind === 'image' ? 'image/*' : kind === 'audio' ? 'audio/*' : '.lrc,.txt,text/plain';

  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError('');
    try {
      const asset = await api.upload(kind, file);
      setAsset(kind, asset);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  return { inputRef, onFile, busy, error, accept };
}

export function ImageNode() {
  const asset = useCanvas((s) => s.assets.image);
  const previewSize = useCanvas((s) => s.params.imagePreviewSize);
  const setParam = useCanvas((s) => s.setParam);
  const { inputRef, onFile, busy, error, accept } = useUpload('image');
  return (
    <NodeShell label="人物参考图" icon="🖼" accent="#60a5fa">
      <Handle type="source" position={Position.Right} id="out" />
      <input ref={inputRef} type="file" accept={accept} hidden onChange={(e) => onFile(e.target.files?.[0])} />
      {asset ? (
        <>
          {/* object-fit: contain：默认完整显示整张图，不裁切；滑块只改变显示区域大小 */}
          <div className="asset-preview" style={{ height: previewSize }} title="点击滑块可调节显示大小">
            <img src={asset.url} alt="参考图" />
          </div>
          <div className="row gap8 mt8 nodrag">
            <span className="muted tiny-text" style={{ whiteSpace: 'nowrap' }}>大小</span>
            <input className="size-slider nodrag" type="range" min={96} max={360} step={4}
              value={previewSize} title={`预览高度 ${previewSize}px`}
              onChange={(e) => setParam('imagePreviewSize', Number(e.target.value))} />
            <button className="btn tiny ghost" title="恢复默认大小（完整显示全图）"
              onClick={() => setParam('imagePreviewSize', 180)}>重置</button>
          </div>
          <div className="row gap8 mt8">
            <div className="asset-name" style={{ flex: 1 }} title={asset.name}>{asset.name}</div>
            <button className="btn tiny" onClick={() => inputRef.current?.click()}>更换</button>
          </div>
        </>
      ) : (
        <button className={`dropzone ${busy ? 'busy' : ''}`} onClick={() => inputRef.current?.click()}>
          <span className="drop-icon">＋</span>
          <span>{busy ? '上传中…' : '点击上传参考图'}</span>
          <small>清晰正脸 / 半身照</small>
        </button>
      )}
      {!asset && <div className="asset-hint mt8">未就绪 · 点击上传参考图</div>}
      {error && <div className="err">{error}</div>}
    </NodeShell>
  );
}

export function AudioNode() {
  const asset = useCanvas((s) => s.assets.audio);
  const analysis = useCanvas((s) => s.analysis);
  const { inputRef, onFile, busy, error, accept } = useUpload('audio');
  return (
    <NodeShell label="歌曲 MP3" icon="🎵" accent="#34d399">
      <Handle type="source" position={Position.Right} id="out" />
      <input ref={inputRef} type="file" accept={accept} hidden onChange={(e) => onFile(e.target.files?.[0])} />
      {asset ? (
        <>
          <div className="asset-row">
            <div className="file-icon">♪</div>
            <div className="asset-meta">
              <div className="asset-name" title={asset.name}>{asset.name}</div>
              <div className="muted">{analysis ? `时长 ${analysis.duration.toFixed(1)}s` : '等待分析'}</div>
            </div>
            <button className="btn tiny" onClick={() => inputRef.current?.click()}>换</button>
          </div>
          <audio className="audio-player nodrag nowheel" controls preload="metadata" src={asset.url} />
          <div className="muted tiny-text mt8">可直接试听；成片会用这首原曲的完整音轨替换生成音频。</div>
        </>
      ) : (
        <button className={`dropzone ${busy ? 'busy' : ''}`} onClick={() => inputRef.current?.click()}>
          <span className="drop-icon">＋</span>
          <span>{busy ? '上传中…' : '点击上传歌曲'}</span>
          <small>MP3 / WAV</small>
        </button>
      )}
      {!asset && <div className="asset-hint mt8">未就绪 · 点击上传歌曲文件</div>}
      {error && <div className="err">{error}</div>}
    </NodeShell>
  );
}

export function LyricsNode() {
  const asset = useCanvas((s) => s.assets.lyrics);
  const setAsset = useCanvas((s) => s.setAsset);
  const useLyrics = useCanvas((s) => s.params.useLyrics);
  const setParam = useCanvas((s) => s.setParam);
  const hasAnalysis = useCanvas((s) => !!s.analysis);
  const { inputRef, onFile, busy, error, accept } = useUpload('lyrics');
  const [pasteMode, setPasteMode] = useState(false);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false); // 粘贴内容改动后尚未落盘
  const lastSavedRef = useRef('');
  const timerRef = useRef<number | null>(null);

  // 输入即自动保存（防抖 700ms），避免"歌词看着填好了、却没点保存按钮"
  const scheduleSave = (value: string) => {
    setText(value);
    if (!value.trim()) return;
    setDirty(true);
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      if (value === lastSavedRef.current) { setDirty(false); return; }
      setSaving(true);
      try {
        const saved = await api.saveText('lyrics', value);
        setAsset('lyrics', saved);
        lastSavedRef.current = value;
      } catch { /* 保留 dirty，继续显示未保存 */ }
      finally { setSaving(false); setDirty(false); }
    }, 700);
  };

  const savePaste = async () => {
    if (!text.trim()) return;
    if (timerRef.current) window.clearTimeout(timerRef.current);
    setSaving(true);
    try {
      const saved = await api.saveText('lyrics', text);
      setAsset('lyrics', saved);
      lastSavedRef.current = text;
      setDirty(false);
    } catch (e: any) { alert(e.message); }
    finally { setSaving(false); }
  };

  return (
    <NodeShell label="歌词 LRC / TXT" icon="📝" accent="#fbbf24">
      <Handle type="source" position={Position.Right} id="out" />
      <label className="lyrics-toggle" title="关闭后不解析歌词、分镜不带台词、成片不烧字幕">
        <input type="checkbox" checked={useLyrics}
          onChange={(e) => setParam('useLyrics', e.target.checked)} />
        <span className="switch-track"><span className="switch-thumb" /></span>
        <span className="switch-label">使用歌词 <small>{useLyrics ? '已开启' : '已关闭'}</small></span>
      </label>
      <div className="row gap8 mt8">
        <button className="btn tiny" onClick={() => inputRef.current?.click()}>上传文件</button>
        <button className="btn tiny ghost" onClick={() => setPasteMode((v) => !v)}>粘贴歌词</button>
      </div>
      <input ref={inputRef} type="file" accept={accept} hidden onChange={(e) => onFile(e.target.files?.[0])} />
      {!useLyrics && (
        <div className="mode-hint mt8">
          歌词已关闭：即使已上传也不会用于分镜和字幕。{hasAnalysis ? '已有分镜仍带歌词，请重新分析。' : ''}
        </div>
      )}
      {pasteMode && (
        <div className="paste-box">
          <textarea value={text} onChange={(e) => scheduleSave(e.target.value)}
            placeholder={'[00:05.20]第一句歌词\n[00:10.80]第二句歌词'} rows={5} />
          <div className="muted tiny-text mt8">
            {saving ? '正在保存…' : dirty ? '即将自动保存…' : text ? '已自动保存' : '输入后自动保存；带时间戳会自动按行配时'}
          </div>
          <button className="btn tiny" onClick={savePaste} disabled={saving || !text.trim()}>立即保存</button>
        </div>
      )}
      {asset ? (
        <div className="asset-row mt8">
          <div className="file-icon">文</div>
          <div className="asset-meta"><div className="asset-name">{asset.name}</div><div className="muted">已就绪</div></div>
          <span className="badge ok">✓</span>
        </div>
      ) : (
        <div className="asset-hint mt8">歌词为可选项 · 不填也能出 MV（按节拍 + 主题场景生成画面，无字幕）</div>
      )}
      {busy && <div className="muted mt8">上传中…</div>}
      {error && <div className="err">{error}</div>}
    </NodeShell>
  );
}

export function AnalyzeNode() {
  const assets = useCanvas((s) => s.assets);
  const params = useCanvas((s) => s.params);
  const setParam = useCanvas((s) => s.setParam);
  const setAnalysis = useCanvas((s) => s.setAnalysis);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const analysis = useCanvas((s) => s.analysis);

  const run = async () => {
    // 歌词可选：只要有歌曲就能分析；无歌词时按节拍 + 主题场景生成分镜
    const missing = missingAssets(assets, ['audio']);
    if (missing) { setError(missing); return; }
    setBusy(true); setError('');
    try {
      const result = await api.analyze({
        image: assets.image?.path || null,
        audio: assets.audio!.path,
        lyrics: params.useLyrics ? (assets.lyrics?.path || null) : null,
        duration: 0, // 强制整首歌曲时长
        maxShots: params.maxShots,
        shotSeconds: 5.17,
        scene: params.scene,
        useLyrics: params.useLyrics,
        seed: params.seed,
      });
      setAnalysis(result);
      setParam('duration', result.songDuration || result.duration); // 时长自动 = 歌曲时长
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const counts = React.useMemo(() => {
    const c: Record<string, number> = {};
    analysis?.shots.forEach((s) => { c[s.section] = (c[s.section] || 0) + 1; });
    return c;
  }, [analysis]);

  return (
    <NodeShell label="节拍与歌词分析" icon="🎛" accent="#a78bfa">
      <Handle type="target" position={Position.Left} id="image" style={{ top: 28 }} />
      <Handle type="target" position={Position.Left} id="audio" style={{ top: 58 }} />
      <Handle type="target" position={Position.Left} id="lyrics" style={{ top: 88 }} />
      <Handle type="source" position={Position.Right} id="out" />
      <label className="scene-field">
        <span>主题场景 <small>（可选，每行一个场景）</small></span>
        <textarea rows={3} value={params.scene}
          placeholder={'舞台，聚光灯，歌手\n雨夜天桥，霓虹，孤独\n海边日落，温暖'}
          onChange={(e) => setParam('scene', e.target.value)} />
        <small>每行可写环境、人物、镜头氛围；多场景时一组连续镜头共用一个场景。</small>
      </label>
      <div className="asset-status mt8">
        <span className={`astat ${assets.image ? 'ok' : 'no'}`}>{assets.image ? '✓' : '✕'} 参考图</span>
        <span className={`astat ${assets.audio ? 'ok' : 'no'}`}>{assets.audio ? '✓' : '✕'} 歌曲</span>
        <span className={`astat ${!params.useLyrics ? 'no' : assets.lyrics ? 'ok' : 'opt'}`}>
          {!params.useLyrics ? '⊘' : assets.lyrics ? '✓' : '○'} 歌词{!params.useLyrics ? '（已关闭）' : assets.lyrics ? '' : '（选填）'}
        </span>
      </div>
      <button className="btn primary wide mt8" onClick={run} disabled={busy}>
        {busy ? '分析中…' : params.useLyrics ? '分析节拍 / 自动配时' : '分析节拍（不含歌词）'}
      </button>
      {analysis ? (
        <div className="analysis-summary">
          <div className="stat"><b>{analysis.duration.toFixed(1)}s</b><span>时长</span></div>
          <div className="stat"><b>{analysis.shots.length}</b><span>镜头</span></div>
          <div className="stat"><b>{analysis.onsets}</b><span>节拍点</span></div>
          <div className="section-bars">
            {Object.entries(counts).map(([k, v]) => (
              <span key={k} className="section-pill" style={{ background: SECTION_COLOR[k] || '#94a3b8' }}>
                {k} ×{v}
              </span>
            ))}
          </div>
          {analysis.sceneEn && (
            <div className="muted tiny-text">场景英文：<b>{analysis.sceneEn}</b>（已写入每镜提示词）</div>
          )}
          {!!analysis.sceneGroups?.length && (
            <div className="scene-groups">
              {analysis.sceneGroups.map((g) => (
                <div key={g.group} className="scene-group-row">
                  <b>场景 {g.group}</b>
                  <span>{g.scene} → {g.sceneEn}</span>
                  <span className="muted">镜头 {g.shots.length ? `#${g.shots[0]}–#${g.shots[g.shots.length - 1]}` : '—'}</span>
                </div>
              ))}
            </div>
          )}
          <div className="muted tiny-text">分镜已生成（成片时长 = 歌曲 {analysis.duration.toFixed(1)}s），去「分镜台」逐镜改提示词。</div>
        </div>
      ) : <div className="muted mt8">上传素材后点击分析，自动完成卡点分镜。</div>}
      {error && <div className="err">{error}</div>}
    </NodeShell>
  );
}

/** 视频提示词里变化句的固定标记：重排变化时只替换这一段，不动场景/音景 */
const VIDEO_VARIATION_RE = /Variation for this shot in the same scene:[\s\S]*?(?=overall_soundscape:)/;
/** 首帧图提示词里变化句的标记：到场景描述或静态摄影描述之前 */
const FRAME_VARIATION_RE = /Variation for this shot in the same scene:[\s\S]*?(?=Setting and environment:|Still frame)/;

function replaceVariation(prompt: string, variation: string, re: RegExp): string {
  if (!variation) return prompt;
  if (re.test(prompt)) return prompt.replace(re, variation + ' ');
  return prompt.trimEnd() + ' ' + variation; // 手动改过提示词、标记丢失时追加
}

export function StoryboardNode() {
  const shots = useCanvas((s) => s.shots);
  const setShots = useCanvas((s) => s.setShots);
  const updateShot = useCanvas((s) => s.updateShot);
  const selectedShot = useCanvas((s) => s.selectedShot);
  const setSelectedShot = useCanvas((s) => s.setSelectedShot);

  const addShot = () => {
    const last = shots[shots.length - 1];
    const start = last ? last.end : 0;
    const shot: Shot = {
      id: `manual-${Date.now()}`, index: shots.length + 1,
      start, end: start + 5.17, frames: 124, section: 'verse', lyric: '',
      prompt: '<Picture 1> is the performer. Cinematic close-up, natural continuous motion.',
      framePrompt: '<Picture 1> is the performer. Cinematic close-up, still frame, sharp focus.',
    };
    setShots([...shots, shot]);
  };

  const removeShot = (index: number) => {
    setShots(shots.filter((s) => s.index !== index).map((s, i) => ({ ...s, index: i + 1 })));
  };

  /** 在同一场景组内把每镜的变化整体右移一位，重新分配机位/光线/运镜/动作。
   *  场景与人物身份不变；视频提示词与首帧图提示词各自替换对应的变化句。 */
  const reRollVariations = () => {
    const groups = new Map<number, number[]>();
    shots.forEach((s, i) => {
      const g = s.sceneGroup || 0;
      groups.set(g, [...(groups.get(g) || []), i]);
    });
    const next = [...shots];
    groups.forEach((idxs) => {
      if (idxs.length < 2) return;
      const vals = idxs.map((i) => ({
        variation: shots[i].variation,
        frameVariation: shots[i].frameVariation,
        variationLabel: shots[i].variationLabel,
      }));
      if (vals.some((v) => !v.variation)) return;
      const shifted = [vals[vals.length - 1], ...vals.slice(0, -1)];
      idxs.forEach((i, k) => {
        const v = shifted[k];
        next[i] = {
          ...next[i],
          variation: v.variation,
          frameVariation: v.frameVariation,
          variationLabel: v.variationLabel,
          prompt: replaceVariation(next[i].prompt, v.variation || '', VIDEO_VARIATION_RE),
          ...(next[i].framePrompt
            ? { framePrompt: replaceVariation(next[i].framePrompt!, v.frameVariation || '', FRAME_VARIATION_RE) }
            : {}),
        };
      });
    });
    setShots(next);
  };

  return (
    <NodeShell label="分镜台 · 可编辑" icon="🎬" accent="#f472b6">
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />
      {shots.length === 0 ? (
        <div className="muted">等待分析结果。每镜 5 秒左右，提示词可直接改。</div>
      ) : (
        <>
          <div className="row gap8 mt8" style={{ flexWrap: 'wrap' }}>
            <button className="btn tiny ghost" disabled={!shots.some((s) => s.variation)}
              title="在同一场景组内重新分配每镜的景别/光线/运镜/动作，场景和人物身份不变"
              onClick={reRollVariations}>🎲 重排镜头变化</button>
            <span className="muted tiny-text">首帧图/视频提示词分开写 · 镜内不切镜头</span>
          </div>
          <div className="shot-list">
            {shots.map((s) => (
              <div key={s.id} className={`shot-card ${selectedShot === s.index ? 'active' : ''}`}
                onClick={() => setSelectedShot(s.index)}>
                <div className="shot-head">
                  <span className="shot-no">#{String(s.index).padStart(2, '0')}</span>
                  <span className="badge" style={{ background: SECTION_COLOR[s.section] || '#94a3b8' }}>{s.section}</span>
                  <span className="muted tiny-text">{s.start.toFixed(1)}–{s.end.toFixed(1)}s</span>
                  <button className="icon-btn" title="删除" onClick={(e) => { e.stopPropagation(); removeShot(s.index); }}>×</button>
                </div>
                {s.scene && (
                  <div className="shot-scene" title={s.sceneEn || s.scene}>
                    场景 {s.sceneGroup}：{s.scene} → {s.sceneEn}
                  </div>
                )}
                {s.variationLabel && (
                  <div className="shot-variation" title={s.variation || ''}>
                    变化：{s.variationLabel}
                  </div>
                )}
                <div className="shot-lyric">{s.lyric || '（无歌词）'}</div>
                <label className="prompt-label" title="只用于 H3 Image 生成的首帧图：静态定格，无运镜、无音景">
                  🖼 首帧图提示词
                </label>
                <textarea rows={3} value={s.framePrompt ?? s.prompt}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateShot(s.index, { framePrompt: e.target.value })} />
                <label className="prompt-label" title="只用于 H3 视频生成：含机位运镜、音景与镜内不切镜头约束">
                  🎞 视频提示词
                </label>
                <textarea rows={3} value={s.prompt}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => updateShot(s.index, { prompt: e.target.value })} />
                <div className="shot-foot">
                  <label>帧数</label>
                  <input type="number" step={17} value={s.frames}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => updateShot(s.index, { frames: Number(e.target.value) })} />
                  <span className="muted tiny-text">≈{(s.frames / 24).toFixed(1)}s</span>
                </div>
              </div>
            ))}
          </div>
          <button className="btn tiny wide mt8" onClick={addShot}>＋ 手动加一镜</button>
        </>
      )}
    </NodeShell>
  );
}

export function KeyframeNode() {
  const nodeId = useNodeId();
  const nodeData = useCanvas((s) => (nodeId ? s.nodes.find((n: any) => n.id === nodeId)?.data : undefined));
  const assets = useCanvas((s) => s.assets);
  const params = useCanvas((s) => s.params);
  const shots = useCanvas((s) => s.shots);
  const keyframes = useCanvas((s) => s.keyframes);
  const keyframeSize = useCanvas((s) => s.keyframeSize);
  const kfJobId = useCanvas((s) => s.keyframeJobId);
  const kfJob = useCanvas((s) => (s.keyframeJobId ? s.jobs[s.keyframeJobId] : undefined));
  const setKeyframeJob = useCanvas((s) => s.setKeyframeJob);
  const setKeyframes = useCanvas((s) => s.setKeyframes);
  const setJob = useCanvas((s) => s.setJob);
  const setParam = useCanvas((s) => s.setParam);
  const setKeyframeSizeMode = useCanvas((s) => s.setKeyframeSizeMode);
  const setKeyframeSize = useCanvas((s) => s.setKeyframeSize);
  const [error, setError] = useState('');
  const [kfWText, setKfWText] = useState(String(params.keyframeWidth));
  const [kfHText, setKfHText] = useState(String(params.keyframeHeight));

  useEffect(() => {
    setKfWText(String(params.keyframeWidth));
    setKfHText(String(params.keyframeHeight));
  }, [params.keyframeWidth, params.keyframeHeight]);

  const commitKfSize = () => {
    const w = clampDim(Number(kfWText), params.width);
    const h = clampDim(Number(kfHText), params.height);
    setKeyframeSize(w, h);
    setKfWText(String(w));
    setKfHText(String(h));
  };

  const sizeMatched = !keyframeSize
    || (keyframeSize.width === params.width && keyframeSize.height === params.height);
  const ready = keyframes.length >= shots.length && shots.length > 0 && sizeMatched;
  /** 上次的首帧图任务（节点数据里持久化）：断点续跑用它找回已生成的图 */
  const savedKfJob = String(nodeData?.kfJobId || kfJobId || '');
  const kfBusy = kfJob?.status === 'running' || kfJob?.status === 'pending';

  const run = async (resume = false) => {
    const missing = missingAssets(assets, ['image']);
    if (missing) { setError(missing); return; }
    if (!shots.length) { setError('请先分析生成分镜'); return; }
    setError('');
    try {
      const { jobId } = await api.keyframes({
        jobId: resume && savedKfJob ? savedKfJob : undefined,
        resume,
        image: assets.image!.path, shots,
        params: {
          width: params.width, height: params.height, steps: params.steps,
          seed: params.seed, fps: params.fps,
          keyframeSizeMode: params.keyframeSizeMode,
          keyframeWidth: params.keyframeWidth, keyframeHeight: params.keyframeHeight,
        },
      });
      if (nodeId) useCanvas.getState().setNodeData(nodeId, { kfJobId: jobId });
      setKeyframeJob(jobId);
      setJob(jobId, { id: jobId, status: 'pending', stage: resume ? '首帧图续跑排队中' : '首帧图排队中', progress: 0, logs: [] });
      const done = await pollJob(jobId, (j) => setJob(jobId, j));
      if (!done || done.status !== 'done') {
        setError(done?.error || '首帧图生成失败'); return;
      }
      const data = await api.keyframesResult(jobId);
      setKeyframes(data.keyframes, {
        width: data.width || params.width,
        height: data.height || params.height,
      });
    } catch (e: any) { setError(e.message); }
  };

  return (
    <NodeShell label="分镜首帧图" icon="🖼" accent="#fb923c">
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />
      <div className="muted tiny-text">
        H3 Image 按每镜提示词 + 参考人物生成首帧，镜头生成时作为视频第一帧（i2v）。
      </div>
      <div className="mt8"><OrientationPicker compact /></div>
      <div className="kf-size-config mt8">
        <label className="check" title="默认跟随视频尺寸；自定义可用更大画布出图，再自动缩放到视频尺寸">
          <input type="checkbox" checked={params.keyframeSizeMode === 'custom'}
            onChange={(e) => setKeyframeSizeMode(e.target.checked ? 'custom' : 'follow')} />
          自定义 H3 Image 出图宽高
        </label>
        <div className="muted tiny-text mt8">
          {params.keyframeSizeMode === 'follow'
            ? `出图尺寸跟随视频：${params.width}×${params.height}`
            : `H3 Image 以 ${params.keyframeWidth}×${params.keyframeHeight} 出图，保存时自动缩放到 ${params.width}×${params.height}`}
        </div>
        {params.keyframeSizeMode === 'custom' && (
          <>
            <div className="row gap8 mt8 dim-input-row"
              title="自定义 H3 Image 出图宽高，输入值自动对齐到 32 的倍数（H3 节点步长）">
              <span className="muted tiny-text" style={{ whiteSpace: 'nowrap' }}>出图宽高</span>
              <input className="dim-input nodrag" type="number" min={256} max={2048}
                aria-label="H3 Image 出图宽度" value={kfWText}
                onChange={(e) => setKfWText(e.target.value)} onBlur={commitKfSize}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
              <span className="muted tiny-text">×</span>
              <input className="dim-input nodrag" type="number" min={256} max={2048}
                aria-label="H3 Image 出图高度" value={kfHText}
                onChange={(e) => setKfHText(e.target.value)} onBlur={commitKfSize}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
              <button className="btn tiny ghost" title="按视频尺寸 2 倍超采样出图"
                onClick={() => setKeyframeSize(clampDim(params.width * 2, params.width), clampDim(params.height * 2, params.height))}>×2</button>
              <button className="btn tiny ghost" title="恢复为视频尺寸"
                onClick={() => setKeyframeSize(clampDim(params.width, 864), clampDim(params.height, 480))}>同视频</button>
            </div>
            <div className="muted tiny-text">
              输入值自动对齐到 32 的倍数（H3 节点要求）；建议与视频保持相同宽高比（否则中心裁切）。尺寸越大细节越好，但更慢、更占显存。改动后需重新生成首帧图。
            </div>
          </>
        )}
      </div>
      {keyframeSize && !sizeMatched && (
        <div className="err mt8">首帧图尺寸为 {keyframeSize.width}×{keyframeSize.height}，与当前 {params.width}×{params.height} 不一致，请重新生成。</div>
      )}
      <button className="btn primary wide mt8" onClick={() => run(false)} disabled={kfBusy}>
        {kfBusy
          ? `生成中 ${Math.round((kfJob?.progress || 0) * 100)}%`
          : ready ? `重新生成首帧（${keyframes.length} 张）` : `生成 ${shots.length} 张首帧图`}
      </button>
      {savedKfJob && !kfBusy && !ready && (
        <>
          <button className="btn wide mt8" onClick={() => run(true)}
            title="回到上次的首帧图任务，跳过已生成的图，只补做中断/失败的那些">
            ⏵ 继续生成首帧图（跳过已完成的）
          </button>
          <div className="muted tiny-text mt8">断点续跑：任务 {savedKfJob.slice(-8)} · 已生成的首帧直接复用</div>
        </>
      )}
      {kfJob && (kfJob.status === 'running' || kfJob.status === 'pending') && (
        <div className="job-progress">
          <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.round(kfJob.progress * 100)}%` }} /></div>
          <div className="muted tiny-text">{kfJob.stage}</div>
        </div>
      )}
      {ready && (
        <>
          <div className="row gap8 mt8 nodrag">
            <span className="muted tiny-text" style={{ whiteSpace: 'nowrap' }}>预览大小</span>
            <input className="size-slider nodrag" type="range" min={64} max={220} step={4}
              value={params.keyframePreviewSize} title={`首帧图预览宽度 ${params.keyframePreviewSize}px`}
              onChange={(e) => setParam('keyframePreviewSize', Number(e.target.value))} />
            <button className="btn tiny ghost" title="恢复默认大小"
              onClick={() => setParam('keyframePreviewSize', 96)}>重置</button>
          </div>
          <div className="kf-grid nodrag nowheel" style={{
            gridTemplateColumns: `repeat(auto-fill, minmax(${params.keyframePreviewSize}px, 1fr))`,
          }}>
            {shots.map((s) => {
              const kf = keyframes.find((k) => k.index === s.index);
              return (
                <div key={s.id} className={`kf-cell ${params.height > params.width ? 'portrait' : ''}`} title={`#${s.index} ${s.lyric || ''}`}>
                  {kf ? <img src={kf.url} alt={`首帧 ${s.index}`} /> : <span className="muted">#{s.index}</span>}
                  <small>#{String(s.index).padStart(2, '0')}</small>
                </div>
              );
            })}
          </div>
          <div className="muted tiny-text mt8">✓ {keyframes.length}/{shots.length} 张就绪</div>
        </>
      )}
      {error && <div className="err">{error}</div>}
    </NodeShell>
  );
}

export function GenerateNode() {
  const nodeId = useNodeId();
  const nodeData = useCanvas((s) => (nodeId ? s.nodes.find((n: any) => n.id === nodeId)?.data : undefined));
  const params = useCanvas((s) => s.params);
  const setParam = useCanvas((s) => s.setParam);
  const assets = useCanvas((s) => s.assets);
  const shots = useCanvas((s) => s.shots);
  const analysis = useCanvas((s) => s.analysis);
  const keyframes = useCanvas((s) => s.keyframes);
  const keyframeSize = useCanvas((s) => s.keyframeSize);
  const keyframeJobId = useCanvas((s) => s.keyframeJobId);
  const setJob = useCanvas((s) => s.setJob);
  const setActiveJob = useCanvas((s) => s.setActiveJob);
  const activeJobId = useCanvas((s) => s.activeJobId);
  const job = useCanvas((s) => (activeJobId ? s.jobs[activeJobId] : undefined));
  const [error, setError] = useState('');
  /** 上次的生成任务 id：断点续跑时用它定位 jobDir/shots 里已生成的镜头 */
  const genJobId = String(nodeData?.genJobId || '');
  const jobBusy = job?.status === 'pending' || job?.status === 'running';

  const run = async (resume = false) => {
    const missing = missingAssets(assets, ['image', 'audio']);
    if (missing) { setError(missing); return; }
    if (!shots.length) { setError('请先分析生成分镜'); return; }
    setError('');
    try {
      // 有首帧图任务就复用它的 jobId（读 keyframes_meta.json 走 i2v）；
      // 续跑则必须回到上次生成的那个 jobDir，否则没有可复用的镜头文件。
      const reuseJobId = resume ? genJobId : (keyframeJobId || '');
      const { jobId } = await api.generate({
        jobId: reuseJobId || undefined,
        resume,
        image: assets.image!.path, audio: assets.audio!.path,
        lyrics: params.useLyrics ? (assets.lyrics?.path || null) : null,
        shots, params: { ...params },
        lyricsData: params.useLyrics ? (analysis?.lyrics || []) : [],
        scene: params.scene, useLyrics: params.useLyrics,
      });
      if (nodeId) useCanvas.getState().setNodeData(nodeId, { genJobId: jobId });
      setJob(jobId, { id: jobId, status: 'pending', stage: resume ? '断点续跑排队中' : '排队中', progress: 0, logs: [] });
      setActiveJob(jobId);
    } catch (e: any) { setError(e.message); }
  };

  return (
    <NodeShell label="H3 镜头生成" icon="⚙" accent="#f97316">
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />
      <div className="param-grid">
        <label>时长(s) · 自动 <input type="number" value={params.duration} readOnly title="成片时长自动等于歌曲时长" /></label>
        <label>步长<input type="number" value={params.steps} readOnly={params.turbo}
          title={params.turbo ? '4步Turbo 已开启：步长固定为 4，取消勾选后恢复 20' : '采样步数，默认 20'}
          onChange={(e) => setParam('steps', Number(e.target.value))} /></label>
        <label>种子<input type="number" value={params.seed} onChange={(e) => setParam('seed', Number(e.target.value))} /></label>
        <label>镜头上限<input type="number" value={params.maxShots} onChange={(e) => setParam('maxShots', Number(e.target.value))} /></label>
      </div>
      <div className="mt8"><OrientationPicker /></div>
      <div className="row gap8 mt8">
        <label className="check" title="勾选即锁定 4 步并加载 Turbo LoRA（快约 5 倍，细节略降）；取消后恢复 20 步">
          <input type="checkbox" checked={params.turbo} onChange={(e) => setParam('turbo', e.target.checked)} />4步Turbo</label>
        <label className="check" title={params.useLyrics ? '' : '歌词已关闭，字幕不会烧录'}>
          <input type="checkbox" checked={params.burnSubs && params.useLyrics} disabled={!params.useLyrics}
            onChange={(e) => setParam('burnSubs', e.target.checked)} />烧歌词
        </label>
      </div>
      <div className="muted tiny-text mt8">
        {params.turbo ? `⚡ Turbo 模式：${params.steps} 步 + 加速 LoRA，速度快约 5 倍、细节略降。`
          : `○ 标准模式：${params.steps} 步采样，画面更精细稳定。`}
      </div>
      {(() => {
        const kfReady = keyframes.length >= shots.length && shots.length > 0;
        const sizeOk = kfReady && keyframeSize
          && keyframeSize.width === params.width && keyframeSize.height === params.height;
        return (
          <div className={`mode-hint ${sizeOk ? 'on' : ''}`}>
            {sizeOk
              ? `✓ 首帧图就绪（${keyframes.length} 张 · ${params.width}×${params.height}）→ 视频以首帧为起点（i2v）`
              : kfReady
                ? `⚠ 首帧图尺寸（${keyframeSize?.width}×${keyframeSize?.height}）与当前（${params.width}×${params.height}）不一致，将退回参考图直生（r2v）。请重新生成首帧图。`
                : `○ 尚无完整首帧图 → 将用参考图直生（r2v）。建议先跑「分镜首帧图」。`}
          </div>
        );
      })()}
      <button className="btn primary wide mt8" onClick={() => run(false)} disabled={jobBusy}>
        {jobBusy ? `生成中 ${Math.round((job?.progress || 0) * 100)}%` : `生成全部镜头（${shots.length}）`}
      </button>
      {genJobId && job?.status !== 'done' && (
        <>
          <button className="btn wide mt8" onClick={() => run(true)} disabled={jobBusy}
            title="回到上次的 jobDir，跳过已经落盘的镜头，只补做中断/失败的那些">
            ⏵ 继续生成（跳过已完成的镜头）
          </button>
          <div className="muted tiny-text mt8">
            断点续跑：任务 {genJobId.slice(-8)} · 已生成的镜头直接复用，不会重跑
          </div>
        </>
      )}
      {job && (
        <div className="job-progress">
          <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.round(job.progress * 100)}%` }} /></div>
          <div className="muted tiny-text">{job.stage} · {Math.round(job.progress * 100)}%</div>
        </div>
      )}
      {error && <div className="err">{error}</div>}
    </NodeShell>
  );
}

export function ExportNode() {
  const activeJobId = useCanvas((s) => s.activeJobId);
  const job = useCanvas((s) => (s.activeJobId ? s.jobs[s.activeJobId] : undefined));
  const assets = useCanvas((s) => s.assets);
  const params = useCanvas((s) => s.params);
  const analysis = useCanvas((s) => s.analysis);
  const setJob = useCanvas((s) => s.setJob);
  const [error, setError] = useState('');
  const [videoError, setVideoError] = useState('');

  const run = async () => {
    if (!activeJobId) { setError('请先生成镜头'); return; }
    if (!assets.audio) { setError('缺少原曲'); return; }
    setError(''); setVideoError('');
    try {
      const { jobId } = await api.compose({
        jobId: activeJobId, audio: assets.audio.path,
        lyricsData: params.useLyrics ? (analysis?.lyrics || []) : [],
        params: { ...params }, useLyrics: params.useLyrics,
      });
      setJob(jobId, { id: jobId, status: 'pending', stage: '合成中', progress: 0, logs: [] });
    } catch (e: any) { setError(e.message); }
  };

  const output = mediaUrl(job?.result?.output);
  return (
    <NodeShell label="合成与导出" icon="🎞" accent="#34d399">
      <Handle type="target" position={Position.Left} id="in" />
      <button className="btn primary wide" onClick={run}>
        {params.useLyrics ? '拼接 + 铺原曲 + 字幕' : '拼接 + 铺原曲（无字幕）'}
      </button>
      {output ? (
        <div className="output-box">
          <video key={output} src={output} controls playsInline onError={() => setVideoError('视频加载失败，可能是文件尚未写入完成或格式不受支持')} />
          {videoError && <div className="err tiny-text">{videoError}</div>}
          <a className="btn wide" href={output} download>下载 MV</a>
        </div>
      ) : (
        <div className="muted mt8">生成完成后点这里合成最终 MP4。H3 自带音频会被你的原曲替换。</div>
      )}
      {job?.status === 'error' && <div className="err">{job.error}</div>}
      {error && <div className="err">{error}</div>}
    </NodeShell>
  );
}

/** 节点参数值的可视化控件：按 object_info 里的类型自动选 select / number / checkbox / textarea */
function ParamControl({ p, value, onChange }: {
  p: WorkflowParam;
  value: string | number | boolean;
  onChange: (v: string | number | boolean) => void;
}) {
  if (p.type === 'BOOLEAN') {
    const on = value === true || value === 'true' || value === 1 || value === '1';
    return (
      <label className="wf-bool">
        <input type="checkbox" checked={on} onChange={(e) => onChange(e.target.checked)} />
        <span>{on ? 'true' : 'false'}</span>
      </label>
    );
  }
  if (p.type === 'COMBO') {
    const cur = String(value ?? '');
    const opts = p.options || [];
    return (
      <select className="wf-input" value={cur} onChange={(e) => onChange(e.target.value)}>
        {!opts.includes(cur) && <option value={cur}>{cur || '（空）'}</option>}
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    );
  }
  if (p.type === 'INT' || p.type === 'FLOAT') {
    const step = p.step ?? (p.type === 'INT' ? 1 : 0.01);
    return (
      <input className="wf-input" type="number" value={Number(value ?? 0)} step={step}
        min={p.min} max={p.max}
        onChange={(e) => {
          const n = Number(e.target.value);
          onChange(p.type === 'INT' ? Math.round(Number.isFinite(n) ? n : 0) : (Number.isFinite(n) ? n : 0));
        }} />
    );
  }
  const text = String(value ?? '');
  const big = !!p.multiline || text.length > 60 || text.includes('\n');
  return big
    ? <textarea className="wf-input" rows={2} value={text} onChange={(e) => onChange(e.target.value)} />
    : <input className="wf-input" value={text} onChange={(e) => onChange(e.target.value)} />;
}

/** 工作流节点参数清单缓存（同一工作流不用反复拉 object_info 描述） */
const wfNodeCache = new Map<string, WorkflowNodeInfo[]>();

export function WorkflowNode() {
  const nodeId = useNodeId();
  const workflows = useCanvas((s) => s.workflows);
  const loading = useCanvas((s) => s.workflowsLoading);
  const wfError = useCanvas((s) => s.workflowsError);
  const globalWorkflowId = useCanvas((s) => s.workflowId);
  const setWorkflowId = useCanvas((s) => s.setWorkflowId);
  const loadWorkflows = useCanvas((s) => s.loadWorkflows);
  const assets = useCanvas((s) => s.assets);
  const params = useCanvas((s) => s.params);
  const wfPatch = useCanvas((s) => s.wfPatch);
  const setWfPatch = useCanvas((s) => s.setWfPatch);
  const resetWfPatch = useCanvas((s) => s.resetWfPatch);
  const setNodeWf = useCanvas((s) => s.setNodeWf);
  const setNodeWfPatch = useCanvas((s) => s.setNodeWfPatch);
  const resetNodeWfPatch = useCanvas((s) => s.resetNodeWfPatch);
  const setWfResult = useCanvas((s) => s.setWfResult);

  // 节点自带配置（画布预设里的分段镜头）优先，否则沿用全局选中的工作流
  const nodeData = useCanvas((s) => (nodeId ? s.nodes.find((n: any) => n.id === nodeId)?.data : undefined));
  const cfg: WfNodeConfig | undefined = nodeData?.wf;
  const workflowId = cfg?.workflowId || globalWorkflowId;
  const [prompt, setPrompt] = useState(cfg?.prompt ?? '');
  const [seed, setSeed] = useState(cfg?.seed ?? params.seed);
  const [width, setWidth] = useState(cfg?.width ?? params.width);
  const [height, setHeight] = useState(cfg?.height ?? params.height);
  const [outputName, setOutputName] = useState(cfg?.outputName ?? '');
  const [useImage, setUseImage] = useState(cfg?.useImage ?? true);
  const [useAudio, setUseAudio] = useState(cfg?.useAudio ?? true);
  /** ⚡ Veda：只作用于本节点的运行请求，默认关 */
  const [veda, setVeda] = useState(!!cfg?.veda);
  /** 第二张参考图（可选）：接到 ref_images.ref_image_1，用于服装/场景补充 */
  const [refImage2, setRefImage2] = useState(cfg?.refImage2 || '');
  const [refImage2Name, setRefImage2Name] = useState(cfg?.refImage2Name || '');
  const [refBusy, setRefBusy] = useState(false);
  const ref2Ref = useRef<HTMLInputElement>(null);
  const [run, setRun] = useState<WorkflowRun | null>(null);
  const [error, setError] = useState('');
  const [nodes, setNodes] = useState<WorkflowNodeInfo[] | null>(null);
  const [nodesLoading, setNodesLoading] = useState(false);
  const [nodesError, setNodesError] = useState('');
  const [paramsOpen, setParamsOpen] = useState(!cfg);
  const [query, setQuery] = useState('');
  const [openNodes, setOpenNodes] = useState<Record<string, boolean>>({});
  const timer = useRef<number | null>(null);

  const wf = workflows.find((w) => w.id === workflowId);
  const slots = wf?.slots;
  const hasImage = !!slots?.image.length;
  const hasAudio = !!slots?.audio.length;
  const hasPrompt = !!slots?.prompt.length;
  const hasSeed = !!slots?.seed.length;
  const hasDim = !!slots?.width.length && !!slots?.height.length;

  const cacheKey = wf ? `${wf.id}@${wf.mtime}` : '';
  const patch = cfg ? (cfg.patch || {}) : (wfPatch[wf?.id || ''] || {});
  const editCount = Object.values(patch).reduce((a, v) => a + Object.keys(v || {}).length, 0);

  /** 参数改动统一入口：节点自带配置写回节点，普通节点写全局（按工作流记忆） */
  const applyPatch = (nid: string, name: string, value?: unknown) => {
    if (cfg) { if (nodeId) setNodeWfPatch(nodeId, nid, name, value); }
    else if (wf) setWfPatch(wf.id, nid, name, value);
  };
  const resetAll = () => {
    if (cfg) { if (nodeId) resetNodeWfPatch(nodeId); }
    else if (wf) resetWfPatch(wf.id);
  };
  const chooseWorkflow = (id: string) => {
    if (cfg) { if (nodeId) setNodeWf(nodeId, { workflowId: id, patch: {} }); }
    else setWorkflowId(id);
  };

  useEffect(() => { loadWorkflows(); }, [loadWorkflows]);
  useEffect(() => () => { if (timer.current) window.clearInterval(timer.current); }, []);

  // 场景描述变化时，若提示词还是空的，顺手带出来当默认值
  useEffect(() => {
    setPrompt((cur) => cur || params.scene || '');
  }, [params.scene]);

  // 读取该工作流的节点参数清单（缓存 30 分钟，随工作流 mtime 失效）
  useEffect(() => {
    if (!wf || !wf.readable || !cacheKey) { setNodes(null); setNodesError(''); return; }
    const cached = wfNodeCache.get(cacheKey);
    if (cached) { setNodes(cached); setNodesError(''); setNodesLoading(false); return; }
    let alive = true;
    setNodesLoading(true);
    setNodesError('');
    setNodes(null);
    api.workflowNodes(wf.id)
      .then((d) => {
        if (!alive) return;
        wfNodeCache.set(cacheKey, d.nodes);
        setNodes(d.nodes);
      })
      .catch((e: any) => { if (alive) setNodesError(e.message || '读取节点参数失败'); })
      .finally(() => { if (alive) setNodesLoading(false); });
    return () => { alive = false; };
  }, [cacheKey, wf?.id, wf?.readable]);

  const startPoll = (runId: string) => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = window.setInterval(async () => {
      try {
        const r = await api.workflowRun(runId);
        setRun(r);
        // 成功输出登记到 store：拼接节点按连线顺序取用这一段
        if (r.status === 'done' && r.result?.primary?.url && nodeId) {
          setWfResult(nodeId, {
            url: r.result.primary.url,
            name: r.result.primary.name,
            runId: r.id,
            at: Date.now(),
          });
        }
        if (r.status !== 'running' && timer.current) {
          window.clearInterval(timer.current);
          timer.current = null;
        }
      } catch { /* transient */ }
    }, 1500);
  };

  /** 参数面板里改过的值，整理成后端要的 patch（nodeId → input → value） */
  const patchForRun = () => {
    // 工作流文件被改过（节点/参数不存在了）时，丢掉已经失效的键，避免 ComfyUI 校验报错
    const known = nodes ? new Map(nodes.map((n) => [n.id, new Set(n.params.map((p) => p.name))])) : null;
    const out: Record<string, Record<string, unknown>> = {};
    for (const [nid, inputs] of Object.entries(patch)) {
      const allowed = known ? known.get(nid) : undefined;
      if (known && !allowed) continue;
      const clean: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(inputs)) {
        if (allowed && !allowed.has(k)) continue;
        if (v === undefined || v === null) continue;
        clean[k] = v;
      }
      if (Object.keys(clean).length) out[nid] = clean;
    }
    return Object.keys(out).length ? out : null;
  };

  const pickRef2 = async (file?: File) => {
    if (!file) return;
    setRefBusy(true); setError('');
    try {
      const a = await api.upload('image', file);
      setRefImage2(a.path);
      setRefImage2Name(file.name);
      if (nodeId) setNodeWf(nodeId, { refImage2: a.path, refImage2Name: file.name });
    } catch (e: any) { setError(e.message); }
    finally { setRefBusy(false); }
  };
  const clearRef2 = () => {
    setRefImage2(''); setRefImage2Name('');
    if (nodeId) setNodeWf(nodeId, { refImage2: '', refImage2Name: '' });
  };

  const onRun = async () => {
    if (!wf) { setError('请选择工作流'); return; }
    if (!wf.readable) { setError('该工作流文件无法解析，请重新导出'); return; }
    setError('');
    // 画布预设节点：把当前控件值写回节点，保存画布 / 刷新后仍能复现
    if (cfg && nodeId) {
      setNodeWf(nodeId, { prompt, seed, width, height, outputName, useImage, useAudio, veda, refImage2, refImage2Name });
    }
    try {
      const { runId } = await api.runWorkflow({
        workflowId: wf.id,
        image: hasImage && useImage ? (assets.image?.path || null) : null,
        image2: refImage2 || null,
        audio: hasAudio && useAudio ? (assets.audio?.path || null) : null,
        prompt: hasPrompt ? prompt : '',
        seed,
        width: hasDim ? width : 0,
        height: hasDim ? height : 0,
        patch: patchForRun(),
        outputName: outputName || wf.name,
        veda,
        vedaOptions: veda ? { sparsity: '32' } : null,
      });
      setRun({ id: runId, workflowId: wf.id, workflowName: wf.name, status: 'running', stage: '排队中', progress: 0, logs: [] });
      startPoll(runId);
    } catch (e: any) { setError(e.message); }
  };

  const rescan = async () => {
    wfNodeCache.clear();
    if (wf) await loadWorkflows(true);
  };

  const stamp = (ms: number) => {
    const d = new Date(ms);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const primary = run?.result?.primary?.url ? mediaUrl(run.result.primary.url) : '';
  const isVideo = /\.(mp4|webm|mov)$/i.test(run?.result?.primary?.name || '');

  // ---- 参数面板的筛选/分组 ----
  const q = query.trim().toLowerCase();
  const totalParams = (nodes || []).reduce((a, n) => a + n.params.length, 0);
  const visible = (nodes || []).filter((n) => {
    if (!q) return true;
    if (n.title.toLowerCase().includes(q) || n.type.toLowerCase().includes(q) || n.id === q) return true;
    return n.params.some((p) => p.name.toLowerCase().includes(q));
  });
  const groups: { title: string; nodes: WorkflowNodeInfo[] }[] = [];
  for (const n of visible) {
    const g = n.group || '';
    const last = groups[groups.length - 1];
    if (last && last.title === g) last.nodes.push(n);
    else groups.push({ title: g, nodes: [n] });
  }
  const nodeOpen = (nid: string) => {
    if (q) return true;
    return openNodes[nid] ?? Object.keys(patch[nid] || {}).length > 0;
  };
  const toggleNode = (nid: string) => setOpenNodes((cur) => ({ ...cur, [nid]: !nodeOpen(nid) }));
  const valueOf = (p: WorkflowParam, nid: string) => {
    const e = patch[nid];
    return e && p.name in e ? (e[p.name] as string | number | boolean) : p.value;
  };
  // 面板收起时给一眼能看懂的关键参数（分段镜头先显示截取区间，避免被长参数挤掉）
  const PRIORITY = ['start_time', 'end_time', 'noise_seed', 'aspect_ratio', 'megapixels', 'filename_prefix'];
  const patchSummary = Object.entries(patch)
    .map(([nid, inputs]) => {
      const keys = Object.keys(inputs || {}).sort((a, b) => {
        const ia = PRIORITY.indexOf(a); const ib = PRIORITY.indexOf(b);
        return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
      });
      return { nid, text: `#${nid} ${keys.slice(0, 3).map((k) => `${k}=${inputs[k]}`).join(' ')}` };
    })
    .sort((a, b) => (a.text.includes('start_time') ? 0 : 1) - (b.text.includes('start_time') ? 0 : 1))
    .map((x) => x.text).join(' · ').slice(0, 150);

  return (
    <NodeShell label={cfg ? (nodeData?.label || '其他工作流') : '其他工作流'} icon="🧩" accent="#818cf8" width={348}>
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />
      <div className="muted tiny-text" style={{ marginBottom: 6 }}>
        {cfg
          ? `本节点独立绑定：${wf?.name || cfg.workflowId}（参数只影响这一段）`
          : '自动读取 ComfyUI 的 workflows 目录，选一个直接跑（图片/音频/提示词按节点自动绑定）'}
      </div>
      <div className="row gap8">
        <select value={workflowId} onChange={(e) => chooseWorkflow(e.target.value)}
          style={{ flex: 1, minWidth: 0 }} disabled={loading}>
          {!workflows.length && <option value="">{loading ? '扫描中…' : '未找到工作流'}</option>}
          {workflows.map((w) => (
            <option key={w.id} value={w.id}>{w.name}{w.readable ? '' : '（无法解析）'}</option>
          ))}
        </select>
        <button className="btn" title="重新扫描 workflows 目录与节点参数" onClick={rescan}>↻</button>
      </div>
      {(wfError || error) && <div className="err tiny-text">{error || wfError}</div>}
      {wf && (
        <div className="muted tiny-text mt8">
          {wf.nodes} 个节点 · 更新 {stamp(wf.mtime)}
          {wf.missing.length ? ` · ⚠ 缺少插件：${wf.missing.slice(0, 3).join(', ')}` : ''}
        </div>
      )}

      <div className="row gap8 mt8" style={{ flexWrap: 'wrap' }}>
        <label className="check" style={{ opacity: hasImage ? 1 : 0.45 }}
          title={hasImage ? '把这个工作流里 LoadImage 节点的图换成素材区的参考图' : '该工作流没有 LoadImage 节点'}>
          <input type="checkbox" checked={hasImage && useImage} disabled={!hasImage}
            onChange={(e) => setUseImage(e.target.checked)} />参考图
        </label>
        <label className="check" style={{ opacity: hasAudio ? 1 : 0.45 }}
          title={hasAudio ? '把 LoadAudio 节点的音频换成本曲' : '该工作流没有 LoadAudio 节点'}>
          <input type="checkbox" checked={hasAudio && useAudio} disabled={!hasAudio}
            onChange={(e) => setUseAudio(e.target.checked)} />音频
        </label>
      </div>
      <div className="muted tiny-text">
        图：{hasImage ? (assets.image ? assets.image.name.slice(-24) : '未上传，将用工作流自带默认图') : '不适用'}
        ；音：{hasAudio ? (assets.audio ? assets.audio.name.slice(-24) : '未上传，将用工作流自带默认音频') : '不适用'}
      </div>

      {/* 第二张参考图：接到 H3 的 ref_images.ref_image_1，提示词里用 <Picture 2> 指代 */}
      <div className="row gap8 mt8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="muted tiny-text">参考图 2</span>
        <button className="btn tiny" onClick={() => ref2Ref.current?.click()} disabled={refBusy}
          title="可选：接第二张参考图（服装 / 场景 / 配饰），提示词里用 <Picture 2> 指代">
          {refBusy ? '上传中…' : refImage2 ? '更换' : '＋ 加一张'}
        </button>
        {refImage2 && <button className="btn tiny" onClick={clearRef2}>清除</button>}
        {refImage2 && <span className="muted tiny-text" title={refImage2}>{refImage2Name.slice(-18)}</span>}
        <input ref={ref2Ref} type="file" accept="image/*" hidden
          onChange={(e) => { pickRef2(e.target.files?.[0]); e.currentTarget.value = ''; }} />
      </div>

      {hasPrompt && (
        <div className="scene-field mt8">
          <textarea value={prompt} placeholder="提示词（写入该工作流的文本节点）"
            onChange={(e) => setPrompt(e.target.value)} style={{ minHeight: 64 }} />
        </div>
      )}

      <div className="param-grid mt8">
        {hasSeed && <label>种子<input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} /></label>}
        {hasDim && <label>宽<input type="number" value={width} onChange={(e) => setWidth(Number(e.target.value))} /></label>}
        {hasDim && <label>高<input type="number" value={height} onChange={(e) => setHeight(Number(e.target.value))} /></label>}
        <label>输出名<input value={outputName} placeholder={wf?.name || 'workflow'}
          onChange={(e) => setOutputName(e.target.value)} /></label>
      </div>

      {/* ---- 每节点参数面板 ---- */}
      {wf && (
        <div className="wf-panel">
          <div className="wf-panel-head">
            <button className="wf-panel-title" onClick={() => setParamsOpen((v) => !v)}>
              <span className="wf-caret">{paramsOpen ? '▾' : '▸'}</span>
              <span>⚙ 节点参数</span>
              <span className="wf-panel-meta">
                {nodesLoading ? '读取中…'
                  : nodes ? `${nodes.length} 节点 / ${totalParams} 项`
                    : nodesError ? '读取失败' : ''}
                {editCount > 0 ? ` · 已改 ${editCount}` : ''}
              </span>
            </button>
            {editCount > 0 && (
              <button className="btn tiny" title="清除本工作流的全部自定义参数"
                onClick={() => resetAll()}>重置</button>
            )}
          </div>

          <div className={`wf-veda${veda ? ' on' : ''}`}>
            <label className="check"
              title="Veda 稀疏注意力：提交时在 SageAttentionPatch 之后插一个 Veda 节点，不改工作流文件。768×1280 以上约 1.3–1.4× 提速；608 短镜头下 attention 占比小，收益不明显。需已安装 veda-sparse-attention">
              <input type="checkbox" checked={veda}
                onChange={(e) => {
                  setVeda(e.target.checked);
                  if (cfg && nodeId) setNodeWf(nodeId, { veda: e.target.checked });
                }} />
              ⚡ Veda 稀疏注意力
            </label>
            <span className="muted tiny-text">{veda ? '本次运行启用' : '默认关闭 · 768+ 才划算'}</span>
          </div>

          {paramsOpen && (
            <>
              {nodesError && <div className="err tiny-text">{nodesError}</div>}
              {nodesLoading && <div className="muted tiny-text">正在按 ComfyUI 节点定义生成表单…</div>}
              {nodes && !nodes.length && (
                <div className="muted tiny-text">该工作流没有可改的参数（全部由连线或上方控件决定）</div>
              )}
              {nodes && nodes.length > 0 && (
                <>
                  <input className="wf-search" value={query} placeholder="搜索节点 / 参数名…"
                    onChange={(e) => setQuery(e.target.value)} />
                  <div className="wf-list">
                    {groups.map((g, gi) => (
                      <div className="wf-group" key={`${g.title}-${gi}`}>
                        {g.title && <div className="wf-group-title">{g.title}</div>}
                        {g.nodes.map((n) => {
                          const edits = patch[n.id] || {};
                          const ncount = Object.keys(edits).length;
                          const expanded = nodeOpen(n.id);
                          return (
                            <div className="wf-node" key={n.id}>
                              <button className={`wf-node-head${ncount ? ' edited' : ''}`}
                                onClick={() => toggleNode(n.id)} title={`${n.type} #${n.id}`}>
                                <span className="wf-caret">{expanded ? '▾' : '▸'}</span>
                                <span className="wf-node-title">{n.title}</span>
                                <span className="wf-node-type">#{n.id}</span>
                                {ncount > 0 && <span className="wf-node-badge">{ncount}</span>}
                              </button>
                              {expanded && (
                                <div className="wf-node-body">
                                  {n.params.map((p) => {
                                    const changed = p.name in edits;
                                    return (
                                      <div className={`wf-param${changed ? ' changed' : ''}`} key={p.name}>
                                        <div className="wf-param-head">
                                          <span className="wf-param-name" title={`${p.name} · ${p.type}`}>{p.name}</span>
                                          {changed && (
                                            <button className="wf-revert" title="恢复工作流里的原值"
                                              onClick={() => applyPatch(n.id, p.name, undefined)}>↺</button>
                                          )}
                                        </div>
                                        <ParamControl p={p} value={valueOf(p, n.id)}
                                          onChange={(v) => applyPatch(n.id, p.name, v === p.value ? undefined : v)} />
                                      </div>
                                    );
                                  })}
                                  {n.slotParams > 0 && (
                                    <div className="muted tiny-text">{n.slotParams} 项由上方控件控制</div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ))}
                    {!visible.length && <div className="muted tiny-text">没有匹配的节点或参数</div>}
                  </div>
                  <div className="muted tiny-text">
                    {editCount > 0 ? `已改 ${editCount} 项，点运行会作为 patch 提交` : '点节点展开改参数，默认值即工作流里的原值'}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}

      {cfg && !paramsOpen && editCount > 0 && (
        <div className="muted tiny-text">已设参数：{patchSummary}</div>
      )}

      <button className="btn primary wide mt8" onClick={onRun} disabled={!wf || run?.status === 'running'}>
        {run?.status === 'running' ? '运行中…' : `运行：${wf?.name || '请选择工作流'}`}
      </button>

      {run && (
        <div className="job-progress">
          <div className="progress-track"><div className="progress-fill" style={{ width: `${Math.round((run.progress || 0) * 100)}%` }} /></div>
          <div className="muted tiny-text">{run.stage} · {Math.round((run.progress || 0) * 100)}%{run.elapsed ? ` · ${run.elapsed}s` : ''}</div>
          {run.logs?.length > 0 && (
            <div className="muted tiny-text" style={{ maxHeight: 72, overflow: 'auto' }}>
              {run.logs.slice(-4).map((l, i) => <div key={i}>· {l}</div>)}
            </div>
          )}
        </div>
      )}
      {run?.status === 'error' && <div className="err">{run.error}</div>}
      {primary && (
        <div className="output-box">
          {isVideo
            ? <video key={primary} src={primary} controls playsInline />
            : <img src={primary} alt="工作流输出" style={{ width: '100%', borderRadius: 8 }} />}
          <a className="btn wide" href={primary} download>下载结果</a>
          {run?.result && run.result.files.length > 1 && (
            <div className="muted tiny-text">共 {run.result.files.length} 个输出文件，已存到 workspace/outputs</div>
          )}
        </div>
      )}
    </NodeShell>
  );
}

/**
 * 「拼接成片」节点：把连进来的工作流镜头节点最近一次输出按顺序 concat，
 * 铺上原曲的指定起点，可选片名与淡入淡出，直接得到最终 MP4。
 * 没有连线结果时可以手动挑选 workspace/outputs 里已有的片段。
 */
type StitchResult = Awaited<ReturnType<typeof api.stitch>>;

/* ---------------- 🎬 bot 导演台：按 MP3 时长拆分镜 → 逐镜 bot → 合成一条长视频 ---------------- */

/** AudioCrop 只吃整秒（int() 解析 m:ss），所以分镜边界一律取整秒 */
function parseClock(t: string | number): number {
  if (typeof t === 'number' && Number.isFinite(t)) return Math.max(0, t);
  const parts = String(t || '').trim().split(':').map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return 0;
  return Math.max(0, parts.reduce((a, n) => a * 60 + n, 0));
}
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));


/** 旧版默认提示词写死了服装/性别；已存进画布的旧文案在加载时一次性改成跟随参考图的中性描述 */
const stripOldWardrobe = (s: string) => s
  .replace(/身穿月白刺绣立领长衫的古风女子/g, '人物')
  .replace(/月白长衫古风女子/g, '人物')
  .replace(/月白刺绣长衫女歌手/g, '歌手');

type BotShotStatus = 'idle' | 'running' | 'paused' | 'done' | 'error';
type BotShot = {
  n: number;
  label: string;
  start: string;
  end: string;
  seconds: number;
  prompt: string;
  /** 本镜的运镜原文，换运镜时用它定位并在提示词里替换 */
  motion?: string;
  motionLabel?: string;
  seed: number;
  status: BotShotStatus;
  progress?: number;
  url?: string;
  name?: string;
  elapsed?: number;
  runId?: string;
  error?: string;
};

export function BotStageNode() {
  const nodeId = useNodeId();
  const { fitView } = useReactFlow();
  const nodeData = useCanvas((s) => (nodeId ? s.nodes.find((n: any) => n.id === nodeId)?.data : undefined));
  const assets = useCanvas((s) => s.assets);
  const params = useCanvas((s) => s.params);

  const workflowId = String(nodeData?.workflowId || 'Minimax+H3+bot');
  const [audioDur, setAudioDur] = useState(0);
  const [probeError, setProbeError] = useState('');
  const [start, setStart] = useState(String(nodeData?.audioStart ?? '0:00'));
  const [per, setPer] = useState(Number(nodeData?.shotSeconds ?? 8));
  const [useSec, setUseSec] = useState(String(nodeData?.useSeconds ?? ''));
  const [count, setCount] = useState(String(nodeData?.shotCount ?? ''));
  const [mp, setMp] = useState(Number(nodeData?.megapixels ?? 0.6));
  const [steps, setSteps] = useState(Number(nodeData?.steps ?? 4));
  /** ⚡ Veda：逐镜运行时都带上，默认关 */
  const [veda, setVeda] = useState(nodeData?.veda === true);
  const [aspect, setAspect] = useState(String(nodeData?.aspect ?? '9:16 (Portrait Widescreen)'));
  const [seed0, setSeed0] = useState(Number(nodeData?.baseSeed ?? params.seed ?? 2026112501));
  const [tpl, setTpl] = useState(stripOldWardrobe(String(nodeData?.prompt ?? DEFAULT_BOT_PROMPT)));
  /** 运镜风格与幅度：决定拆分镜时分配哪些景别/机位/运动 */
  const [motionStyle, setMotionStyle] = useState<MotionStyle>(
    (['mix', 'story', 'emotion', 'stage'] as MotionStyle[]).includes(nodeData?.motionStyle) ? nodeData.motionStyle : 'mix',
  );
  const [motionEnergy, setMotionEnergy] = useState<0 | 1 | 2>(
    [0, 1, 2].includes(Number(nodeData?.motionEnergy)) ? (Number(nodeData.motionEnergy) as 0 | 1 | 2) : 1,
  );
  const [autoStitch, setAutoStitch] = useState(nodeData?.autoStitch !== false);
  const { title, onChange: setTitle } = useAutoTitle(nodeId, nodeData?.title, nodeData?.titleEdited);
  const [fade, setFade] = useState(Number(nodeData?.fade ?? 0.6));
  const [outputName, setOutputName] = useState(String(nodeData?.outputName ?? 'botMV_长视频'));
  const [shots, setShots] = useState<BotShot[]>(() => (Array.isArray(nodeData?.shots) ? nodeData.shots : []));
  const [result, setResult] = useState<any>(nodeData?.result || null);
  const [busy, setBusy] = useState(false);
  /** 正在按 runId 接回上次中断的镜头（此时还没有新任务进度，单独给个提示） */
  const [attaching, setAttaching] = useState(false);
  const [stitching, setStitching] = useState(false);
  const [error, setError] = useState('');
  /** 停止/中断后的温和提示（区别于红色报错）：告诉用户还剩多少镜、从哪继续 */
  const [notice, setNotice] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  /** 第二张参考图（可选）：所有镜头共用，接到 ref_images.ref_image_1 */
  const [refImage2, setRefImage2] = useState(nodeData?.refImage2 || '');
  const [refImage2Name, setRefImage2Name] = useState(nodeData?.refImage2Name || '');
  const [refBusy, setRefBusy] = useState(false);
  const ref2Ref = useRef<HTMLInputElement>(null);
  /** 工作流里角色节点的 id：换工作流版本也能定位 AudioCrop / 分辨率 / 种子 / 合成节点 */
  const [roles, setRoles] = useState({ crop: '177', res: '115', seed: '129', combine: '142', sched: '124' });
  const cancelRef = useRef(false);

  const persist = (patch: Record<string, unknown>) => {
    if (nodeId) useCanvas.getState().setNodeData(nodeId, patch);
  };

  /** 刷新页面后，上次停在 running 的镜头已经没有轮询在跑了。
   *  改成 paused：不会显示假进度，也会被「继续生成」接手（有 runId 时先接回服务端原任务）。 */
  const recoveredRef = useRef(false);
  useEffect(() => {
    if (recoveredRef.current) return;
    recoveredRef.current = true;
    // 老画布里保存的旧默认提示词也一起改掉，免得「重新载入画布」后又写回人物服装
    const oldPrompt = nodeData?.prompt;
    if (typeof oldPrompt === 'string' && stripOldWardrobe(oldPrompt) !== oldPrompt) {
      persist({ prompt: stripOldWardrobe(oldPrompt) });
    }
    if (!shots.some((s) => s.status === 'running')) return;
    const next = shots.map((s) => (s.status === 'running' ? { ...s, status: 'paused' as BotShotStatus } : s));
    setShots(next);
    persist({ shots: next });
  }, []);

  /** 把导演台镜头镜像到全局，底部时间轴在分镜台为空时显示这一份（真实数据仍以节点 data 为准） */
  useEffect(() => {
    if (!nodeId) return;
    useCanvas.getState().setStageShots(nodeId, shots.map((s) => ({
      nodeId, n: s.n, label: s.motionLabel || s.label,
      start: s.start, end: s.end, seconds: s.seconds,
      status: s.status, progress: s.progress, url: s.url,
    })));
  }, [nodeId, shots]);

  const pickRef2 = async (file?: File) => {
    if (!file) return;
    setRefBusy(true); setError('');
    try {
      const a = await api.upload('image', file);
      setRefImage2(a.path);
      setRefImage2Name(file.name);
      persist({ refImage2: a.path, refImage2Name: file.name });
    } catch (e: any) { setError(e.message); }
    finally { setRefBusy(false); }
  };  const clearRef2 = () => {
    setRefImage2(''); setRefImage2Name('');
    persist({ refImage2: '', refImage2Name: '' });
  };

  // MP3 真实时长：决定能拆几镜（不靠猜，进来就读 ffprobe）
  useEffect(() => {
    const p = assets.audio?.path;
    if (!p) { setAudioDur(0); setProbeError(''); return; }
    let alive = true;
    setProbeError('');
    api.probe(p)
      .then((d) => { if (alive) setAudioDur(d.duration || 0); })
      .catch((e: any) => { if (alive) { setAudioDur(0); setProbeError(e.message || '读取时长失败'); } });
    return () => { alive = false; };
  }, [assets.audio?.path]);

  // 探测节点角色（AudioCrop / ResolutionSelector / noise_seed / VHS_VideoCombine）
  useEffect(() => {
    if (!workflowId) return;
    let alive = true;
    api.workflowNodes(workflowId).then((d) => {
      if (!alive) return;
      const next = { crop: '', res: '', seed: '', combine: '', sched: '' };
      for (const n of d.nodes) {
        if (/AudioCrop/i.test(n.type)) next.crop = n.id;
        else if (/ResolutionSelector/i.test(n.type)) next.res = n.id;
        else if (/VHS_VideoCombine/i.test(n.type)) next.combine = n.id;
        else if (/Scheduler/i.test(n.type) && n.params.some((p) => p.name === 'steps')) next.sched = n.id;
        else if (n.params.some((p) => p.name === 'noise_seed')) next.seed = n.id;
      }
      setRoles({
        crop: next.crop || '177', res: next.res || '115',
        seed: next.seed || '129', combine: next.combine || '142',
        sched: next.sched || '124',
      });
    }).catch(() => { /* 用默认 id 兜底 */ });
    return () => { alive = false; };
  }, [workflowId]);

  const s0 = Math.floor(parseClock(start));
  const remainAll = audioDur ? Math.max(0, Math.floor(audioDur) - s0) : 0;
  // 截取时长留空＝一直做到歌曲结尾；填了就只做这一段（想做 16 秒就填 16）
  const useNum = Number(useSec);
  const total = useSec.trim() && Number.isFinite(useNum) && useNum > 0
    ? Math.min(remainAll, Math.round(useNum)) : remainAll;
  const doneCount = shots.filter((s) => s.status === 'done').length;

  /** 按 MP3 时长拆分镜：整数秒 + 运镜轮换 + 逐镜独立种子 */
  const split = () => {
    if (!audioDur) { setError(probeError || '还没读到 MP3 时长（先在上面选好歌曲）'); return; }
    const avail = total;
    if (avail < 3) { setError('可用时长不足 3 秒，请把起点往前调或加大截取时长'); return; }
    const perSec = Math.max(2, Math.min(20, Math.round(per) || 8));
    let n = count.trim() ? Math.round(Number(count)) : Math.floor(avail / perSec);
    if (!Number.isFinite(n) || n < 1) n = 1;
    n = Math.min(n, 60);
    // 均分后每镜太短就先减镜数，避免出现 1 秒的碎片镜头
    while (n > 1 && Math.floor(avail / n) < Math.min(3, perSec)) n -= 1;
    const base = Math.floor(avail / n);
    const motions = buildMotions(n, { style: motionStyle, energy: motionEnergy, seed: seed0 });

    const list: BotShot[] = [];
    let cur = s0;
    for (let i = 0; i < n; i++) {
      const len = i === n - 1 ? (s0 + avail) - cur : base;
      if (len <= 0) break;
      const m = motions[i];
      list.push({
        n: i + 1,
        label: `镜${i + 1} · ${m.label}`,
        start: clock(cur), end: clock(cur + len), seconds: len,
        prompt: fillTemplate(tpl, m),
        motion: m.text,
        motionLabel: m.label,
        seed: seed0 + i,
        status: 'idle',
      });
      cur += len;
    }
    setShots(list);
    setResult(null);
    setError('');
    setNotice('');
    setOpen(null);
    persist({
      shots: list, result: null, audioStart: start, shotSeconds: perSec, shotCount: count, useSeconds: useSec,
      megapixels: mp, steps, aspect, baseSeed: seed0, prompt: tpl, autoStitch, title, fade, outputName,
      motionStyle, motionEnergy,
    });
    // 拆分后节点会突然变高，重新取景一次，否则底部按钮会被视口裁掉
    window.setTimeout(() => fitView({ padding: 0.1, duration: 450 }), 260);
  };

  const updateAt = (idx: number, patch: Partial<BotShot>) =>
    setShots((prev) => prev.map((s, i) => (i === idx ? { ...s, ...patch } : s)));

  /** 把新运镜写回某一镜：能定位到旧运镜就原地替换，否则按模板重拼（提示词已被手改过的情况） */
  const applyMotion = (shot: BotShot, m: Motion): Partial<BotShot> => ({
    label: `镜${shot.n} · ${m.label}`,
    motion: m.text,
    motionLabel: m.label,
    prompt: shot.motion && shot.prompt.includes(shot.motion)
      ? shot.prompt.replace(shot.motion, m.text)
      : fillTemplate(tpl, m),
  });

  /** 重排全部运镜：只换景别/机位/运动，区间与种子不动，已生成的片段仍然有效 */
  const rerollMotions = () => {
    if (!shots.length) return;
    const ms = buildMotions(shots.length, {
      style: motionStyle, energy: motionEnergy, seed: (Date.now() ^ seed0) >>> 0,
    });
    const next = shots.map((s, i) => ({ ...s, ...applyMotion(s, ms[i]) }));
    setShots(next);
    persist({ shots: next });
  };

  /** 只重抽某一条的运镜，用来救「这一镜机位不好看」 */
  const rerollShot = (idx: number) => {
    const shot = shots[idx];
    if (!shot) return;
    let m = buildMotions(1, {
      style: motionStyle, energy: motionEnergy, seed: (Date.now() ^ (idx * 7919) ^ seed0) >>> 0,
    })[0];
    // 骰子偶尔会抽回原来那条，重试几次，避免「点了没反应」的错觉
    for (let k = 0; k < 4 && m.text === shot.motion; k++) {
      m = buildMotions(1, {
        style: motionStyle, energy: motionEnergy, seed: (Date.now() + (k + 1) * 104729) >>> 0,
      })[0];
    }
    const next = shots.map((s, i) => (i === idx ? { ...s, ...applyMotion(s, m) } : s));
    setShots(next);
    persist({ shots: next });
  };

  /** 单镜参数：只覆盖分段/种子/输出，其余沿用工作流默认 */
  const patchFor = (shot: BotShot) => {
    const p: Record<string, Record<string, unknown>> = {};
    p[roles.crop] = { start_time: shot.start, end_time: shot.end };
    p[roles.res] = { aspect_ratio: aspect, megapixels: Number(mp) || 0.6, multiple: 32 };
    p[roles.seed] = { noise_seed: shot.seed };
    p[roles.combine] = { filename_prefix: `botstage/S${shot.n}`, frame_rate: 24 };
    if (roles.sched) p[roles.sched] = { steps: Math.max(1, Math.round(steps)) };
    return p;
  };

  const doStitch = async (list: BotShot[]) => {
    const clips = list.filter((s) => s.url).map((s) => s.url!);
    if (!clips.length || !assets.audio?.path) return;
    setStitching(true);
    try {
      const r = await api.stitch({
        clips, audio: assets.audio.path, start, title, fade, outputName,
      });
      setResult(r);
      persist({ result: r, shots: list });
      // 成片播放器会再加高节点，重新取景一次，保证「下载」按钮在视野里
      window.setTimeout(() => fitView({ padding: 0.1, duration: 450 }), 300);
    } catch (e: any) {
      setError(`合成失败：${e.message}`);
    } finally { setStitching(false); }
  };

  /** 内部中止哨兵：和真实报错区分开，停止后镜头回到 paused（可续跑），而不是标红 */
  const STOP = '__mv_stop__';

  /** 串行逐镜生成（ComfyUI 单队列，串行才不会互相抢显存），跑完按开关自动合成。
   *  只跑 indices 里没完成的镜头，因此「继续生成」天然不会重跑已完成的镜。
   *  force=true 时不做 runId 接续（单镜 ▶ 重跑：按当前参数重新提交）。 */
  const runShots = async (indices: number[], force = false) => {
    if (busy) return;
    if (!assets.image?.path) { setError('缺少角色参考图'); return; }
    if (!assets.audio?.path) { setError('缺少歌曲 MP3'); return; }
    if (!indices.length) { setError('先拆分镜'); return; }
    setBusy(true); setError(''); setNotice(''); cancelRef.current = false;
    let list = [...shots];
    const setOne = (idx: number, patch: Partial<BotShot>) => {
      list = list.map((s, i) => (i === idx ? { ...s, ...patch } : s));
      setShots(list);
    };

    /** 断点接续：上次中断的那一镜，服务端可能还在跑（甚至已跑完）。
     *  能接回就接回，接不回来才重新提交，避免白跑一遍 GPU。 */
    const attachRun = async (idx: number, runId: string): Promise<'done' | 'lost'> => {
      let r: WorkflowRun | null = null;
      try { r = await api.workflowRun(runId); } catch { return 'lost'; }
      if (!r || r.status === 'error') return 'lost';
      // 服务端重启后残留的 running 状态：超过 45 分钟视为失效，直接重跑
      if (r.status === 'running' && r.createdAt && Date.now() - r.createdAt > 45 * 60 * 1000) return 'lost';
      setOne(idx, { status: 'running', progress: r.progress || 0, error: undefined });
      for (let k = 0; k < 3200; k++) {
        if (cancelRef.current) throw new Error(STOP);
        if (r.status === 'done') {
          const primary = r.result?.primary;
          if (!primary?.url) return 'lost';
          setOne(idx, {
            status: 'done', progress: 1, url: primary.url, name: primary.name,
            elapsed: r.elapsed, runId: r.id, error: undefined,
          });
          persist({ shots: list });
          return 'done';
        }
        await sleep(1500);
        try { r = await api.workflowRun(runId); } catch { return 'lost'; }
        if (r.status === 'running') setOne(idx, { progress: r.progress || 0 });
        else if (r.status === 'error') return 'lost';
      }
      return 'lost';
    };

    try {
      for (const idx of indices) {
        if (cancelRef.current) break;
        let shot = list[idx];
        if (!shot || shot.status === 'done') continue;

        // 上次中断但服务端有对应 runId：先尝试接回（单镜重跑时跳过，按新参数重来）
        if (!force && shot.status === 'paused' && shot.runId) {
          setAttaching(true);
          let attached: 'done' | 'lost' = 'lost';
          try { attached = await attachRun(idx, shot.runId); }
          finally { setAttaching(false); }
          if (attached === 'done') continue;
          shot = list[idx];
        }

        setOne(idx, { status: 'running', progress: 0, error: undefined, url: undefined, name: undefined });
        persist({ shots: list });

        const { runId } = await api.runWorkflow({
          workflowId,
          image: assets.image.path,
          image2: refImage2 || null,
          audio: assets.audio.path,
          prompt: shot.prompt,
          seed: shot.seed,
          width: params.width,
          height: params.height,
          patch: patchFor(shot),
          outputName: `botstage_S${shot.n}`,
          veda,
          vedaOptions: veda ? { sparsity: '32' } : null,
        });
        // runId 立刻落盘：刷新/关页后还能靠它接回这一镜
        setOne(idx, { runId });
        persist({ shots: list });

        let finished: WorkflowRun | null = null;
        for (let k = 0; k < 3200; k++) {
          if (cancelRef.current) throw new Error(STOP);
          await sleep(1500);
          const r = await api.workflowRun(runId);
          if (r.status === 'running') {
            list = list.map((s, i) => (i === idx ? { ...s, progress: r.progress || 0 } : s));
            setShots(list);
            continue;
          }
          if (r.status === 'error') throw new Error(r.error || `镜${shot.n} 生成失败`);
          finished = r;
          break;
        }
        if (!finished) throw new Error(`镜${shot.n} 超时未返回`);
        const primary = finished.result?.primary;
        if (!primary?.url) throw new Error(`镜${shot.n} 没有拿到视频输出`);
        setOne(idx, {
          status: 'done', progress: 1,
          url: primary.url, name: primary.name, elapsed: finished.elapsed, runId: finished.id,
        });
        persist({ shots: list });
      }
      if (autoStitch && !cancelRef.current && list.length && list.every((s) => s.status === 'done')) {
        await doStitch(list);
      }
    } catch (e: any) {
      const msg = String(e?.message || '生成失败');
      if (msg === STOP || cancelRef.current) {
        // 用户主动停止：正在跑的那一镜退回 paused，点「继续生成」可以接着来
        list = list.map((s) => (s.status === 'running' ? { ...s, status: 'paused' } : s));
        setShots(list);
        persist({ shots: list });
        const dn = list.filter((s) => s.status === 'done').length;
        setNotice(`已停止 · 已完成 ${dn}/${list.length} 镜，点「继续生成」接着跑（已完成的不会重跑）`);
      } else {
        setError(msg);
        list = list.map((s) => (s.status === 'running' ? { ...s, status: 'error', error: msg } : s));
        setShots(list);
        persist({ shots: list });
        const dn = list.filter((s) => s.status === 'done').length;
        if (dn) setNotice(`已生成 ${dn}/${list.length} 镜；排除上面的问题后点「继续生成」，会从断点那一镜接着跑`);
      }
    } finally { setBusy(false); }
  };

  const stop = () => { cancelRef.current = true; };
  const readyToStitch = shots.length > 0 && shots.every((s) => s.status === 'done');
  /** 还没收片的镜头（idle/error/paused），「继续生成」只跑这些 */
  const pendingIdx = shots.map((s, i) => (s.status === 'done' ? -1 : i)).filter((i) => i >= 0);
  const nextPending = pendingIdx.length ? shots[pendingIdx[0]] : null;
  const outputUrl = result?.url ? mediaUrl(result.url) : '';
  // 实测标定（608×1056 / 192 帧）：8 步 257s、4 步 181s、4 步@0.45MP 124s
  // 固定开销（装载 + VAE 解码 + 封装）随像素线性，采样单步近似按像素^1.4 增长
  const px = Math.max(0.1, Number(mp) || 0.6) / 0.6;
  const perShotSec = Math.round((8 + 80 * px) + Math.max(1, steps) * 23 * Math.pow(px, 1.4));
  const totalSec = shots.length * perShotSec;
  // 单位别搞混：这里算的是秒，显示时换算成小时/分钟
  const estLabel = totalSec >= 3600
    ? `${(totalSec / 3600).toFixed(1)} 小时`
    : `${Math.max(1, Math.round(totalSec / 60))} 分钟`;

  return (
    <NodeShell label={String(nodeData?.label || 'bot 导演台')} icon="🎬" accent="#a78bfa" width={430}>
      <Handle type="target" position={Position.Left} id="in" />
      <Handle type="source" position={Position.Right} id="out" />

      <div className="muted tiny-text" style={{ marginBottom: 6 }}>
        按 MP3 真实时长自动拆成多个分镜，逐镜跑 <b>{workflowId}</b>，最后拼成一条长视频
      </div>

      <div className="bot-stat">
        <span>{audioDur ? `音频 ${audioDur.toFixed(1)}s` : (probeError || '读取时长中…')}</span>
        <span>起点 {start}</span>
        <span>可用 {total}s</span>
        {shots.length > 0 && <span className="bot-stat-hi">{shots.length} 镜 · {shots.reduce((a, s) => a + s.seconds, 0)}s</span>}
      </div>

      <div className="param-grid mt8">
        <label>截取起点（原曲）<input value={start} placeholder="0:00 / 1:28" onChange={(e) => setStart(e.target.value)} /></label>
        <label title="留空＝从起点一直做到歌曲结尾；只想做一段就填秒数（如 16）">截取时长（秒，空＝到结尾）
          <input value={useSec} placeholder={remainAll ? `到结尾 ${remainAll}s` : '—'} onChange={(e) => setUseSec(e.target.value)} /></label>
        <label title="AudioCrop 只吃整秒；24fps 下 8 秒 = 192 帧，正好对齐 H3 的 17n+5 栅格">每镜秒数
          <input type="number" min={2} max={20} step={1} value={per}
            onChange={(e) => setPer(Number(e.target.value))} /></label>
        <label title="留空＝按每镜秒数铺满截取时长；手填＝把截取时长均分给这么多镜">镜数（空＝自动）<input value={count} placeholder={`自动 ${total ? Math.floor(total / Math.max(2, per)) : '—'}`}
          onChange={(e) => setCount(e.target.value)} /></label>
        <label title="ComfyUI 实际像素 = 比值 × 总像素；竖屏 0.6 约 608×1056">清晰度（MP）<input type="number" min={0.1} max={2} step={0.05} value={mp}
          onChange={(e) => setMp(Number(e.target.value))} /></label>
        <label title="turbo LoRA 原生就是 4 步：4 步 ≈ 8 步一半耗时，画质差异很小">采样步数
          <input type="number" min={1} max={20} step={1} value={steps}
            onChange={(e) => setSteps(Number(e.target.value))} /></label>
      </div>

      <div className="bot-speeds">
        <span className="muted tiny-text">速度档</span>
        {[
          { label: '⚡ 极速', s: 4, m: 0.45, tip: '4 步 + 0.45MP，最快，远景/快剪够用' },
          { label: '⚖ 均衡', s: 4, m: 0.6, tip: '4 步 + 0.6MP（默认），≈ 8 步的一半耗时' },
          { label: '🎬 高质', s: 8, m: 0.6, tip: '8 步原设定，最慢' },
        ].map((q) => (
          <button key={q.label} title={q.tip}
            className={`bot-chip${steps === q.s && Math.abs(Number(mp) - q.m) < 0.01 ? ' on' : ''}`}
            onClick={() => { setSteps(q.s); setMp(q.m); persist({ steps: q.s, megapixels: q.m }); }}>{q.label}</button>
        ))}
        <span className="muted tiny-text">≈ {Math.floor(perShotSec / 60)}分{perShotSec % 60}秒/镜</span>
      </div>

      <div className="bot-speeds">
        <span className="muted tiny-text">运镜风格</span>
        {MOTION_STYLES.map((q) => (
          <button key={q.id} title={q.tip}
            className={`bot-chip${motionStyle === q.id ? ' on' : ''}`}
            onClick={() => { setMotionStyle(q.id); persist({ motionStyle: q.id }); }}>{q.label}</button>
        ))}
        {shots.length > 0 && <span className="muted tiny-text">改后点 🎲 生效</span>}
      </div>

      <div className="bot-speeds">
        <span className="muted tiny-text">动作幅度</span>
        {MOTION_ENERGY.map((q) => (
          <button key={q.v} title={q.tip}
            className={`bot-chip${motionEnergy === q.v ? ' on' : ''}`}
            onClick={() => { setMotionEnergy(q.v); persist({ motionEnergy: q.v }); }}>{q.label}</button>
        ))}
        <span className="muted tiny-text" title="景别、机位、运动三项都在轮换，相邻两镜不会用同一个机位">共 {MOTION_COMBOS} 种机位组合</span>
      </div>

      <label className="bot-check"
        title="Veda 稀疏注意力：每镜提交时在 SageAttentionPatch 之后插一个 Veda 节点，不改工作流文件。768×1280 以上约 1.3–1.4× 提速；608 短镜头收益很小。需已安装 veda-sparse-attention">
        <input type="checkbox" checked={veda}
          onChange={(e) => { setVeda(e.target.checked); persist({ veda: e.target.checked }); }} />
        ⚡ Veda 稀疏注意力{veda ? '（已启用）' : '（768+ 才划算）'}
      </label>

      {/* 第二张参考图：所有镜头共用，接到 ref_images.ref_image_1 */}
      <div className="row gap8 mt8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
        <span className="muted tiny-text">参考图 2</span>
        <button className="btn tiny" onClick={() => ref2Ref.current?.click()} disabled={refBusy}
          title="可选：所有镜头共用第二张参考图（服装 / 场景），提示词里用 <Picture 2> 指代">
          {refBusy ? '上传中…' : refImage2 ? '更换' : '＋ 加一张'}
        </button>
        {refImage2 && <button className="btn tiny" onClick={clearRef2}>清除</button>}
        {refImage2 && <span className="muted tiny-text" title={refImage2}>{refImage2Name.slice(-18)}</span>}
        <input ref={ref2Ref} type="file" accept="image/*" hidden
          onChange={(e) => { pickRef2(e.target.files?.[0]); e.currentTarget.value = ''; }} />
      </div>

      <label className="bot-line">画面比例
        <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
          <option value="9:16 (Portrait Widescreen)">9:16 竖屏</option>
          <option value="16:9 (Landscape Widescreen)">16:9 横屏</option>
          <option value="1:1 (Square)">1:1 方形</option>
          <option value="3:4 (Portrait Standard)">3:4 竖版</option>
        </select>
      </label>

      <label className="bot-line" title="可用占位符：{motion} 整套运镜 / {size} 景别 / {angle} 机位 / {move} 镜头运动。想完全自己写机位就只留 {size} 和 {angle}">
        提示词模板（<code>{'{motion}'}</code> 换成整套运镜，也可拆用 <code>{'{size}'}</code> <code>{'{angle}'}</code> <code>{'{move}'}</code>）
        <textarea rows={3} value={tpl} onChange={(e) => setTpl(e.target.value)} />
      </label>

      <div className="row gap8 mt8" style={{ flexWrap: 'wrap' }}>
        <button className="btn" onClick={split} disabled={!audioDur || busy}>🧩 按 MP3 拆分镜</button>
        {shots.length > 0 && (
          <button className="btn" onClick={rerollMotions} disabled={busy}
            title="保留每镜的区间与种子，只重新分配景别/机位/运动；已生成的片段不会失效，可只重跑不喜欢的镜">🎲 重排运镜</button>
        )}
        {shots.length > 0
          ? <span className="muted tiny-text">
              基准种子 {seed0} · {steps} 步/{mp}MP · 共 ≈ {estLabel}
            </span>
          : total > 0 && <span className="muted tiny-text">≈ {Math.max(1, Math.floor(total / Math.max(2, per)))} 镜 × {Math.max(2, per)}s</span>}
      </div>

      {shots.length > 0 && (
        <div className="bot-list">
          {shots.map((s, i) => (
            <div className={`bot-shot ${s.status}`} key={`${s.n}-${s.start}`}>
              <div className="bot-shot-head">
                <span className={`bot-dot ${s.status}`} />
                <b className="bot-shot-title">{s.label}</b>
                <span className="bot-shot-time">{s.start}–{s.end} · {s.seconds}s</span>
                <button className="bot-mini" title="展开/收起提示词"
                  onClick={() => setOpen(open === i ? null : i)}>✎</button>
                <button className="bot-mini" title="只重跑这一镜（用当前参数重新提交，不接续上次的任务）"
                  disabled={busy} onClick={() => runShots([i], true)}>▶</button>
              </div>
              {s.status === 'running' && (
                <div className="bot-bar"><i style={{ width: `${Math.round((s.progress || 0) * 100)}%` }} /></div>
              )}
              {s.status === 'paused' && (
                <div className="bot-shot-meta">
                  ⏸ 上次中断{(s.progress || 0) > 0 ? `（约 ${Math.round((s.progress || 0) * 100)}%）` : ''} · 点「继续生成」接着跑
                </div>
              )}
              {s.status === 'done' && (
                <div className="bot-shot-meta">
                  ✅ {s.elapsed ? `${s.elapsed}s · ` : ''}{s.name || '已完成'}
                  {s.url && <a href={mediaUrl(s.url)} target="_blank" rel="noreferrer">预览</a>}
                </div>
              )}
              {s.status === 'error' && <div className="bot-shot-meta err">{s.error}</div>}
              {open === i && (
                <>
                  <div className="bot-shot-motion">
                    <span className="muted tiny-text">运镜</span>
                    <span className="bot-motion-name">{s.motionLabel || s.motion || '—'}</span>
                    <button className="bot-mini" title="换这一镜的景别与机位（区间和种子不变）"
                      disabled={busy} onClick={() => rerollShot(i)}>🎲</button>
                  </div>
                  <textarea className="bot-shot-prompt" rows={4} value={s.prompt}
                    onChange={(e) => updateAt(i, { prompt: e.target.value })} />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="row gap8 mt8" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary" style={{ flex: 1 }}
          onClick={() => runShots(pendingIdx)}
          disabled={busy || !shots.length || readyToStitch}>
          {busy
            ? (attaching ? '↻ 接续上次的镜头…' : `生成中 ${doneCount}/${shots.length}…`)
            : !shots.length ? '先拆分镜'
              : readyToStitch ? '全部镜头已生成'
                : doneCount > 0
                  ? `⏵ 继续生成（剩 ${pendingIdx.length} 镜${nextPending ? ` · 从镜${nextPending.n}` : ''}）`
                  : `▶ 逐镜生成 ${shots.length} 镜`}
        </button>
        {busy && <button className="btn" onClick={stop}>⏹ 停止</button>}
      </div>

      {shots.length > 0 && !readyToStitch && doneCount > 0 && (
        <div className="muted tiny-text mt8">
          断点续跑：已完成的 {doneCount} 镜不会重跑；中断/失败的镜会从原任务接回，接不回来才重新生成。
        </div>
      )}
      {notice && <div className="bot-notice">{notice}</div>}

      <label className="bot-check">
        <input type="checkbox" checked={autoStitch} onChange={(e) => setAutoStitch(e.target.checked)} />
        全部镜头完成后自动合成一条长视频
      </label>

      <div className="param-grid mt8">
        <label>片名（可空）<input value={title} placeholder="留空自动取 MP3 文件名" onChange={(e) => setTitle(e.target.value)} /></label>
        <label>淡入淡出<input type="number" min={0} max={2} step={0.1} value={fade}
          onChange={(e) => setFade(Number(e.target.value))} /></label>
        <label style={{ gridColumn: '1 / -1' }}>输出名<input value={outputName} onChange={(e) => setOutputName(e.target.value)} /></label>
      </div>

      <button className="btn wide mt8" disabled={stitching || busy || !shots.some((s) => s.status === 'done')}
        onClick={() => doStitch(shots)}>
        {stitching ? '合成中…' : `🎞 合成 ${shots.filter((s) => s.status === 'done').length} 段长视频`}
      </button>

      {error && <div className="err">{error}</div>}

      {result && (
        <div className="output-box">
          <video key={outputUrl} src={outputUrl} controls playsInline />
          <div className="muted tiny-text">
            {result.width}×{result.height} · {result.duration.toFixed(2)}s · {result.clips.length} 段 · {result.elapsed}s
          </div>
          <a className="btn wide" href={outputUrl} download>下载长视频</a>
        </div>
      )}
    </NodeShell>
  );
}

export function StitchNode() {
  const nodeId = useNodeId();
  const nodeData = useCanvas((s) => (nodeId ? s.nodes.find((n: any) => n.id === nodeId)?.data : undefined));
  const nodes = useCanvas((s) => s.nodes);
  const edges = useCanvas((s) => s.edges);
  const wfResults = useCanvas((s) => s.wfResults);
  const assets = useCanvas((s) => s.assets);
  const setNodeData = useCanvas((s) => s.setNodeData);

  const [manual, setManual] = useState<string[]>([]);
  const [outputs, setOutputs] = useState<{ name: string; url: string }[]>([]);
  const [pick, setPick] = useState('');
  const [start, setStart] = useState(String(nodeData?.start ?? '0:00'));
  const { title, onChange: setTitle } = useAutoTitle(nodeId, nodeData?.title, nodeData?.titleEdited);
  const [fade, setFade] = useState(Number(nodeData?.fade ?? 0.6));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<StitchResult | null>(null);

  useEffect(() => { api.outputs().then((d) => setOutputs(d.files)).catch(() => {}); }, []);

  // 连线顺序即拼接顺序；只收「已经有成功输出」的镜头节点。
  // 若上游是 bot 导演台，则按分镜顺序展开它已经跑完的多段，而不是只取一段。
  const auto = edges
    .filter((e: any) => e.target === nodeId)
    .flatMap((e: any) => {
      const src = nodes.find((n: any) => n.id === e.source);
      const staged = Array.isArray(src?.data?.shots) ? src.data.shots : [];
      const expanded = staged
        .filter((s: any) => s?.url && s.status === 'done')
        .map((s: any) => ({ url: s.url as string, name: s.name || `镜${s.n}`, from: `${src?.data?.label || e.source} · 镜${s.n}` }));
      if (expanded.length) return expanded;
      const r = wfResults[e.source];
      return r ? [{
        url: r.url as string, name: r.name as string,
        from: (src?.data?.label || e.source) as string,
      }] : [];
    });
  const clips = auto.length
    ? auto
    : manual.map((u) => ({ url: u, name: u.split('/').pop() || u, from: '手动挑选' }));

  const addManual = () => {
    if (!pick) return;
    const f = outputs.find((o) => o.url === pick);
    setManual((m) => (m.includes(pick) ? m : [...m, pick]));
    setPick('');
    if (f) setError('');
  };

  const run = async () => {
    if (!clips.length) { setError('没有可拼的片段：先跑镜头节点，或在下方挑选已有 MP4'); return; }
    if (!assets.audio) { setError('缺少歌曲 MP3（素材节点）'); return; }
    setBusy(true); setError(''); setResult(null);
    try {
      const r = await api.stitch({
        clips: clips.map((c) => c.url),
        audio: assets.audio.path, start, title, fade,
        outputName: String(nodeData?.outputName || '拼接成片'),
      });
      setResult(r);
      if (nodeId) setNodeData(nodeId, { start, title, fade });
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  };

  const outputUrl = result?.url ? mediaUrl(result.url) : '';

  return (
    <NodeShell label={String(nodeData?.label || '拼接成片')} icon="🎞" accent="#34d399" width={348}>
      <Handle type="target" position={Position.Left} id="in" />
      <div className="muted tiny-text" style={{ marginBottom: 6 }}>
        把连进来的镜头按顺序拼成一条，铺原曲、可选片名与淡入淡出
      </div>

      <div className="stitch-list">
        {clips.map((c, i) => (
          <div className="stitch-item" key={`${c.url}-${i}`}>
            <span className="stitch-idx">{i + 1}</span>
            <span className="stitch-name" title={`${c.from} · ${c.name}`}>{c.name}</span>
            {!auto.length && (
              <button className="stitch-del" title="从列表移除"
                onClick={() => setManual((m) => m.filter((_, k) => k !== i))}>✕</button>
            )}
          </div>
        ))}
        {!clips.length && <div className="muted tiny-text">暂无片段：运行左侧镜头节点后会自动出现在这里</div>}
      </div>

      {!auto.length && (
        <>
          <div className="row gap8 mt8">
            <select value={pick} onChange={(e) => setPick(e.target.value)} style={{ flex: 1, minWidth: 0 }}>
              <option value="">挑选已有 MP4…</option>
              {outputs.map((o) => <option key={o.url} value={o.url}>{o.name}</option>)}
            </select>
            <button className="btn" onClick={addManual} disabled={!pick}>加入</button>
            {manual.length > 0 && <button className="btn" title="清空手动片段" onClick={() => setManual([])}>清空</button>}
          </div>
        </>
      )}
      {auto.length > 0 && (
        <div className="muted tiny-text">{auto.length} 段来自连线（按连线顺序），想换片段请断开对应连线</div>
      )}

      <div className="param-grid mt8">
        <label>原曲起点<input value={start} placeholder="1:28" onChange={(e) => setStart(e.target.value)} /></label>
        <label>淡入淡出<input type="number" min={0} max={2} step={0.1} value={fade}
          onChange={(e) => setFade(Number(e.target.value))} /></label>
        <label style={{ gridColumn: '1 / -1' }}>片名（可空）<input value={title} placeholder="留空自动取 MP3 文件名" onChange={(e) => setTitle(e.target.value)} /></label>
      </div>

      <button className="btn primary wide mt8" onClick={run} disabled={busy || !clips.length}>
        {busy ? '拼接中…' : clips.length ? `拼接 ${clips.length} 段成片` : '等待镜头输出'}
      </button>

      {error && <div className="err">{error}</div>}
      {result && (
        <div className="output-box">
          <video key={outputUrl} src={outputUrl} controls playsInline />
          <div className="muted tiny-text">
            {result.width}×{result.height} · {result.duration.toFixed(2)}s · {result.clips.length} 段 · {result.elapsed}s
          </div>
          <a className="btn wide" href={outputUrl} download>下载成片</a>
        </div>
      )}
    </NodeShell>
  );
}

export const nodeTypes = {
  image: ImageNode,
  audio: AudioNode,
  lyrics: LyricsNode,
  analyze: AnalyzeNode,
  storyboard: StoryboardNode,
  keyframe: KeyframeNode,
  generate: GenerateNode,
  export: ExportNode,
  workflow: WorkflowNode,
  stitch: StitchNode,
  botstage: BotStageNode,
};

// Keep a tiny helper used by the App for the timeline strip.
export function sectionColor(section: string) {
  return SECTION_COLOR[section] || '#94a3b8';
}
