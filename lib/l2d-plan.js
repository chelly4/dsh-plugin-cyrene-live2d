/**
 * 小昔涟 · 语义动作协议 v1 —— 编译器（纯函数，零依赖）
 *
 * 借自 鲸语 Jingyu Live2D Agent 的 compiler.py（MIT）：
 *   "Semantic action IR -> bounded, eased parameter tracks. Never parses prose."
 * 这条纪律照抄：**这里只吃结构化计划，绝不解析自然语言**。自然语言由模型出成
 * {version:1, actions:[...]}，本地只做校验与编译。
 *
 * 三条硬规矩（都是他们踩出来的，2026-11-07 移植）：
 *   1. 参数不在能力目录里 → 直接拒绝（不能让模型瞎编参数名）
 *   2. 参数是作者物理的输出 → 直接拒绝（驱动它会和物理打架，画面抽搐）
 *   3. 同一参数被两个动作重叠驱动（>15ms）→ 直接拒绝，除非显式 expression overlay
 *
 * 为什么把「compile」和「execute」拆开：校验失败时**根本不该执行**，
 * 只该把错误交回给模型让它改一次。合起来就只能"先做再发现问题"。
 *
 * 这份文件在两边各存一份同字节副本（插件 lib/ 与独立版 src/），
 * 用 md5 校验一致性 —— 不许一边改了另一边没改。
 */

export const PLAN_VERSION = 1
export const MAX_ACTIONS = 24
export const OVERLAP_EPSILON = 0.015 // 秒；比这短的重叠视为可忽略

const KINDS = ['look', 'nod', 'shake_head', 'expression', 'hold', 'param']
const DIRECTIONS = ['left', 'right', 'up', 'down', 'center']

export class PlanError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PlanError'
  }
}

/* ─────────────── 数值与曲线 ─────────────── */

function num(value, name, low, high) {
  if (typeof value === 'boolean' || typeof value !== 'number' || !Number.isFinite(value)) {
    throw new PlanError(`${name} 必须是有限数字`)
  }
  if (value < low || value > high) {
    throw new PlanError(`${name} 超出范围 ${low}..${high}`)
  }
  return value
}

const r5 = (v) => Math.round(v * 1e5) / 1e5
const r6 = (v) => Math.round(v * 1e6) / 1e6

/** 段间线性插值。点必须按时间升序（编译器保证）。 */
export function sampleTrack(track, t) {
  const pts = track.points
  if (!pts.length) return 0
  if (t <= pts[0][0]) return pts[0][1]
  const last = pts[pts.length - 1]
  if (t >= last[0]) return last[1]
  for (let i = 1; i < pts.length; i++) {
    const [t1, v1] = pts[i]
    if (t <= t1) {
      const [t0, v0] = pts[i - 1]
      const span = t1 - t0
      if (span <= 0) return v1
      const u = (t - t0) / span
      return v0 + (v1 - v0) * u
    }
  }
  return last[1]
}

/* ─────────────── 能力目录 ─────────────── */

/**
 * 校验能力目录的形状。目录由渲染端在模型加载后导出（真实 min/max/default），
 * 不能手写 —— 手写的那份一定会和模型的 moc3 漂开。
 */
export function checkCaps(caps) {
  if (!caps || typeof caps !== 'object') throw new PlanError('能力目录缺失（渲染端没导出）')
  const params = caps.params
  if (!params || typeof params !== 'object') throw new PlanError('能力目录里没有 params')
  const ids = Object.keys(params)
  if (!ids.length) throw new PlanError('能力目录里 params 是空的')
  for (const id of ids) {
    const p = params[id]
    if (!p || !Number.isFinite(p.min) || !Number.isFinite(p.max) || !Number.isFinite(p.default)) {
      throw new PlanError(`参数 ${id} 的 min/max/default 不完整`)
    }
    if (p.min > p.max) throw new PlanError(`参数 ${id} 的 min > max`)
  }
  return { params, physics: new Set(Array.isArray(caps.physics) ? caps.physics : []) }
}

/* ─────────────── 动作构造器 ─────────────── */

/** 保形 hold：从中立位缓入到目标值、停住、再缓回中立位。 */
function envelope(defaultValue, value, duration, fade) {
  const f = Math.min(fade, duration * 0.28)
  return [
    [0, defaultValue],
    [f, value],
    [duration - f, value],
    [duration, defaultValue],
  ]
}

/** 波浪：点头/摇头用。首尾都回到中立位，中间按 count 次来回。 */
function wavePoints(defaultValue, amp, duration, count) {
  const out = [[0, defaultValue], [0.12 * duration, defaultValue - amp * 0.16]]
  for (let n = 0; n < count; n++) {
    const st = 0.17 * duration + (n * 0.66 * duration) / count
    const w = (0.66 * duration) / count
    out.push([st, defaultValue])
    out.push([st + w * 0.32, defaultValue + amp * (1 - 0.1 * n)])
    out.push([st + w * 0.76, defaultValue - amp * 0.85])
  }
  out.push([duration, defaultValue])
  return out.sort((a, b) => a[0] - b[0])
}

/* ─────────────── 主函数 ─────────────── */

/**
 * @param {object} plan  {version:1, intent?, summary?, actions:[...]}
 * @param {object} caps  能力目录（渲染端导出）
 * @returns {{ok:true, tracks:Array, warnings:string[], ms:number} | {ok:false, error:string}}
 */
export function compilePlan(plan, caps) {
  try {
    return { ok: true, ...compileInner(plan, caps) }
  } catch (e) {
    const msg = e instanceof PlanError ? e.message : `编译失败：${(e && e.message) || e}`
    return { ok: false, error: msg }
  }
}

function compileInner(plan, caps) {
  const { params, physics } = checkCaps(caps)

  if (!plan || typeof plan !== 'object') throw new PlanError('动作计划必须是对象')
  if (plan.version !== PLAN_VERSION) throw new PlanError(`动作计划需要 version: ${PLAN_VERSION}`)

  const actions = plan.actions
  if (!Array.isArray(actions) || actions.length < 1 || actions.length > MAX_ACTIONS) {
    throw new PlanError(`actions 必须包含 1..${MAX_ACTIONS} 个动作`)
  }
  if (String(plan.intent || '').length > 2000) throw new PlanError('intent 过长（上限 2000 字）')
  if (String(plan.summary || '').length > 1000) throw new PlanError('summary 过长（上限 1000 字）')

  const tracks = []
  const warnings = []

  const add = (pid, start, duration, pointsIn, index, label, meta = {}) => {
    if (!(pid in params)) throw new PlanError(`模型没有参数 ${pid}`)
    if (physics.has(pid)) throw new PlanError(`${pid} 归作者物理控制，不能直接驱动`)
    const p = params[pid]
    const clipped = []
    let sawClamp = false
    for (const [t, v] of pointsIn) {
      if (!Number.isFinite(v)) throw new PlanError('参数曲线包含非有限值')
      const c = Math.max(p.min, Math.min(p.max, v))
      if (c !== v) sawClamp = true
      clipped.push([r5(t), r6(c)])
    }
    if (sawClamp) warnings.push(`${pid} 已限制到模型范围 ${p.min}..${p.max}`)

    // 通道冲突：同一参数被另一个动作重叠驱动
    for (const old of tracks) {
      if (old.id !== pid || old.action === index) continue
      const overlap =
        Math.min(old.start + old.duration, start + duration) - Math.max(old.start, start)
      if (overlap <= OVERLAP_EPSILON) continue
      // 显式 expression overlay 可以叠在主轨上（表情本来就是叠层）
      const overlayOk =
        !!meta.expression && meta.layer === 'overlay' && !old.expression && old.owner !== 'gesture'
      if (overlayOk) continue
      throw new PlanError(
        `动作 ${old.action + 1} 与 ${index + 1} 同时控制 ${pid}，请错开时间或改用 expression overlay`
      )
    }

    tracks.push({
      id: pid,
      start: r5(start),
      duration: r5(duration),
      points: clipped,
      action: index,
      label,
      owner: meta.expression ? 'expression' : 'semantic',
      stage: meta.expression ? 'expression' : 'param',
    })
  }

  let endMs = 0

  for (let index = 0; index < actions.length; index++) {
    const action = actions[index]
    if (!action || typeof action !== 'object') throw new PlanError('每个动作必须是对象')

    const kind = action.kind
    if (!KINDS.includes(kind)) throw new PlanError(`不支持的动作类型 ${kind}`)
    const at = num(action.at === undefined ? 0 : action.at, 'at', 0, 59)
    const duration = num(action.duration === undefined ? 2.5 : action.duration, 'duration', 0.2, 20)
    const strength = num(action.strength === undefined ? 0.6 : action.strength, 'strength', 0, 1)
    const count = action.count === undefined ? 1 : action.count
    if (!Number.isInteger(count) || count < 1 || count > 4) {
      throw new PlanError('count 必须是 1..4 的整数')
    }
    endMs = Math.max(endMs, at + duration)

    if (kind === 'look') {
      const direction = action.direction || 'center'
      if (!DIRECTIONS.includes(direction)) throw new PlanError('不支持的视线方向')
      const label = {
        left: '看向左侧', right: '看向右侧', up: '抬眼看上方',
        down: '低头看下方', center: '看向你',
      }[direction]
      const x = direction === 'left' ? -1 : direction === 'right' ? 1 : 0
      const y = direction === 'up' ? 1 : direction === 'down' ? -1 : 0
      const headDelay = Math.min(0.09, duration * 0.15)
      const bodyDelay = Math.min(0.19, duration * 0.3)

      // 局部保形：从中立位缓入、停住、缓回。delay 让头/身比眼珠慢半拍，
      // 这个错位就是「活人感」的来源（照抄鲸语的 head_delay / body_delay）。
      const hp = (pid, value, fade, delay) => {
        const d0 = delay || 0
        const p0 = params[pid]
        if (!p0) throw new PlanError(`模型没有参数 ${pid}（${label} 需要它）`)
        const dur0 = duration - d0
        add(pid, at + d0, dur0, envelope(p0.default, value, dur0, fade), index, label)
      }

      if (x !== 0 || direction === 'center') {
        hp('ParamEyeBallX', x * 0.75 * strength, 0.22)
        hp('ParamAngleX', x * 28 * strength, 0.28, headDelay)
        hp('ParamBodyAngleX', x * 14 * strength, 0.34, bodyDelay)
      }
      if (y !== 0) {
        hp('ParamEyeBallY', y * 0.6 * strength, 0.22)
        hp('ParamAngleY', y * 18 * strength, 0.28, headDelay)
      }
    } else if (kind === 'nod' || kind === 'shake_head') {
      const pid = kind === 'nod' ? 'ParamAngleY' : 'ParamAngleX'
      if (!(pid in params)) {
        throw new PlanError(`模型没有参数 ${pid}（${kind} 需要它）`)
      }
      if (duration < count * 0.45) {
        throw new PlanError('重复点头／摇头的时间太短，请至少每次 0.45 秒')
      }
      const label = kind === 'nod' ? `点头${count}次` : `轻轻摇头${count}次`
      const amp = (kind === 'nod' ? -15 : 20) * strength
      const d = params[pid].default
      // 物理输出参数不能驱动 —— add 会拦，这里先拦一次给出更清楚的措辞
      if (physics.has(pid)) {
        throw new PlanError(`${pid} 归作者物理控制，不能拿来做${kind}`)
      }
      add(pid, at, duration, wavePoints(d, amp, duration, count), index, label)
    } else if (kind === 'hold' || kind === 'param') {
      const pid = action.param
      if (typeof pid !== 'string' || !pid) throw new PlanError(`${kind} 动作需要 param 字段`)
      const p = params[pid]
      if (!p) throw new PlanError(`模型没有参数 ${pid}`)
      // 范围不在这里拦：交给 add 统一裁剪并记 warning。
      // 理由（照抄鲸语）：曲线在包络里本来就会略微越界，逐点裁剪是常态；
      // hold 的 value 若单独从严拒绝，会出现「同样的越界，曲线能过、显式值不能过」的双标。
      if (typeof action.value === 'boolean' || typeof action.value !== 'number' || !Number.isFinite(action.value)) {
        throw new PlanError('value 必须是有限数字')
      }
      const value = action.value
      const label = action.label || `${pid} = ${value}`
      add(pid, at, duration, envelope(p.default, value, duration, 0.42), index, label)
    } else if (kind === 'expression') {
      const name = action.name
      const exps = Array.isArray(caps.expressions) ? caps.expressions : []
      if (!name) throw new PlanError('expression 动作需要 name')
      if (exps.length && !exps.includes(name)) {
        throw new PlanError(`模型没有表情 ${name}（可用：${exps.join(', ')}）`)
      }
      // 表情走独立通道：标记 overlay，不占参数轨
      tracks.push({
        id: `expression:${name}`,
        start: r5(at),
        duration: r5(duration),
        points: [],
        action: index,
        label: `表情 ${name}`,
        owner: 'expression',
        stage: 'expression',
        expression: name,
      })
    }
  }

  if (!tracks.length) throw new PlanError('计划编译后没有任何可执行的轨道')
  tracks.sort((a, b) => a.start - b.start || a.action - b.action)
  return { tracks, warnings, ms: Math.round(endMs * 1000) }
}
