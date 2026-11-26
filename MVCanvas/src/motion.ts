/**
 * 🎥 运镜系统：景别 × 机位 × 运动，按风格与幅度组合。
 *
 * 旧版是 6 条整段文案按取模轮换，第 7 镜起必然重复同一套机位，长片一眼就看出来。
 * 现在拆成三个正交维度：景别（size）决定取景、机位（angle）决定视角、运动（move）决定镜头怎么动，
 * 组合数足够多；再按「风格」偏好取景、「幅度」限制运动强度，并用打乱序列保证相邻两镜不撞机位。
 * 与 UI 无关，可以单独跑测试（scripts/motion-check.mjs）。
 */

export type MotionStyle = 'mix' | 'story' | 'emotion' | 'stage';
export type Piece = {
  name: string;
  text: string;
  /** 运动幅度：0 稳 / 1 中 / 2 大（仅 MOTION_MOVE 使用） */
  lv?: 0 | 1 | 2;
  /** 适合的运镜风格；空表示全风格可用 */
  tags?: MotionStyle[];
  /** 适配的景别下标区间（0 大特写 … 7 大全景），用来挡掉「面部特写 + 贴地机位」这类怪组合 */
  sizeBand?: [number, number];
};

export const MOTION_STYLES: { id: MotionStyle; label: string; tip: string }[] = [
  { id: 'mix', label: '🎲 混搭', tip: '景别、机位、运动全维度混排，长片最不容易看出套路' },
  { id: 'story', label: '🎞 叙事', tip: '中近景为主，缓推缓移跟随人物，最稳、最少崩坏' },
  { id: 'emotion', label: '💧 情绪', tip: '特写与浅景深为主，微动配缓推，适合戏腔、抒情段落' },
  { id: 'stage', label: '🏛 舞台', tip: '全景与环绕、升降为主，交代环境与身段，适合副歌' },
];

export const MOTION_ENERGY: { v: 0 | 1 | 2; label: string; tip: string }[] = [
  { v: 0, label: '🪶 稳', tip: '几乎静止或极缓移动，H3 最不容易崩，特写镜头建议用这一档' },
  { v: 1, label: '🎥 中', tip: '缓推、横移、环绕、升降，电影常规运镜（推荐）' },
  { v: 2, label: '💥 大', tip: '手持、快推、半圈环绕，动感强但属于模型压力测试，容易崩坏' },
];

/** 景别：越靠前越近，tags 表示适合哪些风格 */
export const MOTION_SIZE: Piece[] = [
  { name: '大特写', text: '眼部与大半个面部占满画面的大特写', tags: ['emotion'] },
  { name: '面部特写', text: '面部特写，脸部占画面主要位置', tags: ['emotion'] },
  { name: '近景', text: '近景，头顶到锁骨入画', tags: ['emotion', 'story'] },
  { name: '半身中景', text: '半身中景，胸口以上入画', tags: ['story', 'emotion'] },
  { name: '中景', text: '中景，腰线以上入画，留出手臂动作', tags: ['story', 'stage'] },
  { name: '中全景', text: '中全景，膝盖以上入画', tags: ['story', 'stage'] },
  { name: '全景', text: '全景，人物全身入画并留出头顶空间', tags: ['stage'] },
  { name: '大全景', text: '大全景，人物在画面中占较小比例，环境成为主体', tags: ['stage'] },
];

/** 机位：视角与高度，本身不产生运动 */
export const MOTION_ANGLE: Piece[] = [
  { name: '正面平视', text: '正面平视机位，镜头与眼睛同高', tags: ['story', 'emotion'] },
  { name: '三四侧', text: '略微偏侧的三四侧机位', tags: ['story', 'emotion', 'stage'] },
  { name: '正侧', text: '正侧面机位，人物呈剪影感侧脸', tags: ['stage'], sizeBand: [2, 6] },
  { name: '过肩', text: '过肩机位，前景是虚化的肩线与发丝', sizeBand: [2, 5] },
  { name: '背后侧', text: '背后侧四十五度机位，人物回望镜头', tags: ['stage'], sizeBand: [3, 7] },
  { name: '低角度仰拍', text: '低角度仰拍机位，人物显得挺拔有力', tags: ['stage', 'emotion'], sizeBand: [1, 6] },
  { name: '高角度俯拍', text: '高角度俯拍机位，视线从上往下压', tags: ['stage'], sizeBand: [4, 7] },
  { name: '顶拍', text: '近乎正上方的顶拍机位，地面或裙摆形成图案', tags: ['stage'], sizeBand: [5, 7] },
  { name: '贴地低机位', text: '贴近地面的超低机位，前景是虚化的地面与衣摆', tags: ['stage'], sizeBand: [4, 7] },
];

/** 运动：镜头本身的动作，lv 决定需要多大幅度（0 稳 / 1 中 / 2 大） */
export const MOTION_MOVE: Piece[] = [
  { name: '静止微浮', text: '镜头几乎不动，只有极轻微的呼吸式浮动', lv: 0 },
  { name: '缓推', text: '镜头极缓慢地向前推近，取景逐渐收紧', lv: 0 },
  { name: '缓拉', text: '镜头缓慢向后拉远，逐渐带出更多环境', lv: 0 },
  { name: '缓横移', text: '镜头以很慢的速度水平横移', lv: 0 },
  { name: '缓左移', text: '镜头极缓慢向左平移，人物逐渐偏到画面右侧', lv: 0 },
  { name: '缓抬', text: '镜头保持不动，只极缓慢地抬高一点，露出更多背景', lv: 0 },
  { name: '焦点呼吸', text: '机位固定不动，只有焦点在人物与背景之间极轻微地呼吸', lv: 0 },
  { name: '极缓变焦', text: '镜头极缓慢地变焦拉远，环境比重逐渐增加', lv: 0 },
  { name: '缓下移', text: '镜头极缓慢向下移动一点，视线落回人物腰线', lv: 0 },
  { name: '缓摇', text: '镜头缓慢摇过一段环境后停在人物身上', lv: 1, tags: ['story', 'stage'] },
  { name: '弧线环绕', text: '镜头沿弧线缓缓绕人物移动，背景产生视差', lv: 1, tags: ['story', 'stage', 'emotion'] },
  { name: '升镜', text: '镜头从腰部高度缓慢升到与眼睛平齐', lv: 1, tags: ['stage', 'story'], sizeBand: [2, 7] },
  { name: '降镜', text: '镜头从高处缓慢下降到平视高度', lv: 1, tags: ['stage'], sizeBand: [2, 7] },
  { name: '跟随', text: '镜头跟随人物的重心起落轻微起伏，始终锁住面部', lv: 1, tags: ['story', 'emotion'] },
  { name: '变焦压缩', text: '镜头缓慢变焦推近，背景被压缩得更紧', lv: 1, tags: ['emotion', 'story'] },
  { name: '手持轻晃', text: '手持拍摄，画面带自然的轻微晃动与呼吸感', lv: 2, tags: ['emotion', 'stage'] },
  { name: '快推', text: '镜头快速推近到面部，情绪骤然收紧', lv: 2, tags: ['emotion'], sizeBand: [0, 4] },
  { name: '半圈环绕', text: '镜头围绕人物走半圈，光影从脸的一侧滑到另一侧', lv: 2, tags: ['stage', 'emotion'], sizeBand: [1, 7] },
  { name: '快速横移', text: '镜头横向快速跟拍，背景拉出运动模糊', lv: 2, tags: ['stage', 'emotion'], sizeBand: [3, 7] },
];

export type Motion = { label: string; text: string; size: string; angle: string; move: string };

/** 可复现的伪随机（LCG）：同一个基准种子拆出来的分镜，运镜每次都一样 */
export function motionRand(seed: number) {
  let s = Math.abs(Math.floor(seed)) % 2147483647;
  if (s <= 0) s += 2147483646;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

export function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 洗牌成一条长度 n 的序列，且相邻两项不重名（避免连续两镜同一机位） */
export function seqNoRepeat<T extends { name: string }>(pool: T[], n: number, rand: () => number): T[] {
  if (!pool.length) throw new Error('运镜池为空');
  const out: T[] = [];
  while (out.length < n) {
    const bag = shuffle(pool, rand);
    const last = out[out.length - 1]?.name;
    if (last && bag.length > 1 && bag[0].name === last) {
      const j = bag.findIndex((x) => x.name !== last);
      if (j > 0) [bag[0], bag[j]] = [bag[j], bag[0]];
    }
    out.push(...bag);
  }
  return out.slice(0, n);
}

export const motionAllowed = (p: Piece, style: MotionStyle, energy: number) => {
  if (p.lv !== undefined && p.lv > energy) return false;
  if (style !== 'mix' && p.tags && p.tags.length && !p.tags.includes(style)) return false;
  return true;
};

/** 按风格 + 幅度给 n 个镜头分配运镜；同一批内景别/机位/运动三项都尽量不重复 */
export function buildMotions(n: number, opt: { style: MotionStyle; energy: 0 | 1 | 2; seed: number }): Motion[] {
  // 三个维度用不同派生种子，否则同一次洗牌会让景别/机位/运动同步轮转，长片节奏会变呆板；
  // 再把风格掺进盐值，避免切换风格后每个节点的第一镜都抽到同一个机位
  const styleSalt = { mix: 0, story: 7717, emotion: 15413, stage: 23131 }[opt.style];
  const base = opt.seed + styleSalt;
  const randS = motionRand(base);
  const randA = motionRand(base + 9973);
  const randM = motionRand(base + 19937);
  // 景别是风格的核心，必须严格按风格走
  const sizes = seqNoRepeat(
    MOTION_SIZE.filter((p) => motionAllowed(p, opt.style, opt.energy)), n, randS,
  );
  // 机位与运动只在「风格过滤后还剩得够多」时收窄；否则宁可放宽到全池，
  // 也不要在 38 镜的长片里三四个机位来回撞（长片最容易被看出来的就是机位循环）
  const pool = (all: Piece[]) => {
    const strict = all.filter((p) => motionAllowed(p, opt.style, opt.energy));
    const byEnergy = all.filter((p) => p.lv === undefined || p.lv <= opt.energy);
    return strict.length >= 5 ? strict : (byEnergy.length >= 3 ? byEnergy : all);
  };
  // 机位与运动要跟着景别走：逐镜在「适配当前景别」的子集里抽，并避开上一镜用过的，
  // 这样「面部特写 + 贴地超低机位」这种明显不搭的组合不会出现
  const pickFor = (all: Piece[], sizeIdx: number, rand: () => number, prev: string) => {
    const base = pool(all);
    const fit = base.filter((p) => !p.sizeBand || (sizeIdx >= p.sizeBand[0] && sizeIdx <= p.sizeBand[1]));
    const cand = (fit.length ? fit : base).filter((p) => p.name !== prev);
    const use = cand.length ? cand : base;
    return use[Math.floor(rand() * use.length) % use.length];
  };
  let prevAngle = '';
  let prevMove = '';
  const angles: Piece[] = [];
  const moves: Piece[] = [];
  for (let i = 0; i < n; i++) {
    const sizeIdx = Math.max(0, MOTION_SIZE.indexOf(sizes[i]));
    const a = pickFor(MOTION_ANGLE, sizeIdx, randA, prevAngle);
    const m = pickFor(MOTION_MOVE, sizeIdx, randM, prevMove);
    angles.push(a);
    moves.push(m);
    prevAngle = a.name;
    prevMove = m.name;
  }
  return Array.from({ length: n }, (_, i) => {
    const s = sizes[i];
    const a = angles[i];
    const m = moves[i];
    return {
      label: `${s.name} · ${m.name}`,
      text: `${s.text}，${a.text}，${m.text}`,
      size: s.text,
      angle: a.text,
      move: m.text,
    };
  });
}

/** 模板占位符：{motion} 整体 / {size} 景别 / {angle} 机位 / {move} 运动 */
export function fillTemplate(tpl: string, m: Motion, scene = ''): string {
  let t = tpl;
  // 大幅度运动时，模板里写死的「稳定运镜」会和手持/快推打架，直接去掉
  if (m.move.includes('手持') || m.move.includes('快速') || m.move.includes('快推')) {
    t = t.replace(/[，,]?\s*稳定运镜/g, '');
  }
  // 场景：新模板有 {scene} 占位符就替换掉；已保存的旧模板没有占位符，就插到 {motion} 前，兼容旧画布
  t = scene
    ? (t.includes('{scene}') ? t.replace(/\{scene\}/g, scene)
      : t.includes('{motion}') ? t.replace(/\{motion\}/g, `${scene}，{motion}`)
      : `${scene}，${t}`)
    : t.replace(/\{scene\}[，,]?\s*/g, '');
  if (!/\{(motion|size|angle|move)\}/.test(t)) return `${t}，${m.text}`;
  return t
    .replace(/\{motion\}/g, m.text)
    .replace(/\{size\}/g, m.size)
    .replace(/\{angle\}/g, m.angle)
    .replace(/\{move\}/g, m.move);
}

export const DEFAULT_BOT_PROMPT =
  '图1中的人物（严格保持参考图的脸型、眉形、眼睛、鼻梁与唇形不变），'
  + '{scene}，{motion}，口型与音频严格同步，电影级柔光，浅景深，镜内一个连续长镜头不切换，无字幕无水印';

/** 组合总数，用于界面提示 */
export const MOTION_COMBOS = MOTION_SIZE.length * MOTION_ANGLE.length * MOTION_MOVE.length;
