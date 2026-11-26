// stitch.cjs — 把多段镜头拼成一条成片（纯 ffmpeg，无 bridge 依赖）
// 用途：「拼接成片」节点。把若干段等尺寸/等帧率镜头按顺序 concat，
// 再铺上原曲的指定起点，可选片名与淡入淡出。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const FFMPEG = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_BIN || 'ffprobe';

const FONT_CANDIDATES = [
  process.env.MV_FONT_PATH,
  'C:/Windows/Fonts/msyhbd.ttc',
  'C:/Windows/Fonts/msyh.ttc',
  'C:/Windows/Fonts/simhei.ttf',
].filter(Boolean);

const safeName = (name) => String(name).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_').slice(-120);

function probe(file) {
  const out = execFileSync(FFPROBE, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-show_entries', 'format=duration',
    '-of', 'json', file,
  ], { encoding: 'utf8', timeout: 60000 });
  const j = JSON.parse(out);
  const s = (j.streams || [])[0] || {};
  return {
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    duration: Number(j.format && j.format.duration) || 0,
  };
}

/** 支持 "88" / "1:28" / "01:28.5" 三种写法（AudioCrop 只吃整秒，这里更宽松） */
function parseTime(t) {
  if (typeof t === 'number' && Number.isFinite(t)) return Math.max(0, t);
  const s = String(t || '').trim();
  if (!s) return 0;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return Math.max(0, parts.reduce((a, n) => a * 60 + n, 0));
}

function resolveFile(p, workspace, outputsDir) {
  if (!p) throw new Error('片段路径为空');
  if (/^https?:\/\//i.test(p)) throw new Error('只支持本地文件，不支持远程地址');
  let f;
  if (String(p).startsWith('/media/')) f = path.join(workspace, decodeURIComponent(String(p).slice('/media/'.length)));
  else if (path.isAbsolute(p)) f = p;
  else f = path.join(outputsDir, String(p));
  f = path.resolve(f);
  if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error(`片段不存在：${p}`);
  return f;
}

const escText = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/'/g, "\\'")
  .replace(/:/g, '\\:')
  .replace(/%/g, '\\%');

const escFont = (p) => String(p).replace(/\\/g, '/').replace(/:/g, '\\:');

function pickFont() {
  return FONT_CANDIDATES.find((f) => { try { return fs.existsSync(f); } catch { return false; } }) || '';
}

/**
 * @param {object} o
 * @param {string[]} o.clips 片段（绝对路径 / /media URL / outputs 下的文件名），按顺序拼接
 * @param {string} o.audio 原曲路径
 * @param {string|number} o.start 原曲起点（"1:28" / 88）
 * @param {number} [o.fade] 淡入淡出秒数
 * @param {string} [o.title] 片名（空则不烧字）
 * @param {string} [o.outputName] 输出文件名前缀
 */
function stitch({ clips, audio, start = 0, fade = 0.6, title = '', outputName = 'stitch', workspace, outputsDir }) {
  const t0 = Date.now();
  if (!Array.isArray(clips) || !clips.length) throw new Error('至少需要 1 段镜头');
  const files = clips.map((c) => resolveFile(c, workspace, outputsDir));
  if (!audio) throw new Error('缺少原曲（用于铺音轨）');
  const audioFile = resolveFile(audio, workspace, outputsDir);

  const metas = files.map((f) => ({ file: f, ...probe(f) }));
  for (const m of metas) {
    if (!m.width || !m.height) throw new Error(`读不到画面尺寸：${path.basename(m.file)}`);
    if (!m.duration) throw new Error(`读不到时长：${path.basename(m.file)}`);
  }
  const W = metas[0].width;
  const H = metas[0].height;
  const total = +metas.reduce((a, m) => a + m.duration, 0).toFixed(3);
  const fps = 24;
  const fadeSec = Math.min(Math.max(Number(fade) || 0, 0), Math.min(2, total / 4));

  const parts = [];
  metas.forEach((m, i) => {
    parts.push(
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
      `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
    );
  });
  parts.push(`${metas.map((_, i) => `[v${i}]`).join('')}concat=n=${metas.length}:v=1:a=0[vc]`);

  const post = [];
  const font = title ? pickFont() : '';
  if (title && font) {
    post.push(
      `drawtext=fontfile='${escFont(font)}':text='${escText(title)}':fontcolor=white@0.94` +
      `:fontsize=${Math.round(W * 0.052)}:x=(w-text_w)/2:y=${Math.round(H * 0.075)}` +
      `:alpha='if(lt(t,0.4),t/0.4,if(lt(t,3.4),1,max(0,(4-t)/0.6)))'`,
    );
  }
  if (fadeSec > 0) {
    post.push(`fade=t=in:st=0:d=${fadeSec.toFixed(2)}`);
    post.push(`fade=t=out:st=${Math.max(0, total - fadeSec).toFixed(2)}:d=${fadeSec.toFixed(2)}`);
  }
  if (post.length) parts.push(`[vc]${post.join(',')}[vout]`);
  const vmap = post.length ? '[vout]' : '[vc]';

  const af = [`apad`, `atrim=0:${total}`, `asetpts=N/SR/TB`];
  if (fadeSec > 0) {
    af.push(`afade=t=in:st=0:d=${fadeSec.toFixed(2)}`);
    af.push(`afade=t=out:st=${Math.max(0, total - fadeSec).toFixed(2)}:d=${fadeSec.toFixed(2)}`);
  }
  parts.push(`[${metas.length}:a]${af.join(',')}[aout]`);

  const fileName = `${safeName(outputName || 'stitch')}_${Date.now().toString(36).slice(-5)}.mp4`;
  const outFile = path.join(outputsDir, fileName);

  const args = ['-y', '-hide_banner', '-loglevel', 'error'];
  for (const f of files) args.push('-i', f);
  args.push('-ss', String(parseTime(start)), '-t', String(total), '-i', audioFile);
  args.push(
    '-filter_complex', parts.join(';'),
    '-map', vmap, '-map', '[aout]',
    '-c:v', 'libx264', '-crf', '18', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart',
    outFile,
  );
  execFileSync(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 15 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });

  return {
    name: fileName,
    output: outFile,
    url: `/media/outputs/${encodeURIComponent(fileName)}`,
    width: W,
    height: H,
    duration: total,
    clips: files.map((f) => path.basename(f)),
    start: parseTime(start),
    elapsed: +((Date.now() - t0) / 1000).toFixed(1),
  };
}

module.exports = { stitch, parseTime, probe };
