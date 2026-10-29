/**
 * 识屏助手 · 浏览器半边（无构建、普通脚本）
 *
 * 在 DSH Web 的 shell.overlay 槽里放一个悬浮按钮：截取当前屏幕 → 预览 →
 * 选模式分析（解题 / 操作 / 总结 / 提取 / 自由提问）→ 直接显示结果。
 *
 * 图片本身只在宿主内存里暂存，分析时由宿主交给当前模型。
 */
;(function () {
  'use strict'

  const ROUTE = '/dsh-screen-7421'
  const SHORTCUT_ID = 'screen-assistant.capture'
  const MODES = [
    ['solve', '解决问题'],
    ['operate', '教我操作'],
    ['summarize', '总结内容'],
    ['extract', '提取文字'],
    ['ask', '自由提问'],
  ]

  /** 快捷键（DSH 设置里可改）和悬浮面板之间的桥：命令只负责发事件，面板负责截屏。 */
  const shortcutBus = {
    listeners: new Set(),
    /** 宿主已经注册系统级热键时，窗口内命令让位，避免同一个键触发两次截屏。 */
    globalActive: false,
    emit() {
      for (const listener of [...this.listeners]) {
        try {
          listener()
        } catch (error) {
          console.error('[screen-assistant] shortcut handler failed', error)
        }
      }
    },
  }

  const CSS = `
.dsa-root, .dsa-root * { box-sizing: border-box; }
.dsa-root { font-family: "Segoe UI", "Microsoft YaHei", system-ui, sans-serif; pointer-events: none; }
.dsa-btn, .dsa-panel, .dsa-toast, .dsa-zoom { pointer-events: auto; }
.dsa-btn {
  position: fixed; right: 22px; bottom: 96px; z-index: 60;
  display: inline-flex; align-items: center; gap: 7px;
  height: 42px; padding: 0 16px; border: 0; border-radius: 21px;
  background: #4d6bfe; color: #fff; font-size: 14px; font-weight: 600;
  box-shadow: 0 8px 24px rgba(77, 107, 254, .35), 0 1px 2px rgba(0,0,0,.12);
  cursor: pointer; transition: transform .15s ease, box-shadow .15s ease;
}
.dsa-btn:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(77, 107, 254, .42); }
.dsa-btn:active { transform: translateY(0); }
.dsa-panel {
  position: fixed; right: 22px; bottom: 96px; z-index: 60;
  width: 420px; max-width: calc(100vw - 32px);
  max-height: min(730px, calc(100vh - 130px));
  display: flex; flex-direction: column; overflow: hidden;
  background: #fff; border: 1px solid #e5e7eb; border-radius: 16px;
  box-shadow: 0 24px 64px rgba(15, 23, 42, .22), 0 2px 8px rgba(15, 23, 42, .08);
  color: #111827;
}
.dsa-head {
  display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;
  padding: 14px 16px 12px; border-bottom: 1px solid #f1f2f4;
}
.dsa-title { font-size: 15px; font-weight: 700; line-height: 20px; }
.dsa-sub { margin-top: 2px; font-size: 11px; color: #9ca3af; line-height: 16px; }
.dsa-x {
  width: 26px; height: 26px; border: 0; border-radius: 8px; background: transparent;
  color: #6b7280; font-size: 18px; line-height: 1; cursor: pointer;
}
.dsa-x:hover { background: #f3f4f6; color: #111827; }
.dsa-body { padding: 14px 16px; overflow-y: auto; }
.dsa-hero { text-align: center; padding: 18px 8px 8px; }
.dsa-hero-icon {
  width: 52px; height: 52px; margin: 0 auto 12px; border-radius: 16px;
  display: flex; align-items: center; justify-content: center;
  background: #eef2ff; color: #4d6bfe;
}
.dsa-hero-title { font-size: 14px; font-weight: 700; }
.dsa-hero-text { margin: 6px auto 0; max-width: 300px; font-size: 12px; line-height: 1.7; color: #6b7280; }
.dsa-hotkey { margin-top: 9px; font-size: 11px; color: #9ca3af; }
.dsa-hotkey kbd {
  display: inline-block; padding: 1px 6px; margin-left: 4px;
  border: 1px solid #e5e7eb; border-bottom-width: 2px; border-radius: 5px;
  background: #f9fafb; color: #4b5563; font: inherit; font-size: 10.5px;
}
.dsa-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.dsa-label { font-size: 11px; color: #6b7280; }
.dsa-delay {
  border: 1px solid #e5e7eb; background: #f9fafb; color: #4b5563;
  height: 26px; padding: 0 9px; border-radius: 999px; font-size: 11px; cursor: pointer;
}
.dsa-delay.on { border-color: #4d6bfe; background: #eef2ff; color: #3b5bdb; font-weight: 600; }
.dsa-preview-wrap { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid #e5e7eb; background: #0f172a; }
.dsa-preview { display: block; width: 100%; max-height: 210px; object-fit: contain; cursor: zoom-in; }
.dsa-preview-bar {
  position: absolute; left: 8px; bottom: 8px; display: flex; gap: 6px;
}
.dsa-mini {
  height: 24px; padding: 0 9px; border: 0; border-radius: 6px;
  background: rgba(17, 24, 39, .72); color: #fff; font-size: 11px; cursor: pointer;
}
.dsa-mini:hover { background: rgba(17, 24, 39, .9); }
.dsa-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.dsa-chip {
  border: 1px solid #e5e7eb; background: #f9fafb; color: #4b5563;
  height: 30px; padding: 0 11px; border-radius: 999px; font-size: 12px; cursor: pointer;
}
.dsa-chip:hover { border-color: #c7d2fe; }
.dsa-chip.on { border-color: #4d6bfe; background: #eef2ff; color: #3b5bdb; font-weight: 600; }
.dsa-input {
  width: 100%; min-height: 54px; max-height: 120px; resize: vertical;
  border: 1px solid #e5e7eb; border-radius: 10px; padding: 9px 11px;
  font: inherit; font-size: 12px; line-height: 1.6; color: #111827; background: #fff;
}
.dsa-input:focus { outline: none; border-color: #4d6bfe; box-shadow: 0 0 0 3px rgba(77,107,254,.12); }
.dsa-primary {
  width: 100%; height: 40px; border: 0; border-radius: 10px;
  background: #4d6bfe; color: #fff; font-size: 13px; font-weight: 700; cursor: pointer;
}
.dsa-primary:hover:not(:disabled) { background: #3d5bf0; }
.dsa-primary:disabled { opacity: .55; cursor: default; }
.dsa-ghost {
  height: 34px; padding: 0 12px; border: 1px solid #e5e7eb; border-radius: 9px;
  background: #fff; color: #4b5563; font-size: 12px; cursor: pointer;
}
.dsa-ghost:hover { background: #f9fafb; }
.dsa-error {
  border: 1px solid #fecaca; background: #fef2f2; color: #b91c1c;
  border-radius: 9px; padding: 9px 11px; font-size: 12px; line-height: 1.6; white-space: pre-wrap;
}
.dsa-result {
  border: 1px solid #e5e7eb; background: #f8fafc; border-radius: 10px;
  padding: 12px; font-size: 13px; line-height: 1.7; white-space: pre-wrap;
  word-break: break-word; user-select: text;
}
.dsa-result-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
.dsa-meta { font-size: 11px; color: #9ca3af; }
.dsa-foot {
  padding: 9px 16px; border-top: 1px solid #f1f2f4; font-size: 10.5px;
  line-height: 1.5; color: #9ca3af; display: flex; justify-content: space-between; gap: 10px;
}
.dsa-toast {
  position: fixed; top: 22px; left: 50%; transform: translateX(-50%); z-index: 61;
  background: rgba(17, 24, 39, .92); color: #fff; font-size: 12px;
  padding: 9px 16px; border-radius: 999px; box-shadow: 0 8px 24px rgba(0,0,0,.2);
  pointer-events: none; white-space: nowrap;
}
.dsa-zoom {
  position: fixed; inset: 0; z-index: 62; background: rgba(2, 6, 23, .8);
  display: flex; align-items: center; justify-content: center; padding: 24px; cursor: zoom-out;
}
.dsa-zoom img { max-width: 96vw; max-height: 94vh; border-radius: 8px; box-shadow: 0 20px 60px rgba(0,0,0,.4); }
.dsa-spinner {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
  display: inline-block; vertical-align: -2px; margin-right: 7px;
  animation: dsa-spin .8s linear infinite;
}
@keyframes dsa-spin { to { transform: rotate(360deg); } }
@media (max-width: 560px) {
  .dsa-panel { right: 12px; bottom: 84px; width: calc(100vw - 24px); max-height: calc(100vh - 110px); }
  .dsa-btn { right: 12px; bottom: 84px; }
}
`

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  function errorText(error) {
    const message = error instanceof Error ? error.message : String(error)
    if (error instanceof TypeError && /fetch|network/i.test(message)) {
      return '无法连接识屏服务。插件可能还没加载好，或者 DSH 需要重启后才会生效。'
    }
    return message || '请求失败'
  }

  function ScreenAssistant(props) {
    const React = props.react
    const h = React.createElement
    const [open, setOpen] = React.useState(false)
    const [shot, setShot] = React.useState(null)
    const [mode, setMode] = React.useState('solve')
    const [question, setQuestion] = React.useState('')
    const [result, setResult] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [capturing, setCapturing] = React.useState(false)
    const [toast, setToast] = React.useState('')
    const [error, setError] = React.useState('')
    const [zoom, setZoom] = React.useState(false)
    const [delay, setDelay] = React.useState(3)
    const [hotkey, setHotkey] = React.useState(props.shortcut ? props.shortcut.getKeys() : '')
    const [globalState, setGlobalState] = React.useState({ active: false, keys: '', error: '' })
    const alive = React.useRef(true)
    const captureRef = React.useRef(null)

    React.useEffect(() => {
      alive.current = true
      return () => {
        alive.current = false
      }
    }, [])

    React.useEffect(() => {
      const trigger = () => {
        if (captureRef.current) captureRef.current()
      }
      shortcutBus.listeners.add(trigger)
      return () => shortcutBus.listeners.delete(trigger)
    }, [])

    React.useEffect(() => {
      if (!props.shortcut) return undefined
      const sync = () => setHotkey(props.shortcut.getKeys())
      sync()
      return props.shortcut.subscribe(sync)
    }, [])

    // 全局热键状态：宿主注册成功时显示系统级快捷键。
    React.useEffect(() => {
      let cancelled = false
      fetch(window.location.origin + ROUTE + '/status')
        .then((response) => response.json())
        .then((data) => {
          if (cancelled || !data || !data.ok || !data.global) return
          shortcutBus.globalActive = data.global.active === true
          setGlobalState(data.global)
        })
        .catch(() => {})
      return () => {
        cancelled = true
      }
    }, [])

    // 宿主在后台截屏/分析，通过 SSE 推给页面；DSH 不在前台也能收到。
    React.useEffect(() => {
      let source
      try {
        source = new EventSource(window.location.origin + ROUTE + '/events')
      } catch {
        return undefined
      }
      const parse = (event) => {
        try {
          return JSON.parse(event.data)
        } catch {
          return null
        }
      }
      const onState = (event) => {
        const data = parse(event)
        if (!data) return
        shortcutBus.globalActive = data.active === true
        setGlobalState(data)
      }
      const onCapture = (event) => {
        const data = parse(event)
        if (!data) return
        setShot(data)
        setOpen(true)
        setResult(null)
        setError('')
        setCapturing(false)
        setBusy(true)
      }
      const onStatus = (event) => {
        const data = parse(event)
        if (data && data.phase === 'analyzing') setBusy(true)
      }
      const onResult = (event) => {
        const data = parse(event)
        if (!data) return
        setBusy(false)
        setResult(data)
        setOpen(true)
      }
      const onFailure = (event) => {
        const data = parse(event)
        if (!data) return
        setBusy(false)
        setError(data.message || '全局识屏失败')
        setOpen(true)
      }
      source.addEventListener('state', onState)
      source.addEventListener('capture', onCapture)
      source.addEventListener('status', onStatus)
      source.addEventListener('result', onResult)
      source.addEventListener('failure', onFailure)
      return () => source.close()
    }, [])

    React.useEffect(() => {
      const onKey = (event) => {
        if (event.key !== 'Escape') return
        if (zoom) setZoom(false)
        else if (open) setOpen(false)
      }
      window.addEventListener('keydown', onKey)
      return () => window.removeEventListener('keydown', onKey)
    }, [zoom, open])

    async function post(path, body) {
      const response = await fetch(window.location.origin + ROUTE + '/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
      let data = null
      try {
        data = await response.json()
      } catch {
        // 下面统一按状态码报错。
      }
      if (!response.ok || !data || data.ok !== true) {
        const message = data && data.error && data.error.message ? data.error.message : `请求失败（HTTP ${response.status}）`
        throw new Error(message)
      }
      return data
    }

    async function capture() {
      if (capturing || busy) return
      setError('')
      setResult(null)
      setShot(null)
      setOpen(false)
      setCapturing(true)
      try {
        for (let seconds = delay; seconds > 0; seconds -= 1) {
          setToast(`${seconds} 秒后截取，请切换到目标窗口`)
          await sleep(1000)
        }
        setToast('正在截取屏幕…')
        await sleep(delay > 0 ? 260 : 200)
        const data = await post('capture')
        if (!alive.current) return
        setToast('')
        setShot(data)
        setOpen(true)
      } catch (error) {
        if (!alive.current) return
        setError(errorText(error))
        setOpen(true)
      } finally {
        if (alive.current) {
          setCapturing(false)
          setToast('')
        }
      }
    }

    // 快捷键通过 ref 拿到最新一次渲染的 capture，避免闭包里的 delay / busy 过期。
    captureRef.current = capture

    async function analyze() {
      if (!shot || busy) return
      setBusy(true)
      setError('')
      setResult(null)
      try {
        const data = await post('analyze', { id: shot.id, mode, question })
        if (!alive.current) return
        setResult(data)
      } catch (error) {
        if (alive.current) setError(errorText(error))
      } finally {
        if (alive.current) setBusy(false)
      }
    }

    async function copy() {
      if (!result) return
      try {
        await navigator.clipboard.writeText(result.text)
        setToast('已复制')
        setTimeout(() => {
          if (alive.current) setToast('')
        }, 1200)
      } catch {
        setToast('复制失败，请手动选中文本')
        setTimeout(() => {
          if (alive.current) setToast('')
        }, 1600)
      }
    }

    function reset() {
      setShot(null)
      setResult(null)
      setError('')
      setQuestion('')
    }

    const icon = h(
      'svg',
      { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.9, strokeLinecap: 'round' },
      h('circle', { cx: 12, cy: 12, r: 6.5 }),
      h('circle', { cx: 12, cy: 12, r: 1.6, fill: 'currentColor', stroke: 'none' }),
      h('path', { d: 'M12 2.5v3.2M12 18.3v3.2M2.5 12h3.2M18.3 12h3.2' }),
    )

    return h(
      React.Fragment,
      null,
      h('style', null, CSS),
      h(
        'div',
        { className: 'dsa-root' },
        capturing ? null : open
          ? h(
              'section',
              { className: 'dsa-panel', role: 'dialog', 'aria-label': '识屏助手' },
              h(
                'div',
                { className: 'dsa-head' },
                h(
                  'div',
                  null,
                  h('div', { className: 'dsa-title' }, '识屏助手'),
                  h('div', { className: 'dsa-sub' }, shot ? '看看这张截图，我能帮你做什么' : '截取当前屏幕，识别内容并给出答案'),
                ),
                h('button', { className: 'dsa-x', title: '关闭（Esc）', onClick: () => setOpen(false) }, '×'),
              ),
              h(
                'div',
                { className: 'dsa-body' },
                shot
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        { className: 'dsa-preview-wrap' },
                        h('img', {
                          className: 'dsa-preview',
                          src: shot.dataUrl,
                          alt: '当前屏幕截图',
                          onClick: () => setZoom(true),
                        }),
                        h(
                          'div',
                          { className: 'dsa-preview-bar' },
                          h('button', { className: 'dsa-mini', onClick: () => setZoom(true) }, '放大'),
                          h('button', { className: 'dsa-mini', onClick: reset }, '重新截取'),
                        ),
                      ),
                      h('div', { style: { height: 12 } }),
                      h('div', { className: 'dsa-label', style: { marginBottom: 6 } }, '想要什么结果？'),
                      h(
                        'div',
                        { className: 'dsa-chips' },
                        MODES.map(([value, label]) =>
                          h(
                            'button',
                            {
                              key: value,
                              className: 'dsa-chip' + (mode === value ? ' on' : ''),
                              onClick: () => {
                                setMode(value)
                                setError('')
                              },
                            },
                            label,
                          ),
                        ),
                      ),
                      h('div', { style: { height: 10 } }),
                      h('textarea', {
                        className: 'dsa-input',
                        value: question,
                        placeholder: '补充问题（可选）：例如“这道题为什么选 B”“这个报错怎么修”',
                        onChange: (event) => setQuestion(event.target.value),
                      }),
                      h('div', { style: { height: 10 } }),
                      h(
                        'button',
                        { className: 'dsa-primary', disabled: busy, onClick: analyze },
                        busy ? h('span', { className: 'dsa-spinner' }) : null,
                        busy ? '正在分析…' : '开始分析',
                      ),
                    )
                  : h(
                      React.Fragment,
                      null,
                      h(
                        'div',
                        { className: 'dsa-hero' },
                        h('div', { className: 'dsa-hero-icon' }, icon),
                        h('div', { className: 'dsa-hero-title' }, '让我看看你的屏幕'),
                        h('div', { className: 'dsa-hero-text' }, '题目、报错、软件界面、网页、表格都可以。我会识别内容，给出答案、操作步骤或总结。'),
                      ),
                      h(
                        'div',
                        { className: 'dsa-row', style: { justifyContent: 'center', marginBottom: 12 } },
                        h('span', { className: 'dsa-label' }, '截屏延时'),
                        [0, 3, 5].map((value) =>
                          h(
                            'button',
                            {
                              key: value,
                              className: 'dsa-delay' + (delay === value ? ' on' : ''),
                              onClick: () => setDelay(value),
                            },
                            value === 0 ? '立即' : `${value} 秒`,
                          ),
                        ),
                      ),
                      h('button', { className: 'dsa-primary', onClick: capture }, icon, ' 截取当前屏幕'),
                      h('div', { className: 'dsa-hero-text', style: { marginTop: 10 } }, '建议用 3 秒：点完后切到你要问的窗口。'),
                      h(
                        'div',
                        { className: 'dsa-hotkey', title: globalState.error || undefined },
                        globalState.active && globalState.keys
                          ? h(React.Fragment, null, '全局快捷键 ', h('kbd', null, globalState.keys), ' · 任意窗口可用')
                          : hotkey
                            ? h(
                                React.Fragment,
                                null,
                                '窗口内快捷键 ',
                                h('kbd', null, hotkey),
                                '（DSH 需在前台）',
                              )
                            : globalState.error || '可在 DSH「设置 → 快捷键」里给「识屏：截取当前屏幕」绑定按键',
                      ),
                    ),
                error ? h('div', { className: 'dsa-error', style: { marginTop: 12 } }, error) : null,
                result
                  ? h(
                      React.Fragment,
                      null,
                      h('div', { style: { height: 12 } }),
                      h(
                        'div',
                        { className: 'dsa-result-head' },
                        h('div', { className: 'dsa-label' }, '分析结果'),
                        h(
                          'div',
                          { className: 'dsa-row' },
                          h('button', { className: 'dsa-ghost', onClick: copy }, '复制'),
                          h('button', { className: 'dsa-ghost', onClick: analyze, disabled: busy }, '重新分析'),
                        ),
                      ),
                      h('div', { className: 'dsa-result' }, result.text),
                      h(
                        'div',
                        { className: 'dsa-meta', style: { marginTop: 6 } },
                        `${result.mode === 'auto' ? '全局识屏 · ' : ''}${result.model || ''} · ${Math.max(1, Math.round((result.elapsedMs || 0) / 1000))} 秒`,
                      ),
                    )
                  : null,
              ),
              h('div', { className: 'dsa-foot' }, h('span', null, '截图只在本机生成；点「开始分析」后发送给当前模型。'), h('span', null, 'Esc 关闭')),
            )
          : h(
              'button',
              { className: 'dsa-btn', onClick: () => setOpen(true), title: '识屏助手' },
              icon,
              '识屏',
            ),
        toast ? h('div', { className: 'dsa-toast' }, toast) : null,
        zoom && shot
          ? h('div', { className: 'dsa-zoom', onClick: () => setZoom(false) }, h('img', { src: shot.dataUrl, alt: '屏幕截图' }))
          : null,
      ),
    )
  }

  window.__ModuleLoader__.load({
    id: 'dsh-screen-assistant',
    factory: function (require) {
      const React = require('react')

      const name = 'screen-assistant'
      const inject = ['slots', 'shortcuts']

      function apply(ctx) {
        // 快捷键只负责发事件，真正的截屏由已经挂载的面板完成。
        const shortcutListeners = new Set()
        let hotkey = ''
        const syncHotkey = () => {
          let next = ''
          try {
            const row = ctx.shortcuts.catalog.getSnapshot().find((item) => item.id === SHORTCUT_ID)
            if (row && Array.isArray(row.keys)) next = row.keys.join('')
          } catch (error) {
            console.warn('[screen-assistant] shortcut catalog unavailable:', error)
          }
          hotkey = next
          for (const listener of [...shortcutListeners]) {
            try {
              listener()
            } catch (error) {
              console.error('[screen-assistant] shortcut listener failed', error)
            }
          }
        }
        const shortcut = {
          getKeys: () => hotkey,
          subscribe(listener) {
            shortcutListeners.add(listener)
            return () => shortcutListeners.delete(listener)
          },
        }

        // Ctrl+Shift+S 优先；被 DSH 或浏览器占用时依次退让。用户可在
        // DSH「设置 → 快捷键」里改成任何不冲突的组合。
        const profile = ctx.shortcuts.runtime + ':' + ctx.shortcuts.platform
        const candidates = [
          { code: 'KeyS', modifiers: ['primary', 'shift'] },
          { code: 'KeyS', modifiers: ['primary', 'alt'] },
          { code: 'KeyX', modifiers: ['primary', 'shift'] },
          { code: 'KeyS', modifiers: ['primary', 'alt', 'shift'] },
          { code: 'KeyC', modifiers: ['primary', 'alt'] },
        ]
        let registered = false
        for (const candidate of candidates) {
          let info
          try {
            info = ctx.shortcuts.describeBinding(candidate)
          } catch {
            continue
          }
          if (!info || info.issue || (info.conflicts && info.conflicts.length > 0)) continue
          try {
            ctx.effect(
              () =>
                ctx.shortcuts.register({
                  id: SHORTCUT_ID,
                  label: () => '识屏：截取当前屏幕',
                  aliases: ['识屏', '截图', 'screen capture'],
                  defaults: { [profile]: candidate },
                  regions: ['page', 'editable', 'terminal'],
                  modals: [],
                  resolve: () =>
                    shortcutBus.globalActive
                      ? { status: 'handled', run: () => {} }
                      : { status: 'handled', run: () => shortcutBus.emit() },
                }),
              'screen-assistant: shortcut',
            )
            registered = true
            break
          } catch (error) {
            console.warn('[screen-assistant] shortcut default rejected:', error)
          }
        }
        if (!registered) {
          console.warn('[screen-assistant] no free default shortcut; set one from DSH keyboard settings if available')
        }

        try {
          const off = ctx.shortcuts.catalog.subscribe(syncHotkey)
          ctx.effect(() => off, 'screen-assistant: shortcut catalog')
          syncHotkey()
        } catch (error) {
          console.warn('[screen-assistant] could not subscribe to shortcut catalog:', error)
        }

        ctx.slots.inject('shell.overlay', function* () {
          yield ctx.slots.register(
            { name: 'shell.overlay', id: 'screen-assistant', order: 1200 },
            function () {
              return React.createElement(ScreenAssistant, { react: React, shortcut })
            },
          )
        })
      }

      return { name, inject, apply }
    },
  })
})()
