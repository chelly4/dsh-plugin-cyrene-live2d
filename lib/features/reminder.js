/**
 * 小昔涟 · 副插件 ①：提醒（reminder）
 *
 * 这是**同包里的第二个插件 entry**：`cordis.patch.yml` 里多一行，插件页就会多一行，
 * 可以单独启停。它自己不画任何界面（一个包只有一份 client bundle），
 * 面板那一屏由主客户端 `client.js` 通过下面这几条路由读写。
 *
 * 为什么这样切：
 *  - 数据独立（`~/.dsh/cyrene-live2d/reminder.json`），主包一个字节都不碰；
 *  - 路由独立（`/cyrene-reminder/...`），主包挂了它照样能用；
 *  - 它挂了也不影响桌宠（各是各的 fiber）。
 *
 * 约定：宿主只负责「存 / 读 / 到点标 fired」，**不负责出声**。
 * 出声的是主客户端（它手上才有语音），靠轮询 `/api/due` 发现该说了。
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'

const PACKAGE_ID = 'dsh-plugin-cyrene-live2d'
const PREFIX = '/cyrene-reminder'
const DATA_DIR = path.join(homedir(), '.dsh', 'cyrene-live2d')
const FILE = path.join(DATA_DIR, 'reminder.json')
/** 到点后最多补说这么久；再旧的就不说了（免得开机一口气念五条）。 */
const GRACE_MS = 30 * 60 * 1000

export const inject = ['webServer']

/* ───────────────── 存储 ───────────────── */

function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (j && Array.isArray(j.items)) return { items: j.items }
  } catch {}
  return { items: [] }
}

/** 原子写：tmp → fsync → rename（和主包同一套规矩，别让半份 JSON 落地）。 */
function writeStore(store) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const tmp = FILE + '.tmp'
    const buf = Buffer.from(JSON.stringify({ v: 1, items: store.items }, null, 2), 'utf8')
    const fd = fs.openSync(tmp, 'w')
    try { fs.writeSync(fd, buf, 0, buf.length); try { fs.fsyncSync(fd) } catch {} } finally { fs.closeSync(fd) }
    fs.renameSync(tmp, FILE)
    return true
  } catch { return false }
}

/* ───────────────── 数据形状 ───────────────── */

const MAX_ITEMS = 50
const MAX_TEXT = 200

function normalizeItem(raw) {
  const at = Number(raw && raw.at)
  const text = String((raw && raw.text) || '').trim().slice(0, MAX_TEXT)
  if (!Number.isFinite(at) || at <= 0 || !text) return null
  return {
    id: String((raw && raw.id) || '') || 'r' + Math.random().toString(36).slice(2, 10),
    at,
    text,
    fired: !!(raw && raw.fired),
    createdAt: Number((raw && raw.createdAt) || Date.now()),
  }
}

/* ───────────────── 路由 ───────────────── */

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** 到点且还没说过的（给主客户端轮询用）。 */
function dueList(now) {
  const store = readStore()
  return store.items
    .filter((it) => !it.fired && it.at <= now && now - it.at <= GRACE_MS)
    .sort((a, b) => a.at - b.at)
    .slice(0, 3)
}

export function apply(ctx) {
  // 启动自检：目录在不在、文件能不能读——只写日志，不抛。
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    const s = readStore()
    ctx.logger?.info?.(`${PACKAGE_ID}: 提醒插件已启动（${s.items.length} 条）`)
  } catch (e) {
    ctx.logger?.warn?.(`${PACKAGE_ID}: 提醒插件启动时读不到数据（会用空列表）`, e)
  }

  // ★ handler 只收 (req, res)：第三个参数是 undefined（主插件是这么写的，我们照抄才对）。
  // 早先写成 (req,res,url) 直接读 url.pathname → TypeError → 宿主回 400 空响应。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      let rel = '/'
      try {
        const url = new URL(req.url || '/', 'http://localhost')
        rel = decodeURIComponent(url.pathname.slice(PREFIX.length)) || '/'
      } catch {
        sendJson(res, 400, { ok: false, error: 'bad url' })
        return
      }
      const now = Date.now()

      try {
        if (rel === '/api/list') {
          if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
          const store = readStore()
          sendJson(res, 200, {
            ok: true,
            now,
            graceMs: GRACE_MS,
            items: store.items.slice().sort((a, b) => a.at - b.at),
            due: dueList(now),
          })
          return
        }

        if (rel === '/api/due') {
          if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
          sendJson(res, 200, { ok: true, now, due: dueList(now) })
          return
        }

        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }

        const raw = await readBody(req, 16 * 1024)
        const payload = JSON.parse(String(raw || '{}'))
        const store = readStore()

        if (rel === '/api/add') {
          const item = normalizeItem({ ...payload, createdAt: now, fired: false })
          if (!item) { sendJson(res, 400, { ok: false, error: 'bad item' }); return }
          store.items.push(item)
          store.items.sort((a, b) => a.at - b.at)
          while (store.items.length > MAX_ITEMS) store.items.shift() // 超了丢最早的

          // 写盘失败必须报错：以前这里不回查 writeStore 的返回值，磁盘满/权限被拒时会「看起来存上了」。

          if (!writeStore(store)) { sendJson(res, 500, { ok: false, error: 'write failed' }); return }
          sendJson(res, 200, { ok: true, item, count: store.items.length })
          return
        }

        if (rel === '/api/del') {
          const id = String(payload.id || '')
          const before = store.items.length
          store.items = store.items.filter((it) => it.id !== id)

          if (!writeStore(store)) { sendJson(res, 500, { ok: false, error: 'write failed' }); return }
          sendJson(res, 200, { ok: true, removed: before - store.items.length })
          return
        }

        if (rel === '/api/ack') {
          // 主客户端说完之后来标一次：fired=true，不再重复播。
          const id = String(payload.id || '')
          const hit = store.items.find((it) => it.id === id)
          if (hit) {
          hit.fired = true
          if (!writeStore(store)) { sendJson(res, 500, { ok: false, error: 'write failed' }); return }
        }
          sendJson(res, 200, { ok: !!hit })
          return
        }

        sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
      } catch (e) {
        try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }) } catch {}
      }
    },
  }))

  // 定时器：每分钟把「过期太久还没说」的标记成 fired，避免开机补念一堆。
  const sweep = setInterval(() => {
    try {
      const now = Date.now()
      const store = readStore()
      let changed = false
      for (const it of store.items) {
        if (!it.fired && now - it.at > GRACE_MS) { it.fired = true; changed = true }
      }
      if (changed) writeStore(store)
    } catch {}
  }, 60 * 1000)
  ctx.effect(() => () => { try { clearInterval(sweep) } catch {} })
}
