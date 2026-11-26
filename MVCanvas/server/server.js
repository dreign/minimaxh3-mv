// server.js — MV 无限画布本地后端（Node.js 内置模块，零依赖 Web 层）
// 负责：静态托管、素材上传、任务调度、进度查询、视频流（支持 Range）
// AI 生成与 ffmpeg 由 server/pipeline_bridge.py 调用已验证的 auto_mv.py 完成。

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const wfLib = require_('./workflow_lib.cjs');
const presets = require_('./presets.cjs');
const { stitch } = require_('./stitch.cjs');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const WORKSPACE = path.join(ROOT, 'workspace');
const ASSETS = path.join(WORKSPACE, 'assets');
const JOBS = path.join(WORKSPACE, 'jobs');
const OUTPUTS = path.join(WORKSPACE, 'outputs');
const WORKFLOW_RUNS = path.join(WORKSPACE, 'workflow_runs');
const BRIDGE = path.join(__dirname, 'pipeline_bridge.py');
const PORT = 8787;
const PY = process.env.PYTHON_BIN || 'python';

for (const d of [WORKSPACE, ASSETS, JOBS, OUTPUTS, WORKFLOW_RUNS]) fs.mkdirSync(d, { recursive: true });

const wfRuns = wfLib.createRunStore(WORKFLOW_RUNS);
let wfScanCache = { at: 0, data: null };

/** 扫描 ComfyUI 工作流目录，补上节点数与可绑定槽位；结果缓存 30s */
async function listWorkflowOptions(force = false) {
  if (!force && wfScanCache.data && Date.now() - wfScanCache.at < 30000) return wfScanCache.data;
  const list = wfLib.listWorkflows();
  let oi = null;
  try { oi = await wfLib.objectInfo(); } catch { /* ComfyUI 未启动时只返回文件信息 */ }
  const items = list.map((w) => {
    const base = {
      id: w.id, name: w.name, file: w.file, dir: w.dir,
      mtime: w.mtime, size: w.size, nodes: 0, classes: [], missing: [],
      slots: { image: [], audio: [], prompt: [], seed: [], width: [], height: [] },
      readable: true, error: '',
    };
    try {
      const ui = JSON.parse(fs.readFileSync(w.file, 'utf8'));
      base.nodes = (ui.nodes || []).length;
      if (oi) {
        const det = wfLib.detectSlots(ui, oi);
        base.slots = det.slots;
        base.missing = det.missing;
      }
    } catch (e) { base.readable = false; base.error = 'JSON 解析失败'; }
    return base;
  });
  wfScanCache = { at: Date.now(), data: { dirs: wfLib.workflowDirs(), workflows: items, comfy: !!oi } };
  return wfScanCache.data;
}


const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.ass': 'text/plain; charset=utf-8', '.lrc': 'text/plain; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function send(res, code, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', ...headers });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}
const ok = (res, data) => send(res, 200, data);
const fail = (res, msg, code = 500) => send(res, code, { error: String(msg) });

function readBody(req, max = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new Error('请求体过大')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}

const safeName = (name) => String(name).replace(/[^a-zA-Z0-9._\-\u4e00-\u9fa5]/g, '_').slice(-120);

function readState(jobDir) {
  // 优先读最近写入的阶段状态文件，反映当前所处阶段
  const candidates = ['compose_state.json', 'state.json', 'keyframes_state.json'];
  const file = candidates.map((n) => path.join(jobDir, n)).find((f) => fs.existsSync(f));
  if (!file) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = raw.result || {};
    // 桥接脚本写入的是工作区相对路径（如 outputs/xxx_MV.mp4），
    // 前端 <video>/<a download> 需要走 /media 静态路由，否则会请求到 index.html。
    if (typeof result.output === 'string' && result.output && !/^https?:\/\//i.test(result.output)) {
      const rel = result.output.replace(/\\/g, '/').replace(/^\/+/, '');
      result.output = rel.startsWith('media/') ? '/' + rel
        : rel.startsWith('outputs/') ? '/media/' + rel
        : '/media/jobs/' + encodeURIComponent(path.basename(jobDir)) + '/' + rel;
    }
    return {
      id: path.basename(jobDir), status: raw.status || 'pending', stage: raw.stage || '',
      progress: raw.progress || 0, logs: raw.logs || [], result,
      error: raw.error || '',
    };
  } catch { return null; }
}

function serveFile(res, file, rangeHeader) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const stat = fs.statSync(file);
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (rangeHeader) {
    const m = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
    if (m) {
      const start = m[1] ? parseInt(m[1], 10) : Math.max(0, stat.size - parseInt(m[2] || '0', 10));
      const end = m[2] && m[1] ? Math.min(parseInt(m[2], 10), stat.size - 1) : stat.size - 1;
      if (start < stat.size && end >= start) {
        res.writeHead(206, {
          ...headers,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Content-Length': end - start + 1,
        });
        fs.createReadStream(file, { start, end }).pipe(res);
        return true;
      }
    }
  }
  res.writeHead(200, { ...headers, 'Content-Length': stat.size });
  fs.createReadStream(file).pipe(res);
  return true;
}

function spawnBridge(config, stateFile) {
  const cfgPath = path.join(WORKSPACE, `cfg_${Date.now()}_${randomBytes(3).toString('hex')}.json`);
  fs.writeFileSync(cfgPath, JSON.stringify({ ...config, stateFile }, null, 2));
  if (stateFile && !fs.existsSync(stateFile)) {
    fs.writeFileSync(stateFile, JSON.stringify({ status: 'pending', stage: '排队中', progress: 0, logs: [] }));
  }
  const child = spawn(PY, [BRIDGE, cfgPath], { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.on('error', (e) => console.error('[bridge]', e));
  child.unref();
}

async function api(req, res, url) {
  const p = url.pathname;

  if (p === '/api/uploads' && req.method === 'GET') {
    // 列出已上传素材，供「工作流」节点直接挑选参考图/音频
    const files = fs.readdirSync(ASSETS).map((f) => ({
      name: f, path: path.join(ASSETS, f), url: `/media/assets/${encodeURIComponent(f)}`,
      kind: f.startsWith('image_') ? 'image' : f.startsWith('audio_') ? 'audio' : 'other',
      mtime: fs.statSync(path.join(ASSETS, f)).mtimeMs,
    })).sort((a, b) => b.mtime - a.mtime).slice(0, 80);
    return ok(res, { files });
  }

  // 可用工作流列表：自动扫描 ComfyUI workflows 目录
  if (p === '/api/workflows' && req.method === 'GET') {
    try {
      const data = await listWorkflowOptions(url.searchParams.get('refresh') === '1');
      return ok(res, data);
    } catch (e) { return fail(res, e.message); }
  }

  // 运行指定工作流（后台执行，立即返回 runId）
  if (p === '/api/workflows/run' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const { workflows } = await listWorkflowOptions();
      const runId = wfLib.startRun({
        workflows, runStore: wfRuns, outputsDir: OUTPUTS,
        workflowId: b.workflowId,
        image: b.image || null, image2: b.image2 || null, audio: b.audio || null,
        prompt: b.prompt || '', seed: Number(b.seed),
        width: Number(b.width) || 0, height: Number(b.height) || 0,
        patch: b.patch || null, outputName: b.outputName || '',
        veda: !!b.veda, vedaOptions: b.vedaOptions || null,
      });
      return ok(res, { runId });
    } catch (e) { return fail(res, e.message); }
  }

  if (p.startsWith('/api/workflows/run/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/workflows/run/'.length));
    const state = wfRuns.read(id);
    return state ? ok(res, state) : fail(res, '运行记录不存在', 404);
  }

  // 单个工作流的节点参数清单（可视化参数表单）
  if (p.startsWith('/api/workflows/') && p.endsWith('/nodes') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/workflows/'.length, p.length - '/nodes'.length));
    try {
      const { workflows } = await listWorkflowOptions();
      const w = workflows.find((x) => x.id === id);
      if (!w) return fail(res, '工作流不存在', 404);
      const ui = JSON.parse(fs.readFileSync(w.file, 'utf8'));
      const oi = await wfLib.objectInfo();
      const nodes = wfLib.describeNodes(ui, oi);
      const total = nodes.reduce((a, n) => a + n.params.length, 0);
      return ok(res, { id, name: w.name, nodes, total });
    } catch (e) {
      return fail(res, `读取节点参数失败：${e.message || e}（ComfyUI 需在线才能读取节点定义）`);
    }
  }

  if (p.startsWith('/api/workflows/') && req.method === 'GET') {
    // 读取单个工作流的详情（含 UI 原始 JSON，便于前端展示节点清单）
    const id = decodeURIComponent(p.slice('/api/workflows/'.length));
    if (id && id !== 'run') {
      const { workflows } = await listWorkflowOptions();
      const w = workflows.find((x) => x.id === id);
      if (!w) return fail(res, '工作流不存在', 404);
      return ok(res, w);
    }
  }

  if (p === '/api/presets' && req.method === 'GET') {
    const list = [presets.botMvCanvas({ workspace: WORKSPACE }), presets.botMvAuto({ workspace: WORKSPACE })];
    return ok(res, { presets: list.map((one) => ({ id: one.id, name: one.name, note: one.note, missing: one.missing })) });
  }

  // 画布预设：返回带真实素材路径的节点/连线，前端 applyPreset 即可
  if (p.startsWith('/api/presets/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/presets/'.length));
    if (id === 'bot-mv') return ok(res, presets.botMvCanvas({ workspace: WORKSPACE }));
    if (id === 'bot-mv-auto') return ok(res, presets.botMvAuto({ workspace: WORKSPACE }));
    return fail(res, '预设不存在', 404);
  }

  // 拼接成片：多段镜头 concat + 铺原曲起点 + 可选片名/淡入淡出（同步执行，几秒到几十秒）
  if (p === '/api/stitch' && req.method === 'POST') {
    const b = await readBody(req);
    try {
      const out = stitch({
        clips: b.clips, audio: b.audio, start: b.start, fade: b.fade, title: b.title,
        outputName: b.outputName, workspace: WORKSPACE, outputsDir: OUTPUTS,
      });
      return ok(res, out);
    } catch (e) {
      const msg = e.stderr ? String(e.stderr).slice(-1200) : e.message;
      return fail(res, `拼接失败：${msg}`);
    }
  }

  // 媒体探测：导演台按 MP3 真实时长拆分镜（绝对路径或 /media/ 均可）
  if (p === '/api/probe' && req.method === 'GET') {
    const raw = url.searchParams.get('path') || '';
    const file = raw.startsWith('/media/')
      ? path.join(WORKSPACE, decodeURIComponent(raw.slice('/media/'.length)))
      : raw;
    if (!file || !fs.existsSync(file)) return fail(res, `文件不存在：${raw}`, 404);
    try {
      const out = execFileSync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate',
        '-of', 'json', file,
      ], { encoding: 'utf8', timeout: 60000 });
      const j = JSON.parse(out || '{}');
      const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
      const a = (j.streams || []).find((s) => s.codec_type === 'audio') || {};
      return ok(res, {
        file, name: path.basename(file),
        duration: Number(j.format && j.format.duration) || 0,
        size: Number(j.format && j.format.size) || 0,
        video: v.codec_name ? { codec: v.codec_name, width: v.width, height: v.height, fps: v.r_frame_rate } : null,
        audio: a.codec_name ? { codec: a.codec_name } : null,
      });
    } catch (e) {
      return fail(res, `探测失败：${String(e.stderr || e.message).slice(-400)}`);
    }
  }

  if (p === '/api/health' && req.method === 'GET') {
    let comfy = false;
    try {
      const r = await fetch('http://127.0.0.1:8188/system_stats', { signal: AbortSignal.timeout(2500) });
      comfy = r.ok;
    } catch {}
    let ffmpeg = false;
    try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 4000 }); ffmpeg = true; } catch {}
    return ok(res, { comfy, ffmpeg, outputDir: OUTPUTS, workspace: WORKSPACE });
  }

  if (p === '/api/upload' && req.method === 'POST') {
    const b = await readBody(req);
    const kind = ['image', 'audio', 'lyrics'].includes(b.kind) ? b.kind : 'asset';
    const name = safeName(b.name || 'upload');
    const file = path.join(ASSETS, `${kind}_${Date.now()}_${name}`);
    fs.writeFileSync(file, Buffer.from(b.data || '', 'base64'));
    return ok(res, { name, path: file, url: `/media/assets/${path.basename(file)}` });
  }

  if (p === '/api/save-text' && req.method === 'POST') {
    const b = await readBody(req);
    const isLrc = /\[\d{1,3}:\d{2}/.test(b.text || '');
    const name = `lyrics_pasted_${Date.now()}${isLrc ? '.lrc' : '.txt'}`;
    const file = path.join(ASSETS, name);
    fs.writeFileSync(file, b.text || '', 'utf8');
    return ok(res, { name, path: file, url: `/media/assets/${name}` });
  }

  // 校验已持久化素材的文件是否仍在磁盘上，前端据此清除失效记录
  if (p === '/api/assets/verify' && req.method === 'POST') {
    const b = await readBody(req);
    const result = {};
    for (const kind of ['image', 'audio', 'lyrics']) {
      const a = b.assets?.[kind];
      result[kind] = !!(a && typeof a.path === 'string' && fs.existsSync(a.path) && fs.statSync(a.path).isFile());
    }
    return ok(res, result);
  }

  if (p === '/api/analyze' && req.method === 'POST') {
    const b = await readBody(req);
    const cfg = {
      command: 'analyze', audio: b.audio, lyrics: b.lyrics, image: b.image,
      duration: b.duration, maxShots: b.maxShots, shotSeconds: b.shotSeconds,
      scene: b.scene || '', useLyrics: b.useLyrics !== false,
      seed: Number(b.seed) || 0,
    };
    try {
      const cfgPath = path.join(WORKSPACE, `analyze_${Date.now()}.json`);
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
      const out = execFileSync(PY, [BRIDGE, cfgPath], {
        cwd: ROOT, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 15 * 60 * 1000,
      });
      const line = out.split('\n').find((x) => x.startsWith('RESULT '));
      if (!line) throw new Error(out.slice(-800) || '分析无输出');
      return ok(res, JSON.parse(line.slice(7)));
    } catch (e) { return fail(res, e.stderr?.toString().slice(-1500) || e.message); }
  }

  if (p === '/api/generate' && req.method === 'POST') {
    const b = await readBody(req);
    // 复用首帧图任务的 jobId，以便读取 keyframes_meta.json 走 i2v
    let jobId = b.jobId;
    let jobDir;
    if (jobId && fs.existsSync(path.join(JOBS, jobId))) {
      jobDir = path.join(JOBS, jobId);
    } else {
      jobId = `job_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}_${randomBytes(2).toString('hex')}`;
      jobDir = path.join(JOBS, jobId);
      fs.mkdirSync(path.join(jobDir, 'shots'), { recursive: true });
    }
    fs.mkdirSync(path.join(jobDir, 'shots'), { recursive: true });
    const stateFile = path.join(jobDir, 'state.json');
    spawnBridge({
      command: 'generate', jobId, jobDir,
      image: b.image, audio: b.audio, lyrics: b.lyrics,
      duration: b.params?.duration, shots: b.shots, params: b.params, lyricsData: b.lyricsData,
      scene: b.scene || '', useLyrics: b.useLyrics !== false,
      // 断点续跑：复用 jobDir/shots 里已生成的镜头，只补缺失的
      resume: !!b.resume,
    }, stateFile);
    return ok(res, { jobId });
  }

  // 逐镜生成首帧图（H3 Image），独立任务，完成后写 keyframes_meta.json
  if (p === '/api/keyframes' && req.method === 'POST') {
    const b = await readBody(req);
    let jobId = b.jobId;
    let jobDir;
    if (jobId && fs.existsSync(path.join(JOBS, jobId))) {
      jobDir = path.join(JOBS, jobId);
    } else {
      jobId = `job_${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}_${randomBytes(2).toString('hex')}`;
      jobDir = path.join(JOBS, jobId);
      fs.mkdirSync(path.join(jobDir, 'shots'), { recursive: true });
    }
    const stateFile = path.join(jobDir, 'keyframes_state.json');
    // H3 Image 出图尺寸：既留在 params 里（桥接层优先读），也显式写到配置顶层便于排查
    const kfSize = {
      keyframeSizeMode: b.params?.keyframeSizeMode || 'follow',
      keyframeWidth: Number(b.params?.keyframeWidth) || 0,
      keyframeHeight: Number(b.params?.keyframeHeight) || 0,
    };
    spawnBridge({
      command: 'keyframes', jobId, jobDir,
      image: b.image, shots: b.shots, params: b.params, ...kfSize,
      // 断点续跑：复用 jobDir/keyframes 里已生成的首帧图
      resume: !!b.resume,
    }, stateFile);
    return ok(res, { jobId });
  }

  if (p === '/api/compose' && req.method === 'POST') {
    const b = await readBody(req);
    const jobId = b.jobId;
    const jobDir = path.join(JOBS, jobId);
    if (!fs.existsSync(jobDir)) return fail(res, '任务不存在');
    const stateFile = path.join(jobDir, 'compose_state.json');
    spawnBridge({
      command: 'compose', jobId, jobDir,
      audio: b.audio, lyrics: b.lyrics, lyricsData: b.lyricsData, params: b.params,
      useLyrics: b.useLyrics !== false,
    }, stateFile);
    return ok(res, { jobId });
  }

  if (p.startsWith('/api/job/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/job/'.length));
    const job = readState(path.join(JOBS, id));
    return job ? ok(res, job) : fail(res, '任务不存在', 404);
  }

  // 读取某任务的首帧图结果
  if (p.startsWith('/api/keyframes/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/keyframes/'.length));
    const meta = path.join(JOBS, id, 'keyframes_meta.json');
    if (!fs.existsSync(meta)) return fail(res, '尚未生成首帧图', 404);
    return ok(res, JSON.parse(fs.readFileSync(meta, 'utf8')));
  }

  if (p === '/api/jobs' && req.method === 'GET') {
    const jobs = fs.readdirSync(JOBS).map((id) => readState(path.join(JOBS, id))).filter(Boolean);
    return ok(res, { jobs });
  }

  if (p === '/api/outputs' && req.method === 'GET') {
    const files = fs.readdirSync(OUTPUTS).filter((f) => /\.(mp4|webm|mov)$/i.test(f)).map((f) => ({
      name: f, url: `/media/outputs/${encodeURIComponent(f)}`, size: fs.statSync(path.join(OUTPUTS, f)).size,
    }));
    return ok(res, { files });
  }

  return fail(res, '未知接口', 404);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname.startsWith('/media/')) {
      const rel = decodeURIComponent(url.pathname.slice('/media/'.length));
      const file = path.resolve(WORKSPACE, rel);
      if (!file.startsWith(WORKSPACE)) return fail(res, '禁止访问', 403);
      if (serveFile(res, file, req.headers.range)) return;
      return fail(res, '文件不存在', 404);
    }
    // static SPA
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    let file = path.resolve(DIST, rel);
    if (!file.startsWith(DIST) || !fs.existsSync(file)) file = path.join(DIST, 'index.html');
    if (!fs.existsSync(file)) return fail(res, '前端未构建，请先运行 npm run build', 404);
    serveFile(res, file);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) fail(res, e.message);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`MV Canvas running at http://127.0.0.1:${PORT}`);
  console.log(`workspace: ${WORKSPACE}`);
});
