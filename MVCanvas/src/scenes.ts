/** MV 主题场景预设。
 *  desc 用中文逗号分隔的词组：
 *   - 分镜台交给后端 auto_mv.py 的 SCENE_EN 词典逐行翻译成英文写进每镜提示词；
 *   - 导演台直接把中文拼进提示词模板。
 *  因此这里选用的词都落在后端词典里，避免翻译时被丢弃。
 *  每个预设一行 = 一个场景；分镜台里用户可自行加行做多场景轮换。 */
export type ScenePreset = { id: string; name: string; desc: string };

export const SCENE_PRESETS: ScenePreset[] = [
  { id: 'modern-stage', name: '现代舞台', desc: '现代舞台，聚光灯，乐队背景' },
  { id: 'big-concert', name: '大型演唱会', desc: '演唱会，体育馆，观众，烟火' },
  { id: 'live-band', name: '乐队现场', desc: '舞台，乐队背景，霓虹，夜晚' },
  { id: 'landscape', name: '山水景色', desc: '山，湖，雾，水墨' },
  { id: 'rainy-overpass', name: '雨夜天桥', desc: '雨夜天桥，霓虹，孤独' },
  { id: 'seaside-sunset', name: '海边日落', desc: '海边日落，温暖' },
  { id: 'ancient-corridor', name: '古风夜廊', desc: '古风街道，月光，夜晚' },
  { id: 'cyber-city', name: '赛博都市', desc: '赛博朋克，霓虹街道，夜晚' },
  { id: 'campus-rooftop', name: '校园天台', desc: '校园天台，黄昏' },
  { id: 'desert-highway', name: '沙漠公路', desc: '沙漠，公路，日落' },
  { id: 'snow-mountain', name: '雪山孤影', desc: '雪山，冬天，孤独' },
  { id: 'forest', name: '森林秘境', desc: '森林，清晨，雾，魔法' },
  { id: 'flower-field', name: '花海晴日', desc: '花海，春天，晴天，浪漫' },
  { id: 'music-festival', name: '音乐节', desc: '音乐节，人群，烟火，夜晚' },
  { id: 'cafe', name: '咖啡馆', desc: '咖啡馆，雨天，温暖，安静' },
  { id: 'subway', name: '地铁站', desc: '地铁站，夜晚，人群' },
  { id: 'ancient-town', name: '古镇雨巷', desc: '古镇，雨天，水墨' },
  { id: 'starry-grassland', name: '星空旷野', desc: '星空，草原，夜晚' },
];

/** 随机抽一个场景描述（直接可填进 textarea / params.scene） */
export function pickRandomScene(): string {
  return SCENE_PRESETS[Math.floor(Math.random() * SCENE_PRESETS.length)].desc;
}

/** 按 id 取预设（画布里存的是 desc 文本，id 只用于 UI 高亮匹配） */
export function sceneById(id: string): ScenePreset | undefined {
  return SCENE_PRESETS.find((p) => p.id === id);
}

/** 当前文本命中哪个预设（用于 chip 高亮）；自定义文本返回 undefined */
export function matchScenePreset(desc: string): ScenePreset | undefined {
  const key = (desc || '').trim();
  return SCENE_PRESETS.find((p) => p.desc === key);
}
