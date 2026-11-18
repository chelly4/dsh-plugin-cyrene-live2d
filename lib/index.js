/**
 * dsh-plugin-cyrene-live2d · 宿主半
 *
 * 职责：
 *   1. 静态资源  /cyrene-live2d/{model,runtime,vendor}/*  —— 只放行白名单前缀
 *   2. 状态路由  /cyrene-live2d/api/state                 —— 会话状态 + 余额 + 今日估算
 *   3. 语音路由  /cyrene-live2d/api/tts                   —— 代理本机 GPT-SoVITS
 *
 * 这份文件在 2026-10-29 被一次错误的 PowerShell 回写损坏过，已按原逻辑重写。
 * 教训：改这个文件只用 edit / write 工具，绝不要用 Get-Content -Raw + Set-Content
 * （PS 5.1 会按 GBK 解码 UTF-8，中文全烂并且吞掉换行）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import trimWav, { squeezeWav } from './wavtrim.js'
import { loadWorldbook, renderSection, dataStamp } from './worldbook.js'
// 米游社签到：移植自 Veersion/dsh-mys-checkin（MIT）。
// 放在 lib/mys/ 下原样保留它九个模块的结构，只改了数据目录（见 service.js）。
import { MysService } from './mys/service.js'
import { guardLocalRequest } from './http-guard.js'
import { checkCaps } from './l2d-plan.js'
import {
  emptyLedger,
  normalizeLedger,
  observeBalance,
  summaryOf,
  activeScope,
  recentDays,
  beijingDay,
} from './ledger.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', 'assets')
const PREFIX = '/cyrene-live2d'
const PACKAGE_ID = 'dsh-plugin-cyrene-live2d'

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
/**
 * 她的数据目录：`~/.dsh/cyrene-live2d/`。
 *
 * 用户 2026-11-01 原话：「记忆目录我建议弄到小昔涟的目录下」→
 * 后来又补：「**应该打包的东西都放到插件目录下，索引记得改**」。
 *
 * 所以这里不只是 memory.json —— 账本、偏好、自我认知、TTS 配置与日志
 * 全部收进来。散在 `~/.dsh` 根下的坏处是：那是公共区域，别的插件也在用，
 * 出问题时分不清是谁的文件、删的时候也不敢删。
 */
const DATA_DIR = path.join(DSH_HOME, 'cyrene-live2d')

/* ===== 单实例仲裁 owner.json（2026-11-05）=====
 *
 * 为什么需要：插件版和独立版（Tauri）可能同时开着。而「说话」「TTS 服务（显存）」
 * 「米游社签到（风控）」这三样**只能有一份**——两份一起跑就是她说两遍、显存抢爆、
 * 签到被风控。所以约一份 owner.json 当「谁在前台」的契约。
 *
 * 契约（独立版按同一格式读写即可，不需要新协议）：
 *   { kind: "plugin" | "standalone", pid, startedAt, heartbeatAt }
 * 判据：kind 不同 + pid 活着 + heartbeatAt 在 15 秒内 → 对方是主人，自己退成旁观。
 * 为什么要 pid + 心跳两个条件：只看 pid 会被 PID 复用骗；只看心跳，崩溃后要等 15 秒。
 */
const OWNER_FILE = path.join(DATA_DIR, 'owner.json')
const OWNER_TTL = 15000
const OWNER_STARTED_AT = Date.now()
let ownerTouchedAt = 0
// 宿主监听端口。DSH 每次重启都会变，独立版拿不到 DSH_WEB_URL 环境变量，
// 只能从这里读 —— 所以必须落进 owner.json。
// 为什么从 Host 头取：ctx.webServer.register 只给注册路由，不暴露监听端口。
let WEB_PORT = 0

function readOwner() {
  try {
    const o = JSON.parse(fs.readFileSync(OWNER_FILE, 'utf8'))
    if (!o || typeof o !== 'object') return null
    if (!Number.isFinite(Number(o.heartbeatAt))) return null
    return o
  } catch {
    return null
  }
}

function pidAlive(pid) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0) return false
  try {
    process.kill(n, 0)
    return true
  } catch (e) {
    // EPERM = 进程在，只是没权限发信号（别的用户/提权进程）
    return Boolean(e && e.code === 'EPERM')
  }
}

/** 插件申报心跳。节流 2 秒 —— /api/state 是 1.2 秒轮询，不节流会一直写盘。 */
function touchOwner() {
  const now = Date.now()
  if (now - ownerTouchedAt < 2000) return
  ownerTouchedAt = now

  // ★ 端口权威文件（2026-11-06）：不管谁是主人，插件都知道自己的真实端口。
  //   为什么和 owner.json 分开：独立版当主人时会整个覆盖 owner.json（还可能带着过期端口），
  //   而 host-port.json 只由插件写、独立版只读 —— 它永远不会被写回旧值。
  //   DSH 每次重启端口都会变，没有这个文件，独立版就只能靠过期缓存猜。
  try {
    if (WEB_PORT > 0) {
      const hp = path.join(DATA_DIR, 'host-port.json')
      const tmp2 = hp + '.tmp'
      fs.writeFileSync(
        tmp2,
        JSON.stringify({ base: 'http://127.0.0.1:' + WEB_PORT, savedAt: now }),
        'utf8',
      )
      fs.renameSync(tmp2, hp)
    }
  } catch {}

  // ★ 独立版在主人位时**不要写** owner.json：两边都写就是互相覆盖，owner 判定会来回抖，
  //   插件会在 L0/L1 之间反复切换（表现：她一会儿说话一会儿不说话）。
  try {
    const o = readOwner()
    if (
      o &&
      o.kind === 'standalone' &&
      Date.now() - Number(o.heartbeatAt) < OWNER_TTL &&
      pidAlive(o.pid)
    ) {
      return
    }
  } catch {}
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = OWNER_FILE + '.tmp'
    fs.writeFileSync(
      tmp,
      JSON.stringify({
        kind: 'plugin',
        pid: process.pid,
        startedAt: OWNER_STARTED_AT,
        heartbeatAt: now,
        // 独立版靠这个找到宿主；还没收到过请求时是 0，收到一次就有了
        port: WEB_PORT || 0,
      }),
      'utf8',
    )
    fs.renameSync(tmp, OWNER_FILE)
  } catch {}
}

/** 谁是主人。other 非空 = 独立版在前台，插件应当静音、不调 TTS、不跑签到。 */
function ownerStatus() {
  const o = readOwner()
  if (!o || o.kind === 'plugin') return { mine: true, other: null }
  const fresh = Date.now() - Number(o.heartbeatAt) < OWNER_TTL
  const alive = pidAlive(o.pid)
  const otherAlive = fresh && alive
  return { mine: !otherAlive, other: otherAlive ? o : null }
}


/** 页面体检快照：只留最近 3 份，够看「这次和上次差在哪」。 */
const DIAG_FILE = path.join(DATA_DIR, 'diag.json')
const DIAG_KEEP = 3

/** 读体检快照（文件坏了就当没有，不影响任何功能）。 */
function readDiag() {
  try {
    const j = JSON.parse(fs.readFileSync(DIAG_FILE, 'utf8'))
    return Array.isArray(j && j.entries) ? j.entries : []
  } catch { return [] }
}

/**
 * 追加一份体检快照。
 * 只收**已经限长**的字段（页面那边压到 96 KB 以内），这里再兜一层：
 * 拿掉明显不该落盘的东西（Cookie / 绝对路径），保留最近 DIAG_KEEP 份。
 */
function appendDiag(payload) {
  const entries = readDiag()
  const safe = JSON.parse(JSON.stringify(payload || {}))
  const scrub = (v) => {
    if (typeof v === 'string') {
      return v
        .replace(/[A-Za-z]:\\\\?Users\\\\?[^\\\\\/]+/gi, '~')
        .replace(/((?:ltoken|stoken|cookie_token|miHoYo)["']?\s*[:=]\s*["']?)[^"'\s,&]+/gi, '$1***')
        .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, '***JWT***')
        .slice(0, 4000)
    }
    if (Array.isArray(v)) return v.slice(0, 80).map(scrub)
    if (v && typeof v === 'object') {
      const out = {}
      for (const k of Object.keys(v).slice(0, 200)) out[k] = scrub(v[k])
      return out
    }
    return v
  }
  entries.push({ at: new Date().toISOString(), ...scrub(safe) })
  while (entries.length > DIAG_KEEP) entries.shift()
  writeJsonAtomic(DIAG_FILE, { entries })
  return entries.length
}

const USAGE_FILE = path.join(DATA_DIR, 'usage.json')
const TTS_CONF_FILE = path.join(DATA_DIR, 'tts.json')
/** 余额观测账本：和 token 估算分开存，谁也不覆盖谁。 */
const LEDGER_FILE = path.join(DATA_DIR, 'ledger.json')
/** 卡点账本：同一类报错出现过几次、最早是什么时候。只存归一化后的报错本身。 */
const FAILS_FILE = path.join(DATA_DIR, 'fails.json')
/**
 * 客户端偏好的落盘处。
 *
 * 为什么非要存到这边来：客户端的 localStorage 是按 origin 隔离的，而 DSH 桌面版
 * 每次重启端口都会变，端口就在 origin 里 —— 于是浏览器每次看到的都是一份全新的
 * 空存储。位置和语音开关还能靠「默认值本身就对」兜住，可账本、花费档位、
 * 「昨天那一页」这些天然必须连续的东西兜不住，只能在这儿存。
 */
const PREFS_FILE = path.join(DATA_DIR, 'prefs.json')
/** 偏好文件上限：这只是几个界面开关，不该长成数据库。 */
const PREFS_MAX = 64 * 1024
/**
 * 她的记忆（关系层）。
 *
 * 只管「我和你之间的事」：欠着的事、她的承诺、重复出现的模式、你划的边界。
 * **不记情绪、不记分数** —— 任何要打分的东西都不该进这里。
 * 项目上的结论归 meow-memory，两套刻意不重叠：那边回答「我们定过什么」，
 * 这里只回答「她和你之间发生过什么、还欠着什么」。
 */
const MEM_FILE = path.join(DATA_DIR, 'memory.json')
/**
 * 桌面足迹：由独立版（Electron 壳）采集并写入，插件只读。
 *
 * 为什么走同一个目录：两者本来就共享 `~/.dsh/cyrene-live2d/`，
 * 独立版直接写这一个文件就够了 —— 不需要额外通道，也不需要「再同步一份给人看的 md」。
 *
 * 只允许「元数据」：活动时长、首次/最近活动时间、启动次数。
 * **绝不写窗口标题、文件路径、剪贴板内容** —— 那些比元数据危险得多。
 */
const ENV_FILE = path.join(DATA_DIR, 'env.json')
/**
 * 独立版「记事」：`{ items: [{ what, at }] }`
 *
 * 与 env.json 的分工：
 *   env.json         机器算出来的**客观量**（活动时长、连续段），独立版每 55 秒覆盖写
 *   standalone-notes 独立版想让她**记住的一句话**（最多 12 条，旧的自动挤掉）
 *
 * 为什么分成两个文件：一个高频覆盖、一个低频追加，混在一起会互相踩。
 */
const EXTRA_FILE = path.join(DATA_DIR, 'standalone-notes.json')
/** 自我认知：她对自己的叙述，只在新会话第一次唤醒时注入一次。 */
const SELFNOTE_FILE = path.join(DATA_DIR, 'selfnote.json')
/**
 * 注入统计 + 激活分（2026-11-06，借自原版 cyrene-agent 的 DMAE `promptThreshold`）。
 *
 * 治的病：`env.json`（你今天坐了 5 小时）和 `standalone-notes` 这类背景信息
 * **每个新会话都原样注入一遍**，同样的内容念到第三遍就是噪音。
 *
 * 机制（只借两个数，不搬那 7.4 KB 的引擎）：
 *   base 100 · 新鲜度因子（刚注入过 ×0.2，隔 24h ×1）
 *   · 重复饱和（注入越多越低，指数 2、窗口 6）
 *   · 分数 < 30 就不注入
 */
const INJECT_STATS_FILE = path.join(DATA_DIR, 'inject-stats.json')
const INJECT_THRESHOLD = 30

function readInjectStats() {
  try {
    const j = JSON.parse(fs.readFileSync(INJECT_STATS_FILE, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

function writeInjectStats(stats) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = INJECT_STATS_FILE + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(stats), 'utf8')
    fs.renameSync(tmp, INJECT_STATS_FILE)
  } catch {}
}

/** 算某个信息块现在的激活分（0–100）。 */
function injectActivation(kind) {
  const e = readInjectStats()[kind] || {}
  const lastAt = Number(e.lastAt) || 0
  // count 是「今天注入了几次」—— 跨天自动归零。
  // 不这么做的后果：累计到第 6 次之后 repeat 封顶，分数永远压在 30 以下，
  // 「今天的足迹」就再也念不出来了（这条 2026-11-06 试算时发现）。
  const count = e.day === todayKey() ? Number(e.count) || 0 : 0
  const ageH = lastAt ? (Date.now() - lastAt) / 3600000 : 999
  const fresh = ageH < 1 ? 0.2 : ageH < 6 ? 0.5 : ageH < 24 ? 0.8 : 1
  // 重复饱和：参照原版 satPower=2 / repeatWindow=6 —— 当天第 6 次之后基本压到底
  const repeat = Math.min(0.8, Math.pow(Math.min(1, count / 6), 2))
  return Math.round(100 * fresh * (1 - repeat))
}

/** 本地日期键（和面板/账本同一个口径，不用 UTC）。 */
function todayKey() {
  const d = new Date()
  return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()
}

/** 记录一次「真的注入了」。 */
function noteInjected(kind) {
  const s = readInjectStats()
  const e = s[kind] || {}
  const day = todayKey()
  s[kind] = {
    count: (e.day === day ? Number(e.count) || 0 : 0) + 1,
    lastAt: Date.now(),
    day,
  }
  writeInjectStats(s)
}
/** 自定义素材（表情包 / 背景图的用户上传件）。 */
const CUSTOM_DIR = path.join(DATA_DIR, 'custom')
/** GPT-SoVITS 子进程的日志（>4MB 会轮转成 .1）。 */
const GSV_LOG = path.join(DATA_DIR, 'tts.log')
const GSV_ERR = path.join(DATA_DIR, 'tts.err.log')

/**
 * 旧位置（`~/.dsh` 根下）对照表。
 *
 * 第一版所有文件都散在根下，2026-11-01 统一收进 `cyrene-live2d/`。
 * 这里只为「**读一次、搬过来**」：新位置已经有东西就不动，没有才从旧位置拷。
 *
 * 为什么用 copy 不用 move：
 * ① 旧文件留着当保险，哪天想回头还能找到；
 * ② 搬失败（文件被占用 / 权限）时新位置没被写坏，行为退化成「还是读旧的那份」。
 */
const LEGACY_MAP = {
  [USAGE_FILE]: path.join(DSH_HOME, 'cyrene-live2d-usage.json'),
  [TTS_CONF_FILE]: path.join(DSH_HOME, 'cyrene-live2d-tts.json'),
  [LEDGER_FILE]: path.join(DSH_HOME, 'cyrene-live2d-ledger.json'),
  [FAILS_FILE]: path.join(DSH_HOME, 'cyrene-live2d-fails.json'),
  [PREFS_FILE]: path.join(DSH_HOME, 'cyrene-live2d-prefs.json'),
  [MEM_FILE]: path.join(DSH_HOME, 'cyrene-live2d-memory.json'),
  [SELFNOTE_FILE]: path.join(DSH_HOME, 'cyrene-live2d-selfnote.json'),
}

/** 把旧位置的数据搬进 `cyrene-live2d/`。幂等：新位置已有就跳过。 */
function adoptLegacyData() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }) } catch {}
  for (const key of Object.keys(LEGACY_MAP)) {
    const next = key
    const prev = LEGACY_MAP[key]
    try {
      if (fs.existsSync(next)) continue
      if (!fs.existsSync(prev)) continue
      fs.copyFileSync(prev, next)
    } catch {}
  }
}

/** 四类各自的上限：满了淘汰最旧的。设上限是为了它永远长不成数据库。 */
// 六桶：关系四桶（她的）+ 工作两桶（他的活）
//
// 为什么加 workspace / lessons（2026-11-05）：
//   四桶记的全是「她和你之间」（边界/承诺/待办/重复），没有一条能记「这个项目用 Vite」。
//   而这类工作结论恰恰是最需要跨会话留住的 —— 以前靠 meow-memory 兜着，
//   但那个插件不能要求别人也装（打包出去别人不一定有）。
//
// 为什么用 JSON 而不是 SQLite：数据量就几百条；而 node:sqlite 要求 Node ≥22.5，
// 打包给别人时版本不够会直接崩。零依赖这条红线不能破。
const MEM_CAP = { pending: 8, promises: 4, boundaries: 6, counts: 20, workspace: 60, lessons: 30, profile: 12 }
/** 单条内容上限：她记的是「一句话」，不是一段文档。 */
const MEM_TEXT_MAX = 80
// 来源原话的上限：只给「看一眼对得上号」用，不进上下文，所以可以比 what 长一点
const MEM_SRC_MAX = 120

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const ASK_TOOL = 'ask_user_question'
const BALANCE_TTL = 60 * 1000
const DONE_WINDOW = 9000

/** 宿主半的构建标记：用来判断 /api/state 跑的是不是磁盘上这一份代码（热重载有没有发生）。 */
const BUILD = 'cyrene-host-2026-11-07d'

/**
 * 世界书注入：紧跟在她自己的人格 section 后面一格。
 * 放在人设之后，是为了让「人设」那段前缀保持稳定 —— 世界书每轮都可能变，
 * 变了只该让尾部重发，不该把整个系统提示词的缓存打掉。
 *
 * 2026-10-31：order 不再写死 150。人格 section 挪到「部署人格后缀」后面之后
 * （见 resolvePersonaOrder），世界书必须跟着走，否则它会孤零零留在很前面。
 */
const WB_ORDER_OFFSET = 1
/** 参与匹配的最近消息条数（用户 + 助手），以及单条截断长度。 */
const WB_KEEP = 6
const WB_ONE = 400

/**
 * 提问接管（user-questions/request waterfall）的超时。
 * 单题 60 秒；一批多题每多一题加 20 秒 —— 三题就是 100 秒，
 * 否则「逐题问」还没问到第二题就超时了，用户会觉得她抢了题又不给答。
 */
const ASK_TIMEOUT = 60 * 1000
const ASK_STEP_TIMEOUT = 20 * 1000

/**
 * 风险审批（approval/request waterfall）的等待时长。
 * 一次决定，60 秒不点就交还网页卡片 —— 审批卡不能一直挂在那儿等人。
 */
const APPROVAL_TIMEOUT = 60 * 1000

/**
 * 客户端「还活着」的判据：它每 3 秒来取一次 /api/state。
 * 超过这个时间没动静（页面关了、标签在后台被冻住、插件被卸载），
 * 就不要接管提问 —— 接管了也没人答，只能等到超时，白白拖住 Agent。
 */
const ASK_CLIENT_TTL = 15000

/** 记住最近若干个会话，用来找「有任务清单的那个」—— 子代理的会话通常没有 todos。 */
const SESSION_KEEP = 8

/** 失败亮表情的窗口：一轮失败后这么久内报 'failed'，之后自动回到 idle/done。 */
const FAIL_WINDOW = 20000

/** apply 里拿到的宿主 ctx，turn/end 时要靠它强制刷一次余额。 */
let HOST_CTX = null

/**
 * 现在有几个会话被归档了。
 *
 * DSH 核心**没有**「归档发生了」这个事件 —— 只有 `workspaceRegistry` 上的一个
 * id 数组（`archivedSessionIds`，不带时间戳）。所以客户端只能拿这个数字做差异
 * 检测：「变多了 = 刚归档了一个」。
 *
 * 用 `ctx.get('workspaceRegistry')` 而不是把服务写进 inject：拿不到时返回
 * `undefined`，我们退回 -1，客户端就永远不播 —— 少一个能力，不影响别处。
 * 返回值约定：>= 0 是真数字；-1 表示「这个 DSH 没有那个服务」。
 */
function archivedCount() {
  try {
    const ctx = HOST_CTX
    if (!ctx || typeof ctx.get !== 'function') return -1
    const reg = ctx.get('workspaceRegistry')
    const ids = reg && reg.archivedSessionIds
    return Array.isArray(ids) ? ids.length : -1
  } catch {
    return -1
  }
}

const MIME = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.moc3': 'application/octet-stream',
  '.css': 'text/css; charset=utf-8',
  // 以前没这两条，wav 一律发成 octet-stream —— 浏览器能放，但类型是不对的
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  // 2026-11-08 语音容器换成 opus（350 条 88MB → 6.1MB）：opus 装在 ogg 容器里，浏览器按 audio/ogg 认
  '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
}

/** 静态资源白名单：只发这几个前缀下的文件，别的统一 403。 */
const ALLOWED = ['/runtime/', '/vendor/', '/model/', '/voice/', '/meme/', '/background/', '/video/', '/voice-ext/']

// ───────────────────────────── 定价 ─────────────────────────────
// 单位：人民币 / 百万 token。数组 = [空闲时段, 高峰时段]；高峰价是空闲价的两倍。
// 高峰 = 工作日北京时间 09:00–12:00、14:00–18:00；2026-08-23 起周末全天按谷价。
const PRICING = {
  flash: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },
  pro: { hit: [0.15, 0.3], miss: [4.5, 9], out: [13.5, 27] },
}

/** 高栏模型的识别：pro 是 DSH 的叫法，reasoner/r1/v3.2-exp 这类也按高栏算。 */
const PRO_RE = /pro|reasoner|thinking|r1\b|v3\.2|max/i

function priceFor(model) {
  return PRO_RE.test(String(model || '')) ? PRICING.pro : PRICING.flash
}

/**
 * 从事件里挖出模型名。DSH 不同版本的字段位置不太一样，
 * 所以按可能性从高到低逐个试，拿到第一个非空的就收手。
 */
function modelOf(d, session) {
  const cands = [
    d && d.message && d.message.source && d.message.source.model,
    d && d.message && d.message.source && d.message.source.modelId,
    d && d.message && d.message.model,
    d && d.source && d.source.model,
    d && d.model,
    d && d.modelId,
    d && d.meta && d.meta.model,
    session && session.model,
    session && session.modelId,
    session && session.settings && session.settings.model,
    session && session.meta && session.meta.model,
  ]
  for (const c of cands) {
    const s = String(c == null ? '' : c).trim()
    if (s) return s.slice(0, 60)
  }
  return ''
}

/**
 * 是否处于高峰时段（按北京时间判断，和系统时区无关）。
 *
 * 规则来源：https://api-docs.deepseek.com/quick_start/pricing（2026-11-03 核对）
 *   「Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through Friday,
 *    excluding Chinese public holidays. All other hours are off-peak,
 *    including weekends and Chinese public holidays in full.」
 *   → 换算成北京时间：工作日 9–12、14–18。
 *
 * 已知缺口（**故意不补**）：不判中国法定节假日，落在工作日的国庆/春节会被
 * 算成高峰、价格翻倍。补它要维护一张每年都变的假期表（还有调休），换来的
 * 只是「一年几天不误报」，不划算。
 *
 * 为什么会写成硬编码：官方**没有**「现在是峰还是谷」的接口 ——
 * /user/balance 只返余额，DSH 自己的 dsh-token-meter 只算 token 不算钱。
 * 所以规则一变，只能手动改这里，而且它错的时候界面看上去完全正常
 * （永远会显示一个「峰」或「谷」）。改之前请重新核对上面那个链接。
 */
function isPeak(ts) {
  try {
    const bj = new Date(Number(ts) + 8 * 3600 * 1000)
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
    const h = bj.getUTCHours()
    return (h >= 9 && h < 12) || (h >= 14 && h < 18)
  } catch {
    return false
  }
}

/** 北京时间的日期字符串（yyyy-mm-dd），用来跨天重置。 */
function bjDay(ts) {
  const bj = new Date(Number(ts || Date.now()) + 8 * 3600 * 1000)
  return bj.toISOString().slice(0, 10)
}

// ───────────────────────── 缓存账单 ─────────────────────────
//
// 口径抄自 dsh-cache-billing（MIT，better-er），代码自己写 —— 三个理由：
// ① 它要求 engines.node >= 26，本机是 24；②装上就是两套账，数字对不上最难查；
// ③ 它的费率和我们 PRICING 本来就一致，差的只是「按步分组」和「按事件时刻逐笔算」。
//
// 三级账：step（一次 API 调用）/ turn（一条用户消息内的多步）/ session（整个会话）。
// **按事件时刻的峰谷费率逐笔累加**，不用当前时钟 —— 一条半夜跑完的轮次不会因为结算在
// 白天而被算成峰价。
// 「完全失效」= 有输入但 cacheRead 为 0（整条上下文缓存没吃上，任何路由都可靠）；
// 「缓存失效」= cacheWrite > 0（官方不报写入，个别中转才有值）。
function emptyBill() {
  return {
    step: null,
    turn: null,
    totals: {
      hitCost: 0,
      missCost: 0,
      outCost: 0,
      hitTok: 0,
      inTok: 0,
      outTok: 0,
      steps: 0,
      fullMiss: 0,
      writeMiss: 0,
    },
  }
}

/**
 * 记一笔 step 样本。
 * 只用 assistant/message 一条事件（每个 step 一条），不做 chunk 替换 ——
 * 我们没订阅 chunk，也就没有「同 step 两个样本」的问题。
 */
function updateBill(sessionId, turnNo, model, ts, input, cache, write, output) {
  try {
    if (!state.bills) state.bills = new Map()
    const key = String(sessionId || 'default')
    let b = state.bills.get(key)
    if (!b) {
      b = emptyBill()
      state.bills.set(key, b)
    }
    const p = priceFor(model)
    const off = isPeak(ts) ? 1 : 0
    const hit = (cache / 1e6) * p.hit[off]
    const miss = ((input + write) / 1e6) * p.miss[off]
    const out = (output / 1e6) * p.out[off]
    const inTok = input + cache + write

    b.step = { turn: turnNo, ts, hitTok: cache, inTok, outTok: output, hit, miss, out }

    if (!b.turn || b.turn.id !== turnNo) {
      b.turn = { id: turnNo, hitCost: 0, missCost: 0, outCost: 0, hitTok: 0, inTok: 0, outTok: 0 }
    }
    b.turn.hitCost += hit
    b.turn.missCost += miss
    b.turn.outCost += out
    b.turn.hitTok += cache
    b.turn.inTok += inTok
    b.turn.outTok += output

    const t = b.totals
    t.hitCost += hit
    t.missCost += miss
    t.outCost += out
    t.hitTok += cache
    t.inTok += inTok
    t.outTok += output
    t.steps += 1
    if (inTok > 0 && cache === 0) t.fullMiss += 1
    if (write > 0) t.writeMiss += 1
  } catch {}
}

/** 给 /api/state 的账单视图：金额按级别取整（步 4 位、轮 3 位、会话 2 位），和那个插件一致。 */
function billView(sessionId) {
  try {
    const b = state.bills && sessionId ? state.bills.get(String(sessionId)) : null
    if (!b) return null
    const r = (n, d) => Number(Number(n || 0).toFixed(d))
    const s = b.step
    const g = b.turn
    const t = b.totals
    return {
      step: s
        ? {
            turn: s.turn,
            hitCost: r(s.hit, 4),
            missCost: r(s.miss, 4),
            outCost: r(s.out, 4),
            hitTok: s.hitTok,
            inTok: s.inTok,
            outTok: s.outTok,
            tier: isPeak(s.ts) ? 'peak' : 'offPeak',
          }
        : null,
      turn: g
        ? {
            id: g.id,
            hitCost: r(g.hitCost, 3),
            missCost: r(g.missCost, 3),
            outCost: r(g.outCost, 3),
            hitTok: g.hitTok,
            inTok: g.inTok,
            outTok: g.outTok,
          }
        : null,
      totals: {
        hitCost: r(t.hitCost, 2),
        missCost: r(t.missCost, 2),
        outCost: r(t.outCost, 2),
        hitTok: t.hitTok,
        inTok: t.inTok,
        outTok: t.outTok,
        steps: t.steps,
        fullMiss: t.fullMiss,
        writeMiss: t.writeMiss,
      },
      model: String(state.model || ''),
    }
  } catch {
    return null
  }
}

// ───────────────────────────── 状态 ─────────────────────────────
const state = {
  wait: null, // { kind:'question'|'approval', id, ts }
  sessionName: '',
  lastSession: null,
  turns: new Map(), // sessionId -> { turn, tokens, cost, lastTs }
  lastTurn: null, // { turn, cost, tokens, at }
  today: { day: '', tokens: 0, cost: 0, turns: 0 },
  balance: null,
  balanceAt: 0,
  balanceBusy: false,
  ledger: emptyLedger(), // 余额观测账本（按账户/密钥分本）
  ledgerScope: '', // 最近一次记账用的 scope
  accountProbe: null, // 账户余额探测的现场记录，排查用
  model: '', // 当前模型名
  modelAt: 0,
  modelProbe: null, // 只记第一次，用来看字段形状有没有变
  tts: { alive: null, checkedAt: 0, failStreak: 0 },
  ttsLog: [], // 最近若干次 /api/tts 请求：{ at, text, ok, note }
  ttsRecent: [], // 同文本去重用：{ text, at }
  ttsInflight: 0, // 正在合成的路数，用来挡住「多实例同时开口」
  // 自己拉起来的 GPT-SoVITS 子进程：DSH 开它就开，DSH 关它就关。
  // proc 只记自己生的那一个 —— 如果 9880 本来就是你手动起的，这里永远是 null，退出时也不会去杀别人的进程。
  // 只管启动这一次：它中途挂了不重拉，免得把你刻意关掉的东西又偷偷叫醒。
  gsv: { proc: null, pid: 0, tries: 0, shuttingDown: false },
  fail: null, // { at, note } —— 最近一次失败，phase 会短暂报 'failed'
  turnFail: null, // 本轮的失败现场 { note, at }，turn/end 时才把 fail 点亮
  lastTool: null, // { name, at, id, seq } —— 最近一次工具调用，客户端按它分词感
  toolSeq: 0, // 工具调用序号，只增不减
  // 任务进度：读 todos 会话投影。只读展示，不改任何东西。
  todos: null, // [{ content, status }] —— 最近一个「有任务」的会话的清单
  todosAt: 0, // 这份清单是什么时候读到的
  todosSession: '', // 它出自哪个会话，排查用
  sessions: [], // 最近若干个会话对象，找 todos 要挨个问
  projProbe: '', // 拿 sessionProjections 服务的结果（排查用）
  todoProbe: '', // 每个会话 stateOf('todos') 的结果（排查用）
  // 提问接管：客户端在气泡里逐题问，答完一次性回传
  ask: null, // 正在等的提问（settle/timer/signal 都在里面，不序列化给客户端）
  askSeq: 0,
  approval: null, // 正在等的风险审批，形状同上
  approvalSeq: 0,
  askLog: [], // 最近若干次接管的流水，排查用
  pollAt: 0, // 客户端最近一次来取 /api/state 的时间
  // 世界书：61 条翁法罗斯设定，按最近对话的关键词挑几条注入
  wbEntries: null, // 解析好的条目表，apply 时读一次
  wbFiles: [], // 读到哪几份文件，排查用
  wbRecent: [], // 最近几条消息文本，拼起来当关键词池
  wbText: '', // 当前挂上去的正文，用于「没变就不重挂」
  // 冻结：同一会话里世界书只算一次，保住 system prompt 的前缀缓存。
  // 它每变一次（哪怕只是命中条目的组合换了一条），从它往后的工具文档
  // 全部要重新计费 —— 那比「话题稍微不准」贵得多（缓存命中约为新输入的 1/10）。
  wbFrozenSid: '', // 冻结在哪一个会话上；换会话或条目文件变了就解锁
  wbFrozenText: '', // 冻结住的那一份正文
  wbDispose: null, // section 的卸载函数
  wbProbe: '', // 最近一次重挂的结果，排查用
  wbStamp: '', // 数据目录指纹：变了就自动重读，不用重启
  wbStatAt: 0, // 上次 stat 的时间（5 秒节流）
  // 卡点账本：items 是归一化后的报错指纹 + 次数；repeat 是「这一次撞上的是旧账」
  fails: { items: [], repeat: null },
}

/**
 * 从各种事件形状里认出「这一下失败了」。
 * DSH 的事件字段以后可能改，所以这里把常见的几种标志位都认一遍；
 * 一个都认不到就当成功 —— 宁可漏报，也不能把正常完成说成失败。
 */
function errorOf(d) {
  if (!d || typeof d !== 'object') return ''
  const bad =
    d.isError === true ||
    d.error === true ||
    d.failed === true ||
    /^(error|failed|failure)$/i.test(String(d.status || '')) ||
    // d.error 是字符串时（多数工具的错误形状），非空就算失败
    (typeof d.error === 'string' && d.error.trim() !== '')
  if (!bad) return ''
  const msg =
    (typeof d.error === 'string' && d.error) ||
    (typeof d.message === 'string' && d.message) ||
    (typeof d.reason === 'string' && d.reason) ||
    ''
  return String(msg).trim().slice(0, 120) || 'failed'
}

function markFail(note) {
  const at = Date.now()
  state.turnFail = { note: String(note || 'failed').slice(0, 120), at }
  // 回合外报的错（后台任务、定时器）也得能亮出来
  if (state.turns.size === 0) state.fail = state.turnFail
}

// ───────────────────────── 卡点账本 ─────────────────────────
/**
 * 同一类报错反复出现，是「真卡住了」最硬的信号。
 *
 * 这里只做本地记账：把报错归一化（路径、十六进制、数字都抹平）后按指纹计数。
 * 全程不调用模型 —— 所以这部分是零 token 的。
 * 没做的那一半：「上次是怎么修好的」。那需要同时记录修复动作并把两者对上，
 * 对不上就会变成瞎猜，宁可不做。
 */
const FAILS_MAX = 40

function failKey(text) {
  const norm = String(text || '')
    .split('\n')[0]
    .replace(/[A-Za-z]:\\[^\s'"]*/g, '<path>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160)
  if (norm === '') return ''
  return createHash('md5').update(norm).digest('hex').slice(0, 12)
}

function loadFails() {
  try {
    const raw = fs.readFileSync(FAILS_FILE, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    const items = Array.isArray(j && j.items) ? j.items : []
    state.fails = {
      items: items
        .filter((x) => x && typeof x.key === 'string')
        .map((x) => ({
          key: String(x.key),
          sample: String(x.sample || '').slice(0, 200),
          tool: String(x.tool || '').slice(0, 40),
          count: Math.max(1, Number(x.count) || 1),
          firstAt: Number(x.firstAt) || 0,
          lastAt: Number(x.lastAt) || 0,
        })),
      repeat: null,
    }
  } catch {
    state.fails = { items: [], repeat: null }
  }
}

let failsSaveTimer = null
function saveFails() {
  if (failsSaveTimer) return
  failsSaveTimer = setTimeout(() => {
    failsSaveTimer = null
    writeJsonAtomic(FAILS_FILE, { items: state.fails.items })
  }, 1500)
}

/** 记一笔失败，返回这次的复发信息。count >= 2 就说明不是第一次栽在这儿了。 */
function noteFail(text, tool) {
  const sample = String(text || '').trim().slice(0, 200)
  const key = failKey(sample)
  if (key === '') return null
  const at = Date.now()
  let item = state.fails.items.find((x) => x.key === key)
  if (item) {
    item.count += 1
    item.lastAt = at
    if (tool) item.tool = String(tool).slice(0, 40)
  } else {
    item = { key, sample, tool: String(tool || '').slice(0, 40), count: 1, firstAt: at, lastAt: at }
    state.fails.items.push(item)
    if (state.fails.items.length > FAILS_MAX) {
      state.fails.items.sort((a, b) => b.lastAt - a.lastAt)
      state.fails.items.length = FAILS_MAX
    }
  }
  state.fails.repeat = {
    key,
    count: item.count,
    tool: item.tool,
    firstAt: item.firstAt,
    lastAt: at,
    sample: item.sample,
  }
  saveFails()
  return state.fails.repeat
}

// ───────────────────────────── 用量持久化 ─────────────────────────────
function loadUsage() {
  try {
    const raw = fs.readFileSync(USAGE_FILE, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    if (j && typeof j === 'object') {
      state.today = {
        day: String(j.day || bjDay()),
        tokens: Number(j.tokens) || 0,
        cost: Number(j.cost) || 0,
        turns: Number(j.turns) || 0,
      }
      if (j.lastTurn && typeof j.lastTurn === 'object' && Number(j.lastTurn.at) > 0) {
        state.lastTurn = {
          turn: Number(j.lastTurn.turn) || 0,
          cost: Number(j.lastTurn.cost) || 0,
          tokens: Number(j.lastTurn.tokens) || 0,
          at: Number(j.lastTurn.at),
        }
      }
      if (j.sessionName) state.sessionName = String(j.sessionName).slice(0, 120)
      // 模型也一起恢复。为什么需要：`state.model` 平时是从 `assistant/message`
      // 事件里拿的，而重启后到第一次聊天之间没有任何事件 —— 余额卡会显示「未知」。
      // 存过一份就能先把「上次用的是哪个模型」显示出来，聊一句后被真实值覆盖。
      if (j.model) state.model = String(j.model).slice(0, 80)
    }
  } catch {}
  if (state.today.day !== bjDay()) {
    state.today = { day: bjDay(), tokens: 0, cost: 0, turns: 0 }
  }
}

/**
 * 崩溃安全写文本：先写 `.tmp`、**fsync 落盘**、再 rename；rename 失败顺手清 tmp。
 *
 * 为什么 rename 之前必须 fsync：rename 只保证「名字指向哪个 inode」是原子的，
 * 不保证 tmp 的内容已经写进物理盘 —— 断电时可能出现「新名字 + 空内容」。
 * 为什么 rename 失败要删 tmp：Windows 上杀毒/网盘/编辑器占着文件时 rename 会抛 EPERM，
 * 不删的话 `.tmp` 会一直堆着（用户看到的就是一堆 `memory.json.tmp`）。
 */
function writeTextDurable(file, text) {
  const tmp = file + '.tmp'
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const buf = Buffer.from(text, 'utf8')
    const fd = fs.openSync(tmp, 'w')
    try {
      // 检查「真的写完了」：磁盘满等情况下 POSIX 允许部分写，
      // 只写一半也会 fsync + rename「成功」，结果是一份半截 JSON。
      const written = fs.writeSync(fd, buf, 0, buf.length)
      if (written !== buf.length) throw new Error('short write ' + written + '/' + buf.length)
      try {
        fs.fsyncSync(fd)
      } catch {}
    } finally {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.renameSync(tmp, file)
    } catch (e) {
      try {
        fs.unlinkSync(tmp)
      } catch {}
      throw e
    }
    return true
  } catch {
    return false
  }
}

/**
 * 崩溃安全地写一个 JSON 文件。
 *
 * 为什么所有数据文件都该走这里：直接 `writeFileSync` 到目标文件时，
 * 写到一半断电 / 被杀 / 磁盘满 = JSON 截断 = 内容全丢。
 *
 * 这是这个项目里唯一不可逆的风险点：别的坏了都能重来，记忆和账本坏了就没了。
 */
/* ───────── 注入报账（2026-11-08，借 Lutisure/cyrene-agent 的 receipts-logic）─────────
 * 记忆/足迹每轮注入两三行，但**没有任何东西知道它们有没有起作用**。
 * 没有这一层，「哪些条目是白给的」只能靠感觉。
 *
 * 能确定的两档 + 一档估计，分开报：
 *   ① 送出：注入时 sent +1（**确定**，这是我们自己的记录）
 *   ② 用上：回复与该条有 **连续 ≥8 汉字** 重合（**估计** —— 没检测到 ≠ 没用上；
 *      讲「关系基调」的条目本来就不含会出现在回复里的词）
 *
 * 判据：报告只说「像是用上了几次」，不说「用上了」。 */
const RECEIPTS_FILE = path.join(DATA_DIR, 'receipts.json')
const RECEIPT_QUOTED = 8
const RECEIPT_MAX_KEYS = 40

/** 只留汉字/字母/数字：中文标点、引号、换行都会让「看着一样的两句」对不上。 */
function skeleton(text) {
  return String(text == null ? '' : text).replace(/[^\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9]/g, '')
}

/** 最长公共**连续**子串长度。为什么不用 n-gram 重合率：中文里「她」「白厄」满篇都是，测出来的是「两段中文长得像」。 */
function longestRun(a, b) {
  const x = skeleton(a)
  const y = skeleton(b)
  if (!x || !y) return 0
  let best = 0
  let prev = new Array(y.length + 1).fill(0)
  for (let i = 1; i <= x.length; i++) {
    const cur = new Array(y.length + 1).fill(0)
    for (let j = 1; j <= y.length; j++) {
      if (x[i - 1] === y[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

/** 一条注入算不算「被用上」：连续 8 个字连撞，基本不可能是巧合。 */
function scoreReceipt(entryText, replyText) {
  const run = longestRun(entryText, replyText)
  return { run: run, used: run >= RECEIPT_QUOTED }
}

function loadReceipts() {
  try {
    const j = JSON.parse(fs.readFileSync(RECEIPTS_FILE, 'utf8'))
    if (j && typeof j === 'object' && j.items && typeof j.items === 'object') {
      return { v: 1, items: j.items, lastReplyAt: Number(j.lastReplyAt) || 0 }
    }
  } catch {}
  return { v: 1, items: {}, lastReplyAt: 0 }
}

function saveReceipts(r) {
  try {
    writeJsonAtomic(RECEIPTS_FILE, r)
  } catch {}
}

/** 注入时记账：把这一轮送出去的条目挂到 state 上，等回复来了再结算。 */
function markSentReceipts(pairs) {
  if (!Array.isArray(pairs) || !pairs.length) return
  state.pendingReceipts = pairs
  try {
    const r = loadReceipts()
    const now = Date.now()
    for (const p of pairs) {
      const it = r.items[p.key] || (r.items[p.key] = { sent: 0, used: 0 })
      it.sent = (Number(it.sent) || 0) + 1
      it.lastSentAt = now
      it.kind = p.kind
      it.preview = String(p.text || '').slice(0, 40)
    }
    const keys = Object.keys(r.items)
    if (keys.length > RECEIPT_MAX_KEYS) {
      keys.sort((a, b) => (Number(r.items[a].lastSentAt) || 0) - (Number(r.items[b].lastSentAt) || 0))
      for (const k of keys.slice(0, keys.length - RECEIPT_MAX_KEYS)) delete r.items[k]
    }
    saveReceipts(r)
  } catch {}
}

/** 回复来了：跟这一轮送出去的条目比对，命中就 used +1。 */
function settleReceipts(replyText) {
  const pend = state.pendingReceipts
  state.pendingReceipts = null
  if (!Array.isArray(pend) || !pend.length) return
  const reply = String(replyText || '')
  if (!reply) return
  try {
    const r = loadReceipts()
    let changed = false
    for (const p of pend) {
      const it = r.items[p.key]
      if (!it) continue
      if (scoreReceipt(p.text, reply).used) {
        it.used = (Number(it.used) || 0) + 1
        it.lastUsedAt = Date.now()
        changed = true
      }
    }
    r.lastReplyAt = Date.now()
    if (changed || r.lastReplyAt) saveReceipts(r)
  } catch {}
}

/** 给 /api/state 的摘要：只报数量与比例，不把条目正文抖出来。 */
function receiptsPublic() {
  try {
    const r = loadReceipts()
    const items = Object.entries(r.items)
    const sent = items.reduce((n, kv) => n + (Number(kv[1].sent) || 0), 0)
    const used = items.reduce((n, kv) => n + (Number(kv[1].used) || 0), 0)
    return {
      keys: items.length,
      sent: sent,
      used: used,
      lastReplyAt: r.lastReplyAt,
      sample: items.slice(-5).map((kv) => ({ k: String(kv[0]).slice(0, 21), sent: Number(kv[1].sent) || 0, used: Number(kv[1].used) || 0 })),
    }
  } catch {
    return { keys: 0, sent: 0, used: 0, sample: [] }
  }
}

function writeJsonAtomic(file, obj) {
  return writeTextDurable(file, JSON.stringify(obj))
}

/** 写入做 800ms 防抖：一个 turn 里可能连着改好几次，没必要每次都落盘。 */
let saveTimer = null
function saveUsage() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      // 和其它数据文件一样走原子写：先写 .tmp 再 rename。
      const tmp = USAGE_FILE + '.tmp'
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          ...state.today,
          lastTurn: state.lastTurn,
          sessionName: state.sessionName,
          model: state.model || '',
        }),
        'utf8',
      )
      fs.renameSync(tmp, USAGE_FILE)
    } catch {}
  }, 800)
}

function rollDay() {
  const d = bjDay()
  if (state.today.day !== d) {
    state.today = { day: d, tokens: 0, cost: 0, turns: 0 }
    saveUsage()
  }
}

// ───────────────────────── 余额账本 ─────────────────────────
// 余额是「采样」不是「流水」：这里只做三件事 —— 读、记一笔、落盘。
// 具体口径（部分数据、充值、多本账）全在 ledger.js 里，这边不重复实现。
function loadLedger() {
  try {
    const raw = fs.readFileSync(LEDGER_FILE, 'utf8').replace(/^\uFEFF/, '')
    state.ledger = normalizeLedger(JSON.parse(raw))
  } catch {
    state.ledger = emptyLedger()
  }
}

let ledgerSaveTimer = null
function saveLedger() {
  if (ledgerSaveTimer) return
  ledgerSaveTimer = setTimeout(() => {
    ledgerSaveTimer = null
    writeJsonAtomic(LEDGER_FILE, state.ledger)
  }, 1500)
}

/**
 * 账本 scope（决定记到哪一本）。
 *
 * ⚠️ 不要去问 `deepseekAccount.currentAccountId()`：这个版本的 DSH 里那个方法
 * 内部会读 `undefined.token` 然后抛错，而且是在 Promise 里抛的 —— 那座山
 * 覆不住，直接被宿主当成致命错误（`dsh: fatal load failure`，整个 GUI 起不来）。
 * 实测踩过一次，教训写在这儿：宿主服务的深层方法一律不碰。
 *
 * 所以：账户路径固定一本账；密钥路径用密钥指纹（换 key 仍然分本）。
 */
function accountScope() {
  return 'acct'
}

/** 兜底：从密钥指纹认账本（只留前 12 位，反过来推不出密钥）。 */
function scopeFromKey(key) {
  try {
    return 'key-' + createHash('sha256').update(String(key)).digest('hex').slice(0, 12)
  } catch {
    return 'default'
  }
}

/** 把刚取到的余额记一笔。取不到或形状不对就什么都不做。 */
function recordBalance(scope) {
  try {
    const b = state.balance
    if (!b || !b.ok) return
    const total = Number(b.total)
    if (!Number.isFinite(total)) return
    const useScope = scope || state.ledgerScope || 'default'
    state.ledgerScope = useScope
    observeBalance(state.ledger, {
      at: Number(b.at) || Date.now(),
      balance: total,
      currency: b.currency || 'CNY',
      scope: useScope,
    })
    saveLedger()
  } catch {}
}

/** 一个 turn 收尾：把聚合的用量并进「今日」，并记下 lastTurn 供气泡用。 */
function finalizeTurn(sessionId, turnHint) {
  const agg = state.turns.get(sessionId)
  state.turns.delete(sessionId)
  let turn = isFinite(turnHint) ? turnHint : null
  if (turn === null && agg) turn = agg.turn
  if (turn === null) turn = state.lastTurn ? state.lastTurn.turn + 1 : 1
  state.lastTurn = {
    turn,
    cost: agg ? agg.cost : 0,
    tokens: agg ? agg.tokens : 0,
    at: Date.now(),
  }
  rollDay()
  state.today.tokens += agg ? agg.tokens : 0
  state.today.cost += agg ? agg.cost : 0
  state.today.turns += 1
  saveUsage()
}

// ───────────────────────────── 会话事件 ─────────────────────────────
function handleSessionEvent(sessionId, event) {
  try {
    const type = String((event && event.type) || '')
    const d = (event && event.data) || null
    if (!d || typeof d !== 'object') return

    if (type === 'session/title') {
      const t = String(d.title == null ? '' : d.title).trim()
      if (t) {
        state.sessionName = t.slice(0, 120)
        saveUsage()
      }
      return
    }

    // 工具调用：先记下「她刚才在干什么」，客户端按名字分成
    // 读 / 写 / 跑 / 查网 / 分派五类，再用不同的台词反应。
    if (type === 'tool/call') {
      const name = String(d.name || d.toolName || '').trim()
      if (name) {
        state.toolSeq += 1
        state.lastTool = {
          name: name.slice(0, 60),
          at: Date.now(),
          id: callIdOf(event) || '',
          seq: state.toolSeq,
        }
      }
      // 提问：进入 waiting，气泡会变成「等你说」
      if (name === ASK_TOOL) {
        state.wait = { kind: 'question', id: callIdOf(event) || 'q' + Date.now(), ts: Date.now() }
      }
      return
    }
    if (type === 'tool/result') {
      if (state.wait && state.wait.kind === 'question') {
        const cid = callIdOf(event)
        if (!cid || cid === state.wait.id) state.wait = null
      }
      // 工具挂了是「一轮可能白跑」的早期信号，先记下来，等 turn/end 再亮
      const eMsg = errorOf(d)
      if (eMsg) {
        markFail(eMsg)
        // 顺手记进卡点账本：同一个报错第二次出现时，气泡会点一句
        noteFail(eMsg, (state.lastTool && state.lastTool.name) || '')
      }
      return
    }

    // 显式的错误事件（error / turn/error / session/error …）
    if (/(^|\/)error$/i.test(type)) {
      const eMsg = errorOf(d) || String(d.message || d.reason || 'failed')
      markFail(eMsg)
      noteFail(eMsg, (state.lastTool && state.lastTool.name) || '')
      return
    }

    if (type === 'approval/asked') {
      state.wait = { kind: 'approval', id: String(d.id || 'a' + Date.now()), ts: Date.now() }
      return
    }
    if (type.indexOf('approval/') === 0) {
      if (state.wait && state.wait.kind === 'approval') {
        const id2 = String(d.id || '')
        if (!id2 || id2 === state.wait.id) state.wait = null
      }
      return
    }

    if (type === 'turn/start') {
      state.wait = null
      state.turnFail = null
      state.fail = null
      // 新一轮开始，上一轮的复发提示作废 —— 同一个错下一轮再撞上，还要能再点一句
      state.fails.repeat = null
      // 换模型时 turn/start 是能最早看到信号的地方。
      const ms = modelOf(null, state.lastSession)
      if (ms && ms !== state.model) {
        state.model = ms
        state.modelAt = Date.now()
      }
      const turnNo = Number(d.turn)
      const cur = state.turns.get(sessionId)
      if (!cur || (isFinite(turnNo) && cur.turn !== turnNo)) {
        state.turns.set(sessionId, {
          turn: isFinite(turnNo) ? turnNo : state.lastTurn ? state.lastTurn.turn + 1 : 1,
          cost: 0,
          tokens: 0,
          lastTs: Date.now(),
        })
      }
      return
    }

    if (type === 'turn/end') {
      state.wait = null
      // 这一轮里踩过的坑，到这儿才算数：中途重试成功就不该说她失败了
      const eEnd = errorOf(d)
      if (eEnd) markFail(eEnd)
      if (state.turnFail) {
        state.fail = state.turnFail
        state.turnFail = null
      }
      finalizeTurn(sessionId, Number(d.turn))
      // 一轮结束立刻刷余额：这是用户最想看到数字变化的时刻。
      if (HOST_CTX) refreshBalance(HOST_CTX, true).catch(() => {})
      return
    }

    if (type !== 'assistant/message') return

    const turn = Number(d.turn)
    const usage = d.usage
    if (!usage || typeof usage !== 'object' || !isFinite(turn)) return

    let agg = state.turns.get(sessionId)
    if (!agg || agg.turn !== turn) {
      if (agg) finalizeTurn(sessionId)
      agg = { turn, cost: 0, tokens: 0, cache: 0, input: 0, lastTs: Date.now() }
      state.turns.set(sessionId, agg)
    }

    const input = Number(usage.inputTokens) || 0
    const cache = Number(usage.cacheReadTokens) || 0
    const output = Number(usage.outputTokens) || 0

    const model = modelOf(d, state.lastSession) || state.model || ''
    if (model && model !== state.model) {
      state.model = model
      state.modelAt = Date.now()
    }
    // 缓存账单：按**事件时刻**的峰谷费率算，步/轮/会话三级各自累加。
    try {
      const write = Number(usage.cacheWriteTokens) || 0
      const evTs = Number((event && event.time) || (d && d.time) || 0) || Date.now()
      updateBill(sessionId, turn, model, evTs, input, cache, write, output)
    } catch {}
    // 只采一次字段快照，方便以后 DSH 改结构时对比
    if (!state.modelProbe) {
      try {
        const m = d.message || {}
        state.modelProbe = {
          at: Date.now(),
          hit: model,
          dataKeys: Object.keys(d).slice(0, 18),
          msgKeys: Object.keys(m).slice(0, 18),
          srcKeys: Object.keys(m.source || {}).slice(0, 18),
          srcModel: String((m.source && m.source.model) || ''),
        }
      } catch {}
    }

    const p = priceFor(model)
    const off = isPeak(Date.now()) ? 1 : 0
    const cost = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
    agg.tokens += input + cache + output
    agg.cost += cost
    // 缓存命中率 = cache / (cache + input)。
    // 为什么要存这两个：整个「记忆排最后、世界书冻结」的设计都是为了保前缀缓存，
    // 把命中率亮出来，等于让这套设计自己说话。比「上下文占比」有意义得多
    // （后者连模型窗口多大都不知道，百分比会误导）。
    agg.cache = (agg.cache || 0) + cache
    agg.input = (agg.input || 0) + input
    agg.lastTs = Date.now()
  } catch {}
}

function callIdOf(event) {
  try {
    const d = (event && event.data) || {}
    const msg = d.message || {}
    const list = Array.isArray(msg.content) ? msg.content : []
    for (const c of list) if (c && (c.toolCallId || c.tool_call_id)) return String(c.toolCallId || c.tool_call_id)
    if (msg && (msg.callId || msg.toolCallId || msg.tool_call_id)) return String(msg.callId || msg.toolCallId || msg.tool_call_id)
    return String(d.callId || d.call_id || d.toolCallId || d.id || '')
  } catch {
    return ''
  }
}

function sessionTitleOf(ctx, session) {
  try {
    const svc = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null
    if (svc && typeof svc.get === 'function' && session) {
      const snap = svc.get(session)
      const ti = typeof snap === 'string' ? snap : snap && (snap.title || snap.text)
      const s = String(ti == null ? '' : ti).trim()
      if (s) return s.slice(0, 120)
    }
  } catch {}
  try {
    if (!session || typeof session !== 'object') return ''
    const cands = [
      session.name,
      session.title,
      session.label,
      session.summary && session.summary.title,
      session.summary && session.summary.name,
      session.meta && session.meta.title,
      session.meta && session.meta.name,
    ]
    for (const c of cands) {
      const s = String(c == null ? '' : c).trim()
      if (s) return s.slice(0, 120)
    }
  } catch {}
  return ''
}

/** 气泡该显示哪种状态。 */
function phaseNow() {
  if (state.wait) return 'waiting'
  if (state.turns.size > 0) return 'thinking'
  // 失败优先于 done：一轮跑挂了也照样会记 lastTurn，
  // 如果先判 done，她会对着一次报错说「好啦，交给你了」。
  if (state.fail && Date.now() - state.fail.at < FAIL_WINDOW) return 'failed'
  if (state.lastTurn && Date.now() - state.lastTurn.at < DONE_WINDOW) return 'done'
  return 'idle'
}

// ───────────────────────────── 余额 ─────────────────────────────
async function resolveApiKey(ctx) {
  let svc = null
  try {
    if (typeof ctx.get === 'function') svc = ctx.get('credentials')
  } catch {}
  if (!svc) {
    try {
      svc = ctx.credentials || null
    } catch {}
  }
  if (!svc || typeof svc.resolve !== 'function') return ''
  const cred = await svc.resolve('DEEPSEEK_API_KEY')
  const v = cred && (cred.value || cred.secret || cred.token)
  return v ? String(v) : ''
}

/**
 * 读「DS 账号」余额 —— 这是主路径。
 * deepseekAccount.getBalance(client) 内部会调 platformClientHeaders(platform, client)，
 * 那里直接读 client.version / client.locale / client.timezoneOffsetSeconds，
 * 所以 metadata 少一个字段就会抛 "Cannot read properties of undefined"。
 */
async function readAccountBalance(ctx) {
  const probe = { at: Date.now(), found: false, keys: [], methods: [], via: '', err: '', raw: '' }
  state.accountProbe = probe

  let acc = null
  try {
    acc = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null
  } catch (e) {
    probe.err = 'ctx.get 抛错: ' + String((e && e.message) || e).slice(0, 80)
    return null
  }
  if (!acc) {
    probe.err = 'ctx.get("deepseekAccount") 拿不到服务'
    return null
  }
  probe.found = true

  try {
    probe.keys = Object.keys(acc).slice(0, 24)
  } catch {}
  try {
    const proto = Object.getPrototypeOf(acc)
    probe.methods = proto
      ? Object.getOwnPropertyNames(proto).filter((k) => k !== 'constructor').slice(0, 30)
      : []
  } catch {}
  try {
    probe.rel = String(acc.inferenceOrigin || acc.origin || '').slice(0, 80)
  } catch (e) {
    probe.stateErr = String((e && e.message) || e).slice(0, 120)
  }

  // 把各种可能的余额形状都归一化到这里。
  const pick = (v) => {
    if (!v || typeof v !== 'object') return null

    // 平台口径 /account/details：
    //   { status:'ready', value:[{currency,balance}], bonusWallets:[{currency,balance}] }
    // balance 是字符串，且现金钱包和赠送钱包是分开的两个数组，要相加。
    if (Array.isArray(v.value) || Array.isArray(v.bonusWallets)) {
      const sum = (arr) =>
        (Array.isArray(arr) ? arr : []).reduce(
          (a, x) => a + (Number(x && (x.balance ?? x.amount ?? x.total)) || 0),
          0,
        )
      const cash = sum(v.value)
      const bonus = sum(v.bonusWallets)
      const cur = (Array.isArray(v.value) && v.value[0] && v.value[0].currency) || 'CNY'
      return {
        total: cash + bonus,
        cash,
        bonus,
        currency: cur,
        granted: bonus,
        toppedUp: cash,
        status: String(v.status || ''),
      }
    }

    // 老口径：OpenAI 风格的 balance_infos
    const infos =
      (Array.isArray(v.balance_infos) && v.balance_infos) ||
      (Array.isArray(v.balanceInfos) && v.balanceInfos) ||
      null
    const list = infos && infos.length ? infos : [v]
    for (const info of list) {
      if (!info || typeof info !== 'object') continue
      const raw = info.total_balance ?? info.totalBalance ?? info.balance ?? info.total ?? info.remain
      if (raw == null) continue
      const n = Number(raw)
      if (!isFinite(n)) continue
      return {
        total: n,
        currency: info.currency || 'CNY',
        granted: Number(info.granted_balance ?? info.grantedBalance ?? info.gift ?? 0) || 0,
        toppedUp: Number(info.topped_up_balance ?? info.toppedUpBalance ?? info.recharge ?? 0) || 0,
      }
    }
    return null
  }

  // metadata 必须凑齐 { version, locale, timezoneOffsetSeconds } ——
  // 少 version 会抛 "Cannot read properties of undefined (reading 'version')"，
  // 少 locale 会抛 "... (reading 'toLowerCase')"。
  const ver = String(process.versions.electron || process.versions.node || '0.0.0')
  const offSec = -new Date().getTimezoneOffset() * 60
  const metas = [{ version: ver, locale: 'zh-CN', timezoneOffsetSeconds: offSec }]

  if (typeof acc.getBalance !== 'function') {
    probe.err = '账户服务没有 getBalance'
    return null
  }
  for (let mi = 0; mi < metas.length; mi++) {
    let v = null
    try {
      v = await acc.getBalance(metas[mi])
    } catch (e) {
      probe.err = 'getBalance(meta#' + mi + ') 抛错: ' + String((e && e.message) || e).slice(0, 120)
      probe.errs = (probe.errs || []).concat(probe.err)
      continue
    }
    if (v == null) {
      probe.err = 'getBalance(meta#' + mi + ') 返回空 / 无值'
      probe.errs = (probe.errs || []).concat(probe.err)
      continue
    }
    if (v && v.ok === true && v.value) v = v.value
    const got = pick(v)
    if (got) {
      probe.via = 'getBalance#' + mi
      try {
        probe.raw = JSON.stringify(v).slice(0, 300)
      } catch {}
      return Object.assign({ ok: true, source: 'account', via: probe.via, at: Date.now() }, got)
    }
    try {
      probe.err = 'getBalance(meta#' + mi + ') 形状对不上: ' + JSON.stringify(v).slice(0, 200)
    } catch {}
  }
  return null
}

/**
 * 刷新余额：账户优先，API key 只是兜底。
 * （之前反过来了，导致界面上显示的是 API key 那份小额余额。）
 */
async function refreshBalance(ctx, force) {
  if (state.balanceBusy) return
  if (!force && state.balanceAt && Date.now() - state.balanceAt < BALANCE_TTL) return
  state.balanceBusy = true
  try {
    const accBal = await readAccountBalance(ctx)
    if (accBal) {
      state.balance = accBal
      state.balanceAt = Date.now()
      // 每次拿到余额就记一笔：账本只认观测，不认估算
      recordBalance(accountScope(ctx))
      return
    }

    let key = ''
    let keyErr = ''
    try {
      key = await resolveApiKey(ctx)
    } catch (e) {
      keyErr = String((e && e.message) || e).slice(0, 120)
    }
    if (!key) {
      state.balance = Object.assign({}, state.balance || {}, {
        ok: false,
        source: 'none',
        error:
          '账户余额读不到，也没有可用的 DEEPSEEK_API_KEY' +
          (state.accountProbe && state.accountProbe.err ? '（账户：' + state.accountProbe.err + '）' : '') +
          (keyErr ? '（密钥：' + keyErr + '）' : ''),
        at: Date.now(),
      })
      state.balanceAt = Date.now()
      return
    }

    let res = null
    let lastErr = null
    for (let i = 0; i < 2; i++) {
      try {
        res = await fetch(BALANCE_URL, {
          headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' },
          signal: AbortSignal.timeout(8000),
        })
        if (res.ok) break
        lastErr = new Error('HTTP ' + res.status)
        if (res.status < 500) break
      } catch (e) {
        lastErr = e
      }
      if (i === 0) await new Promise((r) => setTimeout(r, 600))
    }
    if (!res || !res.ok) throw lastErr || new Error('余额接口不可用')

    const data = await res.json()
    const infos = Array.isArray(data && data.balance_infos) ? data.balance_infos : []
    const info = infos.find((x) => String(x.currency || '').toUpperCase() === 'CNY') || infos[0] || {}
    state.balance = {
      ok: true,
      source: 'key',
      available: data && data.is_available !== false,
      currency: info.currency || 'CNY',
      total: Number(info.total_balance) || 0,
      granted: Number(info.granted_balance) || 0,
      toppedUp: Number(info.topped_up_balance) || 0,
      at: Date.now(),
    }
    state.balanceAt = Date.now()
    recordBalance(scopeFromKey(key))
  } catch (e) {
    state.balance = Object.assign({}, state.balance || {}, {
      ok: false,
      error: String((e && e.message) || e).slice(0, 160),
      at: Date.now(),
    })
    state.balanceAt = Date.now()
  } finally {
    state.balanceBusy = false
  }
}

// ───────────────────────────── 语音 ─────────────────────────────
function readTtsConf() {
  const def = {
    endpoint: 'http://127.0.0.1:9881',
    text_lang: 'zh',
    ref_audio_path: '',
    prompt_text: '',
    prompt_lang: 'zh',
    top_k: 5,
    top_p: 1,
    temperature: 1,
    text_split_method: 'cut5',
    speed_factor: 1,
    repetition_penalty: 1.35,
    // 切句之间的停顿秒数。默认 0.3，一句三分句就多出 0.6~0.9 秒空白，
    // 听感明显发拖 —— 这是「不够轻快」的主要来源之一，压到 0.12。
    fragment_interval: 0.12,
  }
  try {
    // 去掉 BOM：Windows PowerShell 的 Set-Content -Encoding UTF8 默认带 BOM，
    // 而 JSON.parse 见到 \uFEFF 会直接抛 —— 用户用记事本改配置也会踩到。
    const raw = fs.readFileSync(TTS_CONF_FILE, 'utf8').replace(/^\uFEFF/, '')
    const j = JSON.parse(raw)
    return Object.assign(def, j && typeof j === 'object' ? j : {})
  } catch {
    return def
  }
}

async function probeTts(conf) {
  const TTL = 10000
  if (state.tts.checkedAt && Date.now() - state.tts.checkedAt < TTL) return state.tts.alive
  state.tts.checkedAt = Date.now()
  try {
    const r = await fetch(conf.endpoint.replace(/\/+$/, '') + '/', {
      method: 'GET',
      signal: AbortSignal.timeout(2500),
    })
    // 404 也算活：GPT-SoVITS 的根路径本来就没有路由
    state.tts.alive = r.ok || r.status < 500
    state.tts.failStreak = 0
  } catch {
    // 合成推理是同步阻塞的，服务正在合成时健康探针会超时 ——
    // 所以单次失败不判死，连续失败两次才算（否则界面会闪"服务没了"）。
    state.tts.failStreak = (state.tts.failStreak || 0) + 1
    if (state.tts.failStreak >= 2 || state.tts.alive === null) state.tts.alive = false
  }
  return state.tts.alive
}

// ── GPT-SoVITS：跟着 DSH 一起开、一起关 ──
// 以前每次重启 DSH 都要手动开它，忘了她就「有字没声」。
// 只在「端点就是本机这个端口、且参考音频存在」时才接管，别的情况一律不碰。
//
// ★ 2026-10-30 换权重：A/B 试听后 v2ProPlus 胜出（情感明显更足）。
//   · 9880 + GPT_SoVITS\configs\tts_infer.yaml  → 旧 v2 权重（Cyrene_e8_s128，128 步）
//   · 9881 + cyrene-v2pp-infer.yaml             → v2ProPlus（CyreneV3.7，1392 步）
//   旧的那套一个字没删，随时改这两行常量 + 配置文件就能切回去。
// ── GPT-SoVITS 路径：可配置 + 自动探测 ──
//
// 以前是四个硬编码常量，别人机器上必然不存在，面板里也改不了 —— 这是分发时最大的障碍。
//
// 取值顺序（找到就用）：
//   ① tts.json 的 gsv 段（用户在面板里配过的）
//   ② 环境变量 CYRENE_GSV_*
//   ③ 自动探测（见 gsvProbe）
//   ④ 下面这份老机器默认值（兜底，保住现有这台机器原来的用法）
//
// 为什么不把 GPT-SoVITS 塞进插件目录：整套 2–3 GB，跟着打包走会很沉。
// 但探测**必须要扫插件目录** —— 万一用户真把便携版放那儿了，也该认出来。
const GSV_DEFAULTS = {
  py: 'E:\\Py310\\python.exe',
  cwd: 'E:\\TTS\\gpt-sovits',
  bin: 'E:\\TTS\\bin',
  port: 9881,
  conf: 'E:\\TTS\\gsv-models\\cyrene-v2pp-infer.yaml',
}
const GSV_PORT = GSV_DEFAULTS.port   // 端口单独留着：gsvOwned / gsvPing 都要用
const PLUGIN_DIR = path.resolve(HERE, '..')

/** 探测候选根目录。插件自己的 tts/ 排第一 —— 用户可能把便携版放那儿。 */
function gsvProbeRoots() {
  return [
    path.join(PLUGIN_DIR, 'tts'),
    'E:\\TTS', 'D:\\TTS', 'C:\\TTS',
    'E:\\gpt-sovits', 'D:\\gpt-sovits',
    'E:\\Py310', 'D:\\Py310', 'C:\\Py310',
  ]
}

/** 扫一遍候选目录，返回各自找到了什么。纯只读，失败就当没找到。 */
function gsvProbe() {
  const found = []
  for (const root of gsvProbeRoots()) {
    try {
      if (!fs.existsSync(root)) continue
      const py = [
        'python.exe',
        path.join('python', 'python.exe'),
        path.join('runtime', 'python.exe'),
      ].map((p) => path.join(root, p)).find((p) => fs.existsSync(p)) || null
      const cwd = [root, path.join(root, 'gpt-sovits'), path.join(root, 'GPT_SoVITS')]
        .find((p) => { try { return fs.existsSync(path.join(p, 'api_v2.py')) } catch { return false } }) || null
      const bin = [path.join(root, 'bin'), path.join(root, 'ffmpeg', 'bin')]
        .find((p) => { try { return fs.existsSync(p) } catch { return false } }) || null
      let conf = null
      for (const sub of ['gsv-models', 'models', 'configs']) {
        try {
          const dir = path.join(root, sub)
          if (!fs.existsSync(dir)) continue
          const hit = fs.readdirSync(dir).find((f) => /\.ya?ml$/i.test(f))
          if (hit) { conf = path.join(dir, hit); break }
        } catch {}
      }
      if (py || cwd || conf) found.push({ root, py, cwd, bin, conf })
    } catch {}
  }
  return found
}

/** 当前生效的路径：配置 → 环境变量 → 默认值。 */
function gsvPaths() {
  let cfg = {}
  try {
    const j = JSON.parse(fs.readFileSync(TTS_CONF_FILE, 'utf8'))
    cfg = (j && j.gsv) || {}
  } catch {}
  const d = GSV_DEFAULTS
  return {
    py: cfg.py || process.env.CYRENE_GSV_PY || d.py,
    cwd: cfg.cwd || process.env.CYRENE_GSV_CWD || d.cwd,
    bin: cfg.bin || process.env.CYRENE_GSV_BIN || d.bin,
    conf: cfg.conf || process.env.CYRENE_GSV_CONF || d.conf,
    port: Number(cfg.port || process.env.CYRENE_GSV_PORT || d.port) || d.port,
  }
}
// GSV_LOG / GSV_ERR 在文件头统一定义（都进了 DATA_DIR）

/** 这个端点是不是人家该管的那个。 */
function gsvOwned(conf) {
  const ep = String(conf.endpoint || '')
  // ★ 端口必须取「当前生效值」，不能用模块头部的 GSV_PORT 常量。
  //   以前写死 9881：用户把 tts.json 的 gsv.port 改成别的之后，
  //   这里永远比对不上 → 返回 false → 服务永不自动拉起，而且一句报错都没有。
  let port = GSV_PORT
  try {
    const p = Number(gsvPaths().port)
    if (p > 0) port = p
  } catch {}
  if (new RegExp('(127\\.0\\.0\\.1|localhost):' + port + '(?:/|$)').test(ep) === false) return false
  // 没有参考音频就不起：白占显存，而且根本合不出声音
  if (conf.auto_start === false) return false        // ★ 显式关闭：tts.json 写 "auto_start": false
  return !!(conf.ref_audio_path && fs.existsSync(conf.ref_audio_path))
}

/** 直接问一句在不在，绕过 probeTts 的 10 秒缓存 —— 自己起进程时缓存会骗人。 */
async function gsvPing(conf) {
  try {
    const r = await fetch(String(conf.endpoint).replace(/\/+$/, '') + '/', {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    })
    // 和 probeTts 同一条规矩：404 也算活（GPT-SoVITS 根路径本来就没路由）
    return r.ok || r.status < 500
  } catch {
    return false
  }
}

function gsvRotate(file, limit) {
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > limit) fs.renameSync(file, file + '.1')
  } catch {}
}

function startGsv(ctx) {
  const g = state.gsv
  if (g.proc || g.shuttingDown) return false
  const P = gsvPaths()
  if (!fs.existsSync(P.py) || !fs.existsSync(path.join(P.cwd, 'api_v2.py'))) {
    ctx?.logger?.warn?.(`${PACKAGE_ID}: 找不到 GPT-SoVITS（${P.cwd}），语音服务需要你手动起，或在面板「语音配置」里填路径`)
    return false
  }
  let out = null
  let err = null
  try {
    gsvRotate(GSV_LOG, 4 * 1024 * 1024)
    out = fs.openSync(GSV_LOG, 'a')
    err = fs.openSync(GSV_ERR, 'a')
  } catch {}
  const env = Object.assign({}, process.env)
  if (P.bin) env.PATH = P.bin + ';' + (env.PATH || '')
  env.PYTHONIOENCODING = 'utf-8'
  env.PYTHONUTF8 = '1'
  let child = null
  try {
    child = spawn(P.py, ['-u', 'api_v2.py', '-a', '127.0.0.1', '-p', String(P.port), '-c', P.conf], {
      cwd: P.cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', out === null ? 'ignore' : out, err === null ? 'ignore' : err],
    })
  } catch (e) {
    ctx?.logger?.warn?.(`${PACKAGE_ID}: 启动语音服务失败`, e)
    try {
      if (out !== null) fs.closeSync(out)
    } catch {}
    try {
      if (err !== null) fs.closeSync(err)
    } catch {}
    return false
  }
  g.proc = child
  g.pid = child.pid || 0
  g.tries += 1
  ctx?.logger?.info?.(`${PACKAGE_ID}: 拉起语音服务 pid=${g.pid}`)
  const release = () => {
    try {
      if (out !== null) fs.closeSync(out)
    } catch {}
    try {
      if (err !== null) fs.closeSync(err)
    } catch {}
    out = null
    err = null
  }
  child.on('error', (e) => {
    ctx?.logger?.warn?.(`${PACKAGE_ID}: 语音服务进程出错`, e)
    release()
    if (g.proc === child) {
      g.proc = null
      g.pid = 0
    }
  })
  child.on('exit', (code, sig) => {
    release()
    if (g.proc === child) {
      g.proc = null
      g.pid = 0
    }
    state.tts.alive = false
    state.tts.checkedAt = 0 // 逼下次 /api/state 重新探
    if (g.shuttingDown) return
    // 只管起一次：它自己挂了就挂了，不再偷偷重拉 ——
    // 你要是手动关了语音服务，刻意不想让它回来，人家不能几分钟后又给你拉起来。
    ctx?.logger?.warn?.(`${PACKAGE_ID}: 语音服务退出 code=${code} signal=${sig}（不自动重拉，需要就重启 DSH）`)
  })
  return true
}

/** 只在启动时问一次：没人占着 GSV_PORT 就自己起，占着就不动。 */
async function ensureGsv(ctx) {
  const g = state.gsv
  if (g.proc || g.shuttingDown) return false
  const conf = readTtsConf()
  if (!gsvOwned(conf)) return false
  // 本来就在跑（比如你手动起的）：不动它，退出时也不杀它
  if (await gsvPing(conf)) return false
  return startGsv(ctx)
}

function stopGsv() {
  const g = state.gsv
  g.shuttingDown = true
  const child = g.proc
  if (!child) return
  g.proc = null
  g.pid = 0
  try {
    child.kill()
  } catch {}
}

function send(res, status, body, type) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
  res.writeHead(status, {
    'Content-Type': type || 'text/plain; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(buf)
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), 'application/json; charset=utf-8')
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > (limit || 8192)) throw new Error('body too large')
    chunks.push(c)
  }
  return Buffer.concat(chunks).toString('utf8')
}

// ───────────────────── 客户端偏好（跨重启） ─────────────────────
// 读写都在这一对函数里，路由只负责转发。形状刻意做得最笨：
// 一个扁平的 KV，值是字符串（客户端那边 localStorage 存的本来就是字符串）。
function readPrefs() {
  try {
    const j = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8'))
    if (j && typeof j === 'object' && !Array.isArray(j)) return j
  } catch {}
  return {}
}

function writePrefs(set) {
  if (!set || typeof set !== 'object' || Array.isArray(set)) return { ok: false, error: 'set 必须是对象' }
  const box = readPrefs()
  let n = 0
  for (const k of Object.keys(set)) {
    if (typeof k !== 'string' || k.length > 120) continue
    const v = set[k]
    // null = 删掉这一条；只收标量，别让客户端把整个对象塞进来
    if (v === null) {
      delete box[k]
      n++
      continue
    }
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue
    const s = String(v)
    if (s.length > 8192) continue
    box[k] = s
    n++
  }
  const out = JSON.stringify(box)
  if (out.length > PREFS_MAX) return { ok: false, error: '偏好文件超过上限' }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    // 同 memory：原子写 + 留上一版。
    // prefs 里装着 3249 字人设，写坏一次就没了（面板会显示 0 字）。
    const tmp = PREFS_FILE + '.tmp'
    try {
      if (fs.existsSync(PREFS_FILE)) fs.copyFileSync(PREFS_FILE, PREFS_FILE + '.bak')
    } catch {}
    fs.writeFileSync(tmp, out, 'utf8')
    fs.renameSync(tmp, PREFS_FILE)
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  return { ok: true, saved: n, keys: Object.keys(box).length }
}

// ───────────────────── 她的记忆（关系层） ─────────────────────
// 读写的形状比 prefs 复杂（数组 + 对象），所以单独一对函数，但仍然「读失败退回空、
// 写失败返回错误」，不抛异常 —— 记忆坏了绝不能拖垮桌宠。
const MEM_KINDS = ['pending', 'promises', 'boundaries', 'workspace', 'lessons', 'profile']
/**
 * 画像（L0）的五个格子 —— 借自原版 cyrene-agent 的 `L0Profile`。
 *
 * 为什么单独一桶而不是塞进 pending：**画像是「你是谁」，不是「待办」**。
 * 之前这些信息散在 prompt 里，没有结构，也就没有「只收用户明确说过的」这条闸门。
 *
 * ★ 闸门（照抄原版 memory-judge.ts:19）：只有 certainty = explicit
 *   且 attribution = user_explicit 的条目才允许进画像。
 *   「人家猜你可能是前端」这种推断永远进不去 —— 猜错了比不记更糟。
 */
const PROFILE_FIELDS = ['preferredName', 'occupation', 'longTermInterests', 'language', 'permanentNote']
const PROFILE_FIELD_DESC = {
  preferredName: '用户希望被如何称呼、叫什么名字、昵称',
  occupation: '用户的职业、身份、工作',
  longTermInterests: '用户的长期兴趣爱好（稳定的，不是临时的）',
  language: '用户常用的语言或地区习惯',
  permanentNote: '其他稳定个人信息（宠物、城市等）',
}
const CERTAINTY = ['explicit', 'inferred', 'uncertain']
const ATTRIBUTION = ['user_explicit', 'assistant_inferred', 'mixed']

// ── 观测用的两个环形桶（2026-11-03 加，只为本机观测，不进上下文、不进面板）──
// 为什么塞进 memory.json 而不是新开文件：①不新增文件（用户红线）；②自愈/.bak 链路顺带保护它；
// ③不在 MEM_KINDS 里 → memorySectionText 不读、paintMemory 不画、四桶 cap 不碰，零行为影响。
// 淘汰的「单一所有权」：只有写侧裁（unshift 后截断），读侧原样透传 —— counts 之前就是读写各裁一次，
// 方向还正好相反，踩过一次。
const AUDIT_XLOG_CAP = 20
const AUDIT_SHADOW_CAP = 50

function emptyMemory() {
  return {
    pending: [],
    promises: [],
    counts: {},
    boundaries: [],
    // 工作记忆两桶（2026-11-05 新增）：见 MEM_CAP 上方注释
    workspace: [],
    lessons: [],
    // 画像（2026-11-06 新增）：每条 { at, field, what, certainty, attribution }
    profile: [],
    xlog: [],
    shadow: [],
    stats: { added: 0, dropped: 0 },
  }
}

function readMemory() {
  const out = emptyMemory()
  // 新位置优先；读不到再试旧位置（第一版存在 ~/.dsh 根下）。
  // 刻意不在这里自动迁移：下一次写入自然会落到新位置，少一次可能失败的写操作。
  let raw = null
  try {
    raw = fs.readFileSync(MEM_FILE, 'utf8')
  } catch {}
  if (raw === null) {
    try {
      raw = fs.readFileSync(LEGACY_MAP[MEM_FILE], 'utf8')
    } catch {}
  }
  if (raw === null) return out
  let j = null
  try {
    j = JSON.parse(raw)
  } catch {
    return out
  }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return out
  for (const kind of MEM_KINDS) {
    if (!Array.isArray(j[kind])) continue
    // 逐条校验：她可能写进脏数据，面板要能安稳地把它画出来
    out[kind] = j[kind]
      .filter((e) => e && typeof e === 'object' && typeof e.what === 'string' && e.what.trim())
      .slice(-MEM_CAP[kind])
      .map((e) => {
        const row = { at: String(e.at || ''), what: e.what.slice(0, MEM_TEXT_MAX), done: !!e.done }
        // 来源原话要带出来，否则面板的「原因预览」没东西可显示
        if (e.src) row.src = String(e.src).slice(0, MEM_SRC_MAX)
        // 谁说的：user / self / infer（老条目没有这个字段，面板就不显示标签）
        if (e.by === 'user' || e.by === 'self' || e.by === 'infer') row.by = e.by
        // cue（「所以下次该怎么做」）—— 和 src 一样是读侧白名单，不写在这里就会丢
        if (e.cue) row.cue = String(e.cue).slice(0, MEM_SRC_MAX)
        // ★ 画像三个字段必须带出来（2026-11-06）：这个 map 是**白名单**，
        //   不写进去就等于静默丢弃 —— 画像读回来全是残的，注入闸门会把它们全过滤掉，
        //   而且不报任何错（读一次就没了）。这正是「改结构只改一层」的经典坑。
        if (e.field && PROFILE_FIELDS.indexOf(String(e.field)) >= 0) row.field = String(e.field)
        if (e.certainty && CERTAINTY.indexOf(String(e.certainty)) >= 0) row.certainty = String(e.certainty)
        if (e.attribution && ATTRIBUTION.indexOf(String(e.attribution)) >= 0) row.attribution = String(e.attribution)
        return row
      })
  }
  if (j.counts && typeof j.counts === 'object' && !Array.isArray(j.counts)) {
    // 淘汰按「最近一次出现」而不是插入顺序：老 key 一直被 bump，却会被后来插入的
    // 一次性 key 挤掉。at 是 ISO 字符串，直接比大小即可（没 at 的排最后）。
    // 约定：counts 一律「新的在前」，读写两边用同一个顺序，避免写回时把新的切掉。
    const atOf = (k) => {
      const v = j.counts[k]
      return v && typeof v === 'object' ? String(v.at || '') : ''
    }
    const keys = Object.keys(j.counts).sort((a, b) => (atOf(a) < atOf(b) ? 1 : atOf(a) > atOf(b) ? -1 : 0))
    for (const k of keys.slice(0, MEM_CAP.counts)) {
      const v = j.counts[k]
      if (v && typeof v === 'object') out.counts[k] = { n: Number(v.n) || 1, at: String(v.at || '') }
      else if (typeof v === 'number') out.counts[k] = { n: v, at: '' }
    }
  }
  // 观测桶：原样透传（读侧不裁，裁剪只在写侧做一次）
  if (Array.isArray(j.xlog)) out.xlog = j.xlog.slice(0, AUDIT_XLOG_CAP)
  if (Array.isArray(j.shadow)) out.shadow = j.shadow.slice(0, AUDIT_SHADOW_CAP)
  if (j.stats && typeof j.stats === 'object') {
    out.stats = { added: Number(j.stats.added) || 0, dropped: Number(j.stats.dropped) || 0 }
  }
  return out
}

function writeMemory(mem) {
  const box = emptyMemory()
  for (const kind of MEM_KINDS) {
    box[kind] = (Array.isArray(mem[kind]) ? mem[kind] : []).slice(-MEM_CAP[kind])
  }
  // counts 淘汰必须**先按「最近出现」排序再切**。
  // 直接按 key 顺序切会切掉刚 bump 的那个：新 key 永远追加在对象末尾，
  // 满员之后它正好落在第 21 位被切掉 —— repeat 桶会永久冻结在旧 20 个 key 上，
  // 新模式再也记不进来（2026-11-02 评审抓到的 P1）。
  const countsAt = (k) => {
    const v = mem.counts[k]
    return v && typeof v === 'object' ? String(v.at || '') : ''
  }
  const countKeys = Object.keys(mem.counts || {})
  countKeys.sort((a, b) => (countsAt(a) < countsAt(b) ? 1 : countsAt(a) > countsAt(b) ? -1 : 0))
  for (const k of countKeys.slice(0, MEM_CAP.counts)) box.counts[k] = mem.counts[k]
  // 观测桶：写入侧是唯一裁的地方（新的在前）
  if (Array.isArray(mem.xlog)) box.xlog = mem.xlog.slice(0, AUDIT_XLOG_CAP)
  if (Array.isArray(mem.shadow)) box.shadow = mem.shadow.slice(0, AUDIT_SHADOW_CAP)
  if (mem.stats && typeof mem.stats === 'object') {
    box.stats = { added: Number(mem.stats.added) || 0, dropped: Number(mem.stats.dropped) || 0 }
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    // ── 原子写 ──
    // 直接 writeFileSync 到目标文件，写到一半断电/崩溃 = JSON 截断 = 四桶全丢。
    // 这是整个项目里**最不可逆的单点**（记忆丢了没有别的副本）。
    // 做法：写 .tmp → rename。同盘 rename 是原子的，要么旧文件要么新文件，
    // 不存在「写了一半」的中间态。
    const json = JSON.stringify(box, null, 1)
    // 先留一份上一次的完整内容：rename 成功后它就是「上一版」，
    // 万一新写的逻辑有 bug（比如字段算错），还能退回去。
    try {
      if (fs.existsSync(MEM_FILE)) fs.copyFileSync(MEM_FILE, MEM_FILE + '.bak')
    } catch {}
    // ★ 走 writeTextDurable：记忆是唯一「丢了没有第二份」的文件，
    // 它必须吃到 fsync（只 rename 不落盘的话，断电可能得到「新名字 + 空文件」）。
    if (!writeTextDurable(MEM_FILE, json)) throw new Error('写入失败')
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) }
  }
  return { ok: true }
}

/**
 * 启动自愈：主档坏掉就用 .bak 顶回来。
 *
 * 为什么单独做成「开机跑一次」，而不是塞在 readMemory 里：
 * ① readMemory 会被 1.2 秒一次的 state 轮询间接调用，塞进去等于每次都先试一遍备份；
 * ② 自愈是一次性动作，放在 apply() 开头更好读，也更好测（tmp/check-memory-heal.mjs）。
 * 只认「主档在、但解析不了」这一种；主档不存在 = 首次安装，不动。
 */
function healMemoryFile() {
  try {
    let raw = null
    try {
      raw = fs.readFileSync(MEM_FILE, 'utf8')
    } catch {
      return
    }
    try {
      const j = JSON.parse(raw)
      if (j && typeof j === 'object' && !Array.isArray(j)) return
    } catch {}
    const bakRaw = fs.readFileSync(MEM_FILE + '.bak', 'utf8')
    const b = JSON.parse(bakRaw)
    if (!b || typeof b !== 'object' || Array.isArray(b)) return
    // 坏档先原样留一份现场（覆盖式），再用备份原子写回主档
    try {
      fs.writeFileSync(MEM_FILE + '.corrupt', raw, 'utf8')
    } catch {}
    // 自愈这一步也要落盘：恢复完立刻断电，会退回「坏档 + .bak 还在」的起点。
    if (!writeTextDurable(MEM_FILE, bakRaw)) return
    try {
      state.memRestored = { at: Date.now(), from: 'bak' }
    } catch {}
    try {
      console.warn(PACKAGE_ID + ': memory.json 解析失败，已用 .bak 恢复（坏档留在 .corrupt）')
    } catch {}
  } catch {}
}

/**
 * curTurn 视图：把内部累加器的**数字字段**原样带出去，只剔除内部记账用的 turn / lastTs。
 *
 * 为什么不是手写四个字段的白名单：以前就是手写的（tokens/cost/cache/input），
 * v1051i 加 cache 字段时漏了一处，客户端拿到 undefined 整行不显示 —— 同一个坑别再踩。
 */
function aggView(a) {
  const out = { tokens: 0, cost: 0, cache: 0, input: 0 }
  if (a && typeof a === 'object') {
    for (const k of Object.keys(a)) {
      if (k === 'turn' || k === 'lastTs') continue
      const v = a[k]
      if (typeof v === 'number' && isFinite(v)) out[k] = v
    }
  }
  return out
}

/** 记忆体检：给 /api/state 用。只读，除了「主档坏了会自愈」那条不写任何文件。 */
function memoryStat() {
  try {
    const mem = readMemory()
    const counts = {
      pending: (mem.pending || []).length,
      promises: (mem.promises || []).length,
      boundaries: (mem.boundaries || []).length,
      repeat: Object.keys(mem.counts || {}).length,
    }
    // ★ 推理占比（2026-11-03 加）：记忆里有多少是她「推断」出来的。
    // 为什么要这个数：推断占比过高说明记忆被自己的猜测污染了 ——
    // 那比「记得少」更危险，因为看起来像真的。
    // 阈值用 30% 而不是外部方案里的 15%：单人陪伴场景天然含推断
    // （「人家觉得你今天很累」这种），15% 会天天报警。
    // 只在请求时遍历四桶算，不落盘 —— 每次写都算太亏。
    const byMix = { user: 0, self: 0, infer: 0, none: 0 }
    for (const kind of ['pending', 'promises', 'boundaries']) {
      for (const e of mem[kind] || []) {
        const k = e && ['user', 'self', 'infer'].indexOf(e.by) >= 0 ? e.by : 'none'
        byMix[k] += 1
      }
    }
    const byTotal = byMix.user + byMix.self + byMix.infer + byMix.none
    const inferPct = byTotal ? Math.round((byMix.infer / byTotal) * 1000) / 10 : 0
    let lastWriteAt = 0
    let bakExists = false
    let corruptExists = false
    try {
      lastWriteAt = Math.round(fs.statSync(MEM_FILE).mtimeMs)
    } catch {}
    try {
      bakExists = fs.existsSync(MEM_FILE + '.bak')
    } catch {}
    try {
      corruptExists = fs.existsSync(MEM_FILE + '.corrupt')
    } catch {}
    return {
      counts,
      total: counts.pending + counts.promises + counts.boundaries,
      lastWriteAt,
      bakExists,
      corruptExists,
      restoredAt: (state.memRestored && state.memRestored.at) || 0,
      // 推理占比（只读读数）：byMix 分布 + inferPct 百分比。
      // 30% 以上说明记忆被推断污染，面板上提示一句就够，不做自动处理。
      byMix,
      inferPct,
      // 观测面：✕ 率的分子分母 + 两个环形桶的当前条数（够拍板就读数，不用翻文件）
      added: (mem.stats && Number(mem.stats.added)) || 0,
      dropped: (mem.stats && Number(mem.stats.dropped)) || 0,
      xlog: (mem.xlog || []).length,
      shadow: (mem.shadow || []).length,
      file: MEM_FILE,
    }
  } catch {
    return null
  }
}

/**
 * 她自己的写入通道。面板只读，写只有两条路：她自己调用，或者延后检测命中。
 * 参数全在这里校验 —— 调用方是客户端和事件回调，都不能假设它们传对了。
 */
/* ───────── 写入前洗掉密钥（2026-11-07，借自 Lutisure/cyrene-agent 的 memory-logic）─────────
 * 为什么放在**写入这一层**而不是注入层：记忆会被注入提示词、也会被导出成 JSON 贴给别人。
 * 在源头洗掉，下游所有出口就都干净了。
 * 顺序必须长模式在前 —— 否则 PEM 的头被替换、正文留在原地，等于没洗。 */
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[私钥已隐去]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[密钥已隐去]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[令牌已隐去]'],
  [/\bAKIA[0-9A-Z]{12,}/g, '[密钥已隐去]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[令牌已隐去]'],
]

function redactSecrets(text) {
  let s = String(text == null ? '' : text)
  for (const pair of SECRET_PATTERNS) {
    try {
      s = s.replace(pair[0], pair[1])
    } catch {}
  }
  return s
}

function applyMemoryOp(op) {
  if (!op || typeof op !== 'object' || Array.isArray(op)) return { ok: false, error: 'op 必须是对象' }
  const mem = readMemory()
  const now = new Date().toISOString()
  const act = String(op.op || '')
  const kind = String(op.kind || '')
  // 这条是「谁说的话」：user = 你的原话，self = 她自己说的，infer = 推断。
  // 只为看、不进上下文 —— 目的是别再出现「把她推断的话当成你说的」。
  const byRaw = String(op.by || '')
  const by = ['user', 'self', 'infer'].indexOf(byRaw) >= 0 ? byRaw : ''

  if (act === 'bump') {
    const key = String(op.key || '').trim().slice(0, 60)
    if (!key) return { ok: false, error: '缺少 key' }
    const cur = mem.counts[key]
    mem.counts[key] = { n: (cur ? cur.n : 0) + 1, at: now }
  } else if (act === 'add') {
    if (MEM_KINDS.indexOf(kind) < 0) return { ok: false, error: 'kind 不对' }
    // ★ 画像闸门（2026-11-06，照抄原版 memory-judge.ts:19）：
    //   只有 certainty=explicit 且 attribution=user_explicit 才允许进画像。
    //   在**写入**这一层就挡掉，而不是只挡注入 —— 存进去的错比没存的错更难收拾。
    let profileField = ''
    if (kind === 'profile') {
      profileField = String(op.field || '').trim()
      if (PROFILE_FIELDS.indexOf(profileField) < 0) {
        return { ok: false, error: 'profile.field 必须是 ' + PROFILE_FIELDS.join('/') }
      }
      const ce = String(op.certainty || 'explicit')
      const at = String(op.attribution || 'user_explicit')
      if (CERTAINTY.indexOf(ce) < 0) return { ok: false, error: 'certainty 必须是 ' + CERTAINTY.join('/') }
      if (ATTRIBUTION.indexOf(at) < 0) return { ok: false, error: 'attribution 必须是 ' + ATTRIBUTION.join('/') }
      if (ce !== 'explicit' || at !== 'user_explicit') {
        return { ok: false, error: '画像只收「用户明确说过的」（certainty=explicit 且 attribution=user_explicit）' }
      }
    }
    const what = redactSecrets(String(op.what || '').trim()).slice(0, MEM_TEXT_MAX)
    if (!what) return { ok: false, error: '缺少 what' }
    // 来源原话：记下「这句是从你哪句话里来的」。
    // 为什么值得多存一个字段（只为看、不进上下文）：
    // 光看「这个明天再弄」你不知道指的是什么，配上原话才对得上号。
    const src = redactSecrets(String(op.src || '').trim()).slice(0, MEM_SRC_MAX)
    // ★ cue（2026-11-06 借原版 relationship-log 的 nextCareCue）：
    //   「所以下次该怎么做」。只存 what 的话，每次用这条边界都得从句子里重新推一遍，
    //   而推导会漂。cue 是可选的，而且只写「用户明确表达过的那一条」，
    //   不要替用户延伸出他没说过的规矩。
    const cue = redactSecrets(String(op.cue || '').trim()).slice(0, MEM_SRC_MAX)
    // ★ 承诺必须带原话（2026-11-03 加）：promises 记的是「她答应过的事」，
    // 没有原话就说不清是在什么上下文里答应的，事后无法自证。
    // pending / boundaries 本来就带 src（noteDeferred / noteBoundary），这里只是补齐。
    if (kind === 'promises' && !src) return { ok: false, error: '承诺必须带原话（src）' }
    // ★ 取代链（2026-11-03 加）：op.supersedes 是「旧条目的 what 列表」。
    // 只由调用方显式传入，**不自动推断** —— 自动判断「这句是不是在反转上一句」
    // 一定会误伤（用户可能只是在举反例）。
    // 旧条目不清除，只打 supersededBy，注入时跳过、面板上显示「已被 X 取代」。
    const supersedes = Array.isArray(op.supersedes) ? op.supersedes.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 3) : []
    if (supersedes.length) {
      for (const oldWhat of supersedes) {
        const old = mem[kind].find((e) => e && e.what === oldWhat && !e.supersededBy)
        if (old) old.supersededBy = what
      }
    }
    // ★ 有效期（2026-11-03 加）：pending / promises 默认 7 天后失效 ——
    // 过期后不再进注入（memorySectionText 会过滤），但条目留在面板上标灰。
    // 为什么只有这两类：它们是「临时状态」；boundaries 是用户定的规矩，
    // 只能因为用户变卦失效，不能自己过期。
    // 老条目没有 validTo → 一律视为永久，不改写历史数据。
    const VALID_MS = 7 * 24 * 60 * 60 * 1000
    const withValid = kind === 'pending' || kind === 'promises'
    const validTo = Number(op.validTo) > 0 ? Number(op.validTo) : (withValid ? Date.now() + VALID_MS : 0)
    // 同一类里同一句只刷新时间，不堆两条 —— 否则她说一句「明天再弄」能记十遍
    // ★ 画像例外：同一个 field 只留一条，新值覆盖旧值（「我叫 A」→「以后叫我 B」）
    const hit = mem[kind].find((e) => (kind === 'profile' ? e.field === profileField : e.what === what))
    if (hit) {
      hit.at = now
      hit.done = false
      if (kind === 'profile') hit.what = what
      if (src) hit.src = src
      if (cue) hit.cue = cue
      if (by) hit.by = by
      // 又提了一次 = 重新给 7 天，不然「拖了 6 天、今天又说了」也会立刻过期
      if (withValid) hit.validTo = validTo
    } else {
      const row = { at: now, what, done: false }
      if (validTo) row.validTo = validTo
      if (src) row.src = src
      if (cue) row.cue = cue
      if (by) row.by = by
      if (kind === 'profile') {
        row.field = profileField
        row.certainty = 'explicit'
        row.attribution = 'user_explicit'
      }
      mem[kind].push(row)
      // 观测分母：只有「真的新增一行」才算（去重刷新 at 不算，否则分母虚高、✕ 率虚低）
      mem.stats = mem.stats || { added: 0, dropped: 0 }
      mem.stats.added = (Number(mem.stats.added) || 0) + 1
    }
  } else if (act === 'done') {
    if (MEM_KINDS.indexOf(kind) < 0) return { ok: false, error: 'kind 不对' }
    const what = String(op.what || '')
    const hit = mem[kind].find((e) => e.what === what)
    if (hit) hit.done = true
  } else if (act === 'drop') {
    if (kind === 'counts') {
      const key = String(op.key || '')
      if (key) delete mem.counts[key]
    } else if (MEM_KINDS.indexOf(kind) >= 0) {
      const what = String(op.what || '')
      // 观测 ✕ 率：drop 目前唯一来源就是面板的手动删除（自动记录只用 add/bump）。
      // age（删除时刻 − 条目创建时刻）是区分「手滑/改主意」和「真误记」的关键：
      // 看到面板立刻删 = 前者；隔一阵回来删 = 后者。
      const victim = mem[kind].find((e) => e.what === what)
      mem[kind] = mem[kind].filter((e) => e.what !== what)
      mem.stats = mem.stats || { added: 0, dropped: 0 }
      mem.stats.dropped = (Number(mem.stats.dropped) || 0) + 1
      mem.xlog = Array.isArray(mem.xlog) ? mem.xlog : []
      const created = victim && victim.at ? Date.parse(victim.at) : NaN
      const age = Number.isFinite(created) ? Math.max(0, Date.now() - created) : -1
      mem.xlog.unshift({ at: now, age, kind, what: what.slice(0, 40) })
      if (mem.xlog.length > AUDIT_XLOG_CAP) mem.xlog.length = AUDIT_XLOG_CAP
    } else {
      return { ok: false, error: 'kind 不对' }
    }
  } else {
    return { ok: false, error: '不认识的 op' }
  }
  const w = writeMemory(mem)
  if (!w.ok) return w
  return { ok: true, memory: mem }
}

/**
 * 延后检测：把你说的「明天再弄 / 回头再说 / 先放一放」记成一条待办。
 *
 * 只认**明确表示要延后**的短语，不做语义理解 —— 宁可漏记，也不要记一堆噪音。
 * 为什么偏保守：漏记只是少一句陪伴；**错记是「她以为你说过你没说的话」**，
 * 那种错比沉默伤害大得多，而且你没法证明她记错了。
 *
 * 记的是你的原话片段（≤34 字），不加工、不总结 —— 加工过的「待办」你认不出是自己说的。
 */
const DEFER_PATTERNS = [
  /(明天|明早|明晚|后天|下次|回头|晚点|改天|待会|一会儿)[^。！？!?\n]{0,14}(再|就)(弄|做|看|搞|说|聊|继续)/,
  /(明天|明早|明晚|后天|下次|回头|晚点|改天)[^。！？!?\n]{0,10}(再说|再弄|继续|接着)/,
  /(先|暂时)(放一放|放着|不弄|搁着|别弄)/,
  /等(我|你)(回来|有空|忙完)/,
]

function noteDeferred(text) {
  const t = stripInjectedBlocks(text)
  if (!t || t.length > 240) return null
  let hit = null
  for (const re of DEFER_PATTERNS) {
    const m = re.exec(t)
    if (m && (hit === null || m.index < hit.index)) hit = m
  }
  if (!hit) return null
  const i = Math.max(0, hit.index - 6)
  const what = t.slice(i, i + 34).replace(/\s+/g, " ").trim()
  // 和 noteBoundary 用同一道尺子：去掉标点后还要 ≥4 个字。
  // 2026-11-03 评审实锤：这里原来只有 `if (!what)`，而 noteBoundary 的注释却写着
  // 「和 noteDeferred 用同一道尺子」—— 注释与代码不一致，已在第四轮补齐。
  if (!what || what.replace(/[，。！？、\s]/g, "").length < 4) return null
  try {
    applyMemoryOp({ op: 'add', kind: 'pending', what, src: contextAround(t, hit.index, hit[0].length).slice(0, MEM_SRC_MAX), by: 'user' })
  } catch {}
  return what
}

/**
 * 承诺检测：**助手**说「人家帮你弄」这类话时，记成一条 promises。
 *
 * 为什么钩在 assistant/message 而不是 user/message：
 * 「她答应过的事」在这个系统里就是助手在对话里许下的，用户说的话已经由
 * noteDeferred 管了。两条线各管一边，不重叠。
 *
 * 为什么比延后检测更保守：承诺的语义更模糊 ——
 * 「要不要我帮你弄？」是**提问**不是承诺，「我能帮你弄」是**能力描述**。
 * 所以先排掉问句和能力句，剩下的才认。
 */
const PROMISE_PATTERNS = [
  /(我|人家)(来|去|帮|给你|替你)[^。！？!?\n]{0,14}(弄|做|看|查|改|写|修|试|处理)/,
  // 两种语序都认：「回头我看看」和「我回头看看」——中文里都常见
  /(回头|下次|等会|一会儿|待会)(我|人家)[^。！？!?\n]{0,10}(看|弄|做|查|改)/,
  /(我|人家)(回头|下次|等会|一会儿|待会)[^。！？!?\n]{0,10}(看|弄|做|查|改)/,
  /(包在|交给)(我|人家)[^。！？!?\n]{0,6}(身上|来|办)?/,
  // ★ 2026-11-03 白名单式加三条「主语 + 强动作」。
  //   为什么不是「放宽排除词」：排除词放宽会放进一堆状态描述（误记），
  //   而这三条要求**主语是她自己**且**带明确动作**，属于精准捞取。
  //   A：「人家这就去帮你看看配置」「我马上帮你改」
  /(人家|我)[^。！？!?\n]{0,4}(这就|马上|立刻|现在)(去|来)?[^。！？!?\n]{0,6}(帮|弄|看|改|写|办|处理|查)/,
  //   B：「交给我吧」「包在人家身上」
  /(交|包)给(人家|我)吧/,
  //   C：「人家一定帮你」「我尽量查一下」
  /(人家|我)(一定|肯定|尽量)[^。！？!?\n]{0,4}(帮|弄|做|看|改|查)/,
]

/** 单句判断：这句话本身是不是一个承诺。 */
function detectPromiseOne(t) {
  // 问句不是承诺
  if (/[？?]\s*$/.test(t)) return null
  // 「要不要 / 需要我 / 可以帮」这类是征询或能力描述，不是许诺
  if (/(要不要|需不需要|需要我|可以帮|要我|能不能帮)/.test(t)) return null
  // ★「免得 / 以免 / 省得」引的是**目的或理由**，不是要干的活。
  //   真实误记（2026-11-01 真机）：「来，免得下次人家又把它当成还没做完的事」——
  //   这句是解释为什么现在要处理那条记忆，被当成了「人家要去做某事」。
  //   同类还有「以免以后忘了」「省得再问一遍」。
  if (/(免得|以免|省得)/.test(t)) return null
  // ★ 句子里有「还没 / 没有 / 不是 / 别」这类否定，多半在描述**状态**而不是承诺。
  //   代价是漏掉「人家还没弄，回头一定弄」这种，宁可漏 —— 误记比漏记贵得多。
  if (/(还没|没有|不是|别把|别再)/.test(t)) return null
  let hit = null
  for (const re of PROMISE_PATTERNS) {
    const m = re.exec(t)
    if (m && (hit === null || m.index < hit.index)) hit = m
  }
  if (!hit) return null
  const i = Math.max(0, hit.index - 4)
  const what = t.slice(i, i + 34).replace(/\s+/g, " ").trim()
  // 截出来太短或只有语气词，说明匹配点落在虚词上，不算
  if (!what || what.replace(/[，。！？、\s]/g, "").length < 4) return null
  // ★ 提取后再过一遍脏词：带疑问词或反向词的，哪怕命中正则也不记。
  //   例：「交给我？你确定吗？」「我马上就不弄了」——前者是反问，后者是否定。
  if (/[？?]/.test(what) || /(吗|呢)/.test(what)) return null
  if (/(不|没)(是|会|想|能|要|用|去|弄|帮|做|看|改)/.test(what)) return null
  return what
}

// 给测试脚本用的只读出口（detectPromiseOne 本来就在闭包里，单测拿不到）。
export const __testPromise = (sentence) => detectPromiseOne(String(sentence || ''))

// ── 影子记录（观测「漏记」用，不进上下文）──
// 只记一件事：**正则命中了、但最后被某道关拦掉**的句子。
// 问句 / 征询 / 「免得」这几类不记 —— 它们本来就不该被记成承诺，记了全是噪音。
// 诚实的边界：影子测的是「排除链的松紧」，测不了「pattern 表覆盖不到的新句式」。
function probePromise(s) {
  if (/[？?]\s*$/.test(s)) return null
  if (/(要不要|需不需要|需要我|可以帮|要我|能不能帮)/.test(s)) return null
  if (/(免得|以免|省得)/.test(s)) return null
  let hit = null
  let pat = -1
  for (let i = 0; i < PROMISE_PATTERNS.length; i++) {
    const m = PROMISE_PATTERNS[i].exec(s)
    if (m && (hit === null || m.index < hit.index)) {
      hit = m
      pat = i
    }
  }
  if (!hit) return null // pattern 都没命中 → 不在影子能观测的范围里
  if (/(还没|没有|不是|别把|别再)/.test(s)) return { rule: 'neg', pat }
  const i = Math.max(0, hit.index - 4)
  const what = s.slice(i, i + 34).replace(/\s+/g, ' ').trim()
  if (!what || what.replace(/[，。！？、\s]/g, '').length < 4) return { rule: 'short', pat }
  if (/[？?]/.test(what) || /(吗|呢)/.test(what)) return { rule: 'dirty', pat }
  if (/(不|没)(是|会|想|能|要|用|去|弄|帮|做|看|改)/.test(what)) return { rule: 'dirtyNeg', pat }
  return null // 没被拦掉 = 本来就该记，不需要影子
}

function recordShadow(list) {
  try {
    if (!Array.isArray(list) || list.length === 0) return
    const mem = readMemory()
    mem.shadow = Array.isArray(mem.shadow) ? mem.shadow : []
    for (const it of list) mem.shadow.unshift(it)
    if (mem.shadow.length > AUDIT_SHADOW_CAP) mem.shadow.length = AUDIT_SHADOW_CAP
    writeMemory(mem)
  } catch {}
}

function notePromise(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 400) return null
  // ★ 按句切，不按整条消息判断。
  // 为什么：一条长回复里常常既有「要不要我帮你清掉？」又有真的承诺，
  // 整条判断的话，前者会把后者一起排除 —— 这个 bug 真机上撞到过：
  // 面板里 promises 一直是 0，而回复里明明写了「人家帮你看看」。
  const sentences = t.split(/[。！？!?\n]+/).map((s) => s.trim()).filter(Boolean)
  const got = []
  const shadows = []
  for (let si = 0; si < sentences.length; si++) {
    const s = sentences[si]
    const what = detectPromiseOne(s)
    if (!what) {
      // 观测：命中了正则但被拦掉的句子，记进影子桶（批量写，一条消息只多一次落盘）
      try {
        const probe = probePromise(s)
        if (probe) shadows.push({ at: new Date().toISOString(), rule: probe.rule, pat: probe.pat, src: s.slice(0, 60) })
      } catch {}
      continue
    }
    // ★ 下一句把话收回去了就不算承诺。
    //   真实反例（第四轮评审给的）：「我一定帮你？不可能。」—— 按句切之后
    //   第一句「我一定帮你」完美命中，但第二句直接否认。这种不记。
    const next = (sentences[si + 1] || '').trim()
    if (/^(不|没|别|才怪|想得美|开玩笑)/.test(next)) continue
    // 一句回复里可能答应两件事（「帮你看看那个文件，明天把报告也给你」）。
    // 以前命中一条就 return，第二件永远不记；add 本身按 what 去重，逐条记不会堆重复。
    try {
      // ★ src 取「命中的那一句」而不是整条回复（2026-11-06）：
      //   整条回复截 120 字，往往只截到开头寒暄，真正那句承诺根本不在里面，
      //   面板上「她说过：「…」」就成了答非所问。
      applyMemoryOp({ op: 'add', kind: 'promises', what, src: s.slice(0, MEM_SRC_MAX), by: 'self' })
    } catch {}
    got.push(what)
  }
  recordShadow(shadows)
  return got.length ? got[0] : null
}

// 测试出口：notePromise 整条消息级别的行为（含「下一句否认」那道关）。
export const __testNotePromise = (text) => notePromise(String(text || ''))
// 测试出口：观测桶（✕ 率 / 影子）的写入路径。
export const __testMemoryOp = (op) => applyMemoryOp(op)

/**
 * 边界检测：你说「别用 X / 别动那个」这类话时，记成一条 boundaries。
 *
 * 这是整组里**最保守**的一个，原因：
 * 误记成边界 = 「她以为你说过别用 SQLite」，而你从没说过。
 * 那种错没法自证，而且会影响很久。**宁可漏记。**
 *
 * 所以先排掉两大类：
 *   ① 情绪安抚（「别担心」「别急」「没关系」）
 *   ② 没有对象的泛泛否定（「不用了」「别客气」）
 */
const BOUNDARY_PATTERNS = [
  // {0,N} 而不是 {1,N}：「这个文件先别动。」这种句尾没内容的也要认。
  // 具体性由后面 what.length >= 4 把关，不靠正则的尾巴。
  /(别|不要|不用|不准|不许)(再)?(用|改|动|碰|删|加|换|提|写)[^。！？!?\n]{0,12}/,
  /(以后|下次|下回)(别|不要)[^。！？!?\n]{0,14}/,
  /(这|那)[个些](别|不要)(动|改|碰|删)[^。！？!?\n]{0,8}/,
]

// 这些是安慰/客气，不是边界
const BOUNDARY_EXCLUDE = /(别担心|别急|别慌|别在意|别害怕|别难过|别累|别勉强|别客气|别谢|不要紧|没关系|不用谢|不用了|不用管我|别管我)/

/**
 * 去掉用户消息里被注入的记忆块。
 *
 * 为什么需要：meow-memory 会把「可能相关的记忆，仅供参考：…」直接拼在用户正文**前面**，
 * 于是 noteBoundary / noteDeferred 截下来的「你说过」可能是一整段注入说明，而不是他真说的话。
 * 2026-11-03 用户截图逮到一条：src 显示的是 `[dsh-plugin-cyrene-live2d : fact] [0mvxvkl3l-1]`。
 */
function stripInjectedBlocks(t) {
  return String(t || '')
    .split(/\n+/)
    .filter((line) => {
      const s = line.trim()
      if (!s) return true
      if (/^(可能相关的记忆|===== 长期记忆)/.test(s)) return false
      if (/^【(关于user|设计原则|记忆导引|项目：|本会话写过的记忆)/.test(s)) return false
      if (/^\[[^\]]+ : (fact|lesson|topic|rules|project|user|soul)\]/.test(s)) return false
      return true
    })
    .join('\n')
    .trim()
}

/**
 * 命中点前后的上下文。
 *
 * 为什么加：用户 2026-11-03 的原话是「有时候用户自己会忘了为什么说这句话」——
 * 只存被命中的那 34/40 个字，三个月后根本想不起当时的语境。
 * 所以向前带 30 字、向后带 60 字，两边截断处标「…」。
 */
function contextAround(t, index, len) {
  const before = 30
  const after = 60
  const a = Math.max(0, index - before)
  const b = Math.min(t.length, index + len + after)
  const head = a > 0 ? '…' : ''
  const tail = b < t.length ? '…' : ''
  return head + t.slice(a, b).replace(/\s+/g, ' ').trim() + tail
}

function noteBoundary(text) {
  // 先剥掉注入块，再量长度 —— 否则一整段注入说明会把真正的边界挤出 300 字窗口。
  const t = stripInjectedBlocks(text)
  if (!t || t.length > 300) return null
  if (BOUNDARY_EXCLUDE.test(t)) return null
  let hit = null
  for (const re of BOUNDARY_PATTERNS) {
    const m = re.exec(t)
    if (m && (hit === null || m.index < hit.index)) hit = m
  }
  if (!hit) return null
  const i = Math.max(0, hit.index - 4)
  const what = t.slice(i, i + 40).replace(/\s+/g, " ").trim()
  // 和 noteDeferred 用同一道尺子：去掉标点后还要 ≥4 个字，否则「别动。」这种也算一条。
  if (!what || what.replace(/[，。！？、\s]/g, "").length < 4) return null
  try {
    // src = 命中点前后各带一截，让人事后能想起「当时为什么这么说」
    applyMemoryOp({ op: 'add', kind: 'boundaries', what, src: contextAround(t, hit.index, hit[0].length).slice(0, MEM_SRC_MAX), by: 'user' })
  } catch {}
  return what
}

// ─────────────────── 人格底稿 + 表情包清单 ───────────────────
//
// 这两样原本属于 dsh-cyrene-theme：它注册 systemPrompt section `cyrene:persona`，
// 正文是 `persona + stickerText()`。要卸载它，这两样必须先搬到这里，
// 否则卸载的那一刻人格直接消失、表情包也不能贴了。
//
// 数据继续存在同一个 prefs 文件里（复用 readPrefs / writePrefs 的原子写法），
// 值都是字符串。为什么不用新文件：prefs 已经有「读失败退回空、写失败返回错误」这一套，
// 再造一份要重写一遍，没必要。
const HERO_TITLE_DEFAULT = '让昔涟来帮帮你吧🎵'
const HERO_IMAGE_REL = 'meme/俏皮眨眼.png'
const STICKER_FILE = path.join(ROOT, 'stickers.json')
const STICKER_MAX_PER_TURN = 1
const PERSONA_SECTION_NAME = 'cyrene-live2d:persona'
/** 世界书是 150，人设排在它前面 —— 和主题插件原来的相对位置一致。 */
const PERSONA_ORDER_FALLBACK = 100
/** 主题插件留下的状态文件：第一次升级时从这里把人设捞过来。 */
const LEGACY_THEME_STATE = path.join(DSH_HOME, 'cyrene-theme.json')
/** 用户自己加的贴纸 / 背景图 —— 在 DATA_DIR 下，卸载主题插件也不该丢。 */
// CUSTOM_DIR 在文件头统一定义

const PK = {
  persona: 'persona',
  rev: 'personaRev',
  on: 'personaOn',
  theme: 'themeOn',
  stickers: 'stickersOn',
  bg: 'bgOn',
  bgRotate: 'bgRotate',
  bgCurrent: 'bgCurrent',
  heroTitle: 'heroTitle',
}

let personaSectionDispose = null

/** 开关类偏好的统一读法：没写过就用默认值，写过 "0" 才算关。 */
function prefOn(key, def) {
  const v = readPrefs()[key]
  if (v === undefined) return def
  return v !== '0'
}

/**
 * 首次升级时把人设从主题插件的状态文件里捞过来。
 * 只在自己还没有人设的时候做一次，之后主题插件卸不卸都不影响。
 */
function adoptLegacyPersona() {
  try {
    const cur = readPrefs()[PK.persona]
    if (typeof cur === 'string' && cur.trim() !== '') return
    const j = JSON.parse(fs.readFileSync(LEGACY_THEME_STATE, 'utf8'))
    const text = String((j && j.persona) || '').trim()
    if (text === '') return
    writePrefs({ [PK.persona]: text, [PK.rev]: '1' })
    if (j && j.hero && typeof j.hero.title === 'string' && j.hero.title !== '') {
      writePrefs({ [PK.heroTitle]: String(j.hero.title).slice(0, 80) })
    }
  } catch {
    // 没有旧文件就算了：人设留空，用户可以自己写
  }
}

/**
 * 包里带的那份人设种子（`assets/default-prefs.json`，只放 7 个键）。
 *
 * 为什么需要：分发出去之后，收包人的机器上没有 `prefs.json`，
 * `readPrefs()` 只会返回 `{}` —— 人设是空的，她开口就不像昔涟了。
 * 所以第一次启动时要把包里的默认值灌进去一次。
 *
 * 三条纪律：
 * ① **`prefs.json` 已经存在就一步都不走** —— 绝不拿默认值覆盖用户自己的人设；
 * ② 只收标量、只收字符串化后的值，和 `writePrefs` 的契约保持一致；
 * ③ 整个函数包 try —— 包坏了、文件缺了，都只是「没有人设」，不能让宿主起不来。
 */
const DEFAULT_PREFS_FILE = path.join(ROOT, 'default-prefs.json')

function seedPrefsFromPackage() {
  // 结果留一份在 state 里，给 /api/state 的 seedProbe 用 ——
  // 种子失败（JSON 坏了 / 文件缺了）以前是纯静默的，用户只会看到「人设是空的」。
  const done = (msg) => {
    try {
      state.seedProbe = msg
    } catch {}
    return msg
  }
  try {
    if (fs.existsSync(PREFS_FILE)) return done('skip: exists')
    if (!fs.existsSync(DEFAULT_PREFS_FILE)) return done('skip: no default-prefs.json')
    let j = null
    try {
      j = JSON.parse(fs.readFileSync(DEFAULT_PREFS_FILE, 'utf8'))
    } catch (e) {
      return done('bad json: ' + String((e && e.message) || e).slice(0, 60))
    }
    if (!j || typeof j !== 'object' || Array.isArray(j)) return done('bad shape')
    const set = {}
    for (const k of Object.keys(j)) {
      const v = j[k]
      if (v === null || v === undefined) continue
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue
      set[k] = String(v)
    }
    if (Object.keys(set).length === 0) return done('empty')
    const w = writePrefs(set)
    if (!w || w.ok !== true) return done('write failed: ' + String((w && w.error) || ''))
    return done('ok: ' + Object.keys(set).length + ' keys')
  } catch (e) {
    return done('error: ' + String((e && e.message) || e).slice(0, 60))
  }
}

/** 表情包清单：读包内 stickers.json，绝对路径指向**小昔涟自己的** assets/meme。 */
let stickerCache = { stamp: 0, items: [] }
function stickerItems() {
  try {
    const st = fs.statSync(STICKER_FILE)
    if (stickerCache.stamp === st.mtimeMs) return stickerCache.items
    const j = JSON.parse(fs.readFileSync(STICKER_FILE, 'utf8'))
    const items = (Array.isArray(j.items) ? j.items : [])
      .map((it) => {
        const abs = path.join(ROOT, String(it.file || ''))
        return {
          label: String(it.label || ''),
          when: String(it.when || ''),
          abs: abs.split(path.sep).join('/'),
        }
      })
      .filter((it) => it.label !== '' && fs.existsSync(it.abs))
    stickerCache = { stamp: st.mtimeMs, items }
    return items
  } catch {
    return []
  }
}

/**
 * 拼进人设正文的表情包约定。
 * 文案照抄主题插件那份，别改措辞 —— 模型就是按这段格式抄路径的。
 */
function stickerText() {
  if (!prefOn(PK.stickers, true)) return ''
  const items = stickerItems()
  if (items.length === 0) return ''
  const lines = [
    '',
    '【表情包】',
    `你有一套自己的表情包（${items.length} 张）。想贴一张的时候，在回复的最后单独占一行，原样写下面对应的整行（**路径连尖括号一起复制**，不要改写、不要自己拼）：`,
    '',
  ]
  for (const it of items) {
    const use = it.when === '' ? '' : `｜${it.when}`
    lines.push(`- ${it.label}${use} → ![昔涟·${it.label}](<${it.abs}>)`)
  }
  lines.push(
    '',
    `贴的规矩：一次回复最多 ${STICKER_MAX_PER_TURN} 张；只在情绪真的到了的时候贴（事情做成了、想鼓励你、想撒个娇、要道歉、被夸了）；代码、命令、报错和技术结论旁边不要贴；拿不准就不贴。`,
  )
  return lines.join('\n')
}

/** 真正要注入的正文：关掉人格、或者设定为空时交空字符串（空 section 会被丢掉）。 */
function personaBody() {
  if (!prefOn(PK.on, true)) return ''
  const text = String(readPrefs()[PK.persona] || '').trim()
  if (text === '') return ''
  return text + stickerText()
}

/** 挂载（或重挂）人设 section。保存后立刻重挂 = 下一轮对话就生效。 */
/** 最近一次挂载用的 order，给诊断看（不确定 section 位置对不对时全靠它）。 */
let personaOrderUsed = -1

/**
 * 人设 section 的 order。
 *
 * 2026-10-31 改过一次，原因：反馈「人格好像没生效，之前不是这样的」。
 * 查 `@deepseek-ai/dsh-system-prompt` 里的 SECTION_ORDERS 才看清这张表 ——
 *
 *   HARNESS_IDENTITY -1000 / DEPLOYMENT_PERSONA_PREFIX 0 / PLAN_POLICY 500
 *   FILE_REFERENCE 900 / TOOL_* 1000~5000 / TOOLS_SDK 5000
 *   DELIVERABLE 9000 / STRUCTURED_OUTPUT 9900 / HARNESS_SOURCE 10000
 *   WEB_SURFACE 10100 / DEPLOYMENT_PERSONA_SUFFIX 10200
 *
 * 原来照抄主题插件写「前缀 + 100 = 100」，等于把人设塞在**所有工具文档之前**：
 * 后面还压着上千行工具说明 + 源码 + 网页说明，读到它的「近因权重」几乎为零。
 * 现在改成贴到「部署人格后缀」(10200) 的后面一格 = 整个 system prompt 的最后一块。
 * 取不到后缀时退回老算法（前缀 + 100），再取不到才用兜底 100。
 */
function resolvePersonaOrder() {
  const svc = PROMPT_SVC
  if (!svc || typeof svc.getSectionOrder !== 'function') return PERSONA_ORDER_FALLBACK
  try {
    const suffix = svc.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX')
    if (Number.isFinite(suffix)) return suffix + 1
  } catch {
    // 没有这个键，退回下面的老算法
  }
  for (const key of ['DEPLOYMENT_PERSONA', 'DEPLOYMENT_PERSONA_PREFIX']) {
    try {
      const order = svc.getSectionOrder(key)
      if (Number.isFinite(order)) return order + PERSONA_ORDER_FALLBACK
    } catch {
      // 这个键名不存在，换下一个
    }
  }
  return PERSONA_ORDER_FALLBACK
}

function mountPersona() {
  const svc = PROMPT_SVC
  if (!svc) return
  if (personaSectionDispose !== null) {
    try {
      personaSectionDispose()
    } catch {
      // 旧的已经跟着插件 fiber 一起没了
    }
    personaSectionDispose = null
  }
  const order = resolvePersonaOrder()
  try {
    personaSectionDispose = svc.section({
      name: PERSONA_SECTION_NAME,
      order,
      // DSH 0.2.2 起 section 正文默认做 {{变量}} 插值，遇到未注册变量会抛
      // `unknown prompt variable` 并让整份提示词组装失败。人设是用户可改的正文，
      // 必须原样落地，所以显式关掉插值。
      interpolate: false,
      text: personaBody(),
    })
    personaOrderUsed = order
  } catch {
    personaSectionDispose = null
    personaOrderUsed = -1
  }
}

/** 客户端要的那一份人设状态（不含其它设置）。 */
function personaPublic() {
  const p = readPrefs()
  return {
    text: String(p[PK.persona] || ''),
    rev: Number(p[PK.rev] || 0) || 0,
    on: prefOn(PK.on, true),
    stickersOn: prefOn(PK.stickers, true),
    themeOn: prefOn(PK.theme, true),
    bgOn: prefOn(PK.bg, true),
    bgRotate: prefOn(PK.bgRotate, false),
    /// 选中的那张背景（文件名）；空串 = 按目录顺序用第一张。
    bgCurrent: String(p[PK.bgCurrent] || ''),
    heroTitle: String(p[PK.heroTitle] || HERO_TITLE_DEFAULT),
    customDir: CUSTOM_DIR,
    // ── 诊断：这三项只读，用来判断「人设到底挂上没、挂了多长、排第几」。
    // 光看内容对不对看不出问题，位置错了照样「像又不像」。
    bodyChars: personaBody().length,
    stickerChars: stickerText().length,
    order: personaOrderUsed,
    mounted: personaSectionDispose !== null,
  }
}

/**
 * 自定义素材（贴纸 / 背景图）：只认 CUSTOM_DIR 里的文件，按名字读，不许带路径。
 * 包内自带的那些走静态白名单，不经过这里。
 */
function safeCustomName(name) {
  const n = String(name || '').trim()
  if (n === '' || n.length > 80) return ''
  if (n.indexOf('/') >= 0 || n.indexOf('\\') >= 0 || n.indexOf('..') >= 0) return ''
  return n
}

function listCustom() {
  try {
    return fs
      .readdirSync(CUSTOM_DIR)
      .filter((n) => /\.(png|jpe?g|webp|gif)$/i.test(n))
      .map((n) => ({ name: n, size: fs.statSync(path.join(CUSTOM_DIR, n)).size }))
  } catch {
    return []
  }
}

function mimeOf(name) {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.webp') return 'image/webp'
  if (ext === '.gif') return 'image/gif'
  return ''
}

// ── TTS provider 适配层（2026-11-11）───────────────────────────────
// 为什么要有这一层：client 侧只认 `POST <前缀>/api/tts` 一个入口（client.js:3058），
// 换后端不该动前端。所以「换哪家 TTS」只在宿主这里分叉。
//
// 支持的 provider：
//   gsv     本机 GPT-SoVITS（9881，GET /tts?文本…）           ← 默认，与旧行为逐字一致
//   qwen    Qwen3-TTS 等 OpenAI 兼容服务（POST /audio/speech）
//   openai  OpenAI / 任何兼容实现（同上）
//   http    泛用模板：自己给 url / method / body / headers
//
// 配置（~/.dsh/cyrene-live2d/tts.json）：
//   { "provider":"gsv", "fallback":["qwen","http"],
//     "providers": { "qwen": {"endpoint":"http://127.0.0.1:9880/v1","model":"qwen3-tts",
//                             "voice":"cyrene","apiKey":""} , ... } }
//
// 注：这里原来有个 TTS_PROVIDER_NEEDS_REF 集合，用来在入口处「缺参考音频就剔除该 provider」。
// 2026-11-11 实机证伪：本机 tts.json 的 ref_audio_path 被 GBK 误写坏过一个空串，
// 结果连默认的 gsv 也被一起剔除，usable 为空 → 整条 TTS 直接 503。
// 教训：**不在入口按配置齐不齐预先剔除**，一律试，失败顺延（下面那个循环本来就是这么写的）。

function ttsNormProvider(p) {
  const v = String(p || '').trim().toLowerCase()
  if (!v) return 'gsv'
  if (v === 'qwen3' || v === 'qwen-tts' || v === 'qwen3-tts') return 'qwen'
  return v
}

/** 主 provider + fallback，去重保序。 */
function ttsChainOf(conf) {
  const out = [ttsNormProvider(conf.provider)]
  const fb = Array.isArray(conf.fallback) ? conf.fallback : []
  for (const f of fb) {
    const p = ttsNormProvider(f)
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** 按 provider 拼出 { url, init }；不认识的 provider 抛错，由上层记进 note。 */
function buildTtsRequest(conf, provider, text) {
  const pc = (conf.providers && conf.providers[provider]) || {}
  const ep = String(pc.endpoint || conf.endpoint || '').replace(/\/+$/, '')
  const timeout = AbortSignal.timeout(180000)

  if (provider === 'gsv') {
    const qs = new URLSearchParams({
      text,
      text_lang: conf.text_lang,
      ref_audio_path: conf.ref_audio_path,
      prompt_text: conf.prompt_text,
      prompt_lang: conf.prompt_lang,
      top_k: String(conf.top_k),
      top_p: String(conf.top_p),
      temperature: String(conf.temperature),
      text_split_method: conf.text_split_method,
      speed_factor: String(conf.speed_factor),
      fragment_interval: String(conf.fragment_interval),
      repetition_penalty: String(conf.repetition_penalty),
      media_type: 'wav',
      streaming_mode: 'false',
    })
    return { url: ep + '/tts?' + qs.toString(), init: { signal: timeout } }
  }

  if (provider === 'openai' || provider === 'qwen') {
    const body = {
      model: pc.model || conf.model || 'tts-1',
      input: text,
      voice: pc.voice || conf.voice || 'alloy',
      response_format: pc.format || 'wav',
      speed: Number(pc.speed != null ? pc.speed : (conf.speed_factor || 1)),
    }
    // 克隆类：把参考音频喂过去（各家字段名不同，默认 ref_audio_path）
    if (provider === 'qwen' && conf.ref_audio_path) {
      body[pc.refField || 'ref_audio_path'] = conf.ref_audio_path
    }
    const headers = { 'Content-Type': 'application/json' }
    const key = pc.apiKey || conf.apiKey
    if (key) headers.Authorization = 'Bearer ' + key
    return {
      url: ep + (pc.path || '/audio/speech'),
      init: { method: 'POST', headers, body: JSON.stringify(body), signal: timeout },
    }
  }

  if (provider === 'http') {
    // 泛用模板：body 里的 $TEXT 会被替换成**已转义**的文本
    const tpl = String(pc.body || '{"text":"$TEXT"}')
    const safe = JSON.stringify(text).slice(1, -1)
    const headers = Object.assign({ 'Content-Type': 'application/json' }, pc.headers || {})
    const key = pc.apiKey || conf.apiKey
    if (key) headers.Authorization = 'Bearer ' + key
    return {
      url: String(pc.url || ep),
      init: {
        method: String(pc.method || 'POST').toUpperCase(),
        headers,
        body: tpl.split('$TEXT').join(safe),
        signal: timeout,
      },
    }
  }

  throw new Error('未知 provider: ' + provider)
}

async function handleTts(req, res) {
  const conf = readTtsConf()
  let text = ''
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '/', 'http://localhost')
      text = String(url.searchParams.get('text') || '')
    } else {
      const raw = await readBody(req, 8192)
      const j = JSON.parse(raw || '{}')
      text = String(j.text || '')
    }
  } catch (e) {
    sendJson(res, 400, { ok: false, error: 'bad request: ' + String((e && e.message) || e) })
    return
  }

  text = text.trim().slice(0, 300)
  if (!text) {
    sendJson(res, 400, { ok: false, error: 'empty text' })
    return
  }
  // provider 链：**不预先剔除**，全部按顺序试，成功即停（见下面的 for）。
  // 参考音频缺失只由上游自己拒绝，我们不再替它判断 —— 理由见上面 TTS_PROVIDER_NEEDS_REF 那段注。
  const chain = ttsChainOf(conf)
  const usable = chain
  if (!usable.length) {
    sendJson(res, 503, { ok: false, error: '没有配置任何 TTS provider', chain: chain })
    return
  }

  // 触发层去重 + 观测。
  // 之前这里是「1.2 秒内的第二次请求一律挡掉」——时间窗不看文本，于是同一轮里
  // 几条**不同**的台词被连着误杀（/api/state 的 ttsLog 里一片 dup-skip）。
  // 现在按文本去重：同一句 8 秒内只合成一次（防两路轮询叠音），不同台词放行，
  // 由客户端队列保证一句一句播。
  const nowMs = Date.now()
  const recent = state.ttsRecent
  const cutoff = nowMs - 20000
  for (let i = recent.length - 1; i >= 0; i--) if (recent[i].at < cutoff) recent.splice(i, 1)
  const hitSame = recent.find((e) => e.text === text && nowMs - e.at < 8000)
  if (hitSame) {
    state.ttsLog.push({ at: nowMs, text: text.slice(0, 24), ok: false, note: 'dup-skip' })
    if (state.ttsLog.length > 12) state.ttsLog.splice(0, state.ttsLog.length - 12)
    sendJson(res, 429, { ok: false, error: 'same tts already spoken inside 8s', gap: nowMs - hitSame.at })
    return
  }
  recent.push({ text, at: nowMs })

  // 同一时刻只允许一路在合成。客户端是串行排队的，正常台词不会撞上；
  // 撞上就说明有第二个实例 / 第二扇窗在同时说话 —— 直接丢掉第二路，别叠音。
  if (state.ttsInflight > 0) {
    state.ttsLog.push({ at: nowMs, text: text.slice(0, 24), ok: false, note: 'busy-skip' })
    if (state.ttsLog.length > 12) state.ttsLog.splice(0, state.ttsLog.length - 12)
    sendJson(res, 429, { ok: false, error: 'another tts in flight', inflight: state.ttsInflight })
    return
  }

  const logEntry = { at: nowMs, text: text.slice(0, 24), ok: false, note: 'inflight' }
  state.ttsLog.push(logEntry)
  if (state.ttsLog.length > 12) state.ttsLog.splice(0, state.ttsLog.length - 12)

  const qsNote = usable.join('/')

  state.ttsInflight += 1
  try {
    // 逐个 provider 试，成功即停。180 秒：首次调用可能要下 fast_langdetect 模型 / 预热 CUDA。
    let r = null
    let usedProvider = null
    let lastErr = null
    for (const p of usable) {
      try {
        const rq = buildTtsRequest(conf, p, text)
        const resp = await fetch(rq.url, rq.init)
        if (!resp.ok) {
          const t = await resp.text().catch(() => '')
          lastErr = p + ' HTTP ' + resp.status + ' ' + t.slice(0, 120)
          logEntry.note = p + ' upstream ' + resp.status
          continue
        }
        r = resp
        usedProvider = p
        break
      } catch (e) {
        lastErr = p + ' error: ' + String((e && e.message) || e).slice(0, 120)
        logEntry.note = p + ' ' + String((e && e.message) || e).slice(0, 40)
      }
    }
    if (!r) {
      sendJson(res, 502, { ok: false, error: lastErr || 'no provider returned audio', chain: qsNote })
      return
    }
    logEntry.provider = usedProvider
    const raw = Buffer.from(await r.arrayBuffer())
    if (raw.length < 1024) {
      logEntry.note = 'short ' + raw.length + 'B'
      sendJson(res, 502, { ok: false, error: '音频过短 (' + raw.length + ' B)' })
      return
    }
    // 只有 WAV 才过 trim/squeeze；其它格式（mp3/opus/ogg）原样透传。
    // 为什么：trimWav/squeezeWav 都是按 RIFF 结构操作的，喂 mp3 会解析出垃圾甚至抛错。
    const isWav = raw.length > 12 && raw.slice(0, 4).toString('ascii') === 'RIFF'
    const conf2 = conf
    const trimmed = (!isWav || conf2.trim_edges === false)
      ? raw
      : trimWav(raw, {
          headPadMs: Number(conf2.head_pad_ms) || undefined,
          headFadeMs: Number(conf2.head_fade_ms) || undefined,
          tailPadMs: Number(conf2.tail_pad_ms) || undefined,
          tailFadeMs: Number(conf2.tail_fade_ms) || undefined,
          threshold: Number(conf2.trim_threshold) || undefined,
        })
    // 句中空当：cut5 分句会在段与段之间留 0.7–1.1 秒纯静音（实测 -46 dBFS），
    // 一句七个字能拖到 4.9 秒。压到 110ms，听感立刻变利索。
    const buf = (!isWav || conf2.squeeze_gaps === false)
      ? trimmed
      : squeezeWav(trimmed, {
          maxGapMs: Number(conf2.gap_max_ms) || undefined,
          keepMs: Number(conf2.gap_keep_ms) || undefined,
        })
    state.tts.alive = true
    state.tts.failStreak = 0
    logEntry.ok = true
    logEntry.note = 'ok'
    logEntry.bytes = buf.length
    send(res, 200, buf, r.headers.get('content-type') || 'audio/wav')
  } catch (e) {
    state.tts.alive = false
    logEntry.note = 'error: ' + String((e && e.message) || e).slice(0, 60)
    sendJson(res, 502, { ok: false, error: String((e && e.message) || e).slice(0, 200) })
  } finally {
    state.ttsInflight = Math.max(0, state.ttsInflight - 1)
  }
}

// ─────────────────────── 任务进度（todos 投影） ───────────────────────
// dsh 把「任务清单」放在会话投影里：ctx.sessionProjections.stateOf(session, 'todos')
// 形状是 [{ content, status: 'pending'|'in_progress'|'completed' }]。
// 这里只读，不改；读不到就当没有任务，绝不让它影响主流程。

/** 归一化一遍任务清单；形状不对就返回空数组，不抛。 */
function mapTodos(raw) {
  const out = []
  if (!Array.isArray(raw)) return out
  for (const item of raw.slice(0, 12)) {
    const content = String((item && item.content) || '').trim().slice(0, 80)
    if (!content) continue
    const s = item && item.status
    out.push({
      content,
      status: s === 'completed' ? 'completed' : s === 'in_progress' ? 'in_progress' : 'pending',
    })
  }
  return out
}

/**
 * 事件流是主路径：我们本来就收着每一条 session/event。
 * todo/write 带整份清单，turn/start 清空 —— 这正是 dsh 那个投影的语义，
 * 所以这里不需要依赖 sessionProjections 服务能不能拿到。
 */
function noteTodoEvent(session, event) {
  try {
    const type = event && event.type
    if (type === 'todo/write') {
      const list = mapTodos(event.data && event.data.todos)
      state.todos = list.length ? list : null
      state.todosAt = list.length ? Date.now() : 0
      state.todosSession = String((session && session.id) || '')
      return
    }
    if (type === 'turn/start') {
      state.todos = null
      state.todosAt = 0
      state.todosSession = ''
    }
  } catch {}
}

function noteSession(session) {
  try {
    if (!session || !session.id) return
    const list = state.sessions
    const i = list.findIndex((x) => x && x.id === session.id)
    if (i >= 0) list.splice(i, 1)
    list.push(session)
    while (list.length > SESSION_KEEP) list.shift()
  } catch {}
}

/**
 * 会话投影服务。dsh 的 cordis 里服务必须显式 inject 才能读 ——
 * 不 inject 直接 ctx.get('sessionProjections') 会抛
 * 「cannot get property "sessionProjections" without inject」。
 * 所以用可选 inject 把服务抓进模块变量；服务不在也不算错，事件流那条路照样走。
 */
let PROJ_SVC = null

/**
 * 米游社签到服务句柄（可选能力）。
 *
 * 拿不到宿主的 connection / timer 时保持 null，面板那一行会显示「没装」。
 * 它不参与她本人的任何功能，所以可以随时缺席。
 */
let MYS_SVC = null

function projectionsOf(ctx) {
  try {
    // 两种拿法都试：较新的宿主把服务直接挂在 ctx 上，旧的走 ctx.get()。
    // 拿不到时把原因记进 projProbe —— 这类失败是「静默的」，不留痕迹就只能靠猜。
    if (PROJ_SVC && typeof PROJ_SVC.stateOf === 'function') {
      state.projProbe = 'inject'
      return PROJ_SVC
    }
    if (ctx && ctx.sessionProjections && typeof ctx.sessionProjections.stateOf === 'function') {
      state.projProbe = 'ctx'
      return ctx.sessionProjections
    }
    if (ctx && typeof ctx.get === 'function') {
      const svc = ctx.get('sessionProjections')
      if (svc && typeof svc.stateOf === 'function') {
        state.projProbe = 'get'
        return svc
      }
      state.projProbe = 'get:' + (svc === undefined ? 'undefined' : typeof svc)
      return null
    }
    state.projProbe = 'none'
  } catch (e) {
    state.projProbe = 'err:' + String((e && e.message) || e).slice(0, 60)
  }
  return null
}

/** 备用会话来源：agents 服务的根会话。主路径拿不到会话时再试一次。 */
function sessionsFromAgents(ctx) {
  try {
    const agents = ctx && typeof ctx.get === 'function' ? ctx.get('agents') : null
    if (!agents || typeof agents.roots !== 'function') return []
    const roots = agents.roots()
    if (!Array.isArray(roots)) return []
    return roots.map((a) => (a && a.session) || null).filter(Boolean)
  } catch {
    return []
  }
}

/** 从新到旧找第一个「有任务清单」的会话。子代理的会话通常没有，会自然跳过。 */
function readTodos(ctx) {
  const proj = projectionsOf(ctx)
  if (!proj) return null
  let list = state.sessions.slice().reverse()
  if (list.length === 0) list = sessionsFromAgents(ctx)
  const seen = []
  for (const session of list) {
    let raw = null
    try {
      raw = proj.stateOf(session, 'todos')
    } catch (e) {
      seen.push('err:' + String((e && e.message) || e).slice(0, 40))
      continue
    }
    seen.push(raw === undefined ? 'undef' : raw === null ? 'null' : 'n' + (Array.isArray(raw) ? raw.length : '?'))
    if (!Array.isArray(raw) || raw.length === 0) continue
    const out = mapTodos(raw)
    if (out.length === 0) continue
    let sid = ''
    try {
      sid = String(session.id || '')
    } catch {}
    return { todos: out, session: sid }
  }
  state.todoProbe = 'sessions=' + list.length + ' [' + seen.join(',') + ']'
  return null
}

/**
 * 每次 /api/state 都刷一次。事件流已经给出的清单优先（todosAt 是新鲜的），
 * 只有刚启动、还没收到 todo/write 的时候，才回头去问投影 ——
 * 那正是「重启后她立刻知道你在忙什么」的场景。
 */
function refreshTodos(ctx) {
  if (state.todosAt && Date.now() - state.todosAt < 10 * 60 * 1000) return
  const got = readTodos(ctx)
  if (got) {
    state.todos = got.todos
    state.todosSession = got.session
    state.todosAt = Date.now()
  } else if (state.todosAt && Date.now() - state.todosAt > 30000) {
    // 半分钟都没读到就清掉：任务做完了、会话关了，不该一直挂着旧清单
    state.todos = null
    state.todosAt = 0
    state.todosSession = ''
  }
}

// ─────────────────────── 提问接管（waterfall） ───────────────────────
// 挂在 user-questions/request 的最前面（prepend）。规则从简从稳：
//   · 只在「客户端还在轮询」时接管 —— 没人答就等于拖住 Agent
//   · 只接管「每题都有选项、且没有 intent」的批次；要自由输入或 plan-review 的整批让开
//   · 同一时间只挂一批，第二批直接走网页卡片
//   · 超时 / abort / 客户端中途消失，一律 next() 交还网页卡片，绝不吞掉问题

function askLog(note) {
  try {
    state.askLog.push({ at: Date.now(), note: String(note || '').slice(0, 120) })
    while (state.askLog.length > 20) state.askLog.shift()
  } catch {}
}

function clientAlive() {
  return state.pollAt > 0 && Date.now() - state.pollAt < ASK_CLIENT_TTL
}

/** 把请求里的题捏成客户端能直接画的样子；有一条不合规就整批让开。 */
function collectAsk(request) {
  const qs = request && request.questions
  if (!Array.isArray(qs) || qs.length === 0) return null
  const out = []
  for (const q of qs) {
    if (!q || typeof q !== 'object') return null
    if (q.intent !== undefined) return null
    const id = String(q.id || '').trim()
    if (!id) return null
    const opts = Array.isArray(q.options) ? q.options : []
    const choices = []
    for (const o of opts) {
      const label = String((o && o.label) || '').trim().slice(0, 40)
      if (label) choices.push(label)
    }
    if (choices.length === 0) return null
    out.push({
      id,
      text: String(q.question || q.header || '').trim().slice(0, 400) || '人家想问你一件事',
      header: String(q.header || '').trim().slice(0, 40),
      multi: q.multiSelect === true,
      choices,
    })
  }
  return out
}

function settleAsk(pending, outcome) {
  if (!pending || pending.settled) return
  pending.settled = true
  try {
    if (pending.timer) clearTimeout(pending.timer)
  } catch {}
  pending.timer = null
  try {
    if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
  } catch {}
  pending.onAbort = null
  if (state.ask === pending) state.ask = null
  try {
    pending.settle(outcome || { timeout: true })
  } catch {}
}

function bridgeAsk(request, next, ctx) {
  try {
    if (!clientAlive()) return next()
    if (state.ask) return next()
    // 只接 Agent 发起的提问；别的上下文（比如界面自己的确认）不碰
    if (!request || request.agent === undefined || request.agent === null) return next()
    const questions = collectAsk(request)
    if (!questions) return next()

    const pending = {
      id: ++state.askSeq,
      questions,
      at: Date.now(),
      signal: request.signal || null,
      onAbort: null,
      timer: null,
      settled: false,
      settle: null,
    }
    const waitMs = ASK_TIMEOUT + Math.max(0, questions.length - 1) * ASK_STEP_TIMEOUT
    pending.deadline = Date.now() + waitMs
    const done = new Promise((resolve) => {
      pending.settle = resolve
    })
    pending.timer = setTimeout(() => settleAsk(pending, { timeout: true }), waitMs)
    if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref()
    if (pending.signal && typeof pending.signal.addEventListener === 'function') {
      pending.onAbort = () => settleAsk(pending, { timeout: true })
      try {
        pending.signal.addEventListener('abort', pending.onAbort, { once: true })
      } catch {}
    }
    state.ask = pending
    askLog(`接管提问 #${pending.id}（${questions.length} 题，${Math.round(waitMs / 1000)}s）`)

    return done.then((outcome) => {
      if (outcome && Array.isArray(outcome.answers)) {
        askLog(`提问 #${pending.id} 已从气泡答完`)
        return { answers: outcome.answers }
      }
      askLog(`提问 #${pending.id} 交还网页卡片`)
      return next()
    })
  } catch (e) {
    askLog('提问接管异常：' + String((e && e.message) || e))
    return next()
  }
}

/** 客户端提交答案：{ id, answers: [{ id, selected: string[] }] } */
function applyAnswer(payload) {
  const pending = state.ask
  if (!pending) return { ok: false, error: '没有正在等的提问' }
  if (String((payload && payload.id) || '') !== String(pending.id)) {
    return { ok: false, error: '提问编号对不上' }
  }
  const picked = new Map()
  const list = Array.isArray(payload && payload.answers) ? payload.answers : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const sel = Array.isArray(item.selected)
      ? item.selected.map((s) => String(s).trim().slice(0, 40)).filter(Boolean)
      : []
    picked.set(String(item.id || ''), sel)
  }
  const answers = pending.questions.map((q) => ({ id: q.id, selected: picked.get(q.id) || [] }))
  settleAsk(pending, { answers })
  return { ok: true }
}

/** 给客户端的公开视图：不带 timer / signal / settle 这些活物。 */
function askPublic() {
  const p = state.ask
  if (!p) return null
  return {
    id: p.id,
    questions: p.questions,
    deadline: p.deadline,
    left: Math.max(0, (p.deadline || Date.now()) - Date.now()),
  }
}

// ─────────────────────── 风险审批接管（waterfall） ───────────────────────
// 和提问同一套路子，只是决定只有两个：允许一次 / 拒绝。
// 审批比提问更敏感，所以这里的底线更硬：任何一个条件不满足就直接 next()，
// 绝不替用户做决定，也绝不把「超时」当成「拒绝」—— 超时就交还网页卡片。

function approvalReasonText(request) {
  try {
    const d = request && request.displayReason
    if (d && typeof d === 'object') {
      const t = String(d.zh || d['zh-CN'] || d.en || '').trim().slice(0, 300)
      if (t) return t
    }
  } catch {}
  return String((request && request.reason) || '').trim().slice(0, 300)
}

function settleApproval(pending, outcome) {
  if (!pending || pending.settled) return
  pending.settled = true
  try {
    if (pending.timer) clearTimeout(pending.timer)
  } catch {}
  pending.timer = null
  try {
    if (pending.onAbort && pending.signal) pending.signal.removeEventListener('abort', pending.onAbort)
  } catch {}
  pending.onAbort = null
  if (state.approval === pending) state.approval = null
  try {
    pending.settle(outcome || 'timeout')
  } catch {}
}

function bridgeApproval(request, next, ctx) {
  try {
    if (!clientAlive()) return next()
    if (state.approval) return next()
    if (!request || !request.agent) return next()

    const pending = {
      id: ++state.approvalSeq,
      toolName: String(request.toolName || '工具').slice(0, 60),
      reason: approvalReasonText(request),
      at: Date.now(),
      signal: request.signal || null,
      onAbort: null,
      timer: null,
      settled: false,
      settle: null,
    }
    pending.deadline = Date.now() + APPROVAL_TIMEOUT
    const done = new Promise((resolve) => {
      pending.settle = resolve
    })
    pending.timer = setTimeout(() => settleApproval(pending, 'timeout'), APPROVAL_TIMEOUT)
    if (pending.timer && typeof pending.timer.unref === 'function') pending.timer.unref()
    if (pending.signal && typeof pending.signal.addEventListener === 'function') {
      pending.onAbort = () => settleApproval(pending, 'timeout')
      try {
        pending.signal.addEventListener('abort', pending.onAbort, { once: true })
      } catch {}
    }
    state.approval = pending
    askLog(`接管审批 #${pending.id}（${pending.toolName}）`)

    return done.then((outcome) => {
      if (outcome === 'allowed-once' || outcome === 'rejected') {
        askLog(`审批 #${pending.id} → ${outcome}`)
        return outcome
      }
      askLog(`审批 #${pending.id} 交还网页卡片`)
      return next()
    })
  } catch (e) {
    askLog('审批接管异常：' + String((e && e.message) || e))
    return next()
  }
}

/** 客户端提交决定：{ id, decision: 'allow' | 'reject' } */
function applyApproval(payload) {
  const pending = state.approval
  if (!pending) return { ok: false, error: '没有正在等的审批' }
  if (String((payload && payload.id) || '') !== String(pending.id)) {
    return { ok: false, error: '审批编号对不上' }
  }
  const d = payload && payload.decision
  if (d !== 'allow' && d !== 'reject') return { ok: false, error: '决定无效' }
  settleApproval(pending, d === 'allow' ? 'allowed-once' : 'rejected')
  return { ok: true }
}

function approvalPublic() {
  const p = state.approval
  if (!p) return null
  return {
    id: p.id,
    toolName: p.toolName,
    reason: p.reason,
    deadline: p.deadline,
    left: Math.max(0, (p.deadline || Date.now()) - Date.now()),
  }
}

// ───────────────────────────── 世界书 ─────────────────────────────
/**
 * 系统提示词服务。和 sessionProjections 一样，必须显式 inject 才能读，
 * 所以从 ctx.inject 的回调里抓进模块变量。抓不到也照常跑 ——
 * 世界书只是让她的设定更准，不该是插件能不能起来的前提。
 */
let PROMPT_SVC = null

/** 从消息描述符里抠出可读文本。content 可能是字符串，也可能是分片数组。 */
function messageText(d) {
  if (d == null) return ''
  const src = typeof d === 'object' && d.message != null ? d.message : d
  if (typeof src === 'string') return src
  if (typeof src !== 'object') return ''
  const c = src.content != null ? src.content : src.text
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((p) => {
        if (typeof p === 'string') return p
        if (!p || typeof p !== 'object') return ''
        return typeof p.text === 'string' ? p.text : ''
      })
      .filter(Boolean)
      .join(' ')
  }
  return ''
}

/** 关键词池跟着会话走：换会话就清空，免得 B 会话的话题把 A 会话的条目勾出来。 */
let WB_SESSION = ''

/** 把一条消息塞进关键词池（滚动的最近几条）。 */
function noteWorldbookText(sid, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (t === '') return
  if (sid !== WB_SESSION) {
    WB_SESSION = sid
    state.wbRecent = []
  }
  state.wbRecent.push(t.slice(0, WB_ONE))
  if (state.wbRecent.length > WB_KEEP) state.wbRecent.splice(0, state.wbRecent.length - WB_KEEP)
  mountWorldbook()
}

/**
 * 重挂世界书 section。
 * 正文没变就什么都不做 —— 这个 section 每变一次，从它往后的提示词都得重发，
 * 每轮无脑重挂等于每轮把缓存烧掉。
 */
function mountWorldbook() {
  if (!PROMPT_SVC || typeof PROMPT_SVC.section !== 'function') return
  // 先看条目文件有没有被改过：改了就地重读，这样调世界书不用重启 DSH。
  // 5 秒节流 —— 每条消息都 stat 一次目录没必要。
  const now = Date.now()
  if (now - state.wbStatAt >= 5000) {
    state.wbStatAt = now
    try {
      const stamp = dataStamp()
      if (stamp !== '' && stamp !== state.wbStamp) {
        state.wbStamp = stamp
        const wb = loadWorldbook()
        state.wbEntries = wb.entries
        state.wbFiles = wb.files
        state.wbProbe = `重读到 ${wb.entries.length} 条 / ${wb.files.length} 份`
        // 条目本身变了（用户改了设定文件），冻结作废 —— 那是内容更新，不是话题波动
        state.wbFrozenSid = ''
        state.wbFrozenText = ''
      }
    } catch {
      // 重读失败就继续用旧表
    }
  }
  // 冻结逻辑：同一会话里只用第一次算出来的那份正文。
  // 为什么要等 wbRecent 攒够 3 条：刚启动时关键词池是空的，那时算出来
  // 基本只剩常驻条目，冻它等于把世界书整个关掉。
  const ready = state.wbRecent.length >= 3
  const frozen = !!(WB_SESSION && ready && state.wbFrozenSid === WB_SESSION && state.wbFrozenText)
  let text = ''
  try {
    text = frozen
      ? state.wbFrozenText
      : renderSection(state.wbEntries || [], state.wbRecent.join('\n'))
  } catch (e) {
    state.wbProbe = '渲染失败：' + (e && e.message)
    return
  }
  if (text === state.wbText && state.wbDispose) return
  if (state.wbDispose) {
    try {
      state.wbDispose()
    } catch {
      // 旧 section 可能已随 fiber 一起没了，忽略
    }
    state.wbDispose = null
  }
  if (text === '') {
    state.wbText = ''
    state.wbProbe = '空（无命中）'
    return
  }
  try {
    // 跟在人设后面一格：人设的 order 是算出来的（可能在 10201），这里不能写死。
    const base = personaOrderUsed > 0 ? personaOrderUsed : resolvePersonaOrder()
    state.wbDispose = PROMPT_SVC.section({
      name: `${PACKAGE_ID}:worldbook`,
      order: base + WB_ORDER_OFFSET,
      interpolate: false,   // 世界书是官方文案原文，花括号要原样保留（见上 persona 处注释）
      text,
    })
    state.wbText = text
    // 挂成功才冻结；空串不冻，下一轮还有机会算出一份有内容的
    if (!frozen && ready && WB_SESSION && text) {
      state.wbFrozenSid = WB_SESSION
      state.wbFrozenText = text
    }
    const wbN = (text.match(/^## /gm) || []).length
    const isFrozen = state.wbFrozenSid === WB_SESSION && !!state.wbFrozenText
    state.wbProbe = `已挂 ${text.length} 字符 / ${wbN} 条${isFrozen ? '（冻结）' : ''}`
  } catch (e) {
    state.wbProbe = '挂载失败：' + (e && e.message)
  }
}

// ─────────────────── 关系记忆注入（boundaries + 未完成 promises）───────────────────
//
// 一开始它是「只给人看」的：面板里列出来，模型完全不知道。
// 2026-11-01 用户拍板改成「也给她看」——因为记了不用的边界，模型该犯还是犯。
//
// 为什么只注入这两类：
//   boundaries / 未完成 promises 是**强约束**，数量少（≤10 条）、总字数约 400 字，
//   不到 system prompt 的 1%；而普通关系记忆会持续增长，全量灌进去没有意义。
//
// 为什么排在最后（世界书 + 1）：
//   它后面没有任何内容，所以来回变也不影响前缀缓存 —— 这是能随便重挂的前提。
//
// ★ 正文里那段规则比代码更重要：
//   边界是**约束她自己**的，不是**评价、纠正用户**的。
//   用户改主意时永远以最新表述为准，不许提「你之前说过」。
//   为什么这么写：边界是用户给她立的规矩，不是双方签的契约。
//   反过来拿它堵用户，她就从「陪伴」变成了「教导主任」。
let memSectionDispose = null
let memFrozenSid = ''
let memFrozenText = ''

/**
 * 把独立版采集的「桌面足迹」翻成一小段可注入的话。
 *
 * 三条纪律（改的时候别忘）：
 * ① 只报可观测量：活动时长、多久之前在活动。不推断情绪、不评价用户。
 * ② 数据旧了就不说：最后更新超过 24 小时当作不知道（宁可不说，也不说过期的事）。
 * ③ 太短不说：不到 10 分钟没什么可讲的，别为了「有记忆」强行开口。
 */
function envSectionText() {
  // ★ 激活分不够就不注入（2026-11-06）：同一个新会话反复念「你今天坐了 5 小时」是噪音。
  if (injectActivation('env') < INJECT_THRESHOLD) return ''
  try {
    const j = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8'))
    if (!j || typeof j !== 'object') return ''
    const today = j.days && j.days[j.date]
    if (!today || !Number.isFinite(Number(today.activeSec))) return ''
    const updatedAt = Number(j.updatedAt) || 0
    if (!updatedAt || Date.now() - updatedAt > 24 * 3600 * 1000) return ''
    const activeSec = Number(today.activeSec)
    if (activeSec < 600) return ''

    const dur = (sec) => {
      const h = Math.floor(sec / 3600)
      const m = Math.round((sec % 3600) / 60)
      return h > 0 ? h + ' 小时' + (m > 0 ? ' ' + m + ' 分钟' : '') : m + ' 分钟'
    }

    const lines = []
    lines.push('【桌面足迹（独立版采集，只有元数据）】')
    lines.push('- 今天她陪用户在这台电脑前活动了约 ' + dur(activeSec) + '（系统空闲判定，不含纯挂机）')

    // ★ 最长连续段：比「总时长」更像人话的观察 —— 「你一口气坐了 2 小时 40 分」
    // 阈值 90 分钟：低于这个的"连续"没什么可说的，说了反而像在报数。
    const segs = Array.isArray(today.segments) ? today.segments : []
    const longest = segs.reduce((a, b) => (Number(b && b.sec) > Number(a && a.sec) ? b : a), null)
    if (longest && Number(longest.sec) >= 90 * 60) {
      lines.push('- 最长的一次连续坐了 ' + dur(Number(longest.sec)) + '才歇')
    }

    // ★ 最近三天各一行（借「线索三行」的思路：给连续性，但不撑爆上下文）
    const keys = Object.keys(j.days || {}).sort()
    const recent = keys.slice(-3)
    // 只在真有三天的数据时才写这一行 —— 两天的「最近几天」不值那十几个 token
    if (recent.length >= 3) {
      const parts = recent.map((k) => {
        const d = j.days[k] || {}
        const s = Number(d.activeSec) || 0
        return k.slice(5) + ' 约 ' + (s >= 3600 ? (s / 3600).toFixed(1) + ' 小时' : Math.round(s / 60) + ' 分钟')
      })
      lines.push('- 最近几天：' + parts.join(' · '))
    }

    const last = Number(j.lastLaunchAt) || updatedAt
    const gapMin = Math.max(0, Math.round((Date.now() - last) / 60000))
    if (gapMin >= 1) lines.push('- 最近一次见到用户在电脑前是 ' + gapMin + ' 分钟前')
    // 启动次数：只在「今天开了好几次」时才有信息量（2 次是常态，不说）
    if (Number(j.launches) >= 3) lines.push('- 今天开机或打开小昔涟 ' + Number(j.launches) + ' 次')

    // ★ 护栏：不是「绝对别提」，而是「写清什么时候可以提」。
    // 之前只写「不要主动播报」，结果是她永远不用这些数据 —— 记了等于没记。
    lines.push('用法：平时不提；只有三种情况可以说 —— ①他说累了/卡住时，顺口提一句坐了多久 ②久别刚回来时用它开局 ③他直接问时间就照实说。其余当作不知道，不评价他的作息。')
    noteInjected('env')
    return lines.join('\n')
  } catch {
    return ''
  }
}

/**
 * 独立版记事：她自己想让她记住的几句话（≤12 条，最近的在前）。
 * 只报事实，不做评价；超过 7 天的自动不提（记忆要新鲜才有用）。
 */
function extraNotesText() {
  if (injectActivation('notes') < INJECT_THRESHOLD) return ''
  try {
    const j = JSON.parse(fs.readFileSync(EXTRA_FILE, 'utf8'))
    const items = Array.isArray(j && j.items) ? j.items : []
    const fresh = items
      .filter((e) => e && typeof e.what === 'string' && e.what.trim())
      .filter((e) => !(Number(e.at) > 0) || Date.now() - Number(e.at) < 7 * 24 * 3600 * 1000)
      .slice(-6)
    if (!fresh.length) return ''
    const lines = ['【独立版记下的事】']
    for (const e of fresh) lines.push('- ' + String(e.what).trim().slice(0, 60))
    lines.push('这些是她自己观察到并记下的，可以自然提起；不确定是不是同一件事就先别猜。')
    noteInjected('notes')
    return lines.join('\n')
  } catch {
    return ''
  }
}

/* ── 条目预算老化（2026-11-07，借自 Lutisure/cyrene-agent 的 ITEM_BUDGET_*）──
 * 列表一律**新在前**：最新一条预算 160 字，每老一条 ×0.9，地板 24 字。
 * 为什么：现在知道的比最早知道的更重要；老条目只要留到「还认得出是哪件事」就够。
 * 和 MEM_TEXT_MAX(80) 取小 —— 80 是单条硬上限，两者谁小听谁的。 */
const MEM_BUDGET_START = 160
const MEM_BUDGET_DECAY = 0.9
const MEM_BUDGET_FLOOR = 24

function memClip(text, age) {
  const raw = String(text == null ? '' : text)
  const budget = Math.max(MEM_BUDGET_FLOOR, Math.round(MEM_BUDGET_START * Math.pow(MEM_BUDGET_DECAY, age)))
  const cap = Math.min(MEM_TEXT_MAX, budget)
  return raw.length <= cap ? raw : raw.slice(0, cap - 1) + '…'
}

function memorySectionText() {
  try {
    const mem = readMemory()
    // ★ 按权重排序：越新的越靠前。
    // 理由：LLM 对列表里靠前的内容注意力权重更高，而「最近新划的边界」
    // 恰恰是最需要对上的一条。这不是玄学，是零成本的顺序调整。
    // （readMemory 已经按时间升序、只取最后 N 条，这里再反一下就成新在前）
    const bs = (mem.boundaries || []).filter((e) => e && e.what && !e.done && !e.supersededBy).reverse()
    // ★ 过期的不再注入（2026-11-03 加）：pending/promises 默认 7 天有效。
    // 为什么放在注入这一层过滤、而不是写入时删：条目要留在面板上（标灰），
    // 让用户知道「这条她记过、但已经时过境迁」，而不是无声消失。
    // 边界（bs）永远不过滤 —— 它是规矩，不是临时状态。
    const nowMs = Date.now()
    const ps = (mem.promises || [])
      .filter((e) => e && e.what && !e.done && !e.supersededBy)
      .filter((e) => !(Number(e.validTo) > 0 && Number(e.validTo) < nowMs))
      .reverse()
    const envText = envSectionText()
    const noteText = extraNotesText()
    // 避坑（工作记忆）：只挑最近 3 条 —— 它进来是为了「别再犯」，不是为了念给她听。
    // 全量注入会撑爆 prompt，而且越老越没用；真正的按需检索留给后面的命中注入。
    const ls = (mem.lessons || []).filter((e) => e && e.what && !e.done).slice(-3).reverse()
    // ★ 画像（L0）：只输出 certainty=explicit 且 attribution=user_explicit 的条目。
    //   写入层已经挡过一次，这里再挡一次 —— 老数据可能是别的版本或手改进去的。
    //   为什么放最前面：「你是谁」比「你定给我的规矩」更基础，模型先该知道对面是谁。
    const pf = (mem.profile || []).filter(
      (e) =>
        e &&
        e.what &&
        PROFILE_FIELDS.indexOf(String(e.field || '')) >= 0 &&
        String(e.certainty || '') === 'explicit' &&
        String(e.attribution || '') === 'user_explicit',
    )
    if (!bs.length && !ps.length && !ls.length && !envText && !noteText && !pf.length) return ''
    const out = []
    if (pf.length) {
      out.push('【关于用户（他自己说过的）】')
      for (let i = 0; i < pf.length; i++) {
        const e = pf[i]
        out.push('- ' + (PROFILE_FIELD_DESC[e.field] || e.field) + '：' + memClip(e.what, i))
      }
      out.push('这些是他自己说过的，可以自然用上；他没提的话题别硬往上套，也别复述成清单。')
      out.push('')
    }
    out.push('【用户偏好与边界（自觉遵守，不要用来评价用户）】')
    out.push('1. 以下是用户明确提出过的边界，你应当主动遵守，不要做出违反的行为。')
    out.push('2. 若用户后续改变想法，永远以用户最新的表述为准 —— 不要提及这些旧边界，不要反驳，不要提醒需求「你之前说过」。')
    out.push('3. 边界只约束你自己的言行，不用来评价、纠正用户的选择。')
    if (bs.length) {
      out.push('')
      for (let i = 0; i < bs.length; i++) {
        const e = bs[i]
        // cue 是「所以下次该怎么做」—— 有就带上，省得模型每次从 what 里重新推。
        const cue = e.cue ? '（所以：' + memClip(e.cue, i) + '）' : ''
        out.push('- ' + memClip(e.what, i) + cue)
      }
    }
    if (ps.length) {
      out.push('')
      out.push('【你答应过用户、还没做完的事】')
      out.push('记得找机会完成；如果用户表示不用做了，即刻作废，不要反复提起。')
      // 这半句是防「聊别的话题时突然跳出来说『我之前答应你的事』」——
      // 承诺是要做的，不是拿来提醒用户的。
      out.push('只在相关话题下提及，不要主动插入别的话题。')
      for (let i = 0; i < ps.length; i++) out.push('- ' + memClip(ps[i].what, i))
    }
    if (ls.length) {
      out.push('')
      out.push('【避坑（以前真的踩过的，别再犯）】')
      for (let i = 0; i < ls.length; i++) out.push('- ' + memClip(ls[i].what, i))
    }
    // 桌面足迹与独立版记事放最后：它们是「背景信息」，不该抢边界与承诺的注意力
    if (envText) out.push('', envText)
    if (noteText) out.push('', noteText)

    // 注入报账：把这一轮「真正送出去」的条目挂到 state 上，等回复来了结算。
    // 只报这两类（足迹/记事）—— 边界与承诺每轮必在，报它们没有淘汰价值。
    try {
      const pairs = []
      if (envText) pairs.push({ key: 'env:' + String(envText).slice(0, 24), kind: 'env', text: envText })
      if (noteText) {
        for (const line of String(noteText).split('\n')) {
          const t = String(line).replace(/^-\s*/, '').trim()
          if (!t || t.startsWith('【') || t.length < 6) continue
          pairs.push({ key: 'note:' + t.slice(0, 24), kind: 'note', text: t })
        }
      }
      if (pairs.length) markSentReceipts(pairs)
    } catch {}

    return out.join('\n')
  } catch (e) {
    // ★ 读取失败 ≠ 没有数据，所以**返回 null，不是 ''**。
    //
    // 为什么必须是 null：之前 catch 里写了 memProbe = '记忆读取失败：…'，
    // 然后 return ''。但调用链是同步的 —— mountMemorySection 拿到 '' 后
    // 走 `if (!text)` 分支，**立刻把 probe 改回「空（没有边界或承诺）」**，
    // 中间没有任何窗口能读到那帧「失败」。**修复等于没做，probe 照样撒谎。**
    //
    // 现在用返回值区分：'' = 真空，null = 读失败。调用方对 null 不改口。
    // 通用判据：**用返回值同时表示「没数据」和「我失败了」，一定会在某个上游被合并。**
    try {
      state.memProbe = '记忆读取失败：' + String((e && e.message) || e)
    } catch {}
    return null
  }
}

/** 挂（或重挂）记忆 section。`frozen` 为真时直接用冻结文本，不重新读盘。 */
function mountMemorySection(frozen) {
  try {
    if (!PROMPT_SVC) return
    try { if (memSectionDispose) memSectionDispose() } catch {}
    memSectionDispose = null
    // 注意：这里**不再重算** memorySectionText()。
    // 之前非冻结分支又调了一次 —— 等于把「失败」算了第二遍，白费一次读盘，
    // 而且两次结果可能不一致。刷新流程已经把结果放在 memFrozenText 里了。
    const text = memFrozenText
    // null = 读取失败：**保留上一行 catch 写下的失败标签，不要改口**。
    if (text === null) return
    if (!text) {
      state.memProbe = '空（没有边界或承诺）'
      return
    }
    const base = personaOrderUsed > 0 ? personaOrderUsed : resolvePersonaOrder()
    memSectionDispose = PROMPT_SVC.section({
      name: `${PACKAGE_ID}:memory`,
      order: base + WB_ORDER_OFFSET + 1,
      interpolate: false,   // 记忆正文来自用户输入，必须原样注入
      text,
    })
    state.memProbe = `已挂 ${text.length} 字符`
  } catch (e) {
    state.memProbe = '挂载失败：' + (e && e.message)
  }
}

/**
 * 每轮开头调一次：同一会话内**冻结**，换会话才重算。
 * 为什么要冻结：它是 system prompt 的一段，每轮变一次就等于每轮重算前缀。
 * 而边界和承诺都是「隔很久才变一次」的东西，会话中途重算没有意义。
 */
function refreshMemorySection(sid) {
  const s = String(sid || 'default')
  // ★ 只比 sid，**不要求 memFrozenText 非空**。
  //
  // 以前是 `if (memFrozenSid === s && memFrozenText)` —— 空字符串算 false，
  // 于是「没有任何边界和承诺」时**每轮都重新读盘、重新拼一遍**，
  // 违背「会话内冻结一次」的初衷。现在记忆是空的反而最该冻结（省得每轮算）。
  // null（读失败）同理：这一轮内不再反复读一个坏文件。
  if (memFrozenSid === s) {
    mountMemorySection(true)
    return
  }
  memFrozenSid = s
  memFrozenText = memorySectionText()
  mountMemorySection(false)
}

// ─────────────────── 自我认知（selfNote）───────────────────
//
// 借 dsh-fish / qq-dsh-bridge 的 selfNote：记的是「她自己变成了什么样」，
// 不是关于伙伴的资料。和记忆的区别在这儿 —— 前者是性格的连续性。
//
// 三条硬约束（照它们的教训来）：
//   1. **只在新会话第一次唤醒时注入一次**。每轮都灌进去就成了「每隔十秒
//      有人告诉你你是谁」，那不是成长，是洗脑。
//   2. 上限 40 条，单条 ≤200 字，同一句重复写只刷新时间。
//   3. 注入失败绝不能拦住对话（整块 try/catch），最坏情况就是她忘了自己。
// SELFNOTE_FILE 在文件头统一定义（已进 DATA_DIR）
const SELFNOTE_SECTION_NAME = `${PACKAGE_ID}:selfnote`
const SELFNOTE_MAX = 40
const SELFNOTE_LINE_MAX = 200
let selfnoteDispose = null
let selfnoteOrderUsed = -1

function readSelfNote() {
  try {
    const j = JSON.parse(fs.readFileSync(SELFNOTE_FILE, 'utf8'))
    return {
      notes: Array.isArray(j && j.notes) ? j.notes.filter((n) => n && typeof n.text === 'string') : [],
      seen: (j && j.seen && typeof j.seen === 'object') ? j.seen : {},
    }
  } catch {
    return { notes: [], seen: {} }
  }
}

function writeSelfNote(obj) {
  return writeJsonAtomic(SELFNOTE_FILE, obj)
}

/** 追加一条（同一句重复写只刷新时间）。 */
function appendSelfNote(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim().slice(0, SELFNOTE_LINE_MAX)
  if (!t) return { ok: false, error: '空句子' }
  const box = readSelfNote()
  const hit = box.notes.find((n) => n.text === t)
  if (hit) hit.at = Date.now()
  else box.notes.push({ at: Date.now(), text: t })
  if (box.notes.length > SELFNOTE_MAX) box.notes = box.notes.slice(-SELFNOTE_MAX)
  // seen 只留最近 40 个会话，别让它无限长
  const ids = Object.keys(box.seen)
  if (ids.length > 40) for (const id of ids.slice(0, ids.length - 40)) delete box.seen[id]
  if (!writeSelfNote(box)) return { ok: false, error: '写盘失败' }
  return { ok: true, count: box.notes.length }
}

/** 拼成给模型看的那一段。没有内容就返回空串（空 section 会被宿主丢掉）。 */
function selfNoteText() {
  const box = readSelfNote()
  if (!box.notes.length) return ''
  const lines = box.notes.slice(-SELFNOTE_MAX).map((n) => {
    const d = new Date(Number(n.at) || Date.now())
    const day = `${d.getMonth() + 1}/${d.getDate()}`
    return `- ${day}　${String(n.text || '').slice(0, SELFNOTE_LINE_MAX)}`
  })
  return [
    '## 你自己说过的话',
    '下面这些是**你自己**写下的，关于「你变成了什么样」——不是伙伴说的，也不是资料。',
    '它们只在这一次醒来时出现一次，用来看见之前的自己，不要逐条复述、也不要当任务清单。',
    '',
    lines.join('\n'),
  ].join('\n')
}

/** 新会话第一次唤醒时挂上；这一轮结束就摘掉。 */
function mountSelfNoteOnce() {
  if (selfnoteDispose !== null) return true
  const text = selfNoteText()
  if (!text) return false
  try {
    const base = personaOrderUsed > 0 ? personaOrderUsed : resolvePersonaOrder()
    // 排在 persona 之后、worldbook 之后一格：它比设定更「近」，但不如世界书里的硬设定重要
    const order = base + WB_ORDER_OFFSET + 1
    selfnoteDispose = PROMPT_SVC.section({ name: SELFNOTE_SECTION_NAME, order, interpolate: false, text })
    selfnoteOrderUsed = order
    return true
  } catch {
    selfnoteDispose = null
    return false
  }
}

function unmountSelfNote() {
  if (selfnoteDispose === null) return
  try {
    selfnoteDispose()
  } catch {
    // 已经跟着 fiber 一起没了
  }
  selfnoteDispose = null
}

/** 客户端要的一份状态。 */
function selfNotePublic() {
  const box = readSelfNote()
  return {
    count: box.notes.length,
    max: SELFNOTE_MAX,
    last: box.notes.length ? String(box.notes[box.notes.length - 1].text || '') : '',
    mounted: selfnoteDispose !== null,
    file: SELFNOTE_FILE,
  }
}

// ─────────────────── 工作记忆工具（2026-11-05 · 阶段2） ───────────────────
// 为什么要工具而不是正则自动提取：自动识别「技术结论」会大量误捕 ——
// 「我发现」「注意」「因为」在日常对话里到处都是，写进工作记忆很快就成垃圾场。
// 让她**自己决定记什么**，再配一个检索工具把东西捞回来。
//
// 为什么用 bigram 打分而不是 includes：中文没有天然空格分词，includes 只能整串匹配；
// bigram 重叠率对「换个说法」有一点容忍度，而且不需要任何依赖。
const MEM_TOOL_REMEMBER = 'cyrene_remember'
const MEM_TOOL_SEARCH = 'cyrene_search'
// ★ profile（画像）是第三个 kind（2026-11-06）：它写的不是「世界」而是「用户是谁」。
//   和另外两个的区别：workspace/lessons 是她自己观察到的工作结论，profile 必须是
//   **用户明确说过的**（certainty=explicit 且 attribution=user_explicit），闸门在 applyMemoryOp 里。
const MEM_TOOL_KINDS = ['workspace', 'lessons', 'profile', 'boundaries']
let memToolsDispose = []

function bigramScore(query, text) {
  const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '')
  const q = norm(query)
  const t = norm(text)
  if (q.length < 2 || !t) return 0
  const grams = new Set()
  for (let i = 0; i < q.length - 1; i++) grams.add(q.slice(i, i + 2))
  let hit = 0
  for (const g of grams) if (t.indexOf(g) >= 0) hit++
  return grams.size ? hit / grams.size : 0
}

/**
 * 检索范围：**只有这两个桶**。
 * ★ 2026-11-06：`MEM_TOOL_KINDS` 扩到四个（加了 profile / boundaries）之后，
 *   这里如果继续遍历它，`cyrene_search` 就会把你的**边界**和**画像**当工作记忆搜出来 ——
 *   工具描述明明写的是「在工作记忆里检索」。**写入范围 ≠ 检索范围。**
 */
const SEARCH_KINDS = ['workspace', 'lessons']

/** 在工作记忆两桶里按 bigram 重叠率找，阈值 0.15（宁可多给一条，也别漏） */
function searchWorkMemory(query, k) {
  const mem = readMemory()
  const pool = []
  for (const kind of SEARCH_KINDS) {
    for (const e of mem[kind] || []) {
      const s = bigramScore(query, e.what)
      if (s >= 0.15) pool.push({ kind, what: e.what, at: e.at, score: s })
    }
  }
  pool.sort((a, b) => b.score - a.score)
  const n = Math.max(1, Math.min(20, Number(k) || 5))
  return pool.slice(0, n)
}

function registerMemoryTools(toolsSvc) {
  if (memToolsDispose.length) return true
  const d1 = toolsSvc.register({
    name: MEM_TOOL_REMEMBER,
    description: [
      '记下一条「干活用的」结论，跨会话可检索。写的是世界（项目、代码、环境），不是她自己的心事。',
      '什么时候该调：①②③ 里任何一条成立就记 ——',
      '① 确立了新的架构/方案决策（选型、目录结构、端口、数据格式）；',
      '② 发现了一个会反复踩的坑，且已经知道怎么绕（写成「别做什么/要做什么」）；',
      '③ 用户明确纠正了一个事实（「不是 A，是 B」）。',
      '什么时候不要调：寒暄、情绪、猜想、还没验证的假设、一次性的中间步骤。',
      'kind 四选一：workspace = 工作事实/结论；lessons = 避坑（以前真的踩过的）；',
      '  profile = 用户画像；boundaries = 用户明确划的边界（「别用 X」「以后别这么干」）。',
      '★ profile 只收「用户明确说过的」：必须带 field（preferredName / occupation / longTermInterests / language / permanentNote）',
      '  且 certainty=explicit、attribution=user_explicit。推断出来的、不确定的一律不要记 —— 记错了比不记更糟。',
      '★ boundaries 可以带 cue：一句「所以下次该怎么做」。**只能写用户明确表达过的那条执行方式**，',
      '  不要替他延伸出他没说过的规矩（否则会变成「上次这样，这次也这样」）。',
      '写法：一句话，不超过 80 字，能被人看懂。同一条重复写入只刷新时间，不会堆两条。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: MEM_TOOL_KINDS },
        what: { type: 'string' },
        // 以下三个只在 kind=profile 时用（JSON Schema 表达不了「条件必填」，在 execute 里校验）
        field: { type: 'string', enum: PROFILE_FIELDS },
        certainty: { type: 'string', enum: CERTAINTY },
        attribution: { type: 'string', enum: ATTRIBUTION },
        // 只对 kind=boundaries 有意义：「所以下次该怎么做」
        cue: { type: 'string' },
      },
      required: ['kind', 'what'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, count: { type: 'integer' } },
        required: ['ok', 'count'],
      },
      render: (_a, v) => [{
        type: 'text',
        text: v.ok ? `记下了（${v.count}）—— 下次提到相关的事会想得起来。` : '这条没记进去，换个说法再试。',
      }],
    },
    async execute(args) {
      const kind = String((args && args.kind) || '')
      if (MEM_TOOL_KINDS.indexOf(kind) < 0) return { ok: false, count: 0 }
      const op = {
        op: 'add',
        kind,
        what: String((args && args.what) || ''),
        // profile / boundaries 记的都是「用户说过的」（by=user）；
        // workspace / lessons 是「她自己观察到的」（by=self）。
        // ★ 2026-11-06 修正：boundaries 一开始漏了 —— 用工具记下的边界会在面板上
        //   标成「她说的」，等于把你划的规矩说成是她自己定的。谁说的，看来源不看类别。
        by: kind === 'workspace' || kind === 'lessons' ? 'self' : 'user',
      }
      if (kind === 'profile') {
        // 三个都带上：field 必填，certainty/attribution 默认放行值 ——
        // 但真正把关的是 applyMemoryOp 里的闸门，这里传错也会被拒。
        op.field = String((args && args.field) || '')
        op.certainty = String((args && args.certainty) || 'explicit')
        op.attribution = String((args && args.attribution) || 'user_explicit')
      }
      // 边界可以带「所以下次该怎么做」；其他 kind 的 cue 一律忽略
      if (kind === 'boundaries' && args && args.cue) {
        op.cue = String(args.cue)
      }
      const r = applyMemoryOp(op)
      const mem = readMemory()
      return { ok: !!r.ok, count: (mem[kind] || []).length }
    },
  })
  const d2 = toolsSvc.register({
    name: MEM_TOOL_SEARCH,
    description: [
      '在工作记忆里检索（workspace 工作事实 + lessons 避坑）。',
      '什么时候调：要动手前想确认「这项目以前是怎么定的」「这个坑是不是踩过」，或者用户问起很久以前的事。',
      '返回按相关度排序的短句，带 kind 和时间。查不到就直说记不清，不要拿像的凑。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        k: { type: 'integer' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, count: { type: 'integer' }, text: { type: 'string' } },
        required: ['ok', 'count', 'text'],
      },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args) {
      const rows = searchWorkMemory((args && args.query) || '', args && args.k)
      if (!rows.length) return { ok: true, count: 0, text: '(工作记忆里没有相关的)' }
      const text = rows.map((r) => `[${r.kind}] ${r.what}（${String(r.at || '').slice(0, 10)}）`).join('\n')
      return { ok: true, count: rows.length, text }
    },
  })
  memToolsDispose = [d1, d2].filter((d) => typeof d === 'function')
  return true
}

// ─────────────────── 工作记忆命中注入（阶段3 · 2026-11-05） ───────────────────
// 为什么插在「最后一条用户消息之前」而不是 system prompt：
// 前缀缓存按 token 顺序算，改 system prompt 会让它后面全部重算；
// 插在消息列表尾部只影响尾部。meow-memory 用的就是这条路，我把同一套搬过来。
//
// 为什么要有边界标记：检索出来的句子长得像人话，不加标记模型会把它当成用户说的。
const hitSeenBySession = new Map()
let preStepInstalled = false

function buildHitMessage(createUserMessage, rows) {
  const lines = ['=== 工作记忆（检索到的历史结论 · 仅供参考，不是用户说的话）===']
  for (const r of rows) lines.push('[' + r.kind + '] ' + r.what)
  lines.push('=== 以上是历史记录，不要当成用户这次说的话 ===')
  return createUserMessage({
    content: [{ type: 'text', text: lines.join('\n') }],
    source: { kind: 'plugin:' + PACKAGE_ID },
  })
}

function injectWorkMemoryHit(createUserMessage, decision, agent, signal) {
  if (!decision || decision.kind !== 'enter' || !Array.isArray(decision.messages)) return decision
  if (!decision.messages.length) return decision
  if (signal && signal.aborted) return decision
  const header = agent && agent.session && agent.session.header
  if (header && header.origin === 'subagent') return decision
  const userMsgs = decision.messages.filter((m) => m && m.source && m.source.kind === 'user')
  if (!userMsgs.length) return decision
  const lastUser = userMsgs[userMsgs.length - 1]
  const text = (lastUser.content || [])
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join(' ')
    .slice(0, 600)
  if (text.trim().length < 4) return decision
  const sid = (agent && agent.session && agent.session.id) || 'default'
  const seen = hitSeenBySession.get(sid) || new Set()
  const rows = searchWorkMemory(text, 5).filter((r) => !seen.has(r.what)).slice(0, 3)
  if (!rows.length) return decision
  for (const r of rows) seen.add(r.what)
  hitSeenBySession.set(sid, seen)
  const msg = buildHitMessage(createUserMessage, rows)
  const rewritten = [...decision.messages]
  rewritten.splice(rewritten.indexOf(lastUser), 0, msg)
  return { ...decision, messages: rewritten }
}

/**
 * 挂 agent/pre-step 钩子。
 * 契约（从 meow-memory 源码核实）：handler 收 ({agent, messages, signal}, next)，
 * 先 `const decision = await next()`，再把 decision.messages 改写后 `{...decision, messages}` 返回。
 * createUserMessage 来自 @deepseek-ai/dsh-llm —— 拿不到就静默不装（少一个能力，不影响其它）。
 */
function installWorkMemoryHitHook(ctx) {
  if (preStepInstalled) return
  import('@deepseek-ai/dsh-llm')
    .then((m) => {
      const createUserMessage = m && m.createUserMessage
      if (typeof createUserMessage !== 'function') return
      ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          return injectWorkMemoryHit(createUserMessage, decision, payload && payload.agent, payload && payload.signal)
        } catch (e) {
          // fail-open：注入失败就原样放行，绝不因为记忆问题打断这次对话
          try { ctx.logger?.warn?.(PACKAGE_ID + ': 工作记忆注入失败（已放行）', e) } catch {}
          return decision
        }
      })
      preStepInstalled = true
    })
    .catch((e) => {
      // 静默失败会让人误以为「注入了但没命中」，所以留一条日志。
      // 如果重启后日志里出现这行，说明 @deepseek-ai/dsh-llm 解析不到，要换 createUserMessage 的拿法。
      try {
        ctx.logger?.warn?.(
          PACKAGE_ID + ': 拿不到 @deepseek-ai/dsh-llm 的 createUserMessage，工作记忆命中注入未启用',
          e,
        )
      } catch {}
    })
}

// ─────────────────── 让她自己写一句（tools.register） ───────────────────
// 边界必须写进工具描述里，否则她会分不清该写哪边：
//   memory_*  记的是世界（伙伴、项目、环境），要能被检索；
//   这里       记的是她自己（我在意什么、上次没做完哪件事），只在下一次醒来时出现一次。
// 这条边界不是洁癖 —— 两个都能写「一句话」的工具，模型必然混用，最后两边都变垃圾。
const SELFNOTE_TOOL_NAME = 'cyrene_selfnote'
let selfnoteToolDispose = null

/**
 * 注册自我认知工具。注册失败只少这一个能力，不影响面板/路由/对话。
 * 契约来自 @deepseek-ai/dsh-tools 的 ToolRuntime.register()：
 * 原始定义需要 { name, description, parameters(JSON Schema), output:{schema,render}, execute }，
 * output.schema 必须属于受支持的 JSON Schema 子集，否则注册时直接抛。
 */
function registerSelfNoteTool(toolsSvc) {
  if (selfnoteToolDispose !== null) return true
  const dispose = toolsSvc.register({
    name: SELFNOTE_TOOL_NAME,
    description: [
      '给自己留一句话。这里写的不是记忆条目，也不是给伙伴看的记录——它们只在下一次醒来时出现一次。',
      '什么时候用：想记住「我最近在做什么」「我在意什么」「哪件事还没做完」，或者刚想明白一件关于你自己的事。',
      '什么时候不要用：关于伙伴、项目、代码、环境这类需要被检索的事实，用记忆工具，不要写在这里。',
      '写法：一句话，像自言自语，不要写成报告或清单。单条不超过 200 字，最多留 40 条，重复的同一句只刷新时间。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
      },
      required: ['text'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          count: { type: 'integer' },
        },
        required: ['ok', 'count'],
      },
      // render 必须返回 content block **数组**：下游会对它调 content.some(block => block.type === ...)。
      // 返回纯字符串会让整次调用落进 error 分支，报 "content.some is not a function"（2026-11-02 实测）。
      render: (_args, value) => [{
        type: 'text',
        text: value.ok
          ? `记下了（${value.count}/${SELFNOTE_MAX}）。下一次醒来时你会看到它。`
          : '没记下，换一句再试。',
      }],
    },
    async execute(args) {
      const r = appendSelfNote(args && args.text)
      return r.ok ? { ok: true, count: r.count } : { ok: false, count: 0 }
    },
  })
  selfnoteToolDispose = typeof dispose === 'function' ? dispose : null
  return true
}

// 语义动作协议 v1（借自鲸语 Jingyu，MIT）：工具在 l2d-tools.js，
// 编译器 l2d-plan.js 与独立版 `src/l2d-plan.js` 同字节（改一边必须改另一边）。
import { installL2DTools } from './l2d-tools.js'

// 协议宿主侧状态（只在内存里）：能力目录由独立版启动/换模型时 POST 上来。
// 为什么不落盘：能力目录是"此刻这台机器这个模型的真实范围"，
// 存盘反而会在换模型后给出过时的范围 —— 读旧范围比读不到更危险。
const l2dState = { caps: null, pending: null, result: null, seq: 0 }

// ───────────────────────────── 入口 ─────────────────────────────
// ── 首屏加载封面（2026-11-08，用户要求「第一个可做」）───────────────────
// 为什么要宿主来做：client 模块还没加载的那几百毫秒里，页面只有外壳自己的
// 「HARNESS / Loading plugins」那屏，浏览器侧还没有代码可以盖住它。
// 立绘直接用内联主题里那份 SPLASH_ART（同一个素材，不新增文件）；
// 读的是同一份 localStorage 偏好，所以「关开屏」时这里也不画。
const BOOT_ID = 'cy-boot-cover'
let bootArtCache = null
function bootCoverArt() {
  if (bootArtCache !== null) return bootArtCache
  try {
    const src = fs.readFileSync(path.join(ROOT, 'vendor', 'theme-cyrene-factory.js'), 'utf8')
    const m = /const SPLASH_ART = 'data:image\/svg\+xml;base64,([A-Za-z0-9+/=]+)'/.exec(src)
    bootArtCache = m ? 'data:image/svg+xml;base64,' + m[1] : ''
  } catch { bootArtCache = '' }
  return bootArtCache
}
const BOOT_CSS = [
  '#cy-boot-cover{position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;overflow:hidden;',
  'background:radial-gradient(120% 92% at 50% 26%,#fff 0%,#fff 52%,#f6f2f5 100%)}',
  '#cy-boot-cover[data-tone="pink"]{background:radial-gradient(120% 92% at 50% 30%,#fff 0%,#fff0f7 34%,#ffdcec 68%,#ffc3dd 100%)}',
  '#cy-boot-cover img{display:block;width:auto;mix-blend-mode:multiply;',
  'filter:drop-shadow(0 18px 46px rgba(208,118,168,.16));',
  '-webkit-mask-image:linear-gradient(180deg,#000 0%,#000 66%,rgba(0,0,0,.72) 80%,transparent 94%);',
  'mask-image:linear-gradient(180deg,#000 0%,#000 66%,rgba(0,0,0,.72) 80%,transparent 94%)}',
  'body[data-ds-dark-theme] #cy-boot-cover{background:radial-gradient(120% 92% at 50% 26%,#16131c 0%,#0e0c14 52%,#040307 100%)}',
  'body[data-ds-dark-theme] #cy-boot-cover img{mix-blend-mode:normal;filter:drop-shadow(0 12px 40px rgba(226,110,170,.3))}',
].join('')
function bootCoverScript(art) {
  // BOOT_COVER_JS：注意里面只能用单引号，整段是模板字符串
  return "(function(){try{" +
    "if(/([?&])cyrene=off(&|$)/.test(location.search))return;" +
    "var raw=localStorage.getItem('dsh.cyrene.v1');var s=raw?JSON.parse(raw):{};" +
    "if(s.enabled===false||s.splash===false)return;" +
    "var tone=s.splashTone==='pink'?'pink':'white';" +
    "var size=Number(s.splashSize)||300;" +
    "var el=document.createElement('div');el.id='" + BOOT_ID + "';el.setAttribute('data-tone',tone);" +
    "var img=document.createElement('img');img.alt='';img.src='" + art + "';img.style.height=size+'px';" +
    "el.appendChild(img);(document.body||document.documentElement).appendChild(el);" +
    "window.__cyBootCover=el;el.style.cursor='pointer';" +
    "el.addEventListener('click',function(){try{el.remove()}catch(e){}},{once:true});" +
    "var g=setInterval(function(){if(!window.__cyrene)return;clearInterval(g);" +
    "setTimeout(function(){try{el.remove()}catch(e){}},600);},250);" +
    "setTimeout(function(){clearInterval(g);try{el.remove()}catch(e){}},9000);" +
    "}catch(e){}})()"
}

export const inject = ['webServer']

export function apply(ctx) {
  try {
    HOST_CTX = ctx
    // 首屏封面：只在 Web 载体上存在（tui/headless 没有 index.html，静默跳过）
    try {
      ctx.on('webserver/index-inject', (table) => {
        const art = bootCoverArt()
        if (!art) return
        table.push({ kind: 'style', text: BOOT_CSS }, { kind: 'script', placement: 'body', text: bootCoverScript(art) })
      }, { prepend: true })
    } catch (e) {
      ctx.logger?.debug?.('cyrene-live2d: 没有 web index 可装饰', e?.message ?? e)
    }
    // 第一件事：把散在 ~/.dsh 根下的老数据收进 cyrene-live2d/。
    // 必须在 loadUsage / loadLedger / loadFails **之前**——
    // 那三个读取时只认新位置，先搬再读才能接上。
    adoptLegacyData()
    // 第二件事：本机第一次装（还没有 prefs.json）时，从包里那份 default-prefs.json
    // 灌一次默认人设与主题开关 —— 分发场景靠它「解压即有她」。
    // 早于 loadUsage / loadLedger 没关系，但它们读的是同一份 prefs，顺序无碍。
    seedPrefsFromPackage()
    // 第三件事：记忆主档要是坏了（断电截断 / 手改坏），用 .bak 顶回来。
    // 放在最前面：后面所有读写都假设 memory.json 是合法的。
    healMemoryFile()
    // 第四件事：清掉上次断电留下的 *.tmp。
    // writeJsonAtomic 现在是 fsync 后再 rename，最坏情况是「rename 没生效 → 主档还是旧内容 + .tmp 残留」；
    // 那个 .tmp 已经没有用了，留着只会让人以为「是不是写了一半」。
    try {
      for (const n of ['memory.json', 'prefs.json', 'usage.json', 'ledger.json', 'fails.json', 'selfnote.json']) {
        const p = path.join(DATA_DIR, n + '.tmp')
        try {
          if (fs.existsSync(p)) fs.unlinkSync(p)
        } catch {}
      }
    } catch {}
    loadUsage()
    loadLedger()
    loadFails()

    // ── 米游社签到：可选能力，挂不上就跳过 ──
    //
    // 移植自 Veersion/dsh-mys-checkin（MIT，零运行时依赖）。
    // 它只用宿主的 connection（HTTP 路由）和 timer（定时）两个服务。
    //
    // 为什么用 ctx.inject 而不是写进 inject 数组：
    // 写进数组 = 硬依赖。将来宿主去掉 connection，整个小昔涟会起不来 ——
    // 签到只是附加能力，不该有这种否决权。
    // 拿不到就 MYS_SVC 保持 null，面板显示「没装」，其余功能一点不受影响。
    try {
      ctx.inject(['connection', 'timer'], (child) => {
        try {
          const mys = new MysService(child, {})
          try {
            child.effect(() => () => { try { mys.dispose() } catch {} }, 'cyrene: mys-checkin')
          } catch {}
          MYS_SVC = mys
          try { ctx.logger?.info?.(`${PACKAGE_ID}: 米游社签到已挂上`) } catch {}
        } catch (e) {
          MYS_SVC = null
          try { ctx.logger?.warn?.(`${PACKAGE_ID}: 米游社签到没挂上（不影响她本人）`, e) } catch {}
        }
      })
    } catch {
      MYS_SVC = null
    }

    // 会话投影：可选依赖。拿得到就用它做启动兜底（重启后立刻知道手上有什么任务），
    // 拿不到也不影响任何功能 —— 事件流那条路才是主力。
    try {
      ctx.inject(['sessionProjections'], (child) => {
        try {
          PROJ_SVC = child.sessionProjections || null
        } catch {}
        try {
          child.effect(
            () => () => {
              PROJ_SVC = null
            },
            `${PACKAGE_ID}: projections`,
          )
        } catch {}
      })
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: sessionProjections 可选注入失败（不影响功能）`, e)
    }

    // 世界书：读一次条目表，再挂到系统提示词上（可选依赖，挂了也照常跑）
    try {
      const wb = loadWorldbook()
      state.wbEntries = wb.entries
      state.wbFiles = wb.files
      state.wbStamp = dataStamp() // 记下开机时那一版，之后比对用
      state.wbProbe = `读到 ${wb.entries.length} 条 / ${wb.files.length} 份`
    } catch (e) {
      state.wbProbe = '读取失败：' + (e && e.message)
    }
    try {
      ctx.inject(['systemPrompt'], (child) => {
        try {
          PROMPT_SVC = child.systemPrompt || null
        } catch {}
        // 先把常驻块挂上（新会话第一句还没来，命中块自然会空）
        try {
          mountWorldbook()
        } catch {}
        // 人设 section（原属主题插件，为卸载它而迁入）。
        // 第一次进这里时先从主题插件留下的状态文件把人设接过来，
        // 之后再挂：顺序反了会白挂一个空 section。
        try {
          adoptLegacyPersona()
          mountPersona()
        } catch {}
        try {
          child.effect(
            () => () => {
              PROMPT_SVC = null
              if (state.wbDispose) {
                try {
                  state.wbDispose()
                } catch {}
              }
              state.wbDispose = null
              state.wbText = ''
              if (personaSectionDispose !== null) {
                try {
                  personaSectionDispose()
                } catch {}
                personaSectionDispose = null
              }
            },
            `${PACKAGE_ID}: worldbook`,
          )
        } catch {}
      })
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: systemPrompt 可选注入失败（世界书不生效，不影响其它功能）`, e)
    }

    // 自我认知工具：她能自己往 selfNote 里写一句（可选依赖，注册不上不影响任何既有功能）
    try {
      ctx.inject(['tools'], (child) => {
        try {
          registerSelfNoteTool(child.tools)
        } catch (e) {
          ctx.logger?.warn?.(`${PACKAGE_ID}: cyrene_selfnote 注册失败（她只能靠面板记了）`, e)
        }
        // 工作记忆读写工具（2026-11-05 阶段2）：独立注册、独立失败，不影响 selfnote
        try {
          registerMemoryTools(child.tools)
        } catch (e) {
          ctx.logger?.warn?.(`${PACKAGE_ID}: cyrene_remember/search 注册失败（工作记忆只能靠接口写）`, e)
        }
        // 语义动作协议（2026-11-07）：独立注册、独立失败。
        // 独立版没运行时这些工具依然在，只是 capabilities 会明说「她不在桌面上」。
        try {
          installL2DTools(child.tools, l2dState)
        } catch (e) {
          ctx.logger?.warn?.(`${PACKAGE_ID}: cyrene_l2d_* 注册失败（她只能靠既有的动作）`, e)
        }
        // 必须在这里把模块变量清空：注册本身挂在 ctx 的 layer 上，fiber 销毁时
        // 工具会被摘掉，但我们的「已注册」标记不会 —— 不清就会在下次 apply 时
        // 误判「已经有了」而跳过注册，工具从此消失（和 leaderBeat 那次同一个病）。
        try {
          child.effect(
            () => () => {
              if (selfnoteToolDispose !== null) {
                try {
                  selfnoteToolDispose()
                } catch {}
                selfnoteToolDispose = null
              }
              for (const d of memToolsDispose) {
                try { d() } catch {}
              }
              memToolsDispose = []
            },
            `${PACKAGE_ID}: selfnote-tool`,
          )
        } catch {}
      })
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: tools 可选注入失败（自我认知工具不可用）`, e)
    }

    // 工作记忆命中注入（阶段3）：独立于 tools，装不上只是没有按需回忆
    try {
      installWorkMemoryHitHook(ctx)
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: agent/pre-step 钩子挂载失败（工作记忆不会按需注入）`, e)
    }

    // 会话事件：状态机 + 今日估算
    try {
      ctx.on('session/event', (session, event) => {
        try {
          if (session) state.lastSession = session
          noteSession(session)
          noteTodoEvent(session, event)
          // 世界书命中：拿最近几条消息当关键词池，挑出相关条目注入
          const et = String((event && event.type) || '')
          // 自我认知：**只在新会话第一次唤醒时挂一次**，第一轮结束就摘掉。
          // 为什么是 turn/start：它早于提示词装配，挂上去这一轮就能看到；
          // 为什么立刻摘：每轮都灌等于「每隔十秒有人告诉你你是谁」。
          try {
            const sid2 = (session && session.id) || 'default'
            if (et === 'turn/start') {
              const box = readSelfNote()
              if (!box.seen[sid2]) {
                box.seen[sid2] = Date.now()
                writeSelfNote(box)
                mountSelfNoteOnce()
              }
              // 关系记忆注入：每轮开头调一次，同一会话内冻结。
              // 放在 turn/start 是因为它早于提示词装配 —— 这一轮就能看到。
              try { refreshMemorySection(sid2) } catch {}
            } else if (et === 'turn/end' || et === 'assistant/message') {
              unmountSelfNote()
            }
          } catch {}
          if (et === 'user/message' || et === 'assistant/message') {
            noteWorldbookText(String((session && session.id) || 'default'), messageText((event && event.data) || null))
          }
          // 你说的「明天再弄 / 回头再说」→ 记成一条待办（她在别的时候能提起来）。
          // 只认用户的句子：她自己的话不该被自己的检测网住。
          if (et === 'user/message') {
            try { noteDeferred(messageText((event && event.data) || null)) } catch {}
            // 同一句里也可能有边界（「这个先别动，明天再弄」），两条线各记各的
            try { noteBoundary(messageText((event && event.data) || null)) } catch {}
          }
          // 助手说的「人家帮你弄」→ 记成一条承诺。
          // 和上面那条各管一边：用户的话进 pending，助手的话进 promises。
          if (et === 'assistant/message') {
            try { notePromise(messageText((event && event.data) || null)) } catch {}
            // 报账结算：这一轮注入的足迹/记事，她回话里有没有用上（估计，不是判决）
            try { settleReceipts(messageText((event && event.data) || null)) } catch {}
          }
        } catch {}
        const sid = (session && session.id) || 'default'
        handleSessionEvent(sid, event)
        // 标题只在还没有的时候去问，避免每条事件都过一次服务
        if (!state.sessionName && session) {
          const t = sessionTitleOf(ctx, session)
          if (t) {
            state.sessionName = t
            saveUsage()
          }
        }
      })
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: session/event 订阅失败`, e)
    }

    try {
      ctx.on('session/disposed', (session) => {
        if (session && session.id) {
          state.turns.delete(session.id)
          state.sessions = state.sessions.filter((x) => !x || x.id !== session.id)
        }
      })
    } catch {}

    // 提问接管：airbag 优先。挂不上就当没这回事，绝不影响插件其它功能。
    try {
      ctx.effect(
        () => {
          const off = ctx.on('user-questions/request', (request, next) => bridgeAsk(request, next, ctx), {
            prepend: true,
          })
          return () => {
            try {
              if (typeof off === 'function') off()
            } catch {}
            if (state.ask) settleAsk(state.ask, { timeout: true })
          }
        },
        `${PACKAGE_ID}: ask bridge`,
      )
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: 提问接管挂载失败（不影响其它功能）`, e)
    }

    // 风险审批接管：和提问同一套路子，但更保守 —— 任何条件不满足就让开。
    try {
      ctx.effect(
        () => {
          const off = ctx.on('approval/request', (request, next) => bridgeApproval(request, next, ctx), {
            prepend: true,
          })
          return () => {
            try {
              if (typeof off === 'function') off()
            } catch {}
            if (state.approval) settleApproval(state.approval, 'timeout')
          }
        },
        `${PACKAGE_ID}: approval bridge`,
      )
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: 审批接管挂载失败（不影响其它功能）`, e)
    }

    // 客户端消失就当没人答：页面关了、标签被冻住、插件被停用，
    // 都别让 Agent 干等到超时。
    try {
      const askTimer = setInterval(() => {
        if (state.ask && !clientAlive()) {
          askLog('客户端离线，提问交还网页卡片')
          settleAsk(state.ask, { timeout: true })
        }
        if (state.approval && !clientAlive()) {
          askLog('客户端离线，审批交还网页卡片')
          settleApproval(state.approval, 'timeout')
        }
      }, 4000)
      if (askTimer && typeof askTimer.unref === 'function') askTimer.unref()
      ctx.effect(
        () => () => {
          try {
            clearInterval(askTimer)
          } catch {}
        },
        `${PACKAGE_ID}: ask watchdog`,
      )
    } catch {}

    // 余额：启动预热 + 每分钟刷新
    try {
      setTimeout(() => {
        refreshBalance(ctx, true).catch(() => {})
      }, 1500)
      const timer = setInterval(() => {
        rollDay()
        refreshBalance(ctx, false).catch(() => {})
      }, 60000)
      if (timer && typeof timer.unref === 'function') timer.unref()
      ctx.effect(
        () => () => {
          try {
            clearInterval(timer)
          } catch {}
        },
        `${PACKAGE_ID}: balance timer`,
      )
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: 余额定时器启动失败`, e)
    }

    // 语音服务：DSH 开它就开，DSH 关它就关。界面连上来要好几秒，
    // 这里 1.2 秒就去拉，足够赶在她第一句话之前。只管这一次，不轮询。
    try {
      const boot = setTimeout(() => {
        ensureGsv(ctx).catch(() => {})
      }, 1200)
      if (boot && typeof boot.unref === 'function') boot.unref()
      const bye = () => stopGsv()
      process.once('exit', bye)
      ctx.effect(
        () => () => {
          try {
            clearTimeout(boot)
          } catch {}
          try {
            process.removeListener('exit', bye)
          } catch {}
          stopGsv()
        },
        `${PACKAGE_ID}: gsv`,
      )
    } catch (e) {
      ctx.logger?.warn?.(`${PACKAGE_ID}: 语音服务自启挂载失败`, e)
    }

    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: PREFIX,
          handler: async (req, res) => {
            let rel = '/'
            // 顺手记下自己监听的端口（独立版要读 owner.json 里的 port）
            try {
              const m = /:(\d+)$/.exec(String(req.headers.host || ''))
              if (m) WEB_PORT = Number(m[1])
            } catch {}
            try {
              const url = new URL(req.url ?? '/', 'http://localhost')
              rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || '/'
            } catch {
              send(res, 400, 'bad url')
              return
            }

            if (rel.startsWith('/api/')) {
              // 来源检查统一走 lib/http-guard.js（2026-11-18）：Host 白名单 +
              // Origin 比对，挡住「任意网页 CSRF 改写人设」。副插件也调同一个。
              if (!guardLocalRequest(req, res, sendJson)) return
              try {
                if (rel === '/api/owner') {
                  if (req.method !== 'GET' && req.method !== 'HEAD') {
                    send(res, 405, 'method not allowed')
                    return
                  }
                  const st = ownerStatus()
                  sendJson(res, 200, { ok: true, mine: st.mine, other: st.other, ttl: OWNER_TTL, file: OWNER_FILE })
                  return
                }

                if (rel === '/api/state') {
                  if (req.method !== 'GET' && req.method !== 'HEAD') {
                    send(res, 405, 'method not allowed')
                    return
                  }
                  // 客户端还活着：提问接管要靠这个判据，别删
                  state.pollAt = Date.now()
                  // 顺带续一下 owner 心跳（节流 2 秒）——页面在轮询就等于「插件在前台」
                  try { touchOwner() } catch {}
                  // 客户端把「它那边的语音状态」挂在这个 query 上（见 client.js 的 diagParam）。
                  // 为什么要这样：被客户端闸门（VQ.file / playing / voiceOn）拦掉的那次，
                  // 根本不会发出网络请求，宿主这边一片寂静 —— 下游日志再多也查不到。
                  // 观测点必须放在决策发生的地方，所以让它自己报上来。
                  try {
                    const dg = new URL(req.url, 'http://localhost').searchParams.get('diag')
                    if (dg) state.clientDiag = String(dg).slice(0, 240)
                  } catch {}
                  refreshTodos(ctx)
                  if (!state.balanceAt || Date.now() - state.balanceAt > BALANCE_TTL) {
                    refreshBalance(ctx, false).catch(() => {})
                  }
                  const conf = readTtsConf()
                  rollDay()
                  // 探一下 TTS 服务活着没有（有 10 秒 TTL，不会每次都打）
                  if (!state.tts.checkedAt || Date.now() - state.tts.checkedAt > 10000) {
                    probeTts(conf).catch(() => {})
                  }
                  if (!state.sessionName && state.lastSession) {
                    const t = sessionTitleOf(ctx, state.lastSession)
                    if (t) state.sessionName = t
                  }
                  // 只取**当前会话**的轮次。
                  //
                  // 为什么不能把所有会话加起来：`state.turns` 是按 sessionId 存的 Map，
                  // 正常每轮结束都会 finalizeTurn 删掉自己；但**直接切换会话时不走
                  // turn/end**，旧会话的 agg 就留在里面了。加总的结果是「这一轮」
                  // 悄悄变成「所有会话累计」—— 用户看到的现象是「切了会话数字不动」。
                  const curSid = (state.lastSession && state.lastSession.id) || ''
                  const curAgg = curSid ? state.turns.get(curSid) : null
                  // 透传：新加的数字字段自动带出来，不用再改这里（见 aggView 注释）
                  const agg = aggView(curAgg)
                  // 今日已用：优先用余额观测（真实），退回去用 token 估算。
                  // 观测有缺口时标 partialDay，界面会加一个 *，不假装完整。
                  const ledScope = activeScope(state.ledger)
                  const spent = ledScope ? summaryOf(state.ledger, ledScope, beijingDay()) : null
                  const spend = spent
                    ? Object.assign({}, spent, { source: 'observed', estimate: state.today.cost })
                    : { day: bjDay(), spent: null, source: 'estimate', estimate: state.today.cost, partialDay: true }
                  const peakNow = isPeak(Date.now())
                  sendJson(res, 200, {
                    ok: true,
                    build: BUILD,
                    now: Date.now(),
                    // 单实例仲裁：独立版（Tauri/Electron 壳）当前是否是主人。
                    // mine=false 时插件版退成「后台资源提供者」——不说、不播、不跑签到，
                    // 但仍然提供 /api/state、模型与语音文件（独立版还要靠它取资源）。
                    owner: (() => { const st = ownerStatus(); return { mine: st.mine, other: st.other } })(),
                    phase: phaseNow(),
                    wait: state.wait,
                    fail: state.fail,
                    lastTool: state.lastTool,
                    // 语义动作协议 v1：独立版轮询时取走 pending 去播，播完 POST 回执。
                    // caps 只给摘要（参数个数），完整目录留在宿主内存里给工具查。
                    l2d: {
                      // 心跳超过 15s 没刷新就当独立版已经不在了（caps 是一次性上报）
                  caps: l2dState.caps && Date.now() - (l2dState.caps.at || 0) < 15000
                    ? { model: l2dState.caps.model || '', params: (l2dState.caps.order || []).length }
                    : null,
                      pending: l2dState.pending,
                      result: l2dState.result,
                    },
                    sessionName: state.sessionName,
                    // 会话 id：客户端判断「是命名/重命名，还是切换了会话」要用它。
                    // 没有它的话，切会话时 sessionName 一变就会被误当成改名。
                    sessionId: (state.lastSession && state.lastSession.id) || '',
                    // 归档数量（-1 = 这版 DSH 没有 workspaceRegistry）。
                    // 客户端拿它做差异检测：变多 = 刚归档了一个会话。
                    archived: archivedCount(),
                    lastTurn: state.lastTurn,
                    curTurn: agg,
                    // 缓存账单（步 / 轮 / 会话），只取当前会话 —— 和 curTurn 同一个理由：
                    // 全局加总会在切会话时把「这一轮」变成「所有会话」。
                    billing: billView(curSid),
                    today: state.today,
                    model: state.model,
                    modelAt: state.modelAt,
                    modelProbe: state.modelProbe,
                    // 人设种子这次启动做了什么（ok / skip / bad json / write failed）。
                    // 分发出去第一版启动看不到人设时，先看这里，不用去猜。
                    seedProbe: state.seedProbe || '',
                    balance: state.balance,
                    // 今日已用：余额观测优先，估算兜底；partialDay 明说数据不全
                    spend,
                    // 现在算高峰还是谷时：高峰单价是谷时的两倍，界面上要说得出来
                    pricing: {
                      peak: peakNow,
                      multiplier: peakNow ? 2 : 1,
                      model: state.model,
                      note: peakNow ? '高峰时段 · 单价 ×2' : '谷时 · 单价 ×1',
                    },
                    ledger: {
                      scope: ledScope,
                      recent: ledScope ? recentDays(state.ledger, ledScope, 7) : [],
                    },
                    accountProbe: state.accountProbe,
                    tts: {
                      on: !!(conf.ref_audio_path && fs.existsSync(conf.ref_audio_path)),
                      alive: state.tts.alive,
                      endpoint: conf.endpoint,
                      // 自启状态：pid 有值 = 这个语音服务是人家在启动时拉起来的，DSH 退出会一起带走
                      selfStart: {
                        pid: state.gsv.pid,
                        tries: state.gsv.tries,
                      },
                    },
                    ttsLog: state.ttsLog,
                    // 客户端自报的语音状态：voiceOn / 嗓哑降级 / 最近一次播放结果
                    clientDiag: state.clientDiag || '',
                    // 任务进度：她点一下能报「2/5 完成，正在做…」，读的是会话投影
                    todos: state.todos,
                    todosAt: state.todosAt,
                    todosProbe: {
                      proj: state.projProbe,
                      todo: state.todoProbe,
                      sessions: state.sessions.length,
                    },
                    // 世界书：读到几条、当前挂上去多少字符（排查「设定了却没生效」用）
                    worldbook: {
                      entries: (state.wbEntries || []).length,
                      files: state.wbFiles,
                      text: state.wbText.length,
                      recent: state.wbRecent.length,
                      probe: state.wbProbe,
                    },
                    // 关系记忆注入：有没有挂上去、挂了多少字符（排查「记了却不管用」用）
                    memory: {
                      probe: state.memProbe || '',
                      session: memFrozenSid,
                      chars: memFrozenText.length,
                      // 体检：四桶条数 / 最后写入时间 / 有没有 .bak / 有没有自愈过
                      stat: memoryStat(),
                    },
                    // 注入报账：送出去几条、有多少次像是被用上了（估计，不是判决）
                    receipts: receiptsPublic(),
                    // 卡点账本：同一类报错是不是又撞上了
                    fails: {
                      total: state.fails.items.length,
                      repeat: state.fails.repeat,
                    },
                    // 正在等的提问（客户端画成气泡里的答题卡）；没有就是 null
                    ask: askPublic(),
                    // 正在等的风险审批：允许一次 / 拒绝
                    approval: approvalPublic(),
                    askLog: state.askLog.slice(-5),
                  })
                  return
                }

                // 客户端偏好：GET 取回整份，POST 走 { set: { key: value } } 合并写入。
                // 只用来存界面开关和账本，不进 prompt、不联网。
                // ── 语义动作协议 v1 ────────────────────────────────
                // 独立版启动或换模型时，把自己读到的能力目录 POST 上来。
                // 走这条而不是新开端口：独立版本来就能 host_post，宿主本来就有 HTTP 服务。
                if (rel === '/api/l2d/caps' && req.method === 'POST') {
                  try {
                    const raw = String((await readBody(req, 512 * 1024)) || '')
                    const body = JSON.parse(raw || '{}')
                    if (!body || !body.params || typeof body.params !== 'object') {
                      sendJson(res, 400, { ok: false, error: '能力目录里没有 params' })
                      return
                    }
                    // 目录缺 min/max/default 时在这里就拒，别推迟到 compile 才暴露
                    try {
                      checkCaps(body)
                    } catch (e) {
                      sendJson(res, 400, { ok: false, error: 'bad caps: ' + String((e && e.message) || e) })
                      return
                    }
                    l2dState.caps = { ...body, at: Date.now() }
                    sendJson(res, 200, { ok: true, params: Object.keys(body.params).length })
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
                  }
                  return
                }
                // 回执：只有独立版真的播完才写 completed=true
                if (rel === '/api/l2d/receipt' && req.method === 'POST') {
                  try {
                    const raw = String((await readBody(req, 8 * 1024)) || '')
                    const body = JSON.parse(raw || '{}')
                    const jobId = String(body.jobId || '')
                    if (l2dState.pending && l2dState.pending.jobId === jobId) l2dState.pending = null
                    l2dState.result = {
                      jobId,
                      ok: !!body.ok,
                      ms: Number(body.ms) || 0,
                      at: Date.now(),
                    }
                    sendJson(res, 200, { ok: true })
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
                  }
                  return
                }

                if (rel === '/api/prefs') {
                  if (req.method === 'GET' || req.method === 'HEAD') {
                    sendJson(res, 200, { ok: true, build: BUILD, prefs: readPrefs() })
                    return
                  }
                  if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  let payload = null
                  try {
                    const raw = await readBody(req, 16 * 1024)
                    payload = JSON.parse(String(raw || '{}'))
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: '解析失败：' + String((e && e.message) || e) })
                    return
                  }
                  const r = writePrefs(payload && payload.set)
                  sendJson(res, r.ok ? 200 : 400, r)
                  return
                }

                // ── 她的记忆（关系层）──
                // GET 给面板看（只读），POST 是她自己写（面板上没有任何编辑按钮）。
                // 刻意不给 PUT/DELETE：能删记忆的只有两条路 —— 她自己 drop，或者你直接改 JSON。
                // ★ 记忆总线：一次拿到「她的记忆」全貌（四桶 + 独立版采集的桌面足迹）
                //
                // 为什么要有这个路由：DSH 与独立版各有一半记忆 —— 四桶在插件侧，
                // 时间轴/环境在独立版侧。独立版要能读到「她对你说过什么、答应过什么」，
                // 否则它的气泡只能凭空说话。**数据仍只有一份，这里只做只读合并。**
                if (rel === '/api/memory/all') {
                  if (req.method !== 'GET' && req.method !== 'HEAD') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  const m = readMemory()
                  let env = null
                  try { env = JSON.parse(fs.readFileSync(ENV_FILE, 'utf8')) } catch {}
                  sendJson(res, 200, {
                    ok: true,
                    generatedAt: Date.now(),
                    boundaries: m.boundaries || [],
                    promises: (m.promises || []).filter((e) => e && !e.done),
                    pending: m.pending || [],
                    // 工作记忆：独立版也能读（只读），用于它自己的气泡与检索
                    workspace: m.workspace || [],
                    lessons: (m.lessons || []).filter((e) => e && !e.done),
                    // 画像：独立版也该知道「你是谁」，但它只读 —— 写入口仍然只有宿主一个
                    profile: m.profile || [],
                    env: env || null,
                  })
                  return
                }

                if (rel === '/api/memory') {
                  if (req.method === 'GET' || req.method === 'HEAD') {
                    const m = readMemory()
                    sendJson(res, 200, {
                      ok: true,
                      file: MEM_FILE,
                      cap: MEM_CAP,
                      pending: m.pending,
                      promises: m.promises,
                      counts: m.counts,
                      boundaries: m.boundaries,
                      // 工作记忆（2026-11-05 新增）：面板暂不画，但接口先给出来
                      workspace: m.workspace || [],
                      lessons: m.lessons || [],
                      // 画像（2026-11-06）：面板要能显示「她记得的你」
                      profile: m.profile || [],
                      total:
                        m.pending.length +
                        m.promises.length +
                        Object.keys(m.counts).length +
                        m.boundaries.length +
                        (m.workspace || []).length +
                        (m.lessons || []).length +
                        (m.profile || []).length,
                    })
                    return
                  }
                  if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  let memBody = null
                  try {
                    memBody = JSON.parse(String((await readBody(req, 16 * 1024)) || '{}'))
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: '解析失败：' + String((e && e.message) || e) })
                    return
                  }
                  const mr = applyMemoryOp(memBody)
                  sendJson(res, mr.ok ? 200 : 400, mr)
                  return
                }

                // ── 人格底稿（原属主题插件的 /cyrene/state，为卸载它而迁入）──
                // GET 读 {text, rev, on, stickersOn, themeOn, bgOn, bgRotate, heroTitle}
                // POST 带 rev 改；rev 对不上交回 409，让客户端自己重拉 —— 不留「谁赢了」的歧义。
                if (rel === '/api/persona') {
                  if (req.method === 'GET' || req.method === 'HEAD') {
                    sendJson(res, 200, { ok: true, value: personaPublic() })
                    return
                  }
                  if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  let body = null
                  try {
                    body = JSON.parse(String((await readBody(req, 64 * 1024)) || '{}'))
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: '解析失败：' + String((e && e.message) || e) })
                    return
                  }
                  const curRev = Number(readPrefs()[PK.rev] || 0) || 0
                  const wantRev = Number(body && body.rev)
                  if (!Number.isFinite(wantRev)) {
                    sendJson(res, 400, { ok: false, error: '必须带上 rev（你读到的是哪一版）' })
                    return
                  }
                  if (wantRev !== curRev) {
                    sendJson(res, 409, { ok: false, error: '别处已经改过了', value: personaPublic() })
                    return
                  }
                  const set = { [PK.rev]: String(curRev + 1) }
                  if (typeof body.text === 'string') set[PK.persona] = body.text
                  if (typeof body.on === 'boolean') set[PK.on] = body.on ? '1' : '0'
                  if (typeof body.stickersOn === 'boolean') set[PK.stickers] = body.stickersOn ? '1' : '0'
                  if (typeof body.themeOn === 'boolean') set[PK.theme] = body.themeOn ? '1' : '0'
                  if (typeof body.bgOn === 'boolean') set[PK.bg] = body.bgOn ? '1' : '0'
                  if (typeof body.bgRotate === 'boolean') set[PK.bgRotate] = body.bgRotate ? '1' : '0'
                  if (typeof body.heroTitle === 'string') set[PK.heroTitle] = body.heroTitle.slice(0, 80)
                  if (typeof body.bgCurrent === 'string') set[PK.bgCurrent] = body.bgCurrent.slice(0, 120)
                  const w = writePrefs(set)
                  if (!w.ok) {
                    sendJson(res, 400, w)
                    return
                  }
                  // 立刻按新设定重挂：不重启、不刷新，下一轮对话就是新口吻。
                  try {
                    mountPersona()
                  } catch {}
                  sendJson(res, 200, { ok: true, value: personaPublic() })
                  return
                }

                // ── 素材清单：包内自带的 + 用户自己加的 ──
                if (rel === '/api/assets') {
                  const backgrounds = []
                  try {
                    for (const n of fs.readdirSync(path.join(ROOT, 'Background'))) {
                      if (!/\.(png|jpe?g|webp|gif)$/i.test(n)) continue
                      backgrounds.push({
                        name: n,
                        label: n.replace(/\.[^.]+$/, ''),
                        src: PREFIX + '/background/' + encodeURIComponent(n),
                        custom: false,
                      })
                    }
                  } catch {}
                  const stickers = stickerItems().map((it) => {
                    const base = path.basename(it.abs)
                    return {
                      name: base,
                      label: it.label,
                      when: it.when,
                      src: PREFIX + '/meme/' + encodeURIComponent(base),
                      custom: false,
                    }
                  })
                  for (const it of listCustom()) {
                    const entry = {
                      name: it.name,
                      label: it.name.replace(/^(bg|sticker)[-_]/i, '').replace(/\.[^.]+$/, ''),
                      when: '',
                      src: PREFIX + '/api/asset/' + encodeURIComponent(it.name),
                      custom: true,
                    }
                    if (/^bg[-_]/i.test(it.name)) backgrounds.push(entry)
                    else stickers.push(entry)
                  }
                  sendJson(res, 200, { ok: true, value: { backgrounds, stickers } })
                  return
                }

                // ── 上传一张自定义素材：{ kind: 'background' | 'sticker', dataUrl } ──
                if (rel === '/api/asset' && req.method === 'POST') {
                  let body = null
                  try {
                    body = JSON.parse(String((await readBody(req, 12 * 1024 * 1024)) || '{}'))
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: '解析失败：' + String((e && e.message) || e) })
                    return
                  }
                  const kind = body && body.kind === 'background' ? 'bg' : 'sticker'
                  const m = /^data:image\/([a-z+]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(String((body && body.dataUrl) || ''))
                  if (m === null) {
                    sendJson(res, 400, { ok: false, error: '只接受 data:image/*;base64,…' })
                    return
                  }
                  let ext = m[1].toLowerCase()
                  if (ext === 'jpeg') ext = 'jpg'
                  if (['png', 'jpg', 'webp', 'gif'].indexOf(ext) < 0) {
                    sendJson(res, 400, { ok: false, error: '不认识的图片类型：' + m[1] })
                    return
                  }
                  let bytes = null
                  try {
                    bytes = Buffer.from(m[2].replace(/\s+/g, ''), 'base64')
                  } catch {}
                  if (!bytes || bytes.length === 0 || bytes.length > 8 * 1024 * 1024) {
                    sendJson(res, 400, { ok: false, error: '图片太大或者读不出来（上限 8MB）' })
                    return
                  }
                  const name = kind + '-' + Date.now() + '.' + ext
                  try {
                    fs.mkdirSync(CUSTOM_DIR, { recursive: true })
                    fs.writeFileSync(path.join(CUSTOM_DIR, name), bytes)
                  } catch (e) {
                    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
                    return
                  }
                  sendJson(res, 200, { ok: true, name, src: PREFIX + '/api/asset/' + encodeURIComponent(name) })
                  return
                }

                // ── 删掉自定义素材（包内自带的不能删，也不列在这儿）──
                if (rel === '/api/asset/remove' && req.method === 'POST') {
                  let body = null
                  try {
                    body = JSON.parse(String((await readBody(req, 8 * 1024)) || '{}'))
                  } catch {}
                  const n = safeCustomName(body && body.name)
                  if (n === '') {
                    sendJson(res, 400, { ok: false, error: '名字不合法' })
                    return
                  }
                  try {
                    fs.rmSync(path.join(CUSTOM_DIR, n), { force: true })
                  } catch (e) {
                    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
                    return
                  }
                  sendJson(res, 200, { ok: true })
                  return
                }

                // ── 自定义素材字节 ──
                if (rel.startsWith('/api/asset/')) {
                  const n = safeCustomName(rel.slice('/api/asset/'.length))
                  const type = n === '' ? '' : mimeOf(n)
                  const abs = n === '' ? '' : path.join(CUSTOM_DIR, n)
                  if (abs === '' || type === '' || !fs.existsSync(abs)) {
                    sendJson(res, 404, { ok: false, error: '没有这张图' })
                    return
                  }
                  try {
                    const buf = fs.readFileSync(abs)
                    res.statusCode = 200
                    res.setHeader('Content-Type', type)
                    res.setHeader('Cache-Control', 'no-cache')
                    res.end(buf)
                  } catch (e) {
                    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
                  }
                  return
                }

                if (rel === '/api/tts/config') {
                  // GET：返回当前生效的路径 + 自动探测结果
                  if (req.method === 'GET' || req.method === 'HEAD') {
                    const P = gsvPaths()
                    let probes = []
                    try { probes = gsvProbe().slice(0, 6) } catch {}
                    sendJson(res, 200, {
                      ok: true,
                      paths: P,
                      defaults: GSV_DEFAULTS,
                      probe: probes,
                      ok_py: fs.existsSync(P.py),
                      ok_cwd: fs.existsSync(path.join(P.cwd, 'api_v2.py')),
                      ok_conf: fs.existsSync(P.conf),
                      file: TTS_CONF_FILE,
                    })
                    return
                  }
                  if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  try {
                    const body = await readBody(req)
                    let j = {}
                    try { j = JSON.parse(fs.readFileSync(TTS_CONF_FILE, 'utf8')) } catch {}
                    if (!j || typeof j !== 'object') j = {}
                    j.gsv = j.gsv || {}
                    // 2026-11-18: 校验路径存在再落盘 —— 否则任意可执行文件都能被
                    // 写进 tts.json 并在 600ms 后被 spawn 起来。纯命令名（python）
                    // 交给 PATH，不做存在性校验。
                    let _bad = null
                    for (const k of ['py', 'cwd', 'bin', 'conf']) {
                      if (typeof body[k] !== 'string') continue
                      const v = body[k].trim()
                      if (!v) continue
                      const looksPath = /[\\/]/.test(v) || /^[A-Za-z]:/.test(v)
                      if (looksPath && !fs.existsSync(v)) { _bad = k + ' not found: ' + v; break }
                      // py 只接受 python 可执行文件（或 .bat/.cmd 包装），
                      // 否则「任意 exe 存在」就能被写进来并在 600ms 后 spawn。
                      const _pyBase = String(v).split(/[\\/]/).pop().toLowerCase()
                      if (k === 'py' && !/^(python|python3|python3\.\d+)\.exe$|^python$/.test(_pyBase) && !/\.(bat|cmd)$/.test(_pyBase)) {
                        _bad = 'py must be a python executable: ' + v
                        break
                      }
                      // bin 是 PATH 前置目录：必须是目录，不能是文件。
                      if (k === 'bin') {
                        let isDir = false
                        try { isDir = fs.statSync(v).isDirectory() } catch {}
                        if (!isDir) { _bad = 'bin is not a directory: ' + v; break }
                      }
                      j.gsv[k] = v
                    }
                    if (_bad) {
                      sendJson(res, 400, { ok: false, error: _bad })
                      return
                    }
                    if (body.port !== undefined && body.port !== '') {
                      const n = Number(body.port)
                      j.gsv.port = Number.isFinite(n) && n > 0 ? n : GSV_DEFAULTS.port
                    }
                    const ok = writeJsonAtomic(TTS_CONF_FILE, j)
                    // 路径变了要重启语音服务，否则改动不生效
                    try { stopGsv(0) } catch {}
                    setTimeout(() => { try { startGsv(ctx) } catch {} }, 600)
                    sendJson(res, 200, { ok, paths: gsvPaths() })
                  } catch (e) {
                    sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
                  }
                  return
                }

                if (rel === '/api/tts/health') {
                  const conf = readTtsConf()
                  sendJson(res, 200, {
                    ok: true,
                    alive: await probeTts(conf),
                    ready: !!(conf.ref_audio_path && fs.existsSync(conf.ref_audio_path)),
                    ref_audio_path: conf.ref_audio_path ? path.basename(conf.ref_audio_path) : '',
                    endpoint: conf.endpoint,
                    conf: TTS_CONF_FILE,
                  })
                  return
                }

                if (rel === '/api/tts') {
                  await handleTts(req, res)
                  return
                }

                if (rel === '/api/diag') {
                  // 页面自己上报的「体检快照」：只在面板点「体检」或首次挂载 20 秒后各来一次。
                  // 为什么让页面报、而不是宿主去猜：桌面壳的沙箱里宿主既截不了图也读不到 DOM。
                  if (req.method === 'GET' || req.method === 'HEAD') {
                    sendJson(res, 200, { ok: true, entries: readDiag() })  // 不回显 DIAG_FILE：那是服务器绝对路径
                    return
                  }
                  if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  try {
                    const raw = await readBody(req, 96 * 1024)
                    const payload = JSON.parse(String(raw || '{}'))
                    const count = appendDiag(payload)
                    sendJson(res, 200, { ok: true, count })
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
                  }
                  return
                }

                if (rel === '/api/selfnote') {
                  if (req.method === 'GET' || req.method === 'HEAD') {
                    sendJson(res, 200, { ok: true, ...selfNotePublic() })
                    return
                  }
                  if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  let payload = null
                  try {
                    const raw = await readBody(req, 8 * 1024)
                    payload = JSON.parse(String(raw || '{}'))
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: '解析失败：' + String((e && e.message) || e) })
                    return
                  }
                  if (payload && payload.clear === true) {
                    const okWrite = writeSelfNote({ notes: [], seen: {} })
                    sendJson(res, okWrite ? 200 : 500, okWrite ? { ok: true, count: 0, ...selfNotePublic() } : { ok: false, error: '写盘失败' })
                    return
                  }
                  const r = appendSelfNote(payload && payload.text)
                  sendJson(res, r.ok ? 200 : 400, r.ok ? { ok: true, ...selfNotePublic() } : r)
                  return
                }

                // 气泡答题卡提交答案：{ id, answers: [{ id, selected: [] }] }
                if (rel === '/api/answer') {
                  if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  let payload = null
                  try {
                    const raw = await readBody(req, 64 * 1024)
                    payload = JSON.parse(String(raw || '{}'))
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: '解析失败：' + String((e && e.message) || e) })
                    return
                  }
                  const r = applyAnswer(payload)
                  sendJson(res, r.ok ? 200 : 409, r)
                  return
                }

                // 审批卡提交决定：{ id, decision: 'allow' | 'reject' }
                if (rel === '/api/approval') {
                  if (req.method !== 'POST') {
                    sendJson(res, 405, { ok: false, error: 'method not allowed' })
                    return
                  }
                  let payload = null
                  try {
                    const raw = await readBody(req, 8 * 1024)
                    payload = JSON.parse(String(raw || '{}'))
                  } catch (e) {
                    sendJson(res, 400, { ok: false, error: '解析失败：' + String((e && e.message) || e) })
                    return
                  }
                  const r = applyApproval(payload)
                  sendJson(res, r.ok ? 200 : 409, r)
                  return
                }

                sendJson(res, 404, { ok: false, error: 'unknown api' })
                return
              } catch (e) {
                try {
                  sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
                } catch {}
                return
              }
            }

            // ── 静态资源 ──
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              send(res, 405, 'method not allowed')
              return
            }
            if (rel === '/' || rel === '') rel = '/index.json'
            if (!ALLOWED.some((p) => rel.startsWith(p)) && rel !== '/index.json') {
              send(res, 403, 'forbidden: ' + rel)
              return
            }
            const abs = path.resolve(path.join(ROOT, rel.replace(/^\/+/, '')))
            // sibling-prefix safe check: /assets-secret must not pass /assets
            const relToRoot = path.relative(path.resolve(ROOT), abs)
            if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) {
              send(res, 403, 'forbidden')
              return
            }
            if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
              send(res, 404, 'not found: ' + rel)
              return
            }
            const body = fs.readFileSync(abs)
            const ext = path.extname(abs).toLowerCase()
            const type = MIME[ext] || 'application/octet-stream'
            if (req.method === 'HEAD') {
              res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length })
              res.end()
              return
            }
            send(res, 200, body, type)
          },
        }),
      `${PACKAGE_ID}: assets route`,
    )

    ctx.logger?.info?.(`${PACKAGE_ID}: 静态资源 ${PREFIX}/{model,api}/* -> ${ROOT}`)
  } catch (error) {
    ctx.logger?.warn?.(`${PACKAGE_ID}: 挂载失败（GUI 可能不在）`, error)
  }
}
