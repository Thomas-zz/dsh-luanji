/**
 * 给对话里 agent 的一只手：`luanji` 工具（记一条 / 找记录）。
 *
 * 只有一个工具、一条铁律：**用户没有明确要求时绝不调用**。
 * 记忆和知识库都是难题，乱记不假装自己解决了它们——它只是一个
 * 本机文本仓库：用户明确说「记」，就原话存进去；明确说「查」，就找出来。
 * 除此之外不参与 agent 的任何思考与工作流。
 *
 * @module dsh-luanji/host/tool
 */

/** 工具名。 */
export const TOOL_NAME = 'luanji'

/**
 * 面向聊天输出的本地时间（2026-11-05 14:32）。
 *
 * @param {number} ms - epoch 毫秒。
 * @returns {string} 格式化时间。
 */
function stamp(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 一条记录在工具结果里的样子（预览一行，不打分）。
 *
 * @param {object} record - 记录。
 * @returns {string} markdown 行。
 */
function line(record) {
  const preview = (record.text || record.quote?.text || '〔图片〕').replace(/\s+/g, ' ').slice(0, 80) + ((record.text || record.quote?.text || '').length > 80 ? '…' : '')
  const from = record.source === 'agent' ? ' · 来自对话' : ''
  return `- ${stamp(record.updated_at || record.created_at)}${from}：${preview}`
}

/**
 * 组装 luanji 工具定义。
 *
 * @param {object} store - 记录存储实例。
 * @param {object} intelligence - { search }。
 * @param {object} [hooks] - { onRecordChange }：记录变更时通知同步引擎。
 * @returns {object} `ctx.tools.register` 定义。
 */
export function createLuanjiTool(store, intelligence, hooks = {}) {
  return {
    name: TOOL_NAME,
    description: [
      '乱记：用户的个人本机笔记本（纯文本，存于 ~/.dsh/luanji，不联网）。',
      '【使用边界】只在用户明确提到要记录或查询笔记时才调用本工具，例如「记一下…」「帮我记到乱记」「这条存起来」「我记过什么…」「翻翻我的笔记」。用户没有明确要求时绝不调用：不要主动为对话做笔记、摘要、归档，不要把它当长期记忆自动写入，也不要在普通问答中检索它。',
      'add（记一条）：content 用用户的原话或用户指定的表述，保留原始措辞，不总结、不润色、不分条改写；确有必要时只在末尾加一行括号里的极简上下文（如（聊 dsh 插件时提到的））。记完一句话确认即可，不复述全文。',
      'find（找记录）：query 给用户记得的原话或大概意思（模糊匹配）；不给 query 返回最近的记录。找到后转述原文，找不到就直说，不要编。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'find'],
          description: 'add 记一条 · find 找记录',
        },
        content: {
          type: 'string',
          description: 'add 必填：要记录的原话（用户的措辞，不要加工）',
        },
        query: {
          type: 'string',
          description: 'find 可选：记得的原话或大概意思；留空返回最近的记录',
        },
        limit: {
          type: 'number',
          description: 'find 可选：最多返回几条（默认 8，最大 20）',
        },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string', description: 'markdown 结果说明' } },
        required: ['text'],
        additionalProperties: false,
      },
      /**
       * Render the result as one text block.
       *
       * @param {object} _args - tool arguments.
       * @param {{text: string}} value - tool output value.
       * @returns {Array<{type: 'text', text: string}>} content blocks.
       */
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    /**
     * @param {{action?: string, content?: string, query?: string, limit?: number}} args - model-supplied arguments.
     * @returns {Promise<{text: string}>} tool output value.
     */
    async execute(args) {
      try {
        const action = args?.action
        if (action === 'add') {
          const record = store.add({ text: args?.content ?? '', source: 'agent' })
          try { hooks.onRecordChange?.() } catch { /* 同步引擎不在也不影响记录 */ }
          return { text: `已记录（${stamp(record.created_at)}，共 ${store.count} 条）。` }
        }
        if (action === 'find') {
          const limit = Math.min(Math.max(Number(args?.limit) || 8, 1), 20)
          const query = String(args?.query ?? '').trim()
          const records = query
            ? intelligence.search(store.all(), query).map((hit) => hit.record)
            : store.all().slice(0, limit)
          if (!records.length) {
            return { text: query ? `没有找到相近的记录（找了「${query}」）。` : '笔记本还是空的。' }
          }
          const head = query ? `找到 ${Math.min(records.length, limit)} 条相近的记录：` : `最近的 ${Math.min(records.length, limit)} 条记录：`
          return { text: head + '\n' + records.slice(0, limit).map(line).join('\n') }
        }
        throw new Error('action 只能是 add 或 find。')
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
    },
  }
}
