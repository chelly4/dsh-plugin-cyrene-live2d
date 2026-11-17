/**
 * 余额观测账本 —— 余额是采样，不是流水。
 *
 * 为什么不能只靠 token 估算：估算要猜「命中还是未命中缓存」、要猜「现在算不算高峰」，
 * 任何一处猜错就会长期偏。余额差值不用猜，代价是「只有界面开着的时候才在观测」——
 * 所以这里把观测缺口也一并记下来，界面上明说是部分数据，而不是装作完整。
 *
 * 金额一律折算成 1e-8 的整数再算：0.1 + 0.2 这种浮点尾巴跑一整天会露出来。
 *
 * 记账本的划分：账户 / 密钥换了就是另一本账（scope 不同）。换 key 之后旧账还在，
 * 只是「今日已用」看的是当前这本 —— 把不同账户的余额基线混在一起是错的。
 */

export const LEDGER_VERSION = 2

const SCALE = 100000000 // 1e8：一亿分之一元
/** 一个自然日的观测缺口超过这么久，就当这天是「部分数据」。 */
const PARTIAL_GAP_MS = 10 * 60 * 1000
/** 保留多少天的明细。 */
const KEEP_DAYS = 60

/** 元 → 整数单位。非法值返回 null（由调用方决定怎么处理）。 */
export function moneyUnits(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  const u = Math.round(n * SCALE)
  return Number.isSafeInteger(u) ? u : null
}

/** 整数单位 → 元。 */
export function preciseMoney(u) {
  return (Number(u) || 0) / SCALE
}

/** 北京时间的日期串（和系统时区无关）。 */
export function beijingDay(ts = Date.now()) {
  const n = Number(ts)
  const d = new Date((Number.isFinite(n) ? n : Date.now()) + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10)
}

export function emptyLedger() {
  return { version: LEDGER_VERSION, active: '', books: {}, date: '' }
}

/** 读回来的东西先过一遍：版本不符的一律当空账本，别拿旧结构硬算。 */
export function normalizeLedger(raw) {
  if (!raw || typeof raw !== 'object') return emptyLedger()
  if (raw.version !== LEDGER_VERSION) return emptyLedger()
  if (!raw.books || typeof raw.books !== 'object') return emptyLedger()
  return raw
}

function pruneDay(book) {
  try {
    const days = Object.keys(book.days || {}).sort()
    while (days.length > KEEP_DAYS) {
      const d = days.shift()
      delete book.days[d]
    }
  } catch {}
}

/**
 * 记一次余额观测。同一毫秒或更早的样本直接丢掉（重复轮询、乱序到达都算）。
 * 余额比上次高 → 记为「到账」（充值/赠金），不是负消费。
 */
export function observeBalance(ledger, snapshot) {
  const at = Number(snapshot && snapshot.at) || Date.now()
  const units = moneyUnits(snapshot && snapshot.balance)
  if (units === null) return null
  const currency = String((snapshot && snapshot.currency) || 'CNY').toUpperCase().slice(0, 8)
  const scope = String((snapshot && snapshot.scope) || 'default').slice(0, 60)
  const key = scope + '-' + currency
  const books = ledger.books || (ledger.books = {})
  let book = books[key]
  if (!book) book = books[key] = { currency, days: {}, lastAt: 0, lastUnits: units }

  // 重复 / 乱序样本：不动账，只把当前这天的汇总照样返回
  if (at <= (Number(book.lastAt) || 0)) {
    return summaryOf(ledger, key, beijingDay(book.lastAt || at))
  }

  const day = beijingDay(at)
  const days = book.days || (book.days = {})
  let row = days[day]
  if (!row) {
    row = days[day] = {
      day,
      firstAt: at,
      lastAt: at,
      openingUnits: units,
      lastUnits: units,
      debitUnits: 0,
      creditUnits: 0,
      samples: 0,
    }
  } else {
    const delta = Number(row.lastUnits) - units
    if (delta > 0) row.debitUnits += delta
    else if (delta < 0) row.creditUnits += -delta // 到账，不是负消费
    row.lastUnits = units
    row.lastAt = at
  }
  row.samples = (Number(row.samples) || 0) + 1
  book.lastAt = at
  book.lastUnits = units
  ledger.active = key
  ledger.date = day
  pruneDay(book)
  return summaryOf(ledger, key, day)
}

/** 某本账某一天的汇总。没有观测记录就返回 null。 */
export function summaryOf(ledger, key, day = beijingDay(), now = Date.now()) {
  const book = ledger.books && ledger.books[key]
  const row = book && book.days && book.days[day]
  if (!row) return null
  const start = Date.parse(day + 'T00:00:00+08:00')
  const end = start + 86400000
  const firstAt = Number(row.firstAt) || 0
  const lastAt = Number(row.lastAt) || 0
  const leadingGapMs = Number.isFinite(start) ? Math.max(0, firstAt - start) : PARTIAL_GAP_MS
  const trailingGapMs = Number.isFinite(start) && Number(now) >= end ? Math.max(0, end - lastAt) : 0
  // 缺口两头任一处超过 10 分钟：这天的数字只覆盖了中间那一段
  const partialDay = leadingGapMs > PARTIAL_GAP_MS || trailingGapMs > PARTIAL_GAP_MS
  const opened = Number(row.openingUnits) || 0
  const credits = Number(row.creditUnits) || 0
  const last = Number(row.lastUnits) || 0
  const spentUnits = Math.max(0, opened + credits - last)
  return {
    day,
    scope: key,
    currency: book.currency,
    spent: preciseMoney(spentUnits),
    partialDay,
    leadingGapMs,
    trailingGapMs,
    opening: preciseMoney(opened),
    current: preciseMoney(last),
    decrease: preciseMoney(Number(row.debitUnits) || 0),
    credits: preciseMoney(credits),
    samples: Number(row.samples) || 1,
    firstAt: firstAt || null,
    lastAt: lastAt || null,
  }
}

/** 当前活跃账本（最后一次观测的那本）。 */
export function activeScope(ledger) {
  return String(ledger.active || '')
}

/** 最近若干天的汇总（给界面看趋势用，目前只用在悬停提示里）。 */
export function recentDays(ledger, key, n = 7, now = Date.now()) {
  const book = ledger.books && ledger.books[key]
  if (!book || !book.days) return []
  return Object.keys(book.days)
    .sort()
    .slice(-n)
    .map((d) => summaryOf(ledger, key, d, now))
    .filter(Boolean)
}
