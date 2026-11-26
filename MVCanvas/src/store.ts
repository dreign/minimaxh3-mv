import { create } from 'zustand';
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react';
import { api } from './api';
import type { Asset, AssetKind, Analysis, Params, Shot, JobState, Keyframe, WorkflowInfo } from './types';
import { DEFAULT_PARAMS } from './types';

export type NodeKind = 'image' | 'audio' | 'lyrics' | 'analyze' | 'storyboard' | 'keyframe' | 'generate' | 'export' | 'workflow' | 'stitch' | 'botstage';

/** 片名默认从 MP3 文件名取：去掉扩展名，以及上传时加的 `audio_<时间戳>_` 前缀 */
export function songTitleFromAsset(asset: Asset | null): string {
  if (!asset?.name) return '';
  return asset.name
    .replace(/\.[^.]+$/, '')
    .replace(/^(?:image|audio|lyrics)_\d+_/, '')
    .replace(/^[\s_\-]+|[\s_\-]+$/g, '')
    .trim();
}

const makeNode = (id: string, kind: NodeKind, label: string, x: number, y: number) => ({
  id,
  type: kind,
  position: { x, y },
  data: { kind, label },
});

const initialNodes = [
  makeNode('image', 'image', '① 人物参考图', 0, 40),
  makeNode('audio', 'audio', '② 歌曲 MP3', 0, 260),
  makeNode('lyrics', 'lyrics', '③ 歌词 LRC/TXT', 0, 450),
  makeNode('analyze', 'analyze', '④ 节拍与歌词分析', 330, 200),
  makeNode('storyboard', 'storyboard', '⑤ 分镜台（可编辑）', 660, 40),
  makeNode('keyframe', 'keyframe', '⑥ 分镜首帧图', 1000, 40),
  makeNode('generate', 'generate', '⑦ H3 镜头生成', 1340, 40),
  makeNode('export', 'export', '⑧ 合成与导出', 1680, 220),
  makeNode('workflow', 'workflow', '🧩 其他工作流', 1340, 660),
];

const initialEdges = [
  { id: 'e-image-analyze', source: 'image', sourceHandle: 'out', target: 'analyze', targetHandle: 'image', animated: true, style: { stroke: '#60a5fa' } },
  { id: 'e-audio-analyze', source: 'audio', sourceHandle: 'out', target: 'analyze', targetHandle: 'audio', animated: true, style: { stroke: '#60a5fa' } },
  { id: 'e-lyrics-analyze', source: 'lyrics', sourceHandle: 'out', target: 'analyze', targetHandle: 'lyrics', animated: true, style: { stroke: '#60a5fa' } },
  { id: 'e-analyze-story', source: 'analyze', target: 'storyboard', animated: true, style: { stroke: '#a78bfa' } },
  { id: 'e-story-kf', source: 'storyboard', target: 'keyframe', animated: true, style: { stroke: '#fb923c' } },
  { id: 'e-kf-gen', source: 'keyframe', target: 'generate', animated: true, style: { stroke: '#f472b6' } },
  { id: 'e-gen-export', source: 'generate', target: 'export', animated: true, style: { stroke: '#34d399' } },
];

// ---- 素材/参数本地持久化：刷新页面后不再丢失"已选好"的素材 ----
const LS_KEY = 'mvcanvas.state.v1';
type Persisted = { assets: Record<AssetKind, Asset | null>; params: Params };
const EMPTY_ASSETS: Record<AssetKind, Asset | null> = { image: null, audio: null, lyrics: null };

/** 4步Turbo 是专用 LoRA：勾上就必须 steps=4，避免「20步 + Turbo」导致过曝/发飘。
 *  取消勾选时恢复常规默认步长。所有入口（setParam、持久化加载、状态恢复）统一收口。 */
const TURBO_STEPS = 4;
function withTurboSteps(params: Params, prevTurbo?: boolean): Params {
  if (params.turbo) return params.steps === TURBO_STEPS ? params : { ...params, steps: TURBO_STEPS };
  if (prevTurbo) return { ...params, steps: DEFAULT_PARAMS.steps };
  return params;
}

function loadPersisted(): Persisted {
  const fallback: Persisted = { assets: { ...EMPTY_ASSETS }, params: { ...DEFAULT_PARAMS } };
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return fallback;
    const d = JSON.parse(raw);
    const clean = (k: AssetKind): Asset | null => {
      const a = d?.assets?.[k];
      return a && typeof a.path === 'string' && a.path ? {
        name: String(a.name || '素材'), path: a.path, url: String(a.url || ''),
      } : null;
    };
    return {
      assets: { image: clean('image'), audio: clean('audio'), lyrics: clean('lyrics') },
      params: withTurboSteps({ ...DEFAULT_PARAMS, ...(d?.params || {}) }),
    };
  } catch { return fallback; }
}

function savePersisted(s: Pick<CanvasState, 'assets' | 'params'>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ assets: s.assets, params: s.params })); }
  catch { /* 隐私模式/配额不足时忽略，功能降级为不持久化 */ }
}

const persisted = loadPersisted();

/** 「工作流」节点的选中项单独持久化，避免和 MV 参数纠缠 */
const WF_KEY = 'mvcanvas.workflow.v1';
function loadWorkflowId(): string {
  try { return String(JSON.parse(localStorage.getItem(WF_KEY) || '{}').workflowId || ''); }
  catch { return ''; }
}
function saveWorkflowId(workflowId: string) {
  try { localStorage.setItem(WF_KEY, JSON.stringify({ workflowId })); } catch { /* ignore */ }
}

/** 各工作流的节点参数覆盖：workflowId → nodeId → 输入名 → 值（可视化参数表单改出来的 patch） */
export type WfPatchMap = Record<string, Record<string, Record<string, unknown>>>;
const WFP_KEY = 'mvcanvas.wfpatch.v1';
function loadWfPatch(): WfPatchMap {
  try {
    const d = JSON.parse(localStorage.getItem(WFP_KEY) || '{}');
    if (!d || typeof d !== 'object' || Array.isArray(d)) return {};
    const out: WfPatchMap = {};
    for (const [wfId, nodes] of Object.entries(d)) {
      if (!nodes || typeof nodes !== 'object') continue;
      for (const [nid, inputs] of Object.entries(nodes as Record<string, unknown>)) {
        if (!inputs || typeof inputs !== 'object') continue;
        const clean = Object.fromEntries(
          Object.entries(inputs as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== null),
        );
        if (!Object.keys(clean).length) continue;
        (out[wfId] = out[wfId] || {})[nid] = clean;
      }
    }
    return out;
  } catch { return {}; }
}
function saveWfPatch(p: WfPatchMap) {
  try { localStorage.setItem(WFP_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

/** 供各节点统一生成"缺什么"的精确提示 */
export function missingAssets(assets: Record<AssetKind, Asset | null>, kinds: AssetKind[]): string {
  const label: Record<AssetKind, string> = { image: '人物参考图', audio: '歌曲 MP3', lyrics: '歌词（文件或粘贴后保存）' };
  const miss = kinds.filter((k) => !assets[k]).map((k) => label[k]);
  return miss.length ? `请先上传/保存：${miss.join('、')}` : '';
}

/** 画布本身（节点/连线）也持久化：刷新页面后不会被打回初始流程 */
const CANVAS_KEY = 'mvcanvas.canvas.v1';
function loadCanvas(): { nodes: any[]; edges: any[] } | null {
  try {
    const d = JSON.parse(localStorage.getItem(CANVAS_KEY) || 'null');
    if (d && Array.isArray(d.nodes) && d.nodes.length) {
      return { nodes: d.nodes, edges: Array.isArray(d.edges) ? d.edges : [] };
    }
  } catch { /* ignore */ }
  return null;
}
let canvasSaveTimer: number | undefined;
function saveCanvasSoon(nodes: any[], edges: any[]) {
  window.clearTimeout(canvasSaveTimer);
  canvasSaveTimer = window.setTimeout(() => {
    try { localStorage.setItem(CANVAS_KEY, JSON.stringify({ nodes, edges, at: Date.now() })); } catch { /* ignore */ }
  }, 300);
}
const savedCanvas = loadCanvas();

/** 单个「工作流」节点自己的配置：有它就不再读写全局 workflowId，多个工作流节点才能各跑各的分段 */export type WfNodeConfig = {
  workflowId: string;
  patch: Record<string, Record<string, unknown>>;
  prompt?: string;
  seed?: number;
  width?: number;
  height?: number;
  outputName?: string;
  useImage?: boolean;
  useAudio?: boolean;
  /** ⚡ Veda 稀疏注意力开关（默认关）；只影响本节点的运行请求 */
  veda?: boolean;
  /** 第二张参考图（可选）：接到 H3 的 ref_images.ref_image_1，用于服装/场景补充 */
  refImage2?: string;
  refImage2Name?: string;
};

/** 工作流节点最近一次成功输出，供「拼接成片」节点按连线顺序收片 */
export type WfResult = { url: string; name: string; runId: string; at: number };

/** 画布预设（服务端按真实素材路径生成） */
export type CanvasPreset = {
  id?: string;
  name: string;
  note?: string;
  nodes: any[];
  edges: any[];
  assets?: Partial<Record<AssetKind, Asset | null>>;
  params?: Partial<Params>;
  shots?: Shot[];
  missing?: string[];
};

/** 删除操作的撤销快照 */
export type DeletedSnapshot = { nodes: any[]; edges: any[]; at: number };

/**
 * 导演台（bot 工作流）镜头的全局镜像。
 * 导演台的真实数据仍以节点 data 为准，这里只做只读镜像，供底部时间轴显示。
 */
export type StageShot = {
  nodeId: string;
  n: number;
  label?: string;
  start: string;
  end: string;
  seconds: number;
  status: 'idle' | 'running' | 'paused' | 'done' | 'error';
  progress?: number;
  url?: string;
};

interface CanvasState {
  nodes: any[];
  edges: any[];
  assets: Record<AssetKind, Asset | null>;
  params: Params;
  analysis: Analysis | null;
  shots: Shot[];
  jobs: Record<string, JobState>;
  activeJobId: string | null;
  keyframeJobId: string | null;
  keyframes: Keyframe[];
  keyframeSize: { width: number; height: number } | null;
  /** 每镜视频的完整 URL（从生成任务的 result.shots 捕获，独立于 job 状态，合成覆盖后仍在） */
  shotVideos: string[];
  /** 时间轴缩略图显示模式：自动优先视频、否则首帧图 */
  timelineView: 'auto' | 'keyframe' | 'video';
  setTimelineView: (v: 'auto' | 'keyframe' | 'video') => void;
  /** 当前在时间轴上展示的导演台节点；分镜台（shots）为空时用它兜底 */
  stageNodeId: string | null;
  stageShots: StageShot[];
  /** 导演台拆分/进度/状态变化时同步镜像；空列表只允许「当前拥有者」清空 */
  setStageShots: (nodeId: string, list: StageShot[]) => void;
  /** 从 ComfyUI workflows 目录扫描出来的工作流选项 */
  workflows: WorkflowInfo[];
  workflowsLoading: boolean;
  workflowsError: string;
  /** 当前选中的工作流 id（「工作流」节点使用） */
  workflowId: string;
  /** 各工作流的节点参数覆盖（参数面板改出来的值，运行时作为 patch 提交） */
  wfPatch: WfPatchMap;
  loadWorkflows: (force?: boolean) => Promise<void>;
  setWorkflowId: (id: string) => void;
  /** 设置/清除某个节点参数；value 传 undefined 表示恢复默认 */
  setWfPatch: (workflowId: string, nodeId: string, input: string, value?: unknown) => void;
  /** 重置某工作流（或其中某个节点）的全部参数覆盖 */
  resetWfPatch: (workflowId: string, nodeId?: string) => void;
  /** 各工作流节点最近一次成功输出（nodeId → 结果），拼接节点按连线顺序取用 */
  wfResults: Record<string, WfResult>;
  setWfResult: (nodeId: string, r: WfResult | null) => void;
  /** 合并节点 data（不换节点对象以外的东西） */
  setNodeData: (nodeId: string, patch: Record<string, unknown>) => void;
  /** 更新某个工作流节点自己的配置（workflowId / patch / 提示词 / 种子…） */
  setNodeWf: (nodeId: string, patch: Partial<WfNodeConfig>) => void;
  /** 改/删该节点自己 patch 里的一个参数；value=undefined 表示恢复默认 */
  setNodeWfPatch: (nodeId: string, wfNodeId: string, input: string, value?: unknown) => void;
  /** 清空该节点的参数覆盖（可只清某个工作流节点） */
  resetNodeWfPatch: (nodeId: string, wfNodeId?: string) => void;
  /** 载入画布预设：替换节点/连线/素材/参数（新建画布） */
  applyPreset: (p: CanvasPreset) => void;
  selectedShot: number | null;
  setKeyframeJob: (id: string | null) => void;
  setKeyframes: (kfs: Keyframe[], size?: { width: number; height: number }) => void;
  onNodesChange: (changes: any) => void;
  onEdgesChange: (changes: any) => void;
  addNode: (kind: NodeKind) => void;
  /** 最近一次删除的节点/连线快照，用于撤销（点击或 Ctrl+Z） */
  lastDeleted: DeletedSnapshot | null;
  /** 删除节点，并连带删掉所有挂在它身上的连线；一次删除只留一个撤销快照 */
  removeNodes: (ids: string[], extraEdgeIds?: string[]) => void;
  /** 只删除连线（选中连线后按 Delete） */
  removeEdges: (ids: string[]) => void;
  /** 撤销最近一次删除（节点恢复原位，连线一并恢复） */
  undoDelete: () => void;
  /** 丢弃撤销快照（提示条消失时调用） */
  clearUndo: () => void;
  setAsset: (kind: AssetKind, asset: Asset | null) => void;
  hydrateAssets: (valid: Partial<Record<AssetKind, boolean>>) => void;
  setParam: <K extends keyof Params>(key: K, value: Params[K]) => void;
  /** 切换横竖/分辨率：同步更新宽高，并作废旧首帧图（尺寸不匹配不可用于 i2v）。返回是否作废了首帧图。 */
  setSize: (width: number, height: number) => boolean;
  /** 切换 H3 Image 出图尺寸模式；切到 custom 时以当前视频尺寸为起点 */
  setKeyframeSizeMode: (mode: 'follow' | 'custom') => void;
  /** 一次设置自定义 H3 Image 出图宽高（避免两次 setParam 的中间态） */
  setKeyframeSize: (width: number, height: number) => void;
  setAnalysis: (analysis: Analysis | null) => void;
  setShots: (shots: Shot[]) => void;
  updateShot: (index: number, patch: Partial<Shot>) => void;
  setSelectedShot: (index: number | null) => void;
  setJob: (id: string, job: JobState) => void;
  setActiveJob: (id: string | null) => void;
  restoreState: (d: { assets?: any; params?: any; analysis?: any; shots?: any }) => void;
  reset: () => void;
}

export const useCanvas = create<CanvasState>((set, get) => ({
  nodes: savedCanvas?.nodes || initialNodes,
  edges: savedCanvas?.edges || initialEdges,
  assets: persisted.assets,
  params: persisted.params,
  analysis: null,
  shots: [],
  jobs: {},
  activeJobId: null,
  keyframeJobId: null,
  keyframes: [],
  keyframeSize: null,
  shotVideos: [],
  timelineView: 'auto',
  setTimelineView: (timelineView) => set({ timelineView }),
  stageNodeId: null,
  stageShots: [],
  setStageShots: (nodeId, list) => {
    const cur = get().stageNodeId;
    // 多个导演台节点时，空列表不能把别人的镜头清掉
    if (!list.length && cur && cur !== nodeId) return;
    if (!list.length && !cur) return;
    set({ stageNodeId: nodeId, stageShots: list });
  },
  workflows: [],
  workflowsLoading: false,
  workflowsError: '',
  workflowId: loadWorkflowId(),
  loadWorkflows: async (force) => {
    if (get().workflowsLoading && !force) return;
    set({ workflowsLoading: true, workflowsError: '' });
    try {
      const data = await api.workflows(!!force);
      const list = data.workflows || [];
      const cur = get().workflowId;
      set({
        workflows: list,
        workflowsLoading: false,
        // 选中的工作流已被删除时，自动落到列表第一个
        workflowId: cur && list.some((w) => w.id === cur) ? cur : (list[0]?.id || ''),
      });
      if (!cur && list[0]) saveWorkflowId(list[0].id);
    } catch (e: any) {
      set({ workflowsLoading: false, workflowsError: e.message || '扫描工作流失败' });
    }
  },
  setWorkflowId: (workflowId) => {
    set({ workflowId });
    saveWorkflowId(workflowId);
  },
  wfPatch: loadWfPatch(),
  setWfPatch: (workflowId, nodeId, input, value) => {
    const all = { ...get().wfPatch };
    const forWf = { ...(all[workflowId] || {}) };
    const forNode = { ...(forWf[nodeId] || {}) };
    if (value === undefined) delete forNode[input];
    else forNode[input] = value;
    if (Object.keys(forNode).length) forWf[nodeId] = forNode;
    else delete forWf[nodeId];
    if (Object.keys(forWf).length) all[workflowId] = forWf;
    else delete all[workflowId];
    set({ wfPatch: all });
    saveWfPatch(all);
  },
  resetWfPatch: (workflowId, nodeId) => {
    const all = { ...get().wfPatch };
    if (!nodeId) delete all[workflowId];
    else {
      const forWf = { ...(all[workflowId] || {}) };
      delete forWf[nodeId];
      if (Object.keys(forWf).length) all[workflowId] = forWf;
      else delete all[workflowId];
    }
    set({ wfPatch: all });
    saveWfPatch(all);
  },
  wfResults: {},
  setWfResult: (nodeId, r) => {
    const next = { ...get().wfResults };
    if (r) next[nodeId] = r; else delete next[nodeId];
    set({ wfResults: next });
  },
  setNodeData: (nodeId, patch) => set({
    nodes: get().nodes.map((n: any) => (n.id === nodeId ? { ...n, data: { ...n.data, ...patch } } : n)),
  }),
  setNodeWf: (nodeId, patch) => {
    const node = get().nodes.find((n: any) => n.id === nodeId);
    if (!node) return;
    const wf = { ...(node.data?.wf || {}), ...patch };
    get().setNodeData(nodeId, { wf });
  },
  setNodeWfPatch: (nodeId, wfNodeId, input, value) => {
    const node = get().nodes.find((n: any) => n.id === nodeId);
    const cur: WfNodeConfig | undefined = node?.data?.wf;
    if (!cur) return;
    const patch = { ...(cur.patch || {}) };
    const forNode = { ...(patch[wfNodeId] || {}) };
    if (value === undefined) delete forNode[input];
    else forNode[input] = value;
    if (Object.keys(forNode).length) patch[wfNodeId] = forNode;
    else delete patch[wfNodeId];
    get().setNodeWf(nodeId, { patch });
  },
  resetNodeWfPatch: (nodeId, wfNodeId) => {
    const node = get().nodes.find((n: any) => n.id === nodeId);
    const cur: WfNodeConfig | undefined = node?.data?.wf;
    if (!cur) return;
    const patch = { ...(cur.patch || {}) };
    if (!wfNodeId) { get().setNodeWf(nodeId, { patch: {} }); return; }
    delete patch[wfNodeId];
    get().setNodeWf(nodeId, { patch });
  },
  applyPreset: (p) => {
    const assets: Record<AssetKind, Asset | null> = { ...EMPTY_ASSETS, ...(p.assets || {}) };
    const params = withTurboSteps({ ...DEFAULT_PARAMS, ...(p.params || {}) });
    set({
      nodes: p.nodes || initialNodes, edges: p.edges || [],
      assets, params, analysis: null, shots: p.shots || [],
      jobs: {}, activeJobId: null, keyframeJobId: null, keyframes: [], keyframeSize: null,
      shotVideos: [], timelineView: 'auto', selectedShot: null, wfResults: {}, lastDeleted: null,
      stageNodeId: null, stageShots: [],
    });
    savePersisted({ assets, params });
  },
  selectedShot: null,

  setKeyframeJob: (keyframeJobId) => set({ keyframeJobId }),
  setKeyframes: (keyframes, size) => set({
    keyframes,
    keyframeSize: size || (keyframes.length
      ? { width: get().params.width, height: get().params.height }
      : null),
  }),

  onNodesChange: (changes) => set({ nodes: applyNodeChanges(changes, get().nodes) }),
  onEdgesChange: (changes) => set({ edges: applyEdgeChanges(changes, get().edges) }),

  addNode: (kind) => {
    const labels: Record<NodeKind, string> = {
      image: '人物参考图', audio: '歌曲 MP3', lyrics: '歌词 LRC/TXT',
      analyze: '节拍与歌词分析', storyboard: '分镜台', keyframe: '分镜首帧图',
      generate: 'H3 镜头生成', export: '合成与导出', workflow: '其他工作流',
      stitch: '拼接成片', botstage: 'bot 导演台',
    };
    const n = get().nodes.length;
    set({
      nodes: [...get().nodes, makeNode(`${kind}-${Date.now()}`, kind, labels[kind], 120 + (n % 4) * 180, 620 + Math.floor(n / 4) * 120)],
    });
  },

  lastDeleted: null,
  removeNodes: (ids, extraEdgeIds) => {
    const idSet = new Set((ids || []).filter(Boolean));
    const edgeSet = new Set((extraEdgeIds || []).filter(Boolean));
    if (!idSet.size && !edgeSet.size) return;
    const nodes = get().nodes;
    const edges = get().edges;
    const goneNodes = nodes.filter((n: any) => idSet.has(n.id));
    // 连带删除挂在这些节点上的连线，避免留下悬空边
    const goneEdges = edges.filter((e: any) => edgeSet.has(e.id) || idSet.has(e.source) || idSet.has(e.target));
    if (!goneNodes.length && !goneEdges.length) return;
    const goneEdgeIds = new Set(goneEdges.map((e: any) => e.id));
    const stageGone = !!get().stageNodeId && idSet.has(get().stageNodeId!);
    set({
      nodes: nodes.filter((n: any) => !idSet.has(n.id)),
      edges: edges.filter((e: any) => !goneEdgeIds.has(e.id)),
      lastDeleted: { nodes: goneNodes, edges: goneEdges, at: Date.now() },
      // 删掉正在上时间轴的导演台时，时间轴同步清空，避免留着已不存在的镜头
      ...(stageGone ? { stageNodeId: null, stageShots: [] } : {}),
    });
  },
  removeEdges: (ids) => {
    get().removeNodes([], ids);
  },
  undoDelete: () => {
    const snap = get().lastDeleted;
    if (!snap) return;
    const nodeIds = new Set(get().nodes.map((n: any) => n.id));
    const edgeIds = new Set(get().edges.map((e: any) => e.id));
    set({
      nodes: [
        ...get().nodes,
        // 恢复时清掉选中态，避免刚回来就被 Delete 再删一次
        ...snap.nodes.filter((n: any) => !nodeIds.has(n.id)).map((n: any) => ({ ...n, selected: false })),
      ],
      edges: [...get().edges, ...snap.edges.filter((e: any) => !edgeIds.has(e.id))],
      lastDeleted: null,
    });
  },
  clearUndo: () => { if (get().lastDeleted) set({ lastDeleted: null }); },

  setAsset: (kind, asset) => {
    const assets = { ...get().assets, [kind]: asset };
    set({ assets });
    savePersisted({ assets, params: get().params });
  },

  // 页面启动时用服务端文件存在性校验持久化素材，失效的自动清除
  hydrateAssets: (valid) => {
    const cur = get().assets;
    const assets = { ...cur };
    let changed = false;
    (Object.keys(valid) as AssetKind[]).forEach((k) => {
      if (assets[k] && valid[k] === false) { assets[k] = null; changed = true; }
    });
    if (changed) {
      set({ assets });
      savePersisted({ assets, params: get().params });
    }
  },

  setParam: (key, value) => {
    const prev = get().params;
    const params = withTurboSteps({ ...prev, [key]: value }, key === 'turbo' ? prev.turbo : false);
    set({ params });
    savePersisted({ assets: get().assets, params });
  },

  setSize: (width, height) => {
    const cur = get().params;
    // 跟随模式下，自定义出图尺寸也随视频尺寸同步，保证打开 custom 时初值正确
    const params = { ...cur, width, height,
      ...(cur.keyframeSizeMode === 'follow' ? { keyframeWidth: width, keyframeHeight: height } : {}),
    };
    const invalidated = !!(cur.width !== width || cur.height !== height) && get().keyframes.length > 0;
    set({
      params,
      ...(invalidated ? { keyframes: [], keyframeSize: null } : {}),
    });
    savePersisted({ assets: get().assets, params });
    return invalidated;
  },

  setKeyframeSizeMode: (mode) => {
    const cur = get().params;
    const params = { ...cur, keyframeSizeMode: mode,
      ...(mode === 'custom' ? { keyframeWidth: cur.width, keyframeHeight: cur.height } : {}),
    };
    set({ params });
    savePersisted({ assets: get().assets, params });
  },

  setKeyframeSize: (keyframeWidth, keyframeHeight) => {
    const params = { ...get().params, keyframeWidth, keyframeHeight };
    set({ params });
    savePersisted({ assets: get().assets, params });
  },

  setAnalysis: (analysis) => set({ analysis, shots: analysis ? analysis.shots : [] }),
  setShots: (shots) => set({ shots }),
  updateShot: (index, patch) => set({
    shots: get().shots.map((s) => (s.index === index ? { ...s, ...patch } : s)),
  }),
  setSelectedShot: (selectedShot) => set({ selectedShot }),
  setJob: (id, job) => {
    const patch: Partial<CanvasState> = { jobs: { ...get().jobs, [id]: job } };
    // 生成任务完成时 result.shots 是相对路径（shots/shot_01.mp4），转成可播放 URL 独立保存。
    // 合成阶段会用同一 jobId 覆写 result 为成片，届时 shotVideos 仍能保留镜头视频。
    const rel = job.result?.shots;
    if (job.status === 'done' && rel && rel.length) {
      patch.shotVideos = rel.map((p) => `/media/jobs/${encodeURIComponent(id)}/${p.replace(/\\/g, '/')}`);
    }
    set(patch);
  },
  setActiveJob: (activeJobId) => set({ activeJobId }),

  restoreState: (d) => {
    const assets = { ...EMPTY_ASSETS };
    (['image', 'audio', 'lyrics'] as AssetKind[]).forEach((k) => {
      const a = d?.assets?.[k];
      if (a && typeof a.path === 'string' && a.path) assets[k] = a;
    });
    const params = withTurboSteps({ ...DEFAULT_PARAMS, ...(d?.params || {}) });
    set({ assets, params, analysis: d?.analysis || null, shots: d?.shots || [] });
    savePersisted({ assets, params });
  },

  reset: () => {
    try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(WFP_KEY); } catch { /* ignore */ }
    try { localStorage.removeItem(CANVAS_KEY); } catch { /* ignore */ }
    set({
      nodes: initialNodes, edges: initialEdges,
      assets: { ...EMPTY_ASSETS },
      params: { ...DEFAULT_PARAMS }, analysis: null, shots: [], jobs: {}, activeJobId: null,
      keyframeJobId: null, keyframes: [], keyframeSize: null,
      shotVideos: [], timelineView: 'auto', selectedShot: null, wfPatch: {}, wfResults: {}, lastDeleted: null,
      stageNodeId: null, stageShots: [],
    });
  },
}));

// 节点/连线一变就（防抖 300ms）写进 localStorage，刷新后画布保持原样
useCanvas.subscribe((s, prev) => {
  if (s.nodes !== prev.nodes || s.edges !== prev.edges) saveCanvasSoon(s.nodes, s.edges);
});
