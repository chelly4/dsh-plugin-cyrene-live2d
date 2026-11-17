/**
 * 语音边缘处理：裁掉句首的那口气、句尾的静音，两端各加一小段淡入淡出。
 *
 * 为什么需要它：
 *   参考音本身带着起音的气声时，合成结果会在每句开头多出半拍鼻音，
 *   ASR 会把它听成「啊 / 哎 / 嗯」；句尾又会拖 140–330ms 的死静音。
 *   这两件事都跟模型无关，纯粹是生成的边缘没收拾干净。
 *
 * 只处理 16-bit PCM 的单/多声道 WAV；其它格式原样返回，不改一个字。
 */

const DEFAULTS = {
  headPadMs: 40, // 第一个有声点之前保留多少
  headFadeMs: 20, // 开头淡入
  tailPadMs: 80, // 最后一个有声点之后保留多少
  tailFadeMs: 40, // 结尾淡出
  // 有声判定：相对满量程的比例。0.02 够切掉起音那口气，又不会把软辅音当成静音。
  threshold: 0.02,
  // 兜底：无论判定成什么样，开头最多只砍 120ms、结尾最多砍 400ms。
  // 没有这条，遇到「秋」这种轻声起头的句子会一口气砍掉半句（实测砍过 1.05 秒）。
  maxHeadTrimMs: 120,
  maxTailTrimMs: 400,
}

// 合并选项时把 undefined / null 跳过。
// 踩过的坑：宿主传的是 `Number(conf.head_pad_ms) || undefined`，配置里没写的项
// 会变成显式的 undefined，Object.assign 一盖就把默认值冲成 undefined ——
// 于是 Math.round(rate * undefined) = NaN，整个函数静默变成 no-op。
function withDefaults(def, opts) {
  const o = Object.assign({}, def)
  if (opts && typeof opts === 'object') {
    for (const k of Object.keys(opts)) {
      const v = opts[k]
      if (v !== undefined && v !== null && !(typeof v === 'number' && Number.isNaN(v))) o[k] = v
    }
  }
  return o
}

function findChunks(buf) {
  if (buf.length < 64) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let off = 12
  let fmt = null
  let dataOff = -1
  let dataSize = 0
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(off + 8),
        channels: buf.readUInt16LE(off + 10),
        rate: buf.readUInt32LE(off + 12),
        bits: buf.readUInt16LE(off + 22),
      }
    } else if (id === 'data') {
      dataOff = off + 8
      dataSize = Math.min(size, buf.length - dataOff)
      break
    }
    off += 8 + size + (size & 1)
  }
  if (!fmt || dataOff < 0) return null
  return { fmt, dataOff, dataSize }
}

export default function trimWav(buf, opts) {
  try {
    const o = withDefaults(DEFAULTS, opts)
    const info = findChunks(buf)
    if (!info) return buf
    const { fmt, dataOff, dataSize } = info
    if (fmt.format !== 1 || fmt.bits !== 16 || !fmt.rate) return buf

    const ch = Math.max(1, fmt.channels)
    const total = Math.floor(dataSize / 2 / ch)
    if (total < 8) return buf

    const pcm = new Int16Array(total * ch)
    for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(dataOff + i * 2)

    const thr = Math.max(80, Math.round(o.threshold * 32767))
    let first = -1
    let last = -1
    for (let i = 0; i < total; i++) {
      let peak = 0
      for (let c = 0; c < ch; c++) {
        const v = Math.abs(pcm[i * ch + c])
        if (v > peak) peak = v
      }
      if (peak >= thr) {
        if (first < 0) first = i
        last = i
      }
    }
    if (first < 0 || last <= first) return buf

    const perMs = fmt.rate / 1000
    const maxHead = Math.round(perMs * o.maxHeadTrimMs)
    const maxTail = Math.round(perMs * o.maxTailTrimMs)
    const start = Math.max(Math.max(0, first - Math.round(perMs * o.headPadMs)), first - maxHead)
    const end = Math.min(Math.min(total, last + Math.round(perMs * o.tailPadMs)), last + maxTail)
    if (end <= start) return buf

    // 整段都没被裁就不动它（避免每句都重建缓冲）
    const trimmedHead = start > 0
    const trimmedTail = end < total
    const outFrames = end - start
    const fadeIn = trimmedHead ? Math.min(Math.round(perMs * o.headFadeMs), outFrames) : 0
    const fadeOut = trimmedTail ? Math.min(Math.round(perMs * o.tailFadeMs), outFrames) : 0

    const payload = Buffer.alloc(outFrames * ch * 2)
    for (let i = 0; i < outFrames; i++) {
      let g = 1
      if (fadeIn && i < fadeIn) g = i / fadeIn
      if (fadeOut && i >= outFrames - fadeOut) g = Math.min(g, (outFrames - i - 1) / fadeOut)
      for (let c = 0; c < ch; c++) {
        payload.writeInt16LE(Math.round(pcm[(start + i) * ch + c] * g), (i * ch + c) * 2)
      }
    }

    const header = Buffer.from(buf.subarray(0, dataOff))
    header.writeUInt32LE(payload.length, dataOff - 4)
    header.writeUInt32LE(header.length + payload.length - 8, 4)
    return Buffer.concat([header, payload])
  } catch {
    return buf
  }
}

// ─────────────────── 句中的空当 ───────────────────
// cut5 分句之后，段与段之间会夹进 0.7–1.1 秒的纯静音：一句七个字能拖到 4.9 秒，
// 听感像她在每句话中间发呆。那些空当实测峰值只有 -46 dBFS、RMS -72 dB，
// 是真静音，不是压低的软辅音 —— 所以可以放心压短。
// 只压「被语音包住的」静音；首尾静音归 trimWav 管，这里一律不碰。
const SQ_DEFAULTS = {
  maxGapMs: 260, // 长过这个的句中静音才处理
  keepMs: 110, // 压到这个长度（左右各留一半）
  threshold: 0.006, // 静音判定（相对满量程）
  winMs: 10, // 判定窗
}

export function squeezeWav(buf, opts) {
  try {
    const o = withDefaults(SQ_DEFAULTS, opts)
    const info = findChunks(buf)
    if (!info) return buf
    const { fmt, dataOff, dataSize } = info
    if (fmt.format !== 1 || fmt.bits !== 16 || !fmt.rate) return buf

    const ch = Math.max(1, fmt.channels)
    const total = Math.floor(dataSize / 2 / ch)
    if (total < 8) return buf

    const pcm = new Int16Array(total * ch)
    for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(dataOff + i * 2)

    const thr = Math.max(60, Math.round(o.threshold * 32767))
    const win = Math.max(1, Math.round((fmt.rate * o.winMs) / 1000))
    const nWin = Math.floor(total / win)
    if (nWin < 4) return buf

    const silent = new Uint8Array(nWin)
    for (let w = 0; w < nWin; w++) {
      let peak = 0
      for (let i = w * win; i < (w + 1) * win; i++) {
        for (let c = 0; c < ch; c++) {
          const v = pcm[i * ch + c]
          const a = v < 0 ? -v : v
          if (a > peak) peak = a
        }
        if (peak >= thr) break
      }
      silent[w] = peak < thr ? 1 : 0
    }

    // 连续静音段（按样本）
    const runs = []
    let s = -1
    for (let w = 0; w <= nWin; w++) {
      const q = w < nWin && silent[w]
      if (q && s < 0) s = w
      else if (!q && s >= 0) {
        runs.push([s * win, w * win])
        s = -1
      }
    }
    if (!runs.length) return buf

    let firstVoice = 0
    while (firstVoice < nWin && silent[firstVoice]) firstVoice++
    let lastVoice = nWin - 1
    while (lastVoice > 0 && silent[lastVoice]) lastVoice--
    if (lastVoice <= firstVoice) return buf

    const keep = Math.round((fmt.rate * o.keepMs) / 1000)
    const maxGap = Math.round((fmt.rate * o.maxGapMs) / 1000)
    const cuts = []
    for (const [a, b] of runs) {
      if (b <= firstVoice * win || a >= lastVoice * win) continue // 首尾的不归它管
      const len = b - a
      if (len <= maxGap) continue
      // 删「空当开头」那一截，把靠后、紧挨着下一个字的 keepMs 留下。
      //
      // 这里踩过一个真 bug：原来写的是
      //   from = a + (len - keep) / 2; cuts.push([from, from + (len - keep)])
      // —— 想「留中间」，可删的区间从中间起算、长度又是 len - keep，
      // 终点等于 a + 1.5×(len-keep)，直接越过 b 伸进下一个字。
      // 实测 1200ms 的空当删了 1090ms，其中约 435ms 是下一个字的起音，
      // 听感就是「字被剪掉、字间抽一下」。keepMs 必须留在尾巴上。
      const cutEnd = a + (len - keep)
      if (cutEnd > b) continue // 兜底：任何情况下都不许删过 b
      cuts.push([a, cutEnd])
    }
    if (!cuts.length) return buf

    let frames = total
    for (const [a, b] of cuts) frames -= b - a
    if (frames < 8) return buf

    const payload = Buffer.alloc(frames * ch * 2)
    let src = 0
    let dst = 0
    for (const [a, b] of cuts) {
      const n = a - src
      for (let i = 0; i < n; i++) {
        for (let c = 0; c < ch; c++) payload.writeInt16LE(pcm[(src + i) * ch + c], (dst + i) * ch * 2 + c * 2)
      }
      dst += n
      src = b
    }
    for (let i = src; i < total; i++) {
      for (let c = 0; c < ch; c++) payload.writeInt16LE(pcm[i * ch + c], (dst + i - src) * ch * 2 + c * 2)
    }

    const header = Buffer.from(buf.subarray(0, dataOff))
    header.writeUInt32LE(payload.length, dataOff - 4)
    header.writeUInt32LE(header.length + payload.length - 8, 4)
    return Buffer.concat([header, payload])
  } catch {
    return buf
  }
}
