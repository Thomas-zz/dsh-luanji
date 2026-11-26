/**
 * 乱记手机网页：登录、查看、搜索、创建、编辑、图片、删除/恢复。
 *
 * 全部写操作走 /api/sync/v1/ops（会话 Cookie + CSRF 头），与桌面插件同一套
 * 版本（baseRev）与幂等（opId）规则：冲突不覆盖，失败不假装保存成功。
 */
(function () {
  'use strict'

  var csrf = null
  var records = []
  var total = 0
  var offset = 0
  var query = ''
  var editing = null          // 正在编辑的远端记录（null = 新建）
  var removed = null          // 刚删除的记录（供「撤销」恢复）
  var pendingImages = []      // 新贴的图 [{blob, hash, mime, size, name}]
  var keepAttachments = []    // 编辑时保留的既有附件
  var saving = false

  var $ = function (id) { return document.getElementById(id) }

  // ── 工具 ─────────────────────────────────────────────
  function toast(message, actionLabel, action) {
    var box = $('toast')
    box.innerHTML = ''
    box.appendChild(document.createTextNode(message))
    if (actionLabel) {
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = actionLabel
      btn.onclick = function () { hideToast(); action() }
      box.appendChild(btn)
    }
    box.hidden = false
    clearTimeout(toast.timer)
    toast.timer = setTimeout(hideToast, actionLabel ? 6000 : 3200)
  }
  function hideToast() { $('toast').hidden = true }

  function when(ms) {
    return new Date(ms).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  function uuid() { return crypto.randomUUID() }

  /** API 请求：同源 Cookie；写操作带 CSRF 头。 */
  function api(path, options) {
    options = options || {}
    var headers = options.headers || {}
    if (options.body && typeof options.body !== 'string') {
      options.body = JSON.stringify(options.body)
      headers['content-type'] = 'application/json'
    }
    if (options.method && options.method !== 'GET') headers['x-csrf-token'] = csrf
    headers['x-luanji-protocol'] = '1'
    options.headers = headers
    return fetch(path, options).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: '服务没有返回有效数据。' } }).then(function (data) {
        return { status: res.status, data: data }
      })
    })
  }

  // ── 登录 ─────────────────────────────────────────────
  function showLogin(message) {
    $('view-main').hidden = true
    $('view-editor').hidden = true
    $('view-login').hidden = false
    $('login-error').textContent = message || ''
    setTimeout(function () { $('login-password').focus() }, 50)
  }

  $('login-form').addEventListener('submit', function (event) {
    event.preventDefault()
    var button = $('login-submit')
    button.disabled = true
    api('/api/web/v1/login', { method: 'POST', body: { password: $('login-password').value } })
      .then(function (res) {
        if (res.status === 200 && res.data.ok) {
          csrf = res.data.csrf
          $('login-password').value = ''
          enterMain()
        } else {
          $('login-error').textContent = (res.data && res.data.error) || '登录失败。'
        }
      })
      .catch(function () { $('login-error').textContent = '网络错误，请稍后再试。' })
      .finally(function () { button.disabled = false })
  })

  $('logout').addEventListener('click', function () {
    api('/api/web/v1/logout', { method: 'POST' }).finally(function () {
      csrf = null
      records = []
      showLogin()
    })
  })

  function enterMain() {
    $('view-login').hidden = true
    $('view-editor').hidden = true
    $('view-main').hidden = false
    reload()
  }

  // ── 列表 ─────────────────────────────────────────────
  function reload(reset) {
    if (reset) { offset = 0; records = [] }
    var params = new URLSearchParams({ offset: String(offset), limit: '20' })
    if (query) params.set('q', query)
    return api('/api/web/v1/records?' + params).then(function (res) {
      if (res.status === 401) { showLogin(); return }
      if (!res.data.ok) throw new Error(res.data.error || '读取失败')
      total = res.data.total
      var fresh = res.data.records || []
      // 简单追加去重（搜索翻页时可能重叠）
      var seen = {}
      records.forEach(function (r) { seen[r.id] = true })
      records = records.concat(fresh.filter(function (r) { return !seen[r.id] }))
      offset = records.length
      renderList()
    }).catch(function (error) { toast(error.message || '读取失败') })
  }

  function renderList() {
    var list = $('list')
    list.innerHTML = ''
    records.forEach(function (record) { list.appendChild(card(record)) })
    $('count').textContent = total ? total + ' 条' : ''
    $('empty').hidden = records.length > 0
    $('more').hidden = records.length >= total
  }

  function card(record) {
    var node = document.createElement('article')
    node.className = 'card'
    if (record.quote) {
      var quote = document.createElement('div')
      quote.className = 'quote-box'
      var qtext = document.createElement('div')
      qtext.className = 'q-text'
      qtext.textContent = record.quote.text
      quote.appendChild(qtext)
      var qsrc = document.createElement('div')
      qsrc.className = 'q-src'
      var origin = record.quote.origin || {}
      qsrc.textContent = (origin.role === 'user' ? '我' : origin.role === 'assistant' ? 'AI · ' + (origin.model || '模型未知') : '摘录') + (origin.sessionTitle ? ' · ' + origin.sessionTitle : '')
      quote.appendChild(qsrc)
      node.appendChild(quote)
    }
    if (record.text) {
      var text = document.createElement('p')
      text.className = 'text'
      text.textContent = record.text
      node.appendChild(text)
    }
    if (record.attachments && record.attachments.length) {
      var imgs = document.createElement('div')
      imgs.className = 'imgs'
      record.attachments.forEach(function (attachment) {
        var img = document.createElement('img')
        img.src = '/api/sync/v1/blobs/' + attachment.hash
        img.alt = attachment.name || '图片'
        img.loading = 'lazy'
        imgs.appendChild(img)
      })
      node.appendChild(imgs)
    }
    var meta = document.createElement('div')
    meta.className = 'meta'
    var time = document.createElement('span')
    time.textContent = when(record.updated_at || record.created_at)
    meta.appendChild(time)
    var actions = document.createElement('div')
    actions.className = 'actions'
    var edit = document.createElement('button')
    edit.type = 'button'
    edit.textContent = '编辑'
    edit.onclick = function () { openEditor(record) }
    actions.appendChild(edit)
    var del = document.createElement('button')
    del.type = 'button'
    del.className = 'danger'
    del.textContent = '删除'
    del.onclick = function () { removeRecord(record) }
    actions.appendChild(del)
    meta.appendChild(actions)
    node.appendChild(meta)
    return node
  }

  $('more').addEventListener('click', function () { reload(false) })

  var searchTimer = null
  $('search').addEventListener('input', function (event) {
    query = event.target.value.trim()
    clearTimeout(searchTimer)
    searchTimer = setTimeout(function () { reload(true) }, 220)
  })

  // ── 图片：压缩 + 哈希 ────────────────────────────────
  var MAX_BLOB = 2097152 // 与服务端 limits.maxBlobBytes 一致

  function readImage(file) {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return Promise.reject(new Error('支持 PNG、JPEG、WebP 和 GIF。'))
    return file.arrayBuffer().then(function (buffer) {
      return createImageBitmap(new Blob([buffer], { type: file.type }))
    }).then(function (bitmap) {
      var scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
      var canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(bitmap.width * scale))
      canvas.height = Math.max(1, Math.round(bitmap.height * scale))
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height)
      bitmap.close()
      return compress(canvas, 0.82, 5).then(function (blob) {
        return { blob: blob, name: file.name || '图片', mime: blob.type }
      })
    })
  }

  /** 逐级降质直到满足单附件上限。 */
  function compress(canvas, quality, rounds) {
    return new Promise(function (resolve) {
      canvas.toBlob(function (blob) {
        if (!blob) return resolve(null)
        if (blob.size <= MAX_BLOB || rounds <= 0) return resolve(blob)
        compress(canvas, Math.max(0.4, quality - 0.12), rounds - 1).then(resolve)
      }, 'image/webp', quality)
    })
  }

  function sha256Hex(bytes) {
    return crypto.subtle.digest('SHA-256', bytes).then(function (digest) {
      return Array.from(new Uint8Array(digest)).map(function (b) { return b.toString(16).padStart(2, '0') }).join('')
    })
  }

  function renderEditorImages() {
    var box = $('editor-images')
    box.innerHTML = ''
    keepAttachments.forEach(function (attachment, index) {
      var wrap = document.createElement('div')
      wrap.className = 'thumb'
      var img = document.createElement('img')
      img.src = '/api/sync/v1/blobs/' + attachment.hash
      img.alt = attachment.name || '图片'
      var rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'rm'
      rm.textContent = '×'
      rm.setAttribute('aria-label', '移除图片')
      rm.onclick = function () { keepAttachments.splice(index, 1); renderEditorImages() }
      wrap.appendChild(img)
      wrap.appendChild(rm)
      box.appendChild(wrap)
    })
    pendingImages.forEach(function (image, index) {
      var wrap = document.createElement('div')
      wrap.className = 'thumb'
      var img = document.createElement('img')
      img.src = URL.createObjectURL(image.blob)
      img.alt = image.name
      var rm = document.createElement('button')
      rm.type = 'button'
      rm.className = 'rm'
      rm.textContent = '×'
      rm.setAttribute('aria-label', '移除图片')
      rm.onclick = function () { pendingImages.splice(index, 1); renderEditorImages() }
      wrap.appendChild(img)
      wrap.appendChild(rm)
      box.appendChild(wrap)
    })
  }

  function attach(files) {
    var list = Array.prototype.slice.call(files)
    if (!list.length) return
    if (keepAttachments.length + pendingImages.length + list.length > 6) { toast('一条记录最多 6 张图。'); return }
    $('editor-status').textContent = '处理图片…'
    Promise.all(list.map(readImage))
      .then(function (images) {
        return Promise.all(images.map(function (image) {
          return image.blob.arrayBuffer().then(function (buffer) {
            return sha256Hex(buffer).then(function (hash) {
              return { blob: image.blob, hash: hash, mime: image.mime, size: image.blob.size, name: image.name }
            })
          })
        }))
      })
      .then(function (prepared) {
        pendingImages = pendingImages.concat(prepared)
        $('editor-status').textContent = ''
        renderEditorImages()
      })
      .catch(function (error) {
        $('editor-status').textContent = ''
        toast(error.message || '图片处理失败')
      })
  }

  $('attach').addEventListener('click', function () { $('file').click() })
  $('file').addEventListener('change', function (event) {
    attach(event.target.files)
    event.target.value = ''
  })

  // ── 编辑器 ───────────────────────────────────────────
  function openEditor(record) {
    editing = record || null
    pendingImages = []
    keepAttachments = record ? (record.attachments || []).slice() : []
    $('editor-title').textContent = record ? '编辑' : '新建'
    $('editor-text').value = record ? record.text : ''
    var quoteBox = $('editor-quote')
    if (record && record.quote) {
      quoteBox.hidden = false
      quoteBox.textContent = record.quote.text + '\n— ' + ((record.quote.origin || {}).sessionTitle || (record.quote.origin || {}).model || '引用')
    } else {
      quoteBox.hidden = true
    }
    renderEditorImages()
    $('editor-status').textContent = ''
    $('view-main').hidden = true
    $('view-editor').hidden = false
    $('editor-text').focus()
  }

  $('new').addEventListener('click', function () { openEditor(null) })
  $('editor-cancel').addEventListener('click', function () {
    // 网络断开也不丢输入：取消前确认。
    var text = $('editor-text').value
    if ((text && text.trim()) || pendingImages.length) {
      if (!window.confirm('放弃这次编辑？')) return
    }
    $('view-editor').hidden = true
    $('view-main').hidden = false
  })

  $('editor-save').addEventListener('click', saveEditor)

  function uploadPendingImages() {
    var uploads = pendingImages.slice()
    return Promise.all(uploads.map(function (image) {
      return image.blob.arrayBuffer().then(function (buffer) {
        return fetch('/api/sync/v1/blobs/' + image.hash, {
          method: 'PUT',
          headers: { 'content-type': image.mime, 'x-csrf-token': csrf, 'x-luanji-protocol': '1' },
          body: new Uint8Array(buffer),
        }).then(function (res) { return res.json() })
      }).then(function (data) {
        if (!data.ok) throw new Error(data.error || '附件上传失败')
        return { id: uuid(), hash: image.hash, mime: image.mime, size: image.size, name: image.name }
      })
    }))
  }

  function saveEditor() {
    if (saving) return
    var text = $('editor-text').value.trim()
    if (!text && !pendingImages.length && !keepAttachments.length && !editing) { toast('先写点什么。'); return }
    saving = true
    $('editor-save').disabled = true
    $('editor-status').textContent = '保存中…'
    var opId = uuid()
    var recordId = editing ? editing.id : uuid()
    var now = Date.now()
    var record = {
      id: recordId,
      text: text,
      source: 'web',
      created_at: editing ? editing.created_at : now,
      updated_at: now,
      quote: editing ? editing.quote : null,
      deleted_at: null,
      attachments: [],
    }
    uploadPendingImages()
      .then(function (uploaded) {
        record.attachments = keepAttachments.concat(uploaded)
        return api('/api/sync/v1/ops', {
          method: 'POST',
          body: { opId: opId, recordId: recordId, baseRev: editing ? editing.rev : 0, kind: 'put', record: record },
        })
      })
      .then(function (res) {
        if (res.status === 401) { showLogin('登录已过期，请重新登录。'); return null }
        var data = res.data
        if (data.ok) return true
        if (data.code === 'REV_CONFLICT') {
          var remote = (data.remote || {}).record || {}
          var choice = window.confirm('这条记录在别处被改过（远端更新于 ' + when(remote.updated_at || now) + '）。\n\n确定 = 载入远端内容重新编辑；取消 = 保留我的输入稍后再试。')
          if (choice) {
            openEditor(Object.assign({}, remote, { rev: data.remote.rev }))
            toast('已载入远端最新内容')
          } else {
            $('editor-status').textContent = '未保存：内容与云端冲突，输入仍在这里'
          }
          return null
        }
        throw new Error(data.error || '保存失败')
      })
      .then(function (done) {
        if (done) {
          $('editor-text').value = ''
          pendingImages = []
          keepAttachments = []
          $('view-editor').hidden = true
          $('view-main').hidden = false
          toast('已保存')
          reload(true)
        }
      })
      .catch(function (error) {
        // 网络断开/失败：保留当前输入，明确告知未保存。
        $('editor-status').textContent = '未保存：' + (error.message || '网络错误')
        toast('没有保存成功，输入已保留')
      })
      .finally(function () {
        saving = false
        $('editor-save').disabled = false
        if (!$('editor-status').textContent.length) $('editor-status').textContent = ''
      })
  }

  // ── 删除 / 恢复 ──────────────────────────────────────
  function removeRecord(record) {
    if (!window.confirm('删除这条记录？')) return
    api('/api/sync/v1/ops', {
      method: 'POST',
      body: { opId: uuid(), recordId: record.id, baseRev: record.rev, kind: 'delete' },
    }).then(function (res) {
      if (res.status === 401) { showLogin('登录已过期，请重新登录。'); return }
      var data = res.data
      if (data.code === 'REV_CONFLICT') { toast('记录在别处被改过，稍后刷新再看。'); return reload(true) }
      if (!data.ok && data.code !== 'ALREADY_DELETED' && data.code !== 'NOT_FOUND') throw new Error(data.error || '删除失败')
      // 记住删除后的 rev 与原内容，供撤销（恢复 = 在墓碑之上重新 put）。
      var snapshot = { record: record, rev: data.ok ? data.rev : record.rev + 1 }
      removed = snapshot
      toast('已删除', '撤销', function () { undoRemove(snapshot) })
      reload(true)
    }).catch(function (error) { toast(error.message || '删除失败，请重试') })
  }

  function undoRemove(snapshot) {
    var record = snapshot.record
    api('/api/sync/v1/ops', {
      method: 'POST',
      body: {
        opId: uuid(), recordId: record.id, baseRev: snapshot.rev, kind: 'put',
        record: {
          id: record.id, text: record.text, source: record.source || 'web',
          created_at: record.created_at, updated_at: Date.now(), quote: record.quote || null,
          deleted_at: null, attachments: record.attachments || [],
        },
      },
    }).then(function (res) {
      if (res.status === 401) { showLogin('登录已过期，请重新登录。'); return }
      var data = res.data
      if (data.ok) { toast('已恢复'); reload(true) }
      else if (data.code === 'REV_CONFLICT') { toast('云端又有新变化，请刷新后重试。'); reload(true) }
      else throw new Error(data.error || '恢复失败')
    }).catch(function (error) { toast(error.message || '恢复失败') })
  }

  // ── 启动 ─────────────────────────────────────────────
  // 已有会话时先取回 CSRF 令牌（登录响应里的令牌在刷新后会丢失）
  api('/api/web/v1/session').then(function (res) {
    if (res.status === 200 && res.data.ok) {
      csrf = res.data.csrf
      enterMain()
    } else showLogin()
  }).catch(function () { showLogin('服务暂不可达，请检查网络。') })
})()
