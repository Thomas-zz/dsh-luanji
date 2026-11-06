/**
 * 乱记的本机理解：找一下 & 翻一翻。
 *
 * 从乱记 Web 版 assets/ai.js 移植——算法一个字没改，只是换了个住处。
 * 没有网络客户端：找得到找不回，都只发生在本机。
 *
 * - 找一下：原话命中（子串）+ 意思挨得近（字/词 gram 余弦），轻度新近加成。
 * - 翻一翻：偏爱没翻过、放了些日子的旧纸，带一点随机，不显示任何分数。
 *
 * @module dsh-luanji/host/search
 */

const STOP_WORDS = {
  的: 1, 了: 1, 是: 1, 我: 1, 你: 1, 他: 1, 她: 1, 它: 1,
  和: 1, 与: 1, 在: 1, 有: 1, 就: 1, 也: 1, 不: 1, 都: 1,
  要: 1, 还: 1, 这: 1, 那: 1, 一个: 1, 一些: 1, 可能: 1,
  如果: 1, 因为: 1, 所以: 1, 但是: 1, 然后: 1, 自己: 1,
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp('[\\u0000-\\u001f]', 'g')
const PAIRED_PUNCT = new RegExp('[“”‘’「」『』【】（）()［］\\[\\]{}<>《》]', 'g')

function normalize(value) {
  return String(value || '')
    .toLowerCase()
    .replace(CONTROL_CHARS, ' ')
    .replace(PAIRED_PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function tokens(value) {
  const text = normalize(value)
  if (!text) return []
  const out = []
  const words = text.match(/[a-z0-9_]+|[\u3400-\u9fff]/g) || []
  for (const word of words) {
    if (STOP_WORDS[word]) continue
    out.push(word)
  }
  return out
}

function grams(value) {
  const text = normalize(value).replace(/\s/g, '')
  const result = {}
  if (!text) return result
  for (let i = 0; i < text.length; i++) {
    const one = text.slice(i, i + 1)
    result[one] = (result[one] || 0) + 0.35
    if (i < text.length - 1) {
      const two = text.slice(i, i + 2)
      result[two] = (result[two] || 0) + 1
    }
  }
  for (const token of tokens(value)) {
    result['w:' + token] = (result['w:' + token] || 0) + 2
  }
  return result
}

function cosine(a, b) {
  let dot = 0
  let aa = 0
  let bb = 0
  for (const k in a) {
    aa += a[k] * a[k]
    if (b[k]) dot += a[k] * b[k]
  }
  for (const k in b) bb += b[k] * b[k]
  if (!aa || !bb) return 0
  return dot / Math.sqrt(aa * bb)
}

/**
 * 找一下：只记得大概意思也能挨回来。
 *
 * @param {object[]} records - 全量记录。
 * @param {string} query - 用户记得的话或大概意思。
 * @returns {{record: object, score: number, exact: boolean}[]} 命中的纸，按分数排。
 */
export function search(records, query) {
  const q = normalize(query)
  if (!q) return []
  const qTokens = tokens(q)
  const qGrams = grams(q)
  const qLower = q.toLowerCase()

  return records
    .map((record) => {
      const text = normalize([record.text, record.quote?.text, record.quote?.origin?.model, record.quote?.origin?.sessionTitle].filter(Boolean).join(' '))
      let score = cosine(qGrams, grams(text)) * 56
      const exactIndex = text.indexOf(qLower)
      const exact = exactIndex >= 0
      if (exact) score += 52 - Math.min(exactIndex / 20, 16)

      let matched = 0
      for (const token of qTokens) {
        if (text.indexOf(token) >= 0) matched++
      }
      if (matched) score += (matched / Math.max(qTokens.length, 1)) * 28

      const ageDays = Math.max(0, (Date.now() - (record.updated_at || record.created_at)) / 86400000)
      score += Math.max(0, 7 - ageDays / 45)
      return { record, score, exact }
    })
    .filter((item) => item.score > 8)
    .sort((a, b) => b.score - a.score)
    .slice(0, 60)
}

/**
 * 翻一翻：挑一张值得重逢的旧纸。
 * 偏爱没翻过、放了些日子的纸；今天的纸略受冷落；刚翻过的先让开。
 *
 * @param {object[]} records - 全量记录。
 * @param {object} [options]
 * @param {string[]} [options.excludeIds] - 这次翻一翻不想再遇到的纸。
 * @returns {object|null} 一张纸，纸摞空时返回 null。
 */
export function pickForFlip(records, options = {}) {
  const exclude = new Set(options.excludeIds || [])
  if (!records.length) return null

  const ranked = records
    .map((record) => {
      const ageDays = Math.max(0, (Date.now() - (record.updated_at || record.created_at)) / 86400000)
      const ageScore = Math.min(ageDays / 45, 1.4)
      const variety = ((record.text.length % 17) / 17) * 0.15
      const recentPenalty = ageDays < 1 ? -0.7 : 0
      const excludedPenalty = exclude.has(record.id) ? -2.5 : 0
      return {
        record,
        score: ageScore + variety + recentPenalty + excludedPenalty + Math.random() * 0.55,
      }
    })
    .sort((a, b) => b.score - a.score)
  return ranked[0].record
}
