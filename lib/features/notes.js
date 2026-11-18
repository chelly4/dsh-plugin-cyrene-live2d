/**
 * 小昔涟 · 副插件 ②：便签（notes）
 *
 * 同一包里的第三个 entry。纯宿主侧：不画界面，只负责「存 / 列 / 删」。
 * 界面那一屏在主客户端里（`createNotesUI` 工厂），所以它自己的代码只有「文件和路由」两件事。
 *
 * 和其它两块的边界：
 *  - 数据 `~/.dsh/cyrene-live2d/notes.json`（和提醒一样各占一个文件，谁也不读谁的）
 *  - 路由 `/cyrene-notes/api/*`
 *  - 它挂了不影响桌宠，也不影响提醒
 */
import fs from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import { guardLocalRequest } from '../http-guard.js'

const PACKAGE_ID = 'dsh-plugin-cyrene-live2d'
const PREFIX = '/cyrene-notes'
// 2026-11-18: honour DSH_HOME like the main plugin does, otherwise the data
// directory silently splits (uninstall/migrate/backup miss the two sub-plugins).
const DSH_HOME = process.env.DSH_HOME || path.join(homedir(), '.dsh')
const DATA_DIR = path.join(DSH_HOME, 'cyrene-live2d')
const FILE = path.join(DATA_DIR, 'notes.json')

const MAX_ITEMS = 200
const MAX_TEXT = 4000

export const inject = ['webServer']

/* ───────────────── 存储 ───────────────── */

function readStore() {
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (j && Array.isArray(j.items)) return { items: j.items }
  } catch {}
  return { items: [] }
}

/** 原子写：tmp → fsync → rename。 */
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

const TYPES = new Set(['error', 'code', 'text'])

function normalize(raw) {
  const text = String((raw && raw.text) || '').trim().slice(0, MAX_TEXT)
  if (!text) return null
  const type = TYPES.has(raw && raw.type) ? raw.type : 'text'
  return {
    // ★ 必须 String()：删除那边比的是字符串，数字 id 会永远删不掉
    id: String((raw && raw.id) || '') || 'n' + Math.random().toString(36).slice(2, 10),
    at: Number((raw && raw.at) || Date.now()),
    type,
    text,
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

export function apply(ctx) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    ctx.logger?.info?.(`${PACKAGE_ID}: 便签插件已启动（${readStore().items.length} 条）`)
  } catch (e) {
    ctx.logger?.warn?.(`${PACKAGE_ID}: 便签插件启动时读不到数据（会用空列表）`, e)
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
      // 只接受本地同源写请求（2026-11-18）
      if (rel.startsWith('/api/') && !guardLocalRequest(req, res, sendJson)) return
      try {
        if (rel === '/api/list') {
          if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
          const store = readStore()
          sendJson(res, 200, { ok: true, count: store.items.length, items: store.items })
          return
        }

        if (req.method !== 'POST') { sendJson(res, 405, { ok: false, error: 'method not allowed' }); return }
        const payload = JSON.parse(String((await readBody(req, 64 * 1024)) || '{}'))
        const store = readStore()

        if (rel === '/api/add') {
          const item = normalize({ ...payload, at: Date.now() })
          if (!item) { sendJson(res, 400, { ok: false, error: 'empty text' }); return }
          // 去重：**全表**找同正文（不只是「连续两次」）——一个月前收过同一段报错，
          // 今天再收不该多出一条，只把时间刷新并提到最前。
          const dup = store.items.find((it) => it.text === item.text)
          if (dup) {
            dup.at = item.at
            dup.type = item.type
            // ★ 去重命中后要把它挪到最前面：列表与「最近 XX」都靠 items[0]，
            //   不挪的话，刚收的那条会留在原位，面板显示的是别人的时间。
            const at0 = store.items.indexOf(dup)
            if (at0 > 0) { store.items.splice(at0, 1); store.items.unshift(dup) }
            if (!writeStore(store)) { sendJson(res, 500, { ok: false, error: 'write failed' }); return }
            sendJson(res, 200, { ok: true, item: dup, count: store.items.length, dedup: true })
            return
          }
          store.items.unshift(item) // 新的在前：便签是「刚收的最常用」
          while (store.items.length > MAX_ITEMS) store.items.pop()

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

        sendJson(res, 404, { ok: false, error: 'unknown endpoint' })
      } catch (e) {
        try { sendJson(res, 500, { ok: false, error: String((e && e.message) || e) }) } catch {}
      }
    },
  }))
}
