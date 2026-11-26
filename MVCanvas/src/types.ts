export type AssetKind = 'image' | 'audio' | 'lyrics';

export interface Asset {
  name: string;
  path: string;
  url: string;
}

export interface Shot {
  id: string;
  index: number;
  start: number;
  end: number;
  frames: number;
  section: string;
  lyric: string;
  /** 该镜所属主题场景（多行输入中的一行），一组连续镜头共用一个场景 */
  scene?: string;
  sceneEn?: string;
  sceneGroup?: number;
  /** 视频用变化句：机位/景别/光线/运镜/动作（英文片段）；同一分镜内不切镜头 */
  variation?: string;
  /** 首帧图用变化句：与视频同机位/光线，但去掉运镜、改成静态定格 */
  frameVariation?: string;
  /** 变化的中文短标签，供分镜台显示 */
  variationLabel?: string;
  /** 视频提示词：含运镜、音景、一镜到底约束 */
  prompt: string;
  /** 首帧图提示词：静态定格，无运镜/音景；缺省时后端会从 prompt 退化生成 */
  framePrompt?: string;
}

export interface SceneGroup {
  group: number;
  scene: string;
  sceneEn: string;
  shots: number[];
}

export interface Analysis {
  duration: number;
  /** 全部主题场景翻译后的英文，以 ' / ' 连接，已写入每镜提示词 */
  sceneEn?: string;
  /** 多行场景的分组概览：每组覆盖一段连续镜头 */
  sceneGroups?: SceneGroup[];
  onsets: number;
  lyrics: { t: number; text: string }[];
  shots: Shot[];
}

export interface Params {
  /** 参考图预览高度（px）：默认以 contain 方式完整显示图片 */
  imagePreviewSize: number;
  /** 分镜首帧图预览格宽（px）：网格按此宽度自动排布，图片完整显示 */
  keyframePreviewSize: number;
  duration: number;
  /** 主题场景：每行一个场景，可写环境/人物/镜头氛围；多场景时一组连续镜头共用一个场景 */
  scene: string;
  songOffset: number;
  width: number;
  height: number;
  /** H3 Image 出图尺寸模式：follow=跟随视频尺寸（默认）；custom=自定义宽高 */
  keyframeSizeMode: 'follow' | 'custom';
  /** 自定义 H3 Image 出图宽（px）：仅 keyframeSizeMode==='custom' 时生效，
   *  出图后自动缩放到 width×height 保存，保证 i2v 首帧一致 */
  keyframeWidth: number;
  /** 自定义 H3 Image 出图高（px） */
  keyframeHeight: number;
  fps: number;
  steps: number;
  seed: number;
  turbo: boolean;
  /** 歌词总开关：关闭后即使已上传歌词，也不解析、不写入分镜台词、不烧字幕 */
  useLyrics: boolean;
  burnSubs: boolean;
  shiftVideo: number;
  shiftAudio: number;
  sampler: string;
  scheduler: string;
  maxShots: number;
}

export interface Keyframe {
  index: number;
  file: string;
  url: string;
  inputName: string;
}

/** 工作流里可被画布绑定的一处输入（节点 id + 输入名） */
export interface WorkflowSlot {
  node: string;
  input: string;
}

/** 从 ComfyUI workflows 目录扫描出来的工作流选项 */
export interface WorkflowInfo {
  id: string;
  name: string;
  file: string;
  dir: string;
  mtime: number;
  size: number;
  nodes: number;
  readable: boolean;
  error?: string;
  missing: string[];
  slots: {
    image: WorkflowSlot[];
    audio: WorkflowSlot[];
    prompt: WorkflowSlot[];
    seed: WorkflowSlot[];
    width: WorkflowSlot[];
    height: WorkflowSlot[];
  };
}

/** 一个节点上可编辑的 widget 参数（可视化表单用） */
export interface WorkflowParam {
  name: string;
  type: 'INT' | 'FLOAT' | 'STRING' | 'BOOLEAN' | 'COMBO' | string;
  value: string | number | boolean;
  default?: string | number | boolean;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  multiline?: boolean;
}

/** 工作流里的一个节点及其可改参数 */
export interface WorkflowNodeInfo {
  id: string;
  type: string;
  title: string;
  group?: string;
  /** 被上方槽位控件（图/音/提示词/种子/宽高）接管、因而不出现在表单里的参数个数 */
  slotParams: number;
  params: WorkflowParam[];
}

/** 一次工作流运行的状态 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: 'running' | 'done' | 'error';
  stage: string;
  progress: number;
  logs: string[];
  error?: string;
  elapsed?: number;
  /** 提交时间戳（ms）：刷新后据此判断残留的 running 是否已失效 */
  createdAt?: number;
  result?: {
    files: { name: string; url: string }[];
    primary: { name: string; url: string };
  };
}

export interface JobState {
  id: string;
  status: 'pending' | 'running' | 'done' | 'error';
  stage: string;
  progress: number;
  logs: string[];
  result?: {
    output?: string;
    shots?: string[];
    storyboard?: string;
  };
  error?: string;
}

export const DEFAULT_PARAMS: Params = {
  imagePreviewSize: 180,
  keyframePreviewSize: 96,
  duration: 0, // 0 = 整首歌曲时长（后端以 ffprobe 实测为准）
  scene: '',
  songOffset: 0,
  width: 864,
  height: 480,
  keyframeSizeMode: 'follow',
  keyframeWidth: 864,
  keyframeHeight: 480,
  fps: 24,
  steps: 20,
  seed: 42,
  turbo: false,
  useLyrics: true,
  burnSubs: true,
  shiftVideo: 12,
  shiftAudio: 3,
  sampler: 'res_multistep',
  scheduler: 'simple',
  maxShots: 24,
};
