// presets.cjs — 画布预设（一键载入一套已经跑通的流程）
// 目前提供 bot-mv：用 Minimax+H3+bot 工作流把一首歌切成 4 个 8 秒镜头，逐镜数字人口播，再拼接成片。
const fs = require('node:fs');
const path = require('node:path');

/** 与 workspace/mv_bot_1125/make_mv.mjs 保持一致：1:28–2:00 四个 8 秒镜头 */
const SHOTS = [
  {
    n: 1, label: '镜1 · 中景推近', start: '1:28', end: '1:36', seed: 2026112501, prefix: 'mvbot/S1',
    prompt: '图1中身穿月白刺绣立领长衫的古风女子，半身中景正面朝向镜头开口吟唱，口型与音频严格同步，眼神平静而专注，镜头从半身缓慢推近到胸口以上，背景灯笼暖光轻微虚化，电影级柔光，浅景深，稳定运镜，无字幕无水印',
  },
  {
    n: 2, label: '镜2 · 近景特写', start: '1:36', end: '1:44', seed: 2026112502, prefix: 'mvbot/S2',
    prompt: '图1中月白长衫古风女子的近景特写，脸部占画面主要位置，轻声吟唱，口型与音频严格同步，睫毛轻颤、呼吸感明显，侧逆光从右后方勾出碎发轮廓，背景深青色完全虚化，镜头极缓慢向右平移，电影级浅景深，无字幕无水印',
  },
  {
    n: 3, label: '镜3 · 仰拍爆发', start: '1:44', end: '1:52', seed: 2026112503, prefix: 'mvbot/S3',
    prompt: '图1中月白长衫古风女子，低角度仰拍，戏腔高音爆发，口型与音频严格同步，眉头微蹙情绪强烈，夜风吹起衣袂与碎发，暖黄顶光与冷青环境光形成强对比，镜头轻微手持晃动，电影级质感，无字幕无水印',
  },
  {
    n: 4, label: '镜4 · 拉远全景', start: '1:52', end: '2:00', seed: 2026112504, prefix: 'mvbot/S4',
    prompt: '图1中月白长衫古风女子站在古建长廊下，镜头从近景缓缓拉远成全景，她面向镜头持续吟唱，口型与音频严格同步，身后灯笼成排向远处延伸，花瓣在空气中飘落，冷暖光交织，电影级大景深，无字幕无水印',
  },
];

function firstFile(dir, test) {
  try {
    return fs.readdirSync(dir).filter(test).map((f) => path.join(dir, f))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] || '';
  } catch { return ''; }
}

const assetUrl = (file, sub) => `/media/${sub}/${encodeURIComponent(path.basename(file))}`;

/** 生成 bot MV 画布（真实素材路径由服务端填，前端直接 applyPreset） */
function botMvCanvas({ workspace, workflowId = 'Minimax+H3+bot' }) {
  const assetsDir = path.join(workspace, 'assets');
  const projDir = path.join(workspace, 'mv_bot_1125');

  const image = path.join(projDir, 'character.png');
  const imageOk = fs.existsSync(image) ? image : firstFile(assetsDir, (f) => f.startsWith('image_') && /\.(png|jpe?g|webp)$/i.test(f));
  const audio = firstFile(assetsDir, (f) => f.startsWith('audio_') && /声声慢/.test(f)) || firstFile(assetsDir, (f) => f.startsWith('audio_') && /\.mp3$/i.test(f));

  const node = (id, kind, label, x, y, data = {}) => ({ id, type: kind, position: { x, y }, data: { kind, label, ...data } });

  const nodes = [
    node('bot-image', 'image', '① 角色参考图', 0, 80),
    node('bot-audio', 'audio', '② 歌曲 MP3', 0, 540),
    // 2×2 排布：四段镜头并排，拼接节点在右侧收口，视口里能一眼看全
    ...SHOTS.map((s, i) => node(`bot-shot-${s.n}`, 'workflow', s.label, 430 + (i % 2) * 430, Math.floor(i / 2) * 720, {
      wf: {
        workflowId,
        patch: {
          115: { aspect_ratio: '9:16 (Portrait Widescreen)', megapixels: 0.6, multiple: 32 },
          177: { start_time: s.start, end_time: s.end },
          129: { noise_seed: s.seed },
          142: { filename_prefix: s.prefix, frame_rate: 24 },
        },
        prompt: s.prompt,
        seed: s.seed,
        width: 608,
        height: 1056,
        useImage: true,
        useAudio: true,
        outputName: `MVbot_S${s.n}`,
      },
    })),
    node('bot-stitch', 'stitch', '⑩ 拼接成片', 1280, 340, {
      start: '1:28',
      title: '声声慢 · 戏腔版',
      fade: 0.6,
      outputName: 'botMV_拼接',
    }),
  ];

  const edges = [];
  for (const s of SHOTS) {
    edges.push({ id: `e-bot-img-${s.n}`, source: 'bot-image', sourceHandle: 'out', target: `bot-shot-${s.n}`, targetHandle: 'in', animated: true, style: { stroke: '#60a5fa' } });
    edges.push({ id: `e-bot-aud-${s.n}`, source: 'bot-audio', sourceHandle: 'out', target: `bot-shot-${s.n}`, targetHandle: 'in', animated: true, style: { stroke: '#60a5fa' } });
    edges.push({ id: `e-bot-out-${s.n}`, source: `bot-shot-${s.n}`, sourceHandle: 'out', target: 'bot-stitch', targetHandle: 'in', animated: true, style: { stroke: '#f472b6' } });
  }

  const shots = SHOTS.map((s, i) => ({
    id: `shot-${s.n}`, index: s.n, start: i * 8, end: (i + 1) * 8, frames: 192,
    section: 'chorus', lyric: s.label.replace(/^镜\d · /, ''), prompt: s.prompt,
  }));

  const missing = [];
  if (!imageOk) missing.push('角色参考图（workspace/mv_bot_1125/character.png）');
  if (!audio) missing.push('歌曲 MP3（workspace/assets）');

  return {
    id: 'bot-mv',
    name: 'bot MV · 4×8 秒数字人',
    note: '素材 → 4 个 bot 镜头（各 8 秒，AudioCrop 分段的独立参数）→ 拼接成片。逐镜运行后，拼接节点会自动接住 4 段输出。',
    workflowId,
    nodes,
    edges,
    shots,
    assets: {
      image: imageOk ? { name: path.basename(imageOk), path: imageOk, url: assetUrl(imageOk, imageOk.startsWith(projDir) ? 'mv_bot_1125' : 'assets') } : null,
      audio: audio ? { name: path.basename(audio), path: audio, url: assetUrl(audio, 'assets') } : null,
      lyrics: null,
    },
    params: {
      width: 608, height: 1056, fps: 24, turbo: true, steps: 4,
      seed: 2026112501, useLyrics: false, burnSubs: false, duration: 32,
      scene: '古风夜晚长廊，灯笼暖光，月白刺绣长衫女歌手，戏腔吟唱',
    },
    missing,
  };
}

/** bot 导演台画布：一个节点按 MP3 真实时长拆分镜、逐镜跑 bot、自动合成一条长视频
 *  （镜数/每镜秒数都在节点里改，这里只给一套能直接开跑的默认值） */
function botMvAuto({ workspace, workflowId = 'Minimax+H3+bot' }) {
  const assetsDir = path.join(workspace, 'assets');
  const projDir = path.join(workspace, 'mv_bot_1125');

  const image = path.join(projDir, 'character.png');
  const imageOk = fs.existsSync(image) ? image : firstFile(assetsDir, (f) => f.startsWith('image_') && /\.(png|jpe?g|webp)$/i.test(f));
  const audio = firstFile(assetsDir, (f) => f.startsWith('audio_') && /声声慢/.test(f)) || firstFile(assetsDir, (f) => f.startsWith('audio_') && /\.mp3$/i.test(f));

  const node = (id, kind, label, x, y, data = {}) => ({ id, type: kind, position: { x, y }, data: { kind, label, ...data } });

  const nodes = [
    node('bot-auto-image', 'image', '① 角色参考图', 0, 80),
    node('bot-auto-audio', 'audio', '② 歌曲 MP3', 0, 560),
    node('bot-auto-stage', 'botstage', '🎬 bot 导演台', 430, 140, {
      workflowId,
      audioStart: '0:00',
      shotSeconds: 8,
      shotCount: '',
      megapixels: 0.6,
      steps: 4,
      aspect: '9:16 (Portrait Widescreen)',
      baseSeed: 2026112601,
      autoStitch: true,
      title: '声声慢 · 戏腔版',
      fade: 0.6,
      outputName: 'botMV_长视频',
      shots: [],
    }),
    node('bot-auto-stitch', 'stitch', '⑩ 拼接成片（可选）', 960, 140, {
      start: '0:00', title: '声声慢 · 戏腔版', fade: 0.6, outputName: 'botMV_长视频_拼接',
    }),
  ];

  const edges = [
    { id: 'e-auto-img', source: 'bot-auto-image', sourceHandle: 'out', target: 'bot-auto-stage', targetHandle: 'in', animated: true, style: { stroke: '#60a5fa' } },
    { id: 'e-auto-aud', source: 'bot-auto-audio', sourceHandle: 'out', target: 'bot-auto-stage', targetHandle: 'in', animated: true, style: { stroke: '#60a5fa' } },
    { id: 'e-auto-out', source: 'bot-auto-stage', sourceHandle: 'out', target: 'bot-auto-stitch', targetHandle: 'in', animated: true, style: { stroke: '#a78bfa' } },
  ];

  const missing = [];
  if (!imageOk) missing.push('角色参考图（workspace/mv_bot_1125/character.png）');
  if (!audio) missing.push('歌曲 MP3（workspace/assets）');

  return {
    id: 'bot-mv-auto',
    name: 'bot 导演台 · 按 MP3 时长拆分镜',
    note: '② 歌曲 MP3 的真实时长决定镜数与截取区间：点「按 MP3 拆分镜」自动生成 N 个 8 秒分镜，逐镜跑 Minimax+H3+bot，跑完自动拼成一条长视频。整首 144 秒约 18 镜、1 小时 GPU。',
    workflowId,
    nodes,
    edges,
    shots: [],
    assets: {
      image: imageOk ? { name: path.basename(imageOk), path: imageOk, url: assetUrl(imageOk, imageOk.startsWith(projDir) ? 'mv_bot_1125' : 'assets') } : null,
      audio: audio ? { name: path.basename(audio), path: audio, url: assetUrl(audio, 'assets') } : null,
      lyrics: null,
    },
    params: {
      width: 608, height: 1056, fps: 24, turbo: true, steps: 4,
      seed: 2026112601, useLyrics: false, burnSubs: false, duration: 0,
      scene: '古风夜晚长廊，灯笼暖光，月白刺绣长衫女歌手，戏腔吟唱',
    },
    missing,
  };
}

/** 默认分镜台流程画布：①参考图 ②MP3 ③歌词 → ④节拍分析 → ⑤分镜台 → ⑥首帧图 → ⑦H3 逐镜 → ⑧合成
 *  与默认初始画布同构，区别是素材已经绑好、参数按工作区常见值收口，载入即可点「分析」开跑 */
function storyboardFlow({ workspace }) {
  const assetsDir = path.join(workspace, 'assets');
  const projDir = path.join(workspace, 'mv_bot_1125');

  const image = path.join(projDir, 'character.png');
  const imageOk = fs.existsSync(image) ? image : firstFile(assetsDir, (f) => f.startsWith('image_') && /\.(png|jpe?g|webp)$/i.test(f));
  const audio = firstFile(assetsDir, (f) => f.startsWith('audio_') && /声声慢/.test(f)) || firstFile(assetsDir, (f) => f.startsWith('audio_') && /\.mp3$/i.test(f));
  const lyrics = firstFile(assetsDir, (f) => f.startsWith('lyrics') && /\.(lrc|txt)$/i.test(f))
    || firstFile(assetsDir, (f) => /\.(lrc|txt)$/i.test(f));

  const node = (id, kind, label, x, y, data = {}) => ({ id, type: kind, position: { x, y }, data: { kind, label, ...data } });

  const nodes = [
    node('sb-image', 'image', '① 人物参考图', 0, 40),
    node('sb-audio', 'audio', '② 歌曲 MP3', 0, 260),
    node('sb-lyrics', 'lyrics', '③ 歌词 LRC/TXT（可选）', 0, 450),
    node('sb-analyze', 'analyze', '④ 节拍与歌词分析', 330, 200),
    node('sb-storyboard', 'storyboard', '⑤ 分镜台（可编辑）', 660, 40),
    node('sb-keyframe', 'keyframe', '⑥ 分镜首帧图', 1000, 40),
    node('sb-generate', 'generate', '⑦ H3 镜头生成', 1340, 40),
    node('sb-export', 'export', '⑧ 合成与导出', 1680, 220),
    node('sb-workflow', 'workflow', '🧩 其他工作流', 1340, 660),
  ];

  const edges = [
    { id: 'e-sb-img-analyze', source: 'sb-image', sourceHandle: 'out', target: 'sb-analyze', targetHandle: 'image', animated: true, style: { stroke: '#60a5fa' } },
    { id: 'e-sb-aud-analyze', source: 'sb-audio', sourceHandle: 'out', target: 'sb-analyze', targetHandle: 'audio', animated: true, style: { stroke: '#60a5fa' } },
    { id: 'e-sb-lyr-analyze', source: 'sb-lyrics', sourceHandle: 'out', target: 'sb-analyze', targetHandle: 'lyrics', animated: true, style: { stroke: '#60a5fa' } },
    { id: 'e-sb-analyze-story', source: 'sb-analyze', target: 'sb-storyboard', animated: true, style: { stroke: '#a78bfa' } },
    { id: 'e-sb-story-kf', source: 'sb-storyboard', target: 'sb-keyframe', animated: true, style: { stroke: '#fb923c' } },
    { id: 'e-sb-kf-gen', source: 'sb-keyframe', target: 'sb-generate', animated: true, style: { stroke: '#f472b6' } },
    { id: 'e-sb-gen-export', source: 'sb-generate', target: 'sb-export', animated: true, style: { stroke: '#34d399' } },
  ];

  const missing = [];
  if (!imageOk) missing.push('人物参考图（workspace/assets）');
  if (!audio) missing.push('歌曲 MP3（workspace/assets）');

  return {
    id: 'storyboard',
    name: '分镜台流程 · 分析→首帧→逐镜→合成',
    note: '默认那条完整链路：① 参考图 + ② MP3（③ 歌词可选）→ ④ 节拍分析切分镜 → ⑤ 分镜台逐镜改提示词 → ⑥ 首帧图 → ⑦ H3 逐镜生成 → ⑧ 合成。也可以直接点右上「⚡ 一键生成 MV」跑完整条。',
    nodes,
    edges,
    shots: [],
    assets: {
      image: imageOk ? { name: path.basename(imageOk), path: imageOk, url: assetUrl(imageOk, imageOk.startsWith(projDir) ? 'mv_bot_1125' : 'assets') } : null,
      audio: audio ? { name: path.basename(audio), path: audio, url: assetUrl(audio, 'assets') } : null,
      lyrics: lyrics ? { name: path.basename(lyrics), path: lyrics, url: assetUrl(lyrics, 'assets') } : null,
    },
    params: {
      width: 864, height: 480, fps: 24, steps: 20, turbo: false,
      seed: 42, duration: 0, maxShots: 24,
      useLyrics: !!lyrics, burnSubs: !!lyrics,
      scene: '',
    },
    missing,
  };
}

module.exports = { botMvCanvas, botMvAuto, storyboardFlow, SHOTS };
