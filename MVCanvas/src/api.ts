import type { AssetKind, JobState, SceneGroup, Shot, WorkflowInfo, WorkflowNodeInfo, WorkflowRun } from './types';

async function request<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  });
  const text = await res.text();
  let data: any;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}: ${text.slice(0, 300)}`);
  return data as T;
}

export const api = {
  health: () => request<any>('/api/health'),

  upload: async (kind: AssetKind, file: File) => {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
    return request<{ name: string; path: string; url: string }>('/api/upload', {
      method: 'POST',
      body: JSON.stringify({ kind, name: file.name, data }),
    });
  },

  saveText: (kind: 'lyrics', text: string) =>
    request<{ name: string; path: string; url: string }>('/api/save-text', {
      method: 'POST', body: JSON.stringify({ kind, text }),
    }),

  verifyAssets: (assets: Record<string, { path: string } | null>) =>
    request<Record<string, boolean>>('/api/assets/verify', {
      method: 'POST', body: JSON.stringify({ assets }),
    }),

  analyze: (payload: { image: string | null; audio: string | null; lyrics: string | null; duration: number; maxShots: number; shotSeconds: number; scene?: string; useLyrics?: boolean; seed?: number }) =>
    request<{ duration: number; songDuration?: number; sceneEn?: string; sceneGroups?: SceneGroup[]; onsets: number; lyrics: { t: number; text: string }[]; shots: Shot[] }>('/api/analyze', {
      method: 'POST', body: JSON.stringify(payload),
    }),

  keyframes: (payload: { jobId?: string; image: string; shots: any[]; params: Record<string, unknown> }) =>
    request<{ jobId: string }>('/api/keyframes', { method: 'POST', body: JSON.stringify(payload) }),

  keyframesResult: (jobId: string) =>
    request<{ keyframes: { index: number; file: string; url: string; inputName: string }[]; count: number; width?: number; height?: number }>(
      `/api/keyframes/${encodeURIComponent(jobId)}`),

  generate: (payload: {
    jobId?: string;
    image: string | null; audio: string | null; lyrics: string | null;
    shots: Shot[]; params: Record<string, unknown>; lyricsData: { t: number; text: string }[]; scene?: string; useLyrics?: boolean;
  }) => request<{ jobId: string }>('/api/generate', { method: 'POST', body: JSON.stringify(payload) }),

  compose: (payload: { jobId: string; audio: string; lyricsData: { t: number; text: string }[]; params: Record<string, unknown>; useLyrics?: boolean }) =>
    request<{ jobId: string }>('/api/compose', { method: 'POST', body: JSON.stringify(payload) }),

  job: (id: string) => request<JobState>(`/api/job/${encodeURIComponent(id)}`),
  jobs: () => request<{ jobs: JobState[] }>('/api/jobs'),
  outputs: () => request<{ files: { name: string; url: string; size: number }[] }>('/api/outputs'),

  // ---- 通用工作流（自动扫描 ComfyUI workflows 目录）----
  workflows: (refresh = false) =>
    request<{ dirs: string[]; workflows: WorkflowInfo[]; comfy: boolean }>(
      `/api/workflows${refresh ? '?refresh=1' : ''}`),

  runWorkflow: (payload: {
    workflowId: string; image?: string | null; audio?: string | null;
    prompt?: string; seed?: number; width?: number; height?: number;
    patch?: Record<string, Record<string, unknown>> | null; outputName?: string;
    /** ⚡ Veda 稀疏注意力：提交时在 MODEL 链上插一个节点，不改工作流文件 */
    veda?: boolean; vedaOptions?: { sparsity?: string; predictor?: string } | null;
  }) => request<{ runId: string }>('/api/workflows/run', { method: 'POST', body: JSON.stringify(payload) }),

  workflowRun: (id: string) => request<WorkflowRun>(`/api/workflows/run/${encodeURIComponent(id)}`),

  /** 某个工作流的全部可编辑节点参数（可视化表单数据源） */
  workflowNodes: (id: string) =>
    request<{ id: string; name: string; nodes: WorkflowNodeInfo[]; total: number }>(
      `/api/workflows/${encodeURIComponent(id)}/nodes`),

  uploads: () => request<{ files: { name: string; path: string; url: string; kind: string; mtime: number }[] }>('/api/uploads'),

  /** 探测媒体真实时长（导演台按 MP3 时长拆分镜时用） */
  probe: (path: string) => request<{
    file: string; name: string; duration: number; size: number;
    video: { codec: string; width: number; height: number; fps: string } | null;
    audio: { codec: string } | null;
  }>(`/api/probe?path=${encodeURIComponent(path)}`),

  /** 画布预设（服务端用真实素材路径组装节点/连线） */
  preset: (id: string) => request<any>(`/api/presets/${encodeURIComponent(id)}`),

  /** 拼接成片：多段镜头 concat + 铺原曲起点 + 可选片名/淡入淡出 */
  stitch: (payload: {
    clips: string[]; audio: string; start: string | number;
    fade?: number; title?: string; outputName?: string;
  }) => request<{
    name: string; output: string; url: string; width: number; height: number;
    duration: number; clips: string[]; start: number; elapsed: number;
  }>('/api/stitch', { method: 'POST', body: JSON.stringify(payload) }),
};

export const pollJob = async (id: string, onUpdate: (job: JobState) => void, stop: () => boolean = () => false) => {
  for (let i = 0; i < 2400; i++) {
    if (stop()) return;
    try {
      const job = await api.job(id);
      onUpdate(job);
      if (job.status === 'done' || job.status === 'error') return job;
    } catch {
      // transient
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return null;
};
