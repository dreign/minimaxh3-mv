import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ReactFlow, ReactFlowProvider, Background, Controls, MiniMap, MarkerType,
  useReactFlow, type Connection, type IsValidConnection,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { nodeTypes, sectionColor } from './nodes';
import { useCanvas, missingAssets, type NodeKind } from './store';
import { api, pollJob } from './api';
import type { JobState } from './types';
import './styles.css';

const ALLOWED: Record<NodeKind, NodeKind[]> = {
  image: ['analyze', 'botstage'], audio: ['analyze', 'botstage'], lyrics: ['analyze'],
  analyze: ['storyboard'], storyboard: ['keyframe'], keyframe: ['generate'],
  generate: ['export'], export: [], workflow: ['stitch'], stitch: [],
  botstage: ['stitch'],
};

/** 时间轴缩略视频：默认展示首帧，悬停播放、移出暂停，避免所有镜头同时解码 */
function TimelineVideo({ src }: { src: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  return (
    <video ref={ref} src={src} muted playsInline preload="metadata"
      onMouseEnter={() => { const v = ref.current; if (v) { v.currentTime = 0; v.play().catch(() => {}); } }}
      onMouseLeave={() => { const v = ref.current; if (v) { v.pause(); v.currentTime = 0; } }} />
  );
}

function Canvas() {
  const nodes = useCanvas((s) => s.nodes);
  const edges = useCanvas((s) => s.edges);
  const onNodesChange = useCanvas((s) => s.onNodesChange);
  const onEdgesChange = useCanvas((s) => s.onEdgesChange);
  const addNode = useCanvas((s) => s.addNode);
  const shots = useCanvas((s) => s.shots);
  const selectedShot = useCanvas((s) => s.selectedShot);
  const setSelectedShot = useCanvas((s) => s.setSelectedShot);
  const jobs = useCanvas((s) => s.jobs);
  const activeJobId = useCanvas((s) => s.activeJobId);
  const setJob = useCanvas((s) => s.setJob);
  const keyframes = useCanvas((s) => s.keyframes);
  const shotVideos = useCanvas((s) => s.shotVideos);
  const timelineView = useCanvas((s) => s.timelineView);
  const setTimelineView = useCanvas((s) => s.setTimelineView);
  /** 导演台镜像的镜头：分镜台没拆分镜时，底部时间轴改显示它 */
  const stageNodeId = useCanvas((s) => s.stageNodeId);
  const stageShots = useCanvas((s) => s.stageShots);
  const { fitView } = useReactFlow();

  const [health, setHealth] = useState<any>(null);
  const [toast, setToast] = useState<{ msg: string; action?: { label: string; run: () => void } } | null>(null);
  const [busy, setBusy] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  /** 分镜台与导演台都有镜头时，时间轴默认看分镜台，可手动切成导演台 */
  const [preferStage, setPreferStage] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  const notify = (msg: string, action?: { label: string; run: () => void }) => {
    window.clearTimeout(toastTimer.current);
    setToast({ msg, action });
    toastTimer.current = window.setTimeout(() => setToast(null), action ? 6500 : 4200);
  };

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth({ comfy: false, ffmpeg: false }));
    // 刷新后恢复的素材可能文件已被清理，校验并清除失效项
    const assets = useCanvas.getState().assets;
    if (assets.image || assets.audio || assets.lyrics) {
      api.verifyAssets(assets)
        .then((valid) => useCanvas.getState().hydrateAssets(valid))
        .catch(() => {});
    }
  }, []);

  useEffect(() => {
    if (!activeJobId) return;
    const timer = setInterval(async () => {
      try {
        const j = await api.job(activeJobId);
        setJob(activeJobId, j);
      } catch { /* ignore transient */ }
    }, 1500);
    return () => clearInterval(timer);
  }, [activeJobId, setJob]);

  /** 删除节点/连线：只改 store，撤销提示由 lastDeleted 的 effect 统一给出 */
  const deleteElements = (nodeIds: string[], edgeIds: string[]) => {
    const s = useCanvas.getState();
    const goneNodes = s.nodes.filter((n: any) => nodeIds.includes(n.id));
    const goneEdges = s.edges.filter((e: any) => edgeIds.includes(e.id));
    if (!goneNodes.length && !goneEdges.length) return;
    s.removeNodes(goneNodes.map((n: any) => n.id), goneEdges.map((e: any) => e.id));
  };

  const deleteSelection = () => {
    const s = useCanvas.getState();
    const nodeIds = s.nodes.filter((n: any) => n.selected).map((n: any) => n.id);
    const edgeIds = s.edges.filter((e: any) => e.selected).map((e: any) => e.id);
    if (!nodeIds.length && !edgeIds.length) { notify('先点选要删除的节点（可框选多个）'); return; }
    deleteElements(nodeIds, edgeIds);
  };

  // 任何入口（节点 ✕ / Delete 键 / 工具栏按钮）删除后，都用同一套撤销提示
  const lastDeleted = useCanvas((s) => s.lastDeleted);
  useEffect(() => {
    if (!lastDeleted) return;
    const names = lastDeleted.nodes.map((n: any) => n.data?.label || n.id);
    const text = names.length
      ? `已删除 ${names.length} 个节点${names.length <= 3 ? `：${names.join('、')}` : ''}`
      : `已删除 ${lastDeleted.edges.length} 条连线`;
    notify(text, {
      label: '撤销',
      run: () => { useCanvas.getState().undoDelete(); notify('已撤销删除'); },
    });
  }, [lastDeleted]);

  // Delete / Backspace 删除选中，Ctrl(Cmd)+Z 撤销；在输入框里打字时不拦截
  useEffect(() => {
    const isTyping = (t: EventTarget | null) => {
      const el = t as HTMLElement | null;
      if (!el || !el.tagName) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target)) return;
      const s = useCanvas.getState();
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const nodeIds = s.nodes.filter((n: any) => n.selected).map((n: any) => n.id);
        const edgeIds = s.edges.filter((edge: any) => edge.selected).map((edge: any) => edge.id);
        if (!nodeIds.length && !edgeIds.length) return;
        e.preventDefault();
        deleteElements(nodeIds, edgeIds);
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && s.lastDeleted) {
        e.preventDefault();
        s.undoDelete();
        notify('已撤销删除');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const isValidConnection: IsValidConnection = useCallback((conn: Connection | any) => {    const src = nodes.find((n: any) => n.id === conn.source)?.data?.kind as NodeKind | undefined;
    const tgt = nodes.find((n: any) => n.id === conn.target)?.data?.kind as NodeKind | undefined;
    return !!src && !!tgt && ALLOWED[src]?.includes(tgt);
  }, [nodes]);

  const onConnect = useCallback((conn: Connection) => {
    const src = nodes.find((n: any) => n.id === conn.source)?.data?.kind;
    const color = src === 'analyze' ? '#a78bfa' : src === 'storyboard' ? '#f472b6'
      : src === 'keyframe' ? '#fb923c' : src === 'generate' ? '#34d399' : '#60a5fa';
    useCanvas.setState((s: any) => ({
      edges: [...s.edges, { ...conn, id: `e-${Date.now()}`, animated: true, style: { stroke: color }, markerEnd: { type: MarkerType.ArrowClosed, color } }],
    }));
  }, [nodes]);

  const saveCanvas = () => {
    const s = useCanvas.getState();
    const payload = JSON.stringify({ nodes: s.nodes, edges: s.edges, assets: s.assets, params: s.params, analysis: s.analysis, shots: s.shots }, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
    a.download = `mv-canvas-${Date.now()}.json`; a.click();
    URL.revokeObjectURL(a.href);
    notify('画布已导出');
  };

  const loadCanvas = async (file?: File) => {
    if (!file) return;
    try {
      const d = JSON.parse(await file.text());
      useCanvas.setState((s: any) => ({
        nodes: d.nodes || s.nodes, edges: d.edges || s.edges,
      }));
      useCanvas.getState().restoreState({
        assets: d.assets || undefined, params: d.params || undefined,
        analysis: d.analysis || undefined, shots: d.shots || undefined,
      });
      notify('画布已加载');
      setTimeout(() => fitView({ padding: 0.15, duration: 500 }), 100);
    } catch (e: any) { notify(`加载失败：${e.message}`); }
  };

  /** 新建画布：用服务端预设（真实素材路径 + 逐镜参数）替换当前画布 */
  const newCanvas = async (presetId: string) => {
    if (presetBusy) return;
    if (useCanvas.getState().nodes.length
      && !window.confirm('新建画布会替换当前画布（想保留请先「保存画布」导出 JSON）。继续？')) return;
    setPresetBusy(true);
    try {
      const p = await api.preset(presetId);
      useCanvas.getState().applyPreset(p);
      const miss = (p.missing || []).join('、');
      notify(miss ? `画布已载入，但缺少素材：${miss}` : `已生成新画布：${p.name}`);
      // 节点首次渲染后高度才测量出来，稍等再 fit 一次，否则底部镜头会被切在视口外
      setTimeout(() => fitView({ padding: 0.12, duration: 500 }), 500);
      setTimeout(() => fitView({ padding: 0.12, duration: 400 }), 1400);
    } catch (e: any) { notify(`载入画布失败：${e.message}`); }
    finally { setPresetBusy(false); }
  };

  const runAll = async () => {
    const s = useCanvas.getState();
    const missing = missingAssets(s.assets, ['image', 'audio']);
    if (missing) { notify(missing); return; }
    setBusy(true);
    try {
      notify(s.params.useLyrics ? '① 分析节拍与歌词…' : '① 分析节拍（不使用歌词）…');
      const analysis = await api.analyze({
        image: s.assets.image!.path, audio: s.assets.audio!.path,
        lyrics: s.params.useLyrics ? (s.assets.lyrics?.path || null) : null,
        duration: 0, maxShots: s.params.maxShots, shotSeconds: 5.17,
        scene: s.params.scene, useLyrics: s.params.useLyrics, seed: s.params.seed,
      });
      useCanvas.getState().setAnalysis(analysis);
      useCanvas.getState().setParam('duration', analysis.songDuration || analysis.duration);
      const shots = useCanvas.getState().shots;

      notify(`② 生成 ${shots.length} 张分镜首帧图…`);
      const kfRes = await api.keyframes({
        image: s.assets.image!.path, shots,
        params: { ...useCanvas.getState().params },
      });
      const kfJobId = kfRes.jobId;
      setJob(kfJobId, { id: kfJobId, status: 'pending', stage: '首帧图排队中', progress: 0, logs: [] });
      useCanvas.getState().setKeyframeJob(kfJobId);
      const kfDone = await pollJob(kfJobId, (j) => setJob(kfJobId, j));
      if (!kfDone || kfDone.status !== 'done') throw new Error(kfDone?.error || '首帧图生成失败');
      const kfData = await api.keyframesResult(kfJobId);
      const finalParams = useCanvas.getState().params;
      useCanvas.getState().setKeyframes(kfData.keyframes, {
        width: kfData.width || finalParams.width,
        height: kfData.height || finalParams.height,
      });

      notify(`③ 基于首帧图生成 ${shots.length} 个镜头…`);
      const { jobId } = await api.generate({
        jobId: kfJobId,
        image: s.assets.image!.path, audio: s.assets.audio!.path,
        lyrics: s.params.useLyrics ? (s.assets.lyrics?.path || null) : null,
        shots, params: { ...useCanvas.getState().params },
        lyricsData: s.params.useLyrics ? (analysis.lyrics || []) : [],
        scene: s.params.scene, useLyrics: s.params.useLyrics,
      });
      setJob(jobId, { id: jobId, status: 'pending', stage: '排队中', progress: 0, logs: [] });
      useCanvas.getState().setActiveJob(jobId);
      const gen = await pollJob(jobId, (j) => setJob(jobId, j));
      if (!gen || gen.status !== 'done') throw new Error(gen?.error || '镜头生成失败');
      notify('④ 合成最终 MV…');
      const comp = await api.compose({
        jobId, audio: s.assets.audio!.path,
        lyricsData: s.params.useLyrics ? (analysis.lyrics || []) : [],
        params: { ...useCanvas.getState().params }, useLyrics: s.params.useLyrics,
      });
      const finished = await pollJob(comp.jobId, (j) => setJob(comp.jobId, j));
      if (!finished || finished.status !== 'done') throw new Error(finished?.error || '合成失败');
      notify('完成！右侧可播放/下载 MV');
    } catch (e: any) { notify(`失败：${e.message}`); }
    finally { setBusy(false); }
  };

  const job: JobState | undefined = activeJobId ? jobs[activeJobId] : undefined;
  const logs = job?.logs || [];
  const selectedCount = nodes.filter((n: any) => n.selected).length + edges.filter((e: any) => e.selected).length;
  /** 分镜台没拆分镜、但导演台已经拆过：时间轴改显示导演台的镜头 */
  const bothSources = shots.length > 0 && stageShots.length > 0;
  const useStage = stageShots.length > 0 && (shots.length === 0 || preferStage);
  const stageDone = stageShots.filter((s) => s.status === 'done').length;
  const tlCount = useStage ? stageShots.length : shots.length;
  /** 当前选中的镜头：分镜台按 index、导演台按 n，和底部时间轴正在显示的那份保持一致 */
  const pickedShot = useStage
    ? stageShots.find((s) => s.n === selectedShot)
    : shots.find((s) => s.index === selectedShot);
  const pickedVideo = (pickedShot as any)?.prompt || '';
  const pickedFrame = !useStage ? ((pickedShot as any)?.framePrompt || '') : '';
  const pickedMeta = useStage
    ? (pickedShot as any)?.label || ''
    : [(pickedShot as any)?.section, (pickedShot as any)?.scene, (pickedShot as any)?.lyric].filter(Boolean).join(' · ');
  const copyPrompt = async (text: string) => {
    try { await navigator.clipboard.writeText(text); notify('提示词已复制'); }
    catch { notify('复制失败，请手动选中'); }
  };

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand"><span className="brand-mark">MV</span><div><b>无限画布 · MV 工作台</b><small>ComfyUI MiniMax H3 · 本地生成</small></div></div>
        <div className="toolbar">
          <select defaultValue="" onChange={(e) => { if (e.target.value) { addNode(e.target.value as NodeKind); e.target.value = ''; } }}>
            <option value="">＋ 添加节点</option>
            <option value="image">人物参考图</option><option value="audio">歌曲 MP3</option>
            <option value="lyrics">歌词</option><option value="analyze">节拍分析</option>
            <option value="storyboard">分镜台</option><option value="keyframe">首帧图</option>
            <option value="generate">H3 生成</option>
            <option value="export">合成导出</option>
            <option value="workflow">其他工作流</option>
            <option value="stitch">拼接成片</option>
            <option value="botstage">bot 导演台</option>
          </select>
          <button className="btn" onClick={() => newCanvas('storyboard')} disabled={presetBusy}
            title="载入默认分镜台流程：① 参考图 + ② MP3 → ④ 节拍分析 → ⑤ 分镜台 → ⑥ 首帧图 → ⑦ 逐镜生成 → ⑧ 合成（也可直接点「⚡ 一键生成 MV」）">
            {presetBusy ? '载入中…' : '📽 分镜台流程'}
          </button>
          <button className="btn" onClick={() => newCanvas('bot-mv')} disabled={presetBusy}
            title="载入 4 个固定 8 秒镜头的 bot 画布（1:28–2:00，逐镜手动运行）">
            {presetBusy ? '载入中…' : '🎬 bot MV 画布'}
          </button>
          <button className="btn" onClick={() => newCanvas('bot-mv-auto')} disabled={presetBusy}
            title="载入 bot 导演台画布：按 MP3 时长自动拆分镜，逐镜跑完自动合成一条长视频（整首歌约 1 小时 GPU）">
            {presetBusy ? '载入中…' : '🧭 bot 导演台'}
          </button>
          <button className="btn" onClick={() => fitView({ padding: 0.15, duration: 500 })}>适应画布</button>
          <button className="btn" onClick={deleteSelection} disabled={!selectedCount}
            title="删除选中的节点/连线（快捷键 Delete 或 Backspace）">✕ 删除选中{selectedCount ? ` (${selectedCount})` : ''}</button>
          <button className="btn" onClick={saveCanvas}>保存画布</button>
          <button className="btn" onClick={() => fileRef.current?.click()}>加载画布</button>
          <input ref={fileRef} type="file" accept=".json" hidden onChange={(e) => loadCanvas(e.target.files?.[0])} />
          <button className="btn primary" onClick={runAll} disabled={busy}>{busy ? '流程运行中…' : '⚡ 一键生成 MV'}</button>
        </div>
        <div className="health">
          <span className={health?.comfy ? 'dot ok' : 'dot bad'} title="ComfyUI">C</span>
          <span className={health?.ffmpeg ? 'dot ok' : 'dot bad'} title="ffmpeg">F</span>
          <span className="muted tiny-text">{health?.comfy ? '就绪' : 'ComfyUI 未连接'}</span>
        </div>
      </header>

      <div className="main">
        <div className="canvas-wrap">
          <ReactFlow
            nodes={nodes} edges={edges}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
            onConnect={onConnect} isValidConnection={isValidConnection}
            nodeTypes={nodeTypes} fitView
            deleteKeyCode={null}
            defaultEdgeOptions={{ animated: true, markerEnd: { type: MarkerType.ArrowClosed } }}
            minZoom={0.2} maxZoom={2}
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={22} size={1.2} color="#d8dee9" />
            <Controls showInteractive={false} />
            <MiniMap pannable zoomable nodeColor={(n: any) => {
              const k = n.data?.kind;
              return k === 'export' ? '#34d399' : k === 'stitch' ? '#34d399' : k === 'generate' ? '#f97316'
                : k === 'keyframe' ? '#fb923c' : k === 'storyboard' ? '#f472b6'
                : k === 'botstage' ? '#a78bfa'
                : k === 'workflow' ? '#818cf8' : '#93c5fd';
            }} />
          </ReactFlow>
        </div>

        <aside className="sidepanel">
          {pickedShot ? (
            <div className="pick-panel">
              <div className="panel-title row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
                <span>分镜 #{String((pickedShot as any).n ?? (pickedShot as any).index).padStart(2, '0')} · 提示词</span>
                <button className="btn tiny ghost" title="收起" onClick={() => setSelectedShot(null)}>✕</button>
              </div>
              {pickedMeta && <div className="pick-meta">{pickedMeta}</div>}
              <div className="pick-sub">🎞 视频提示词</div>
              <div className="pick-prompt">{pickedVideo || <span className="muted tiny-text">（空）</span>}</div>
              <button className="btn tiny ghost pick-copy" onClick={() => copyPrompt(pickedVideo)}>复制视频提示词</button>
              {pickedFrame && (
                <>
                  <div className="pick-sub">🖼 首帧图提示词</div>
                  <div className="pick-prompt">{pickedFrame}</div>
                  <button className="btn tiny ghost pick-copy" onClick={() => copyPrompt(pickedFrame)}>复制首帧图提示词</button>
                </>
              )}
            </div>
          ) : (
            <div className="pick-panel pick-empty">点击分镜台镜头卡片或底部时间轴的任意一镜，这里显示该镜提示词。</div>
          )}
          <div className="panel-title mt16">任务日志</div>
          {job ? (
            <>
              <div className="job-head"><span className={`badge ${job.status}`}>{job.status}</span><span className="muted tiny-text">{job.stage}</span></div>
              <div className="logbox">
                {logs.length ? logs.slice(-120).map((l, i) => <div key={i} className="logline">{l}</div>)
                  : <div className="muted tiny-text">等待任务启动…</div>}
              </div>
            </>
          ) : <div className="muted">尚未开始任务。可在「分镜台」调整提示词后点击生成。</div>}
          <div className="panel-title mt16">环境</div>
          <div className="env-list">
            <div><span>ComfyUI</span><b>{health?.comfy ? '已连接' : '未连接'}</b></div>
            <div><span>ffmpeg</span><b>{health?.ffmpeg ? '可用' : '缺失'}</b></div>
            <div><span>输出目录</span><b className="tiny-text">{health?.outputDir || '—'}</b></div>
          </div>
        </aside>
      </div>

      <footer className="timeline">
        <div className="timeline-head">
          <div className="timeline-title">
            时间轴 <span className="muted tiny-text">{tlCount} 镜</span>
            {bothSources ? (
              <span className="tl-srcs">
                <button className={`tl-view ${!useStage ? 'on' : ''}`} onClick={() => setPreferStage(false)}>分镜台 {shots.length}</button>
                <button className={`tl-view ${useStage ? 'on' : ''}`} onClick={() => setPreferStage(true)}>导演台 {stageShots.length}</button>
              </span>
            ) : useStage && <span className="tl-src">导演台</span>}
          </div>
          <div className="timeline-views">
            {useStage ? (
              <span className="muted tiny-text">
                {stageDone}/{stageShots.length} 已完成{stageNodeId ? ' · 点缩略图定位导演台' : ''}
              </span>
            ) : (
              <>
                <span className="muted tiny-text">显示</span>
                {([['auto', '自动'], ['keyframe', '首帧图'], ['video', '视频']] as const).map(([v, label]) => (
                  <button key={v} className={`tl-view ${timelineView === v ? 'on' : ''}`} onClick={() => setTimelineView(v)}>{label}</button>
                ))}
              </>
            )}
          </div>
        </div>
        <div className="timeline-track">
          {useStage && stageShots.map((s) => (
            <div key={`${s.nodeId}-${s.n}`} className={`tl-shot st-${s.status} ${selectedShot === s.n ? 'active' : ''}`}
              style={{ flexGrow: Math.max(1, s.seconds) }}
              title={`#${s.n} ${s.start}-${s.end}s · ${s.label || '导演台镜头'}${s.status === 'done' ? ' · 已完成' : s.status === 'running' ? ` · 生成中 ${Math.round((s.progress || 0) * 100)}%` : ''}`}
              onClick={() => {
                setSelectedShot(s.n);
                if (stageNodeId) fitView({ nodes: [{ id: stageNodeId }], duration: 500, padding: 1.4 });
              }}>
              <div className="tl-thumb">
                {s.url ? <TimelineVideo src={s.url} /> : <span className="tl-ph">#{s.n}</span>}
                {s.status === 'running' && <div className="tl-prog"><i style={{ width: `${Math.round((s.progress || 0) * 100)}%` }} /></div>}
                {s.status === 'paused' && <span className="tl-flag">⏸</span>}
                {s.status === 'error' && <span className="tl-flag err">!</span>}
              </div>
              <div className="tl-meta">
                <span>#{s.n}</span>
                {s.label && <small>{s.label.slice(0, 6)}</small>}
              </div>
            </div>
          ))}
          {!useStage && shots.map((s) => {
            const videoUrl = shotVideos[s.index - 1];
            const kfUrl = keyframes.find((k) => k.index === s.index)?.url;
            const showVideo = timelineView === 'video' ? !!videoUrl : timelineView === 'keyframe' ? false : !!videoUrl;
            const showKf = timelineView === 'keyframe' ? !!kfUrl : timelineView === 'video' ? false : !videoUrl && !!kfUrl;
            return (
              <div key={s.id} className={`tl-shot ${selectedShot === s.index ? 'active' : ''}`}
                style={{ borderColor: sectionColor(s.section), flexGrow: Math.max(1, s.frames) }}
                title={`#${s.index} ${s.start.toFixed(1)}-${s.end.toFixed(1)}s · ${s.lyric || '无歌词'}`}
                onClick={() => setSelectedShot(s.index)}>
                <div className="tl-thumb">
                  {showVideo ? <TimelineVideo src={videoUrl!} /> : showKf ? <img src={kfUrl} alt={`首帧 ${s.index}`} loading="lazy" />
                    : <span className="tl-ph">#{s.index}</span>}
                </div>
                <div className="tl-meta" style={{ background: sectionColor(s.section) }}>
                  <span>#{s.index}</span>
                  {s.lyric && <small>{s.lyric.slice(0, 6)}</small>}
                </div>
              </div>
            );
          })}
          {!shots.length && !stageShots.length && (
            <span className="muted tiny-text">在「bot 导演台」拆分镜，或在分镜台分析生成后，这里会按节拍显示镜头；生成完成显示缩略图</span>
          )}
        </div>
      </footer>

      {toast && (
        <div className="toast">
          <span>{toast.msg}</span>
          {toast.action && (
            <button className="toast-action" onClick={() => { toast.action!.run(); setToast(null); }}>
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function App() {
  return <ReactFlowProvider><Canvas /></ReactFlowProvider>;
}
