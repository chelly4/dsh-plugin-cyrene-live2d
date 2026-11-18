/**
 * 世界书 · 翁法罗斯设定注入
 *
 * 数据来自 Cyrene-Agent（MIT，Copyright (c) 2026 Playa），经由
 * https://github.com/Cyrene-xl/DSH-Cyrene 的 worldbook/data 转手，
 * 条目格式（`- 触发词:` / `- 常驻:` / `- 优先级:`）沿用上游定义。
 * 详见同目录 worldbook/data 上层的 NOTICE。
 *
 * 这里只做三件事：解析 md、按关键词挑条目、拼成一段注入文本。
 * 不碰任何 DSH API —— 注入时机在 index.js 里，保持这一层可以单独测。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(HERE, 'worldbook', 'data')

/** 常驻块（每轮都注入）与命中块（按关键词）各自的字数上限，超了就按优先级截断。 */
const ALWAYS_MAX = 1800
const HIT_MAX = 3000
/** 参与匹配的最近对话文本上限，防止把整段历史当关键词池。 */
const HAY_MAX = 1500

const META = /^[-*]\s*(触发词|常驻|内在价值|优先级|连带触发词)\s*[:：]\s*(.*)$/

/** 拆关键词：英文逗号、中文逗号、顿号都算分隔符。 */
function splitKeywords(s) {
  return String(s || '')
    .split(/[,，、]/)
    .map((x) => x.trim())
    .filter((x) => x !== '' && x !== '无')
}

/**
 * 解析一份世界书 md。
 * 约定：`## 标题` 起一条；紧随其前的元数据行进字段，其余行进正文；
 * 单独的 `---` 只是分隔线，不进正文。
 */
export function parseEntries(text, file = '') {
  const out = []
  let cur = null
  const flush = () => {
    if (cur && cur.body.join('').trim() !== '') out.push(cur)
    cur = null
  }
  for (const raw of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (/^##\s+/.test(raw)) {
      flush()
      cur = {
        title: raw.replace(/^##\s+/, '').trim(),
        keywords: [],
        always: false,
        priority: 0,
        value: 0,
        chain: [],
        body: [],
        file,
      }
      continue
    }
    if (cur === null) continue
    if (/^-{3,}\s*$/.test(raw)) continue
    const m = META.exec(raw)
    if (m) {
      const key = m[1]
      const val = m[2].trim()
      if (key === '触发词') cur.keywords = splitKeywords(val)
      else if (key === '常驻') cur.always = val === '是' || val === 'true' || val === 'yes'
      else if (key === '内在价值') cur.value = Number(val) || 0
      else if (key === '优先级') cur.priority = Number(val) || 0
      else if (key === '连带触发词') cur.chain = splitKeywords(val)
      continue
    }
    cur.body.push(raw)
  }
  flush()
  return out
}

/** 把整个 data 目录读成条目表。读不到就返回空数组 —— 世界书是可选增强，不该拖垮插件。 */
export function loadWorldbook(dir = DATA_DIR) {
  const all = []
  let files = []
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.md'))
  } catch {
    return { entries: [], files: [] }
  }
  // _glossary 排前面：称谓类条目优先级最高，截断时不该被后读的文件挤掉。
  files.sort((a, b) => {
    const ga = a.startsWith('_') ? 0 : 1
    const gb = b.startsWith('_') ? 0 : 1
    return ga - gb || a.localeCompare(b)
  })
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const e of parseEntries(text, f)) all.push(e)
    } catch {
      // 单份文件坏掉不影响其他
    }
  }
  return { entries: all, files }
}

/**
 * 数据目录的指纹（文件名 + 大小 + mtime）。
 * 用来判断「条目是不是被改过」—— 改了就重读，不必重启 DSH。
 */
export function dataStamp(dir = DATA_DIR) {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort()
    let out = ''
    for (const f of files) {
      const st = fs.statSync(path.join(dir, f))
      out += `${f}:${st.size}:${Math.floor(st.mtimeMs)};`
    }
    return out
  } catch {
    return ''
  }
}

/**
 * 挑条目并渲染。
 * @param {object[]} entries loadWorldbook().entries
 * @param {string} haystack 最近的对话文本（用户 + 助手都算，命中更稳）
 */
export function renderSection(entries, haystack) {
  if (!Array.isArray(entries) || entries.length === 0) return ''
  const hay = String(haystack || '').slice(-HAY_MAX).toLowerCase()

  const always = []
  const hits = []
  for (const e of entries) {
    if (e.always) {
      always.push(e)
      continue
    }
    if (hay === '') continue
    const kws = e.keywords.concat(e.chain)
    for (const k of kws) {
      if (k !== '' && hay.includes(k.toLowerCase())) {
        hits.push(e)
        break
      }
    }
  }

  // 同一条目可能被多个文件重复定义，按标题去重。
  const seen = new Set()
  const uniq = (arr) =>
    arr
      .filter((e) => {
        const key = e.title
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      .sort((a, b) => b.priority - a.priority || b.value - a.value)

  const picked = []
  let used = 0
  const take = (arr, cap) => {
    for (const e of arr) {
      const block = `## ${e.title}\n${e.body.join('\n').trim()}`
      if (used + block.length > cap) continue
      used += block.length + 2
      picked.push(block)
    }
  }
  take(uniq(always), ALWAYS_MAX)
  take(uniq(hits), ALWAYS_MAX + HIT_MAX)

  if (picked.length === 0) return ''

  const head = [
    '【翁法罗斯设定 · 世界书】',
    '以下是与当前对话相关的设定条目，供你回答时依据。用你自己的话说出来，',
    '不要整段照抄，也不要提「世界书」「条目」「资料」这些词；',
    '没有条目覆盖的内容，仍然按「不确定就说不确定」处理，不要现编。',
    '',
  ].join('\n')
  return head + picked.join('\n\n')
}
