/**
 * 识屏助手 · 宿主半边
 *
 * 提供三件事：
 *  1. Web 路由 /dsh-screen-7421/capture|analyze|events|global|status，供悬浮面板截屏、
 *     后台全局热键截图，以及把结果通过 SSE 推回页面；
 *  2. 常驻 PowerShell helper，用 RegisterHotKey 注册系统级快捷键，按 DSH 不在前台也能截屏；
 *  3. capture_screen 工具，让对话里的 Agent 也能主动看屏幕。
 *
 * 截屏走 Windows 自带的 PowerShell + GDI，不依赖任何原生模块；
 * 图片通过 harness 的 attachments 服务入库后作为 ImageBlock 交给模型。
 */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { mkdir, readFile, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'screen-assistant'
export const inject = ['webServer', 'llm', 'attachments', 'agentDefaultModel', 'tools']

const PACKAGE_ROOT = dirname(fileURLToPath(new URL('./index.js', import.meta.url)))
const CAPTURE_SCRIPT = join(PACKAGE_ROOT, 'runtime', 'capture-screen.ps1')
const GLOBAL_HOTKEY_SCRIPT = join(PACKAGE_ROOT, 'runtime', 'global-hotkey.ps1')
const ROUTE_PREFIX = '/dsh-screen-7421'
const CALL_IDENTITY = 'dsh-screen-assistant'
const MAX_EDGE = 2560
const CAPTURE_TTL_MS = 10 * 60 * 1000
const MAX_CAPTURES = 6
const ANALYZE_TIMEOUT_MS = 180_000

/** RegisterHotKey 的修饰键位。 */
const MOD_ALT = 0x0001
const MOD_CONTROL = 0x0002
const MOD_SHIFT = 0x0004

/**
 * 全局热键候选：按顺序尝试，第一个注册成功的生效。
 * 键位只使用 Windows 虚拟键码，避免布局差异。
 */
const GLOBAL_HOTKEY_CANDIDATES = [
  { modifiers: MOD_CONTROL | MOD_SHIFT, vk: 0x53, keys: 'Ctrl+Shift+S' },
  { modifiers: MOD_CONTROL | MOD_ALT, vk: 0x53, keys: 'Ctrl+Alt+S' },
  { modifiers: MOD_CONTROL | MOD_SHIFT, vk: 0x58, keys: 'Ctrl+Shift+X' },
  { modifiers: MOD_CONTROL | MOD_ALT | MOD_SHIFT, vk: 0x53, keys: 'Ctrl+Alt+Shift+S' },
  { modifiers: MOD_CONTROL | MOD_ALT, vk: 0x43, keys: 'Ctrl+Alt+C' },
]

const SYSTEM_PROMPT = `你是「识屏助手」，通过一张 Windows 桌面截图帮助用户。严格遵守：
1. 只根据截图里真正看得见的内容回答，不猜测、不补全不存在的界面或文字；看不清就明确说看不清，并指出大概位置。
2. 先给结论，再给依据或步骤。涉及操作时写清楚点哪里、输入什么、按什么键；涉及题目时先给答案再给关键推导；涉及报错时先判断原因再给修复步骤。
3. 使用简体中文，输出纯文本，不要使用 Markdown 的 #、*、反引号等标记；可以用 1. 2. 3.、短横线和缩进组织内容。
4. 如果截图是黑屏、锁屏、纯壁纸或没有可读内容，直接说明，不要编造。
5. 不要主动复述截图里与问题无关的隐私信息（密码、身份证号、聊天记录等）；如果这些内容正好出现在关键位置，提醒用户注意。
6. 最后另起一行写「置信度：高/中/低」，低或中时用一句话说明原因。`

const MODES = {
  solve: {
    label: '解决问题',
    instruction:
      '判断屏幕上需要解决的问题（题目、报错、代码、表格、表单等），直接给出正确答案或可执行的解决步骤。题目先给答案再给关键推导；报错先判断原因再给修复步骤；代码指出问题行并给出修改后的代码片段。',
  },
  operate: {
    label: '教我操作',
    instruction:
      '把用户的目标转成具体操作：按顺序写清点哪个按钮或菜单、输入什么、用什么快捷键。若目标不明确，先说明你判断的目标，再给步骤；如果有更快的快捷键，一并给出。',
  },
  summarize: {
    label: '总结内容',
    instruction:
      '总结屏幕上的主要内容：先一句话结论，再列 3 到 7 个要点，保留关键数字、名称、时间和结论。不要逐字复述。',
  },
  extract: {
    label: '提取文字',
    instruction:
      '逐字转写屏幕上的文字，保持原有顺序和结构；表格用“|”分隔列；看不清的字用 [?] 标注；不要翻译、不要总结、不要补充。',
  },
  ask: {
    label: '自由提问',
    instruction:
      '根据用户补充的问题分析屏幕内容并回答；如果用户没有补充问题，先概括屏幕内容，再指出最可能需要帮助的地方并给出建议。',
  },
  auto: {
    label: '自动识屏',
    instruction:
      '先判断屏幕属于哪类内容，再选择最有用的回答方式：像题目、报错、代码或表单，就直接给答案、原因或修复步骤；像文档、网页、表格，就先给一句话结论再列关键要点；像软件界面，就给出下一步该点哪里、输入什么。优先解决用户最可能卡住的地方，不要面面俱到；如果没有明显问题，就给一段简短总结。',
  },
}

/** 最近截取的屏幕，按 id 暂存在内存里，避免把整张图在浏览器和宿主之间来回传两次。 */
const captures = new Map()

function cleanupCaptures() {
  const now = Date.now()
  for (const [id, shot] of captures) {
    if (now - shot.at > CAPTURE_TTL_MS) captures.delete(id)
  }
  while (captures.size > MAX_CAPTURES) {
    const oldest = captures.keys().next().value
    if (oldest === undefined) break
    captures.delete(oldest)
  }
}

/**
 * 用 spawn + 文件重定向运行 PowerShell，不捕获 stdout。
 * 某些受限环境禁止匿名管道，execFile 的 stdout 管道会直接 EPERM。
 */
function spawnPowerShell(exe, args, { signal, logPath }) {
  return new Promise((resolve, reject) => {
    const logFd = openSync(logPath, 'w')
    let child
    let timer
    let settled = false
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        closeSync(logFd)
      } catch {
        // 句柄已关闭。
      }
      if (error) reject(error)
      else resolve()
    }
    try {
      child = spawn(exe, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', logFd],
        signal,
      })
    } catch (error) {
      finish(error)
      return
    }
    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // 进程可能已经退出。
      }
      finish(new ScreenError('CAPTURE_TIMEOUT', '截屏超时（30 秒）。', 504))
    }, 30_000)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (code === 0) finish()
      else finish(new ScreenError('CAPTURE_FAILED', `截屏脚本退出码 ${code}。`, 500))
    })
  })
}

async function runPowerShell(args, options) {
  const common = ['-NoProfile', '-NonInteractive']
  try {
    await spawnPowerShell('powershell.exe', [...common, '-ExecutionPolicy', 'Bypass', ...args], options)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await spawnPowerShell('pwsh.exe', [...common, ...args], options)
  }
}

/**
 * 截取整个虚拟桌面（所有显示器拼成一张），最长边压到 MAX_EDGE。
 * @returns {{ data: Buffer, info: { width: number, height: number, sourceWidth: number, sourceHeight: number, scale: number } }}
 */
async function captureScreen(signal) {
  if (process.platform !== 'win32') {
    throw new ScreenError('UNSUPPORTED_PLATFORM', '识屏助手目前只支持 Windows 桌面。', 501)
  }
  const file = join(tmpdir(), `dsh-screen-${randomUUID()}.png`)
  const metaPath = `${file}.json`
  const logPath = `${file}.log`
  await mkdir(dirname(file), { recursive: true })
  let log = ''
  try {
    await runPowerShell(
      ['-File', CAPTURE_SCRIPT, '-OutPath', file, '-MetaPath', metaPath, '-MaxEdge', String(MAX_EDGE)],
      { signal, logPath },
    )
    const metaText = (await readFile(metaPath, 'utf8')).replace(/^\uFEFF/, '')
    let info
    try {
      info = JSON.parse(metaText)
    } catch {
      throw new ScreenError('CAPTURE_FAILED', '截屏脚本返回了无法解析的结果。', 500)
    }
    const data = await readFile(file)
    return { data, info }
  } catch (error) {
    log = await readFile(logPath, 'utf8').catch(() => '')
    if (error instanceof ScreenError && error.code === 'CAPTURE_FAILED' && log.trim() !== '') {
      throw new ScreenError('CAPTURE_FAILED', `无法截取屏幕：${log.trim().slice(0, 800)}`, 500)
    }
    if (error instanceof ScreenError) throw error
    const detail = String(log.trim() || error?.message || error)
    throw new ScreenError('CAPTURE_FAILED', `无法截取屏幕：${detail}`, 500)
  } finally {
    await Promise.all([unlink(file), unlink(metaPath), unlink(logPath)].map((task) => task.catch(() => {})))
  }
}

class ScreenError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'ScreenError'
    this.code = code
    this.status = status
  }
}

function rememberCapture(data, info) {
  const id = randomUUID()
  const at = Date.now()
  captures.set(id, { data, info, at })
  cleanupCaptures()
  return { id, at }
}

function getCapture(id) {
  cleanupCaptures()
  const shot = captures.get(id)
  if (!shot) {
    throw new ScreenError('CAPTURE_EXPIRED', '截图已过期，请重新截取。', 410)
  }
  return shot
}

/**
 * 全局热键 → 宿主 → 浏览器面板的单向事件桥。
 * 面板通过 EventSource 订阅；即使 DSH 在后台，浏览器也会收到事件。
 */
function createBridge() {
  const token = randomUUID()
  const clients = new Set()
  const status = { active: false, keys: '', error: '正在启动全局快捷键…' }
  const broadcast = (event, data) => {
    if (clients.size === 0) return
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
    for (const res of [...clients]) {
      try {
        res.write(payload)
      } catch {
        clients.delete(res)
      }
    }
  }
  const setStatus = (patch) => {
    Object.assign(status, patch)
    broadcast('state', status)
  }
  const attach = (res) => {
    clients.add(res)
    res.write('retry: 3000\n\n')
    res.write(`event: state\ndata: ${JSON.stringify(status)}\n\n`)
    return () => clients.delete(res)
  }
  const closeAll = () => {
    for (const res of clients) {
      try {
        res.end()
      } catch {
        // 连接已经断开。
      }
    }
    clients.clear()
  }
  return { token, status, broadcast, setStatus, attach, closeAll }
}

/** 全局热键被按下后，取消上一次还没跑完的分析并开始新的一次。 */
let globalAbort = null

async function analyzeGlobalShot(ctx, bridge, shot, id) {
  if (globalAbort) globalAbort.abort()
  const controller = new AbortController()
  globalAbort = controller
  const timer = setTimeout(() => controller.abort(), ANALYZE_TIMEOUT_MS)
  try {
    const result = await analyzeShot(ctx, shot, 'auto', '', controller.signal)
    if (globalAbort === controller) bridge.broadcast('result', { id, ...result })
  } catch (error) {
    if (globalAbort !== controller) return
    const message = controller.signal.aborted
      ? '分析超时或已取消。'
      : error instanceof Error
        ? error.message
        : String(error)
    bridge.broadcast('failure', { id, message })
  } finally {
    clearTimeout(timer)
    if (globalAbort === controller) globalAbort = null
  }
}

/**
 * 启动常驻 PowerShell helper，注册系统级热键。
 * helper 注册成功后会一直阻塞在消息循环里；退出即代表注册失败或被关闭。
 */
function startGlobalHotkey(ctx, bridge, disposers) {
  let stopped = false
  let bootTimer
  let child = null
  const stop = () => {
    stopped = true
    clearTimeout(bootTimer)
    if (child) {
      try {
        child.kill()
      } catch {
        // 进程可能已经退出。
      }
      child = null
    }
  }
  disposers.push(stop)

  const spawnHelper = (port, candidate) => {
    const logPath = join(tmpdir(), `dsh-screen-hotkey-${randomUUID()}.log`)
    let logFd
    try {
      logFd = openSync(logPath, 'w')
    } catch {
      return Promise.resolve(null)
    }
    let proc
    try {
      proc = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          GLOBAL_HOTKEY_SCRIPT,
          '-Modifiers',
          String(candidate.modifiers),
          '-Vk',
          String(candidate.vk),
          '-Port',
          String(port),
        ],
        {
          windowsHide: true,
          stdio: ['ignore', 'ignore', logFd],
          env: { ...process.env, DSH_SCREEN_TOKEN: bridge.token },
        },
      )
    } catch {
      closeSync(logFd)
      return Promise.resolve(null)
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (started) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          closeSync(logFd)
        } catch {
          // 句柄已经关闭。
        }
        resolve(started ? { child: proc } : null)
      }
      const timer = setTimeout(() => finish(true), 1200)
      proc.once('error', () => finish(false))
      proc.once('exit', () => {
        if (settled) return
        readFile(logPath, 'utf8')
          .then((text) => {
            if (text.trim()) {
              console.warn(`[screen-assistant] global hotkey ${candidate.keys} failed: ${text.trim().slice(0, 400)}`)
            }
          })
          .catch(() => {})
        finish(false)
      })
    })
  }

  const boot = async () => {
    try {
      if (stopped) return
      const port = Number(ctx.webServer?.port)
      if (!Number.isInteger(port) || port <= 0) {
        bootTimer = setTimeout(boot, 500)
        return
      }
      for (const candidate of GLOBAL_HOTKEY_CANDIDATES) {
        if (stopped) return
        const started = await spawnHelper(port, candidate)
        if (stopped) {
          if (started) {
            try {
              started.child.kill()
            } catch {
              // 进程可能已经退出。
            }
          }
          return
        }
        if (!started) continue
        child = started.child
        bridge.setStatus({ active: true, keys: candidate.keys, error: '' })
        child.once('exit', () => {
          if (stopped) return
          child = null
          bridge.setStatus({ active: false, keys: '', error: '全局快捷键已退出，可在 DSH 设置里改用窗口内快捷键' })
        })
        return
      }
      bridge.setStatus({
        active: false,
        keys: '',
        error: '全局快捷键被其它程序占用，已退回窗口内快捷键',
      })
    } catch (error) {
      if (!stopped) {
        bridge.setStatus({
          active: false,
          keys: '',
          error: `全局快捷键启动失败：${error instanceof Error ? error.message : String(error)}`,
        })
      }
    }
  }
  void boot()
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new ScreenError('BODY_TOO_LARGE', '请求体过大。', 413))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new ScreenError('INVALID_JSON', '请求体不是合法的 JSON。', 400))
      }
    })
    req.on('error', reject)
  })
}

function sendJson(res, status, value) {
  if (res.writableEnded) return
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function fail(res, error) {
  const status = error instanceof ScreenError ? error.status : 500
  const code = error instanceof ScreenError ? error.code : 'INTERNAL'
  const message = error instanceof Error ? error.message : String(error)
  sendJson(res, status, { ok: false, error: { code, message } })
}

function noTextReason(finish) {
  const { kind, failure } = finish ?? {}
  if (kind === 'aborted') return '生成已取消'
  if (kind === 'max-tokens') return '输出达到上限，没有产出正文'
  if (kind !== 'error') return '模型没有返回文本'
  const { message, code } = failure ?? {}
  if (typeof message === 'string' && message.trim() !== '') return message
  if (typeof code === 'string' && code.trim() !== '') return code
  return '模型没有返回文本'
}

function modeOf(value) {
  return Object.hasOwn(MODES, value) ? value : 'solve'
}

function buildUserPrompt(mode, question, info) {
  const spec = MODES[mode]
  const parts = [
    `这是一张当前 Windows 桌面的整屏截图（所有显示器拼合，${info.width}x${info.height} 像素）。`,
    spec.instruction,
  ]
  const extra = typeof question === 'string' ? question.trim().slice(0, 2000) : ''
  if (extra) parts.push(`用户补充的问题：${extra}`)
  return parts.join('\n\n')
}

async function currentSelection(ctx) {
  const service = ctx.agentDefaultModel
  if (!service || typeof service.currentSelection !== 'function') {
    throw new ScreenError('MODEL_UNAVAILABLE', '当前没有可用的模型配置。', 503)
  }
  const selection = service.currentSelection()
  if (!selection?.provider || !selection?.model) {
    throw new ScreenError('MODEL_UNAVAILABLE', '当前对话没有选择模型，请先在输入框下方选择一个模型。', 503)
  }
  return selection
}

async function assertImageCapable(ctx, provider, model, signal) {
  let info
  try {
    info = await ctx.llm.resolveModelInfo(provider, model, signal)
  } catch (error) {
    throw new ScreenError('MODEL_UNAVAILABLE', `无法解析当前模型 ${provider}/${model}：${error instanceof Error ? error.message : String(error)}`, 503)
  }
  if (info.inputModalities === undefined || !info.inputModalities.includes('image')) {
    throw new ScreenError(
      'MODEL_NO_IMAGE',
      `当前模型 ${model} 不支持图片输入。请切换到 DeepSeek-V4.1-Flash 等支持视觉的模型后再试。`,
      409,
    )
  }
  return info
}

async function analyzeShot(ctx, shot, mode, question, signal) {
  const selection = await currentSelection(ctx)
  const modelInfo = await assertImageCapable(ctx, selection.provider, selection.model, signal)
  const ref = await ctx.attachments.saveImage({
    data: shot.data,
    mediaType: 'image/png',
    name: 'screen.png',
  })
  const assembler = new BlockAssembler()
  const started = Date.now()
  for await (const chunk of ctx.llm.stream({
    provider: selection.provider,
    model: selection.model,
    sessionId: CALL_IDENTITY,
    system: SYSTEM_PROMPT,
    messages: [
      createUserMessage({
        content: [
          { type: 'text', text: buildUserPrompt(mode, question, shot.info) },
          { type: 'image', attachment: ref },
        ],
        source: { kind: 'user' },
      }),
    ],
    temperature: mode === 'extract' ? 0.2 : 0.6,
    // 推理模型的思考也占输出预算；1600 在自动识屏时容易把正文截断。
    maxTokens: 4096,
    signal,
  })) {
    assembler.push(chunk)
  }
  const text = assembler
    .blocks()
    .filter((block) => block.type === 'text')
    .map((block) => ('text' in block ? block.text : ''))
    .join('')
    .trim()
  if (!text) {
    throw new ScreenError('EMPTY_RESPONSE', `模型没有返回正文：${noTextReason(assembler.finish)}`, 502)
  }
  return {
    text,
    mode,
    provider: selection.provider,
    model: modelInfo.name || selection.model,
    elapsedMs: Date.now() - started,
  }
}

function applyRoutes(ctx, disposers, bridge) {
  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && path === '/status') {
      sendJson(res, 200, { ok: true, global: bridge.status })
      return
    }

    if (req.method === 'GET' && path === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      res.flushHeaders?.()
      const detach = bridge.attach(res)
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n')
        } catch {
          // 连接已经断开。
        }
      }, 15_000)
      const cleanup = () => {
        clearInterval(ping)
        detach()
      }
      req.on('close', cleanup)
      res.on('close', cleanup)
      return
    }

    if (req.method !== 'POST') {
      fail(res, new ScreenError('METHOD_NOT_ALLOWED', '只支持 POST 请求。', 405))
      return
    }

    const controller = new AbortController()
    const onClose = () => controller.abort()
    res.on('close', onClose)
    let timedOut = false
    let timeoutTimer
    try {
      if (path === '/capture') {
        const { data, info } = await captureScreen(controller.signal)
        const { id, at } = rememberCapture(data, info)
        sendJson(res, 200, {
          ok: true,
          id,
          dataUrl: `data:image/png;base64,${data.toString('base64')}`,
          width: info.width,
          height: info.height,
          sourceWidth: info.sourceWidth,
          sourceHeight: info.sourceHeight,
          capturedAt: new Date(at).toISOString(),
        })
        return
      }
      if (path === '/analyze') {
        const body = await readJsonBody(req)
        const shot = getCapture(body?.id)
        const mode = modeOf(body?.mode)
        timeoutTimer = setTimeout(() => {
          timedOut = true
          controller.abort()
        }, ANALYZE_TIMEOUT_MS)
        const result = await analyzeShot(ctx, shot, mode, body?.question, controller.signal)
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (path === '/global') {
        if (req.headers['x-dsh-screen-token'] !== bridge.token) {
          throw new ScreenError('FORBIDDEN', '全局热键令牌无效。', 403)
        }
        const { data, info } = await captureScreen(controller.signal)
        const { id, at } = rememberCapture(data, info)
        const dataUrl = `data:image/png;base64,${data.toString('base64')}`
        bridge.broadcast('capture', {
          id,
          dataUrl,
          width: info.width,
          height: info.height,
          sourceWidth: info.sourceWidth,
          sourceHeight: info.sourceHeight,
          capturedAt: new Date(at).toISOString(),
          source: 'global',
        })
        bridge.broadcast('status', { phase: 'analyzing', id })
        sendJson(res, 200, { ok: true, id })
        // 先让 helper 收到响应并切回 DSH，再在后台分析；期间面板显示“正在分析”。
        void analyzeGlobalShot(ctx, bridge, getCapture(id), id)
        return
      }
      fail(res, new ScreenError('NOT_FOUND', '未知的识屏接口。', 404))
    } catch (error) {
      if (path === '/global') {
        bridge.broadcast('failure', {
          message: error instanceof Error ? error.message : String(error),
        })
        bridge.broadcast('status', { phase: 'idle' })
      }
      if (timedOut) {
        fail(res, new ScreenError('ANALYZE_TIMEOUT', '分析超时（3 分钟）。可以重试，或换一张更小的截图。', 504))
        return
      }
      if (controller.signal.aborted && !res.writableEnded) return
      fail(res, error)
    } finally {
      if (timeoutTimer) clearTimeout(timeoutTimer)
      res.off('close', onClose)
    }
  }
  disposers.push(
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler,
    }),
  )
}

function applyTool(ctx, disposers) {
  disposers.push(
    ctx.tools.register(
      defineTool({
        name: 'capture_screen',
        description:
          'Capture the current Windows desktop (all monitors) as an image so you can see what the user is looking at. Use it when the user asks about their screen, an error dialog, a GUI, a document, or a question visible on screen. The tool waits delay_ms before capturing so the user can bring the target window to the front; tell the user to switch windows if you use a delay.',
        parameters: {
          delay_ms: {
            type: 'number',
            description: 'Milliseconds to wait before capturing, 0-10000. Default 3000 so the user can switch to the target window.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              width: { type: 'number', required: true },
              height: { type: 'number', required: true },
              image: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  attachmentId: { type: 'string', required: true },
                  mediaType: { type: 'string', required: true },
                  bytes: { type: 'number', required: true },
                  width: { type: 'number', required: true },
                  height: { type: 'number', required: true },
                  name: { type: 'string' },
                },
              },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: `Screenshot of the current desktop (${value.width}x${value.height}). It is attached as an image; inspect it before answering.`,
            },
            { type: 'image', attachment: value.image },
          ],
        },
        timeoutMs: 60_000,
        async execute(args, exec) {
          const delay = Math.min(10_000, Math.max(0, Number(args.delay_ms ?? 3000)))
          if (!Number.isFinite(delay)) throw new ScreenError('INVALID_DELAY', 'delay_ms 必须是 0 到 10000 之间的数字。', 400)
          if (delay > 0) {
            await new Promise((resolve, reject) => {
              const timer = setTimeout(resolve, delay)
              const onAbort = () => {
                clearTimeout(timer)
                reject(new ScreenError('ABORTED', '截屏已取消。', 499))
              }
              if (exec.signal.aborted) onAbort()
              else exec.signal.addEventListener('abort', onAbort, { once: true })
            })
          }
          const routed = exec.agent?.session?.requestHeader?.()?.config
          const provider = routed?.provider ?? exec.agent?.options?.provider
          const model = routed?.model ?? exec.agent?.options?.model
          if (provider && model) await assertImageCapable(ctx, provider, model, exec.signal)
          const { data, info } = await captureScreen(exec.signal)
          const ref = await ctx.attachments.saveImage({
            data,
            mediaType: 'image/png',
            name: 'screen.png',
          })
          return {
            width: info.width,
            height: info.height,
            image: {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.name === undefined ? {} : { name: ref.name }),
            },
          }
        },
      }),
    ),
  )
}

export function apply(ctx) {
  const disposers = []
  const bridge = createBridge()
  applyRoutes(ctx, disposers, bridge)
  applyTool(ctx, disposers)
  startGlobalHotkey(ctx, bridge, disposers)
  ctx.effect(
    () => () => {
      captures.clear()
      if (globalAbort) {
        globalAbort.abort()
        globalAbort = null
      }
      bridge.closeAll()
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 插件卸载时忽略单个清理失败，避免阻断其余资源释放。
        }
      }
    },
    'dsh-screen-assistant: routes, tool, global hotkey',
  )
}
