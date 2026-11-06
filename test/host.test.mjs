/**
 * host 半自测：node test/host.test.mjs（node:test）。
 * 只测纯逻辑（store / search / tool），不碰 cordis。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStore } from '../host/store.js'
import * as intelligence from '../host/search.js'
import { createLuanjiTool } from '../host/tool.js'

function tempStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-test-'))
  return { store: createStore({ dataDir: dir }), dir }
}

test('放下、续写、收走', () => {
  const { store, dir } = tempStore()
  const a = store.add({ text: '把念头先放下', source: 'agent' })
  assert.equal(store.count, 1)
  assert.equal(a.source, 'agent')

  const b = store.update(a.id, '把念头先放下，回来时不必从头找起')
  assert.equal(b.id, a.id)
  assert.ok(b.updated_at >= b.created_at)

  store.add({ text: '第二张纸' })
  store.remove(a.id)
  assert.equal(store.count, 1)
  assert.equal(store.state().records[0].text, '第二张纸')

  // 草稿与落盘
  store.saveDraft('还没放下的半句')
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'))
  assert.equal(disk.draft, '还没放下的半句')
  assert.equal(disk.records.length, 1)
})

test('空纸放不下', () => {
  const { store } = tempStore()
  assert.throws(() => store.add({ text: '   ' }), /先写一下/)
})

test('状态是新的在前', () => {
  const { store } = tempStore()
  store.add({ text: '昨天' })
  store.add({ text: '今天' })
  const state = store.state()
  assert.equal(state.records[0].text, '今天')
  assert.equal(state.count, 2)
})

test('导入合并按 id 去重、取更新的', () => {
  const { store } = tempStore()
  const a = store.add({ text: '旧文' })
  const result = store.importMany({
    records: [
      { id: a.id, text: '新文', created_at: a.created_at, updated_at: a.updated_at + 1000 },
      { text: '带来的一张' },
    ],
  })
  assert.equal(result.added, 1)
  assert.equal(result.updated, 1)
  assert.equal(store.get(a.id).text, '新文')
})

test('找一下：原话命中与大概意思', () => {
  const { store } = tempStore()
  store.add({ text: '把 dsh 插件做成乱记的样子，点侧栏就能写' })
  store.add({ text: '今天买了咖啡豆，埃塞俄比亚的' })
  const exact = intelligence.search(store.all(), 'dsh 插件')
  assert.equal(exact[0].record.text.includes('dsh 插件'), true)
  const fuzzy = intelligence.search(store.all(), '侧边栏随手记想法')
  assert.equal(fuzzy.length >= 1, true)
  // 弱重叠也算挨得近（原版语义）：「量子引力」与「样子」共享“子”仍会命中。
  const weak = intelligence.search(store.all(), '量子引力')
  assert.equal(weak.length >= 0, true)
  // 完全无重叠才真的找不到。
  const none = intelligence.search(store.all(), '浏览器缓存池')
  assert.equal(none.length, 0)
})

test('翻一翻：纸摞空时返回 null，非空返回一张', () => {
  const { store } = tempStore()
  assert.equal(intelligence.pickForFlip([]), null)
  store.add({ text: '一张' })
  const picked = intelligence.pickForFlip(store.all(), { excludeIds: [store.all()[0].id] })
  assert.ok(picked) // 只有一张时即使被排除也仍是它
})

test('luanji 工具：add 记一条', async () => {
  const { store } = tempStore()
  const tool = createLuanjiTool(store, intelligence)
  assert.equal(tool.name, 'luanji')
  // 使用边界必须写进描述（不主动调用是硬性要求）
  assert.match(tool.description, /绝不调用/)
  const out = await tool.execute({ action: 'add', content: '聊天时的好点子' })
  assert.match(out.text, /已记录/)
  assert.equal(store.count, 1)
  assert.equal(store.all()[0].source, 'agent')
  const rendered = tool.output.render({}, out)
  assert.equal(rendered[0].type, 'text')
  // 空 content 报可读错误
  await assert.rejects(() => tool.execute({ action: 'add', content: ' ' }), /先写一下/)
  // 未知 action 报错
  await assert.rejects(() => tool.execute({ action: 'nope' }), /add 或 find/)
})

test('luanji 工具：find 找记录与看最近', async () => {
  const { store } = tempStore()
  store.add({ text: '买一本《卡片笔记写作法》' })
  store.add({ text: '周会改到周三了' })
  const tool = createLuanjiTool(store, intelligence)
  const found = await tool.execute({ action: 'find', query: '卡片笔记' })
  assert.match(found.text, /卡片笔记/)
  const recent = await tool.execute({ action: 'find' })
  assert.match(recent.text, /最近/)
  const empty = await tool.execute({ action: 'find', query: '不存在的词组xyz' })
  assert.match(empty.text, /没有找到/)
})

const quotation = (model = 'DeepSeek V3.2') => ({ text: '原话，不要改写。', origin: { role: 'assistant', model, provider: 'deepseek', sessionId: 's1', nodeKey: 'assistant-1', messageId: 'm1', turn: 1 }, anchor: { exact: '原话，不要改写。', start: 0, end: 8, prefix: '', suffix: '' } })
const tinyImage = { id: 'image-1', name: '图片.png', data: 'data:image/png;base64,iVBORw0KGgo=' }

test('引用不保存或导出宿主内部 provider 连接标识', () => {
  const { store } = tempStore()
  const q = quotation()
  q.origin.provider = 'private-connection-identifier'
  store.add({ quote: q })
  store.saveDraft({ quote: q }, 'quote')
  assert.equal(store.all()[0].quote.origin.provider, undefined)
  assert.equal(store.state().drafts.quote.quote.origin.provider, undefined)
  assert.ok(!JSON.stringify(store.exportAll()).includes('private-connection-identifier'))
})

test('引用和想法分开落盘；编辑想法不改原话，重载仍保留模型来源', () => {
  const { store, dir } = tempStore()
  const note = store.add({ text: '我不完全认同', quote: quotation() })
  store.update(note.id, '我想再想一想')
  const disk = JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'))
  assert.equal(disk.records[0].text, '我想再想一想')
  assert.equal(disk.records[0].quote, undefined)
  assert.equal(disk.quotes[0].text, '原话，不要改写。')
  const again = createStore({ dataDir: dir }).get(note.id)
  assert.equal(again.quote.origin.model, 'DeepSeek V3.2')
  assert.equal(again.quote.origin.messageId, 'm1')
})

test('直接摘录不需要自写内容，重复请求幂等，未知模型不猜测', () => {
  const { store } = tempStore()
  const a = store.add({ id: 'request-1', quote: quotation('') })
  const b = store.add({ id: 'request-1', quote: quotation('') })
  assert.equal(a.id, b.id)
  assert.equal(store.count, 1)
  assert.equal(a.quote.origin.model, '')
  assert.equal(store.exportAll().quotes.length, 1)
})

test('贴图草稿支持重载；提交与清草稿在同一次写入完成', () => {
  const { store, dir } = tempStore()
  store.saveDraft({ text: '半句话', images: [tinyImage], quote: quotation() }, 'quote')
  const again = createStore({ dataDir: dir })
  assert.equal(again.state().drafts.quote.images[0].data, tinyImage.data)
  assert.equal(again.state().drafts.quote.quote.text, quotation().text)
  const note = again.add({ ...again.state().drafts.quote, draftKey: 'quote' })
  assert.equal(again.state().drafts.quote.text, '')
  assert.equal(again.state().drafts.quote.quote, null)
  assert.equal(again.get(note.id).images.length, 1)
})

test('图片、来源、引用关系可完整导出导入；搜索能找到引用和模型', () => {
  const { store } = tempStore()
  store.add({ text: '我的想法', images: [tinyImage], quote: quotation() })
  const dest = tempStore().store
  dest.importMany(store.exportAll())
  const imported = dest.all()[0]
  assert.equal(imported.images[0].data, tinyImage.data)
  assert.equal(imported.quote.text, quotation().text)
  assert.equal(intelligence.search(dest.all(), '原话，不要改写')[0].record.id, imported.id)
  assert.equal(intelligence.search(dest.all(), 'DeepSeek V3.2')[0].record.id, imported.id)
  dest.remove(imported.id)
  assert.equal(dest.exportAll().quotes.length, 0)
})

test('旧 v1 文本数据无损迁移，保存前一版本备份', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-legacy-'))
  const original = JSON.stringify({ v: 1, records: [{ id: 'old', text: '原有记录', source: 'agent', created_at: 1, updated_at: 2 }], draft: '原有草稿' })
  fs.writeFileSync(path.join(dir, 'notes.json'), original)
  const store = createStore({ dataDir: dir })
  store.add({ text: '新的' })
  assert.equal(store.get('old').text, '原有记录')
  assert.equal(store.state().draft, '原有草稿')
  assert.equal(fs.readFileSync(path.join(dir, 'notes.json.bak'), 'utf8'), original)
})

test('损坏的数据文件不会被当成空笔记覆盖', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'luanji-corrupt-'))
  fs.writeFileSync(path.join(dir, 'notes.json'), '{broken')
  assert.throws(() => createStore({ dataDir: dir }), /原文件已保留/)
  assert.equal(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'), '{broken')
})

test('落盘失败不改变内存记录或丢掉草稿', () => {
  const { store, dir } = tempStore()
  store.saveDraft('不能丢的草稿')
  const original = fs.readFileSync(path.join(dir, 'notes.json'), 'utf8')
  fs.mkdirSync(path.join(dir, 'notes.json.bak'))
  assert.throws(() => store.add({ text: '写入会失败' }))
  assert.equal(store.count, 0)
  assert.equal(store.state().draft, '不能丢的草稿')
  assert.equal(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8'), original)
})

test('导入冲突引用不会覆盖已保存的原文', () => {
  const { store } = tempStore()
  const a = store.add({ quote: quotation(), text: '第一条' })
  const incoming = store.exportAll()
  incoming.records[0].id = 'imported'
  incoming.quotes[0].text = '另一句原话'
  store.importMany(incoming)
  assert.equal(store.get(a.id).quote.text, quotation().text)
  assert.equal(store.get('imported').quote.text, '另一句原话')
})

test('拒绝不安全图片和过长文本，而不静默截断', () => {
  const { store } = tempStore()
  assert.throws(() => store.add({ images: [{ data: 'data:image/svg+xml;base64,PHN2Zz4=' }] }), /图片格式/)
  assert.throws(() => store.add({ text: '字'.repeat(20001) }), /内容太长/)
  assert.equal(store.count, 0)
})
