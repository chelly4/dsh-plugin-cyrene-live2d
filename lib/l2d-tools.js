/**
 * 小昔涟 · 语义动作协议 v1 · 宿主侧五个工具
 *
 * 借自鲸语 Jingyu 的 agent-tools.json（MIT），工具名与职责一一对应：
 *   capabilities → 先读能力目录（模型真实参数/范围/表情）
 *   compile      → 只校验、不执行（失败就把错误还给模型去改一次）
 *   execute      → 下发已经校验过的计划，拿 jobId
 *   state        → 读回执（只有 renderer 真的播完才算 completed）
 *   stop         → 平滑回待机
 *
 * **为什么 compile 和 execute 必须分开**：合起来就只能「先做再发现不对」，
 * 校验的意义是让错误在花钱/花时间之前被拦下来。
 *
 * 数据流（不新开端口、不加常驻进程）：
 *   宿主 l2d 状态 → /api/state 的 l2d 字段 → 独立版轮询取走 → 播完 POST 回执
 * 独立版本来就在 1.2 秒轮询 /api/state，这条通道是白搭的。
 */
import { compilePlan } from './l2d-plan.js'

const TEXT = (t) => [{ type: 'text', text: t }]

/** 计划既接受对象，也接受 JSON 字符串（模型输出 JSON 字符串更稳）。 */
function parsePlan(raw) {
  if (raw && typeof raw === 'object') return raw
  if (typeof raw === 'string') {
    try { return JSON.parse(raw) } catch (e) {
      return { __parseError: '计划不是合法 JSON：' + (e && e.message ? e.message : e) }
    }
  }
  return { __parseError: '计划必须是对象或 JSON 字符串' }
}

const CAPS_TTL_MS = 15000   // 独立版 1.2s 轮询 /api/state，15s 没心跳就当它不在了
const PENDING_GRACE_MS = 5000

/** caps 还新鲜吗（一次性的 caps 不能代表「她还在」）。 */
function capsFresh(l2d) {
  return !!(l2d.caps && Date.now() - (l2d.caps.at || 0) < CAPS_TTL_MS)
}

/** pending 超过 ms+5s 还没回执 → 释放并记一条失败回执，否则 execute 会永远「上一段还没播完」。 */
function sweepPending(l2d) {
  const p = l2d.pending
  if (!p) return
  if (Date.now() - (p.at || 0) > (Number(p.ms) || 0) + PENDING_GRACE_MS) {
    l2d.result = { jobId: p.jobId, ok: false, ms: 0, at: Date.now(), timeout: true }
    l2d.pending = null
  }
}

/** 动作模板：省得模型每次现编 JSON（compile 失败率的主要来源）。 */
function buildTemplates(caps) {
  const exprs = (caps && Array.isArray(caps.expressions)) ? caps.expressions : []
  const e0 = exprs[0] || ''
  const out = [
    { name: 'greet', note: '打招呼：轻点头 + 瞥一眼', plan: { version: 1, intent: '打招呼', actions: [
      { kind: 'nod', count: 1, at: 0, duration: 1.2 },
      { kind: 'look', direction: 'right', at: 0.35, duration: 1.0 },
    ] } },
    { name: 'think', note: '思考：看左上、停久一点', plan: { version: 1, intent: '思考', actions: [
      { kind: 'look', direction: 'up', at: 0, duration: 1.8 },
      { kind: 'nod', count: 1, at: 1.4, duration: 0.8 },
    ] } },
  ]
  if (e0) {
    out.push({ name: 'surprise', note: '惊讶：换表情 + 一抬头', plan: { version: 1, intent: '惊讶', actions: [
      { kind: 'expression', name: e0, at: 0, duration: 1.6 },
      { kind: 'look', direction: 'center', at: 0.1, duration: 1.2 },
    ] } })
  }
  return out
}

export function installL2DTools(toolsSvc, l2d) {
  if (!toolsSvc || typeof toolsSvc.register !== 'function') {
    throw new Error('tools 服务不可用')
  }
  const installed = []

  const reg = (def) => {
    const dispose = toolsSvc.register(def)
    installed.push(typeof dispose === 'function' ? dispose : null)
  }

  /* 1) 能力目录 */
  reg({
    name: 'cyrene_l2d_capabilities',
    description: [
      '读取小昔涟当前模型的真实动作能力：参数名、范围、表情列表。',
      '什么时候用：**编排任何动作之前先调这个**。动作里的参数名和表情名只能从这里取，编不出来就是执行失败。',
      '返回 ok=false 说明独立桌面版没在运行 —— 她在页面上，但没有可驱动的舞台。',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          model: { type: 'string' },
          params: { type: 'integer' },
          expressions: { type: 'array', items: { type: 'string' } },
          templates: { type: 'array', items: { type: 'object' } },
          hint: { type: 'string' },
        },
        required: ['ok', 'model', 'params', 'expressions', 'templates', 'hint'],
      },
      render: (_a, v) => TEXT(
        v.ok
          ? `当前模型 ${v.model}：${v.params} 个参数，${v.expressions.length} 个表情${v.expressions.length ? '（' + v.expressions.join('、') + '）' : ''}。`
          : v.hint
      ),
    },
    async execute() {
      const caps = capsFresh(l2d) ? l2d.caps : null
      if (!caps) {
        return {
          ok: false, model: '', params: 0, expressions: [], templates: [],
          hint: '独立桌面版没在运行（15 秒内没有心跳），没有可驱动的舞台。等她在桌面上之后再编排动作。',
        }
      }
      return {
        ok: true,
        model: String(caps.model || ''),
        params: (caps.order && caps.order.length) || Object.keys(caps.params || {}).length,
        expressions: Array.isArray(caps.expressions) ? caps.expressions : [],
        templates: buildTemplates(caps),
        hint: '参数名与表情名只能取自这里；templates 里有现成的『打招呼 / 思考 / 惊讶』可直接改。编排完先用 cyrene_l2d_compile 校验。',
      }
    },
  })

  /* 2) 校验（不执行） */
  reg({
    name: 'cyrene_l2d_compile',
    description: [
      '校验一份语义动作计划：参数是否存在、范围、时长、通道冲突。**只校验，不执行**。',
      '计划格式：{"version":1,"intent":"…","actions":[{"kind":"look","direction":"right","at":0,"duration":1.6}]}',
      '可用 kind：look（direction: left/right/up/down/center）· nod / shake_head（count 1..4）· hold / param（param + value）· expression（name）。',
      '校验失败就把 error 原样看去改，改完再调一次；不要跳过这一步直接 execute。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { plan: { oneOf: [{ type: 'object' }, { type: 'string' }] } },
      required: ['plan'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          tracks: { type: 'integer' },
          ms: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
          error: { type: 'string' },
        },
        required: ['ok', 'tracks', 'ms', 'warnings', 'error'],
      },
      render: (_a, v) => TEXT(
        v.ok
          ? `校验通过：${v.tracks} 条轨道，约 ${v.ms} ms${v.warnings.length ? '；提示：' + v.warnings.join('；') : ''}。`
          : `校验没通过：${v.error}`
      ),
    },
    async execute(args) {
      const plan = parsePlan(args && args.plan)
      if (plan.__parseError) return { ok: false, tracks: 0, ms: 0, warnings: [], error: plan.__parseError }
      if (!capsFresh(l2d)) return { ok: false, tracks: 0, ms: 0, warnings: [], error: '独立桌面版没在运行（没有能力目录 / 心跳过期）' }
      const r = compilePlan(plan, l2d.caps)
      return r.ok
        ? { ok: true, tracks: r.tracks.length, ms: r.ms, warnings: r.warnings || [], error: '' }
        : { ok: false, tracks: 0, ms: 0, warnings: [], error: r.error }
    },
  })

  /* 3) 下发 */
  reg({
    name: 'cyrene_l2d_execute',
    description: [
      '把已经通过校验的动作计划下发给她执行，返回 jobId。之后用 cyrene_l2d_state 追踪。',
      '会再校验一遍（防止计划被改动）；校验不过就退回，不下发。',
      '同一时刻只允许一个待执行任务 —— 上一段还没播完就再下发，会被拒绝。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: { plan: { oneOf: [{ type: 'object' }, { type: 'string' }] } },
      required: ['plan'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          jobId: { type: 'string' },
          ms: { type: 'integer' },
          error: { type: 'string' },
        },
        required: ['ok', 'jobId', 'ms', 'error'],
      },
      render: (_a, v) => TEXT(
        v.ok ? `已下发（${v.jobId}，约 ${v.ms} ms）。她在桌面上动起来之后会写回执。`
          : `没下发：${v.error}`
      ),
    },
    async execute(args) {
      const plan = parsePlan(args && args.plan)
      if (plan.__parseError) return { ok: false, jobId: '', ms: 0, error: plan.__parseError }
      sweepPending(l2d)
      if (!capsFresh(l2d)) return { ok: false, jobId: '', ms: 0, error: '独立桌面版没在运行（没有能力目录 / 心跳过期）' }
      if (l2d.pending) return { ok: false, jobId: '', ms: 0, error: '上一段还没播完，等它结束或先 stop' }
      const r = compilePlan(plan, l2d.caps)
      if (!r.ok) return { ok: false, jobId: '', ms: 0, error: r.error }
      l2d.seq = (l2d.seq || 0) + 1
      const jobId = 'j' + Date.now().toString(36) + '-' + l2d.seq
      l2d.pending = { jobId, tracks: r.tracks, ms: r.ms, at: Date.now() }
      return { ok: true, jobId, ms: r.ms, error: '' }
    },
  })

  /* 4) 回执 */
  reg({
    name: 'cyrene_l2d_state',
    description: [
      '读她的动作状态与上一次的回执。',
      '只有回执里 completed=true 才代表真的播完了；只是「已下发」不算完成 —— 别把下发当成做完。',
    ].join('\n'),
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        properties: {
          online: { type: 'boolean' },
          playing: { type: 'boolean' },
          jobId: { type: 'string' },
          completed: { type: 'boolean' },
          note: { type: 'string' },
        },
        required: ['online', 'playing', 'jobId', 'completed', 'note'],
      },
      render: (_a, v) => TEXT(v.note),
    },
    async execute() {
      sweepPending(l2d)
      const online = capsFresh(l2d)
      const p = l2d.pending
      const r = l2d.result
      const note = !online
        ? '她不在桌面上（独立版没运行）。'
        : p
          ? `正在播 ${p.jobId}（约 ${p.ms} ms）。`
          : r
            ? `最近一次 ${r.jobId}：${r.ok ? '播完了' : '失败了'}（${r.ms} ms）。`
            : '待机中，最近没有动作。'
      // jobId 与 completed 必须来自同一件事：playing 时只能报「未完成」，
      // 否则会出现 {jobId: B, completed: true, playing: true} 这种自相矛盾。
      return {
        online,
        playing: !!p,
        jobId: (p && p.jobId) || (r && r.jobId) || '',
        completed: !p && !!(r && r.ok),
        note,
      }
    },
  })

  /* 5) 停止 */
  reg({
    name: 'cyrene_l2d_stop',
    description: '让她停止当前动作、平滑回待机。',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        required: ['ok', 'note'],
      },
      render: (_a, v) => TEXT(v.note),
    },
    async execute() {
      if (!l2d.pending) return { ok: false, note: '她本来就是待机状态。' }
      l2d.pending = null
      return { ok: true, note: '已停下，回待机。' }
    },
  })

  return {
    dispose() {
      for (const d of installed) {
        try { d && d() } catch {}
      }
      installed.length = 0
    },
  }
}
