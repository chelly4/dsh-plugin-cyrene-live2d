/**
 * 小昔涟 · 共享的「只接受本地同源请求」护栏（2026-11-18，2026-11-19 抽出纯函数）
 *
 * 为什么需要：`readBody` 不看 Content-Type，而 `text/plain` 属于 CORS
 * 简单请求、不触发预检 —— 于是**任意网页**都能 POST 到
 * `127.0.0.1:<端口>/api/*`。主插件有这条检查，两个副插件（提醒/便签）
 * 原来没有：恶意网页可以往提醒里塞一条「到点念出来」的条目，或污染便签。
 *
 * 2026-11-19 补漏：米游社子系统的 9 条路由注册在 `ctx.connection.fetch`
 * 上（路径 `/api/mys/*`，独立 HTTP 入口），**不经过主插件的 `req/res`**，
 * 所以只吃本文件原来的 `guardLocalRequest` 完全挡不住。
 * 改法：把判断抽成与传输层无关的纯函数 `checkLocalHeaders(host, origin)`，
 * 两套入口各自取自己的 header 调它 —— 一套实现，两个调用点。
 *
 * 两层判断（和主插件原实现一致）：
 *   1) Host 白名单：只接受 localhost / 127.0.0.1 / [::1]
 *      —— 挡 DNS 重绑定（evil.com 解析到 127.0.0.1 后，Origin 与 Host
 *      都是 evil.com，只比「同源」会放行）。
 *   2) Origin 存在时，其 hostname 必须与请求 Host 一致（忽略端口，
 *      localhost 与 127.0.0.1 视为同一个）。
 *
 * 不强制要求 Origin 存在：某些客户端/脚本不发 Origin，只拦明确不匹配的。
 */

function isLocalHost(hostHeader) {
  const hostNoPort = String(hostHeader || '').replace(/:\d+$/, '')
  return /^(localhost|127\.0\.0\.1|\[::1\])$/.test(hostNoPort)
}

function normalizeHost(h) {
  return h === 'localhost' ? '127.0.0.1' : h
}

/**
 * 传输层无关的判定：给一对 header 值，回 { ok, error }。
 * Node 的 `IncomingMessage` 和 Web 标准的 `Request` 都能喂进来。
 *
 * @param {string|undefined} hostHeader   `req.headers.host`
 * @param {string|undefined} originHeader `req.headers.origin`
 * @returns {{ok: boolean, error?: string}}
 */
export function checkLocalHeaders(hostHeader, originHeader) {
  const hostNoPort = String(hostHeader || '').replace(/:\d+$/, '')
  if (!isLocalHost(hostHeader)) {
    return { ok: false, error: 'forbidden: non-local host' }
  }
  if (originHeader) {
    let orgHost = ''
    try { orgHost = new URL(originHeader).hostname } catch {}
    if (normalizeHost(orgHost) !== normalizeHost(hostNoPort)) {
      return { ok: false, error: 'forbidden: bad origin' }
    }
  }
  return { ok: true }
}

/**
 * 通过返回 true；否则回 403 JSON 并返回 false。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(res:any, code:number, body:any)=>void} sendJson
 */
export function guardLocalRequest(req, res, sendJson) {
  try {
    const verdict = checkLocalHeaders(req.headers.host, req.headers.origin)
    if (!verdict.ok) {
      sendJson(res, 403, { ok: false, error: verdict.error })
      return false
    }
  } catch {}
  return true
}
