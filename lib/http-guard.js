/**
 * 小昔涟 · 共享的「只接受本地同源请求」护栏（2026-11-18）
 *
 * 为什么需要：`readBody` 不看 Content-Type，而 `text/plain` 属于 CORS
 * 简单请求、不触发预检 —— 于是**任意网页**都能 POST 到
 * `127.0.0.1:<端口>/api/*`。主插件有这条检查，两个副插件（提醒/便签）
 * 原来没有：恶意网页可以往提醒里塞一条「到点念出来」的条目，或污染便签。
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
 * 通过返回 true；否则回 403 JSON 并返回 false。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(res:any, code:number, body:any)=>void} sendJson
 */
export function guardLocalRequest(req, res, sendJson) {
  try {
    const hostNoPort = String(req.headers.host || '').replace(/:\d+$/, '')
    if (!isLocalHost(req.headers.host)) {
      sendJson(res, 403, { ok: false, error: 'forbidden: non-local host' })
      return false
    }
    const org = req.headers.origin
    if (org) {
      let orgHost = ''
      try { orgHost = new URL(org).hostname } catch {}
      if (normalizeHost(orgHost) !== normalizeHost(hostNoPort)) {
        sendJson(res, 403, { ok: false, error: 'forbidden: bad origin' })
        return false
      }
    }
  } catch {}
  return true
}
