// workflow_lib.cjs — 通用 ComfyUI 工作流支持（扫描 / UI-JSON→API / 提交执行）
// 被 server.js 以 createRequire 载入；纯 Node 内置模块，无第三方依赖。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { randomBytes } = require('crypto');

const HOME = os.homedir();
const COMFY_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const COMFY_INPUT = process.env.COMFY_INPUT || path.join(HOME, 'ComfyUI-Shared', 'input');
const COMFY_OUTPUT = process.env.COMFY_OUTPUT || path.join(HOME, 'ComfyUI-Shared', 'output');

/**
 * 默认扫描目录：ComfyUI 用户工作流目录。
 * 优先级：COMFY_WORKFLOW_DIRS（分号分隔，最高）> COMFY_USER_DIR/user/* > ~/ComfyUI-Installs/ComfyUI/ComfyUI/user/*。
 */
function workflowDirs() {
  if (process.env.COMFY_WORKFLOW_DIRS) {
    return process.env.COMFY_WORKFLOW_DIRS.split(';').map((s) => s.trim()).filter(Boolean);
  }
  const base = process.env.COMFY_USER_DIR || path.join(HOME, 'ComfyUI-Installs', 'ComfyUI', 'ComfyUI', 'user');
  return [path.join(base, 'default', 'workflows'), path.join(base, 'workflows')];
}

const SKIP_TYPES = new Set([
  'Label (rgthree)', 'MarkdownNote', 'Note', 'Reroute', 'PrimitiveNode',
  'PreviewAny', 'Label', 'Fast Groups Bypasser (rgthree)', 'Fast Groups Muter (rgthree)',
]);
const SEED_CONTROL = new Set(['fixed', 'increment', 'decrement', 'randomize']);
const WIDGET_TYPES = new Set(['INT', 'FLOAT', 'STRING', 'BOOLEAN', 'COMBO']);
const IMAGE_LOADERS = new Set(['LoadImage', 'LoadImageMask', 'ImageLoad']);
const AUDIO_LOADERS = new Set(['LoadAudio']);
const TEXT_WIDGET_NAMES = new Set(['text', 'prompt', 'value', 'string', 'positive', 'negative', 'prompt_text']);

// ---------------------------------------------------------------- 扫描

function listWorkflows() {
  const out = [];
  const seen = new Set();
  for (const dir of workflowDirs()) {
    let files = [];
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.toLowerCase().endsWith('.json')) continue;
      const full = path.join(dir, f);
      const id = path.basename(f, '.json');
      if (seen.has(id)) continue;
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile() || stat.size > 32 * 1024 * 1024) continue;
      seen.add(id);
      out.push({ id, name: id, file: full, dir, mtime: stat.mtimeMs, size: stat.size });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

/**
 * 从 /object_info 里取某个节点类的输入规格。
 * 只保留"能用 widget 填"的输入，socketOnly 表示必须连线（或本身就是 socket 类型）。
 */
function specsFor(cls, oi) {
  const def = oi[cls];
  if (!def) return null;
  const specs = [];
  for (const group of ['required', 'optional']) {
    for (const [name, spec] of Object.entries((def.input || {})[group] || {})) {
      const t = spec[0];
      const opts = spec[1] || {};
      const isCombo = Array.isArray(t) || t === 'COMBO';
      specs.push({
        name,
        type: isCombo ? 'COMBO' : t,
        options: Array.isArray(t) ? t : undefined,
        socketOnly: opts.forceInput === true || (!isCombo && !WIDGET_TYPES.has(t)),
        default: opts.default,
        min: opts.min, max: opts.max, step: opts.step,
        multiline: !!opts.multiline,
      });
    }
  }
  return specs;
}

/**
 * 从节点的 widgets_values 里读出各 widget 的实际取值。
 * ComfyUI 有两种写法：数组（按 widget 顺序）和字典（按输入名）。
 * 数组里 seed 后面会多一个 control_after_generate（fixed/randomize…），需要跳过。
 */
function readWidgets(node, specs) {
  const out = {};
  const widgets = node.widgets_values;
  if (widgets && !Array.isArray(widgets) && typeof widgets === 'object') {
    for (const s of specs) if (!s.socketOnly && widgets[s.name] !== undefined) out[s.name] = widgets[s.name];
    return out;
  }
  const arr = Array.isArray(widgets) ? widgets.slice() : [];
  let i = 0;
  for (const s of specs) {
    if (s.socketOnly) continue;
    if (i >= arr.length) break;
    if (typeof arr[i] === 'string' && SEED_CONTROL.has(arr[i]) && !('control_after_generate' in out)) {
      i++; if (i >= arr.length) break;
    }
    out[s.name] = arr[i++];
  }
  return out;
}

/** 从 UI 工作流 JSON 里识别可绑定的槽位（图片/音频/提示词/种子/宽高） */
function detectSlots(wf, oi) {
  const slots = { image: [], audio: [], prompt: [], seed: [], width: [], height: [], classes: [], missing: new Set() };
  for (const n of wf.nodes || []) {
    if (SKIP_TYPES.has(n.type)) continue;
    if (n.mode === 4 || n.mode === 2) continue;
    slots.classes.push(n.type);
    const specs = specsFor(n.type, oi);
    if (!specs) { slots.missing.add(n.type); continue; }
    for (const s of specs) {
      if (s.socketOnly) continue;
      if (IMAGE_LOADERS.has(n.type) && s.name === 'image') slots.image.push({ node: String(n.id), input: 'image' });
      else if (AUDIO_LOADERS.has(n.type) && (s.name === 'audio' || s.name === 'file')) slots.audio.push({ node: String(n.id), input: s.name });
      else if (TEXT_WIDGET_NAMES.has(s.name) && s.type === 'STRING') slots.prompt.push({ node: String(n.id), input: s.name });
      else if (s.name === 'seed' || s.name === 'noise_seed') slots.seed.push({ node: String(n.id), input: s.name });
      else if (s.name === 'width') slots.width.push({ node: String(n.id), input: 'width' });
      else if (s.name === 'height') slots.height.push({ node: String(n.id), input: 'height' });
    }
  }
  return {
    slots: {
      image: slots.image, audio: slots.audio, prompt: slots.prompt,
      seed: slots.seed, width: slots.width, height: slots.height,
    },
    classes: [...new Set(slots.classes)],
    missing: [...slots.missing],
  };
}

/**
 * 把工作流拆成"每节点可编辑参数"清单，供前端渲染可视化表单。
 * - 跳过连线驱动的输入（由上游节点决定，改了也不生效）
 * - 跳过已被槽位（图/音/提示词/种子/宽高）接管的输入，避免和上方控件打架
 * - 按分组框（groups）给节点归类，方便折叠
 */
function describeNodes(wf, oi) {
  const links = new Map();
  for (const l of wf.links || []) links.set(l[0], [l[1], l[2]]);

  const detected = detectSlots(wf, oi);
  const slotMap = {};
  for (const [kind, list] of Object.entries(detected.slots)) {
    for (const s of list) (slotMap[s.node] = slotMap[s.node] || {})[s.input] = kind;
  }

  const GENERIC_GROUP = /^(group|组|分组|节点组)\s*\d*$/i;
  const groups = (wf.groups || [])
    .filter((g) => Array.isArray(g.bounding) && g.bounding.length >= 4)
    .filter((g) => String(g.title || '').trim() && !GENERIC_GROUP.test(String(g.title).trim()));
  const groupOf = (pos) => {
    if (!Array.isArray(pos)) return '';
    for (const g of groups) {
      const [x, y, w, h] = g.bounding;
      if (pos[0] >= x && pos[0] <= x + w && pos[1] >= y && pos[1] <= y + h) return g.title || '';
    }
    return '';
  };

  const nodes = [];
  for (const n of wf.nodes || []) {
    if (SKIP_TYPES.has(n.type)) continue;
    if (n.mode === 4 || n.mode === 2) continue;
    const specs = specsFor(n.type, oi);
    if (!specs) continue;

    const linked = new Set();
    for (const inp of n.inputs || []) if (inp.link || inp.link === 0) linked.add(inp.name);

    const values = readWidgets(n, specs);
    const own = slotMap[String(n.id)] || {};
    const params = [];
    let slotParams = 0;
    for (const s of specs) {
      if (s.socketOnly || linked.has(s.name)) continue;
      if (!(s.name in values)) continue;
      if (own[s.name]) { slotParams++; continue; }
      const p = { name: s.name, type: s.type, value: values[s.name] };
      if (s.type === 'COMBO') {
        p.options = (s.options || []).slice(0, 400);
        if (p.value == null) p.value = '';
        else if (typeof p.value !== 'string') p.value = String(p.value);
        if (s.default !== undefined) p.default = s.default;
      } else if (s.type === 'INT' || s.type === 'FLOAT') {
        if (s.min !== undefined) p.min = s.min;
        if (s.max !== undefined) p.max = s.max;
        if (s.step !== undefined) p.step = s.step;
        if (s.default !== undefined) p.default = s.default;
      } else if (s.type === 'BOOLEAN') {
        if (s.default !== undefined) p.default = s.default;
      } else if (s.type === 'STRING') {
        p.multiline = !!s.multiline;
        if (s.default !== undefined) p.default = s.default;
      }
      params.push(p);
    }
    if (!params.length) continue;
    nodes.push({
      id: String(n.id), type: n.type, title: n.title || n.type,
      group: groupOf(n.pos), slotParams, params,
    });
  }
  return nodes;
}

// ---------------------------------------------------------------- 转换

/**
 * UI 工作流 → API prompt。
 * @param wf  UI 格式工作流 JSON
 * @param oi  ComfyUI /object_info
 * @param patch { nodeId: { inputName: value } } 直接覆盖 API 侧输入
 */
function toApiPrompt(wf, oi, patch = {}) {
  const links = new Map();
  for (const l of wf.links || []) links.set(l[0], [l[1], l[2]]);

  const prompt = {};
  const skipped = [];
  const missing = new Set();

  for (const n of wf.nodes || []) {
    if (SKIP_TYPES.has(n.type)) continue;
    if (n.mode === 4 || n.mode === 2) { skipped.push(`${n.id}:${n.type}`); continue; }
    const specs = specsFor(n.type, oi);
    if (!specs) { missing.add(n.type); continue; }

    const inputs = readWidgets(n, specs);

    for (const inp of n.inputs || []) {
      if (!inp.link && inp.link !== 0) continue;
      const src = links.get(inp.link);
      if (src) inputs[inp.name] = [String(src[0]), src[1]];
    }

    if (patch[String(n.id)]) Object.assign(inputs, patch[String(n.id)]);
    prompt[String(n.id)] = { class_type: n.type, inputs, _meta: { title: n.title || n.type } };
  }

  return { prompt, skipped, missing: [...missing] };
}

// ---------------------------------------------------------------- ComfyUI HTTP

async function comfyJson(p, init) {
  const r = await fetch(COMFY_URL + p, { ...init, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`ComfyUI ${p} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

let oiCache = { at: 0, data: null };
async function objectInfo(force = false) {
  if (!force && oiCache.data && Date.now() - oiCache.at < 5 * 60 * 1000) return oiCache.data;
  const data = await comfyJson('/object_info');
  oiCache = { at: Date.now(), data };
  return data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyToComfyInput(srcPath) {
  const base = path.basename(srcPath).replace(/[^a-zA-Z0-9._-]/g, '_');
  const dest = path.join(COMFY_INPUT, `wf_${Date.now().toString(36)}_${base}`);
  fs.copyFileSync(srcPath, dest);
  return path.basename(dest);
}

/** 从 history 条目里提取输出文件（视频优先），返回 [{filename, subfolder, type}] */
function extractOutputs(entry) {
  const files = [];
  const push = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(push);
    if (typeof v.filename === 'string') files.push({ filename: v.filename, subfolder: v.subfolder || '', type: v.type || 'output' });
  };
  for (const out of Object.values(entry.outputs || {})) {
    for (const v of Object.values(out || {})) push(v);
  }
  const video = files.filter((f) => /\.(mp4|webm|mov|mkv)$/i.test(f.filename));
  return video.length ? video : files;
}

// ---------------------------------------------------------------- Veda 稀疏注意力

// 仍然输出 MODEL 的“模型改造”节点：沿这些节点往链尾走，Veda 要插在最后一个之后
const MODEL_TRANSFORM = /(Lora|Patch|ModelSampling|Attention|Swap|BlockSwap|ModelMerge|ModelPatch)/i;

/** 从某个节点出发，沿唯一下游的模型改造节点走到链尾（含起点） */
function modelChainTail(prompt, startId) {
  const consumersOf = (id) => Object.entries(prompt).filter(([, n]) => Object.values(n.inputs || {})
    .some((v) => Array.isArray(v) && String(v[0]) === String(id)));
  let cur = String(startId);
  const seen = new Set([cur]);
  for (let guard = 0; guard < 32; guard++) {
    const cons = consumersOf(cur);
    if (cons.length !== 1) break;
    const [nextId, next] = cons[0];
    if (seen.has(String(nextId))) break;
    if (!MODEL_TRANSFORM.test(String(next.class_type || ''))) break;
    seen.add(String(nextId));
    cur = String(nextId);
  }
  return cur;
}

/**
 * 把 VedaSparseAttention 插进已转换好的 API prompt：
 * 沿 SageAttentionPatch 的 MODEL 链走到链尾（LoRA 等改造节点之后），
 * 把链尾的所有下游改接到 Veda，Veda 再接回链尾。
 * 不改工作流文件，只在提交前动这一次请求，所以开关关掉就完全回到原样。
 */
function applyVeda(prompt, oi, opts = {}) {
  const entries = Object.entries(prompt);
  const already = entries.find(([, n]) => n.class_type === 'VedaSparseAttention');
  if (already) return { ok: true, existing: true, nodeId: already[0], rewired: 0 };
  const sageAll = entries.filter(([, n]) => /SageAttentionPatch/i.test(n.class_type || ''));
  if (!sageAll.length) {
    return { ok: false, reason: '该工作流里没有 SageAttentionPatch 节点，定位不到 MODEL 链，无法插入 Veda' };
  }
  const spec = oi && oi.VedaSparseAttention;
  if (!spec) return { ok: false, reason: 'ComfyUI 未安装 veda-sparse-attention 节点，已按原样运行' };

  const consume = (id) => entries.reduce((acc, [, n]) => acc + Object.values(n.inputs || {})
    .filter((v) => Array.isArray(v) && String(v[0]) === String(id)).length, 0);
  // 多个 Sage 节点时，取真正被下游引用的那个
  const [sageId] = sageAll.sort((a, b) => consume(b[0]) - consume(a[0]))[0];
  if (!consume(sageId)) {
    return { ok: false, reason: `SageAttentionPatch#${sageId} 的输出没有下游引用，无法插入 Veda` };
  }
  // 插到模型链末端（实测顺序：UNET → Sage → LoRA → Guider，Veda 应在 LoRA 之后）
  const tailId = modelChainTail(prompt, sageId);
  if (!consume(tailId)) {
    return { ok: false, reason: `模型链末端 #${tailId} 没有被任何节点引用，无法插入 Veda` };
  }

  const predictorSpec = spec.input?.required?.predictor?.[1] || {};
  const options = Array.isArray(predictorSpec.options) ? predictorSpec.options : [];
  // ref2va 工作流优先用 r2va 预测器；节点默认值通常是 t2va，直接用会不匹配
  const predictor = opts.predictor
    || options.find((x) => /r2v/i.test(x))
    || predictorSpec.default
    || 'minimax_h3_r2va_veda_preview_fp8.safetensors';
  const sparsity = String(opts.sparsity || '32');

  const id = String(Math.max(0, ...entries.map(([k]) => Number(k) || 0)) + 1);
  let rewired = 0;
  for (const [, n] of entries) {
    for (const [name, v] of Object.entries(n.inputs || {})) {
      if (Array.isArray(v) && String(v[0]) === String(tailId)) {
        n.inputs[name] = [id, v[1] ?? 0];
        rewired++;
      }
    }
  }
  prompt[id] = {
    class_type: 'VedaSparseAttention',
    inputs: {
      model: [String(tailId), 0],
      predictor,
      generated_sparsity: sparsity,
      reference_sparsity: '32',
      full_attention_layers: '',
      full_attention_steps: '',
      verbose: false,
    },
    _meta: { title: 'Veda 稀疏注意力' },
  };
  return { ok: true, nodeId: id, sageId, tailId, rewired, predictor, sparsity };
}

// ---------------------------------------------------------------- 运行

function createRunStore(baseDir) {
  return {
    dirFor(runId) { return path.join(baseDir, runId); },
    stateFile(runId) { return path.join(baseDir, runId, 'state.json'); },
    read(runId) {
      try { return JSON.parse(fs.readFileSync(this.stateFile(runId), 'utf8')); } catch { return null; }
    },
    write(runId, state) {
      const dir = this.dirFor(runId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.stateFile(runId), JSON.stringify(state, null, 1), 'utf8');
    },
  };
}

/**
 * 启动一次工作流运行（立即返回 runId，后台异步执行并持续写 state.json）。
 * @param opts { workflows, runStore, outputsDir, mediaBase, workflowId, image, audio,
 *               prompt, seed, width, height, patch, outputName, ttlSeconds }
 */
function startRun(opts) {
  const {
    workflows, runStore, outputsDir, workflowId,
    image, audio, prompt, seed, width, height, patch, outputName, ttlSeconds = 3600,
    veda, vedaOptions,
  } = opts;

  const wf = workflows.find((w) => w.id === workflowId);
  if (!wf) throw new Error(`未找到工作流：${workflowId}`);

  const runId = `wf_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const startedAt = Date.now();
  const state = {
    id: runId, workflowId, workflowName: wf.name, status: 'running',
    stage: '准备工作流', progress: 0.02, logs: [], createdAt: startedAt,
  };
  runStore.write(runId, state);

  const log = (msg) => {
    state.logs = [...state.logs, msg].slice(-200);
    runStore.write(runId, state);
  };
  const setStage = (stage, progress) => {
    state.stage = stage;
    if (typeof progress === 'number') state.progress = Math.min(0.99, Math.max(0, progress));
    runStore.write(runId, state);
  };

  (async () => {
    try {
      const ui = JSON.parse(fs.readFileSync(wf.file, 'utf8'));
      const oi = await objectInfo();
      const detected = detectSlots(ui, oi);
      if (detected.missing.length) {
        log(`⚠ 有节点类未安装：${detected.missing.join(', ')}（相关节点会被跳过）`);
      }

      // 绑定：图片/音频先拷进 ComfyUI 输入目录
      const overrides = {};
      const put = (node, input, value) => {
        overrides[node] = { ...(overrides[node] || {}), [input]: value };
      };
      if (image && detected.slots.image.length && fs.existsSync(image)) {
        const name = copyToComfyInput(image);
        detected.slots.image.forEach((s) => put(s.node, s.input, name));
        log(`参考图 → ${name}`);
      }
      if (audio && detected.slots.audio.length && fs.existsSync(audio)) {
        const name = copyToComfyInput(audio);
        detected.slots.audio.forEach((s) => put(s.node, s.input, name));
        log(`音频 → ${name}`);
      }
      if (prompt && detected.slots.prompt.length) {
        detected.slots.prompt.forEach((s) => put(s.node, s.input, prompt));
        log(`提示词 → ${detected.slots.prompt.map((s) => '#' + s.node).join(', ')}`);
      }
      if (Number.isFinite(seed) && detected.slots.seed.length) {
        detected.slots.seed.forEach((s) => put(s.node, s.input, Math.floor(seed)));
        log(`种子 → ${Math.floor(seed)}`);
      }
      for (const [k, list] of [['width', detected.slots.width], ['height', detected.slots.height]]) {
        const v = Number(k === 'width' ? width : height);
        if (Number.isFinite(v) && v > 0) list.forEach((s) => put(s.node, s.input, Math.floor(v)));
      }
      if (patch && typeof patch === 'object') {
        for (const [node, inputs] of Object.entries(patch)) {
          if (inputs && typeof inputs === 'object') overrides[node] = { ...(overrides[node] || {}), ...inputs };
        }
        const items = Object.values(patch).reduce((a, v) => a + Object.keys(v || {}).length, 0);
        log(`自定义参数 ${items} 项（${Object.keys(patch).length} 个节点）`);
      }

      setStage('转换工作流', 0.08);
      const { prompt: apiPrompt, missing } = toApiPrompt(ui, oi, overrides);
      const nodeCount = Object.keys(apiPrompt).length;
      if (!nodeCount) throw new Error('工作流转换后没有可执行节点');
      log(`已转换 ${nodeCount} 个节点${missing.length ? `，跳过未安装类：${missing.join(',')}` : ''}`);

      // ⚡ Veda：只在这次提交里插节点，不改工作流文件
      if (veda) {
        const r = applyVeda(apiPrompt, oi, vedaOptions || {});
        if (r.ok) {
          state.veda = { on: true, nodeId: r.nodeId, sparsity: r.sparsity, predictor: r.predictor };
          log(`⚡ Veda 已接入 #${r.nodeId}（sparsity ${r.sparsity}，改接 ${r.rewired} 处，predictor ${r.predictor}）`);
        } else {
          state.veda = { on: false, reason: r.reason };
          log(`⚠ Veda 未启用：${r.reason}`);
        }
      }

      setStage('提交到 ComfyUI', 0.12);
      const clientId = `mvcanvas_${randomBytes(4).toString('hex')}`;
      const sub = await comfyJson('/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: apiPrompt, client_id: clientId }),
      });
      if (sub.node_errors && Object.keys(sub.node_errors).length) {
        throw new Error('ComfyUI 校验失败：' + JSON.stringify(sub.node_errors).slice(0, 600));
      }
      const promptId = sub.prompt_id;
      log(`已提交，prompt_id=${promptId.slice(0, 8)}`);

      const deadline = Date.now() + ttlSeconds * 1000;
      let entry = null;
      while (Date.now() < deadline) {
        await sleep(1500);
        let hist = {};
        try { hist = await comfyJson(`/history/${promptId}`); } catch { /* transient */ }
        entry = hist[promptId];
        if (entry && entry.status) {
          const done = entry.status.completed || entry.status.status_str === 'success';
          if (done) break;
          if (entry.status.status_str === 'error') {
            const msgs = entry.status.messages || [];
            const err = msgs.map((m) => (Array.isArray(m) ? { type: m[0], data: m[1] || {} } : m))
              .find((m) => m && m.type === 'execution_error');
            if (err) {
              const d = err.data || {};
              throw new Error(`${d.node_type || '节点'}#${d.node_id || '?'} 报错：${String(d.exception_message || '').trim() || '未知错误'}`);
            }
            throw new Error('ComfyUI 执行失败：' + JSON.stringify(msgs).slice(0, 500));
          }
        }
        if (!entry) {
          // 还在队列里：按已用时间做个温和的进度估计
          const t = (Date.now() - startedAt) / 1000;
          setStage(`ComfyUI 生成中（${Math.round(t)}s）`, 0.2 + Math.min(0.6, t / 600));
        } else {
          setStage('解码输出', 0.85);
        }
      }
      if (!entry) throw new Error(`等待超时（${ttlSeconds}s）`);

      setStage('收集输出', 0.9);
      const files = extractOutputs(entry);
      if (!files.length) throw new Error('工作流执行完成但没有输出文件（请确认有 SaveImage / VHS_VideoCombine 节点）');

      fs.mkdirSync(outputsDir, { recursive: true });
      const saved = [];
      for (const f of files) {
        const src = path.join(COMFY_OUTPUT, f.subfolder || '', f.filename);
        if (!fs.existsSync(src)) { log(`⚠ 找不到输出文件：${src}`); continue; }
        const ext = path.extname(f.filename) || '.png';
        const base = (outputName || wf.name).replace(/[^a-zA-Z0-9\u4e00-\u9fa5._-]/g, '_').slice(0, 60) || 'workflow';
        const dest = path.join(outputsDir, `${base}_${runId.slice(-6)}${ext}`);
        fs.copyFileSync(src, dest);
        saved.push({ name: path.basename(dest), url: `/media/outputs/${encodeURIComponent(path.basename(dest))}` });
        log(`输出 → ${path.basename(dest)}`);
      }
      if (!saved.length) throw new Error('输出文件复制失败');

      state.status = 'done';
      state.progress = 1;
      state.stage = '完成';
      state.elapsed = Math.round((Date.now() - startedAt) / 1000);
      state.result = { files: saved, primary: saved.find((s) => /\.(mp4|webm|mov)$/i.test(s.name)) || saved[0] };
      state.promptId = promptId;
      runStore.write(runId, state);
    } catch (e) {
      state.status = 'error';
      state.stage = '失败';
      state.error = e.message || String(e);
      state.progress = 1;
      state.logs = [...(state.logs || []), `✗ ${state.error}`].slice(-200);
      runStore.write(runId, state);
    }
  })();

  return runId;
}

module.exports = {
  workflowDirs, listWorkflows, detectSlots, describeNodes, specsFor, readWidgets,
  toApiPrompt, applyVeda, objectInfo,
  createRunStore, startRun, extractOutputs, comfyJson, COMFY_INPUT, COMFY_OUTPUT, COMFY_URL,
};
