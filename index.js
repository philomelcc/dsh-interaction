/**
 * dsh-interaction · 交互增强
 *
 * 三块能力（每块都能在「设置 → 交互增强」里单独开关）：
 *  1. ask_flow      —— 分支式提问：声明一张问题图，按依赖分波提问，选 A 就只问 A 那条线。
 *  2. session_*     —— 跨会话消息：列会话、投递消息（会唤醒冷会话）、回读对方回复。
 *  3. 文件支持扩展  —— 右侧边栏文档预览的音频播放器 / 图片缩放旋转（浏览器半侧实现）。
 *
 * Host 半：工具注册 + 设置存储 + HTTP 端点。
 * 开关改动后工具会立即注销/重注册，agent 下一个请求就能看到。
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import {
  defineTool,
  textOutput,
  toLosslessJson,
} from './lib/tool.js'
import { normalizeSteps } from './lib/flow.js'
import { runAskFlow } from './lib/ask.js'
import { createSessionBridge } from './lib/sessions.js'

export const name = 'interaction'
// 只 inject 一定存在的服务；userQuestions / sessionController / sessionTitle / webServer
// 都是运行时 ctx.get() 取，缺了对应功能给一条明确报错，不影响插件加载。
export const inject = ['tools']

/** 设置页 / 客户端读取用 HTTP 前缀。 */
export const API_PREFIX = '/plugins/dsh-interaction/api'

// 测试时用 DSH_INTERACTION_DATA_DIR 指到临时目录，避免读写真实设置。
const DATA_DIR = process.env.DSH_INTERACTION_DATA_DIR || join(homedir(), '.dsh', 'interaction')
const SETTINGS_FILE = join(DATA_DIR, 'settings.json')

const DEFAULTS = {
  askFlow: true,
  crossSession: true,
  fileSupport: true,
  crossSessionMaxDepth: 3,
  crossSessionRateLimit: 3,
}

/** 配置容错：cordis.patch.yml 里写错类型不该让插件起不来。 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const cross = input.crossSession && typeof input.crossSession === 'object' ? input.crossSession : {}
  return {
    crossSession: {
      enabled: cross.enabled === undefined ? true : cross.enabled !== false,
      maxDepth: Number.isFinite(cross.maxDepth) ? Math.max(1, Math.trunc(cross.maxDepth)) : DEFAULTS.crossSessionMaxDepth,
      rateLimit: Number.isFinite(cross.rateLimit) ? Math.max(1, Math.trunc(cross.rateLimit)) : DEFAULTS.crossSessionRateLimit,
    },
  }
}

/** 设置归一化：只接受认识的字段，类型不对就回落到 fallback。 */
export function normalizeSettings(input, fallback = DEFAULTS) {
  const source = input && typeof input === 'object' ? input : {}
  const bool = (key) => (source[key] === undefined ? fallback[key] === true : source[key] !== false)
  const integer = (key, min, max) => {
    const value = Number(source[key])
    if (!Number.isFinite(value)) return fallback[key]
    return Math.min(max, Math.max(min, Math.trunc(value)))
  }
  return {
    askFlow: bool('askFlow'),
    crossSession: bool('crossSession'),
    fileSupport: bool('fileSupport'),
    crossSessionMaxDepth: integer('crossSessionMaxDepth', 1, 10),
    crossSessionRateLimit: integer('crossSessionRateLimit', 1, 60),
  }
}

async function loadSettings(fallback) {
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8')
    return normalizeSettings(JSON.parse(raw), fallback)
  } catch {
    return normalizeSettings({}, fallback)
  }
}

async function persistSettings(settings) {
  await mkdir(dirname(SETTINGS_FILE), { recursive: true })
  await writeFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
}

/** 从 agent 上读会话标题，读不到就给个短 id。 */
function titleOf(ctx, agent) {
  if (agent === undefined || agent === null) return undefined
  try {
    const titles = ctx.get('sessionTitle')
    const snapshot = titles?.get?.(agent.session)
    if (typeof snapshot?.title === 'string' && snapshot.title.trim()) return snapshot.title.trim()
  } catch {
    // 标题读不到不影响功能
  }
  return undefined
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('body is not JSON'))
      }
    })
    req.on('error', reject)
  })
}

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('content-length', Buffer.byteLength(body))
  res.end(body)
}

export async function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const log = (message) => {
    try { ctx?.logger?.info?.(`[interaction] ${message}`) } catch { /* logger 不可用就静默 */ }
  }

  const fallback = {
    ...DEFAULTS,
    crossSession: config.crossSession.enabled,
    crossSessionMaxDepth: config.crossSession.maxDepth,
    crossSessionRateLimit: config.crossSession.rateLimit,
  }
  let settings = await loadSettings(fallback)

  const bridge = createSessionBridge({
    ctx,
    config: { maxDepth: settings.crossSessionMaxDepth, rateLimit: settings.crossSessionRateLimit },
    log,
  })

  // ---------------------------------------------------------------- 工具定义

  function makeAskFlowTool() {
    return defineTool({
      name: 'ask_flow',
      description:
        '分支式提问：一次声明整张问题图，按依赖分波向用户提问——先问第一层，拿到答案后再决定该问哪几道。'
        + '用户的选择会决定后续问题的走向（例如「选了 A 才问 A 的细节，选了 B 就问 B 的细节」）。'
        + '当一个问题的后续问题取决于前面怎么答时用它；一批互不相关的独立问题用 ask_user_question 就行。'
        + '每一步是 ProblemItem：{ id, question, options?, header?, detail?, multi_select?, when? }。'
        + 'when 用来声明「前面选了某个选项才问这题」，写法 { id: 前一个步骤的id, in: [选项label] }，'
        + '也支持 not_in: [...]（选了别的才问）和 answered: true（只要答过就问）。多个条件传数组表示同时满足。'
        + '同一个 when 依赖的题会在后续波次出现，没有依赖的题会在同一波一起问。'
        + '【交互要点】一波里有多个问题时，用户点单选题的选项会自动跳到下一题，只有这一波的最后一题才需要点提交；'
        + '所以凡是互不依赖的问题都放进同一层（别人为串成一条链），用户能少点很多次提交。'
        + '每一波之间用户看得到进度（第 N 步）；第二波起每题会多一个「← 返回上一题」选项，用户能退回去改答案。',
      parameters: {
        intro: { type: 'string', description: '第一张卡片顶部的说明，可选；写一句这次要确认什么' },
        steps: {
          type: 'array',
          required: true,
          description: '问题图，按提问顺序排列（最多 20 个）；有依赖的题会自动排到后面的波次',
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              id: { type: 'string', required: true, description: '稳定 id，答案按它回传，when 也引用它' },
              question: { type: 'string', required: true, description: '要问用户的问题' },
              header: { type: 'string', description: '短标题，会显示成「第 N 步 · 短标题」' },
              detail: { type: 'string', description: '补充说明（markdown），渲染在问题下方' },
              options: {
                type: 'array',
                description: '选项；留空则让用户自由输入',
                items: {
                  type: 'object',
                  additionalProperties: true,
                  properties: {
                    label: { type: 'string', required: true, description: '选项文本，when.in 要精确匹配它' },
                    description: { type: 'string', description: '一句话说明这个选项的后果或取舍' },
                  },
                },
              },
              multi_select: { type: 'boolean', description: '是否允许多选，默认否' },
              when: {
                type: 'object',
                additionalProperties: true,
                description: "依赖条件，如 { id: 'deploy', in: ['A 本地部署'] }；满足才问这道题",
              },
            },
          },
        },
      },
      output: textOutput({
        answers: { type: 'array', items: { type: 'object', additionalProperties: true } },
        skipped: { type: 'array', items: { type: 'string' } },
        waves: { type: 'array', items: { type: 'object', additionalProperties: true } },
        cancelled: { type: 'boolean' },
      }),
      async execute(args, exec) {
        const userQuestions = ctx.get('userQuestions')
        if (userQuestions === undefined) {
          throw new Error('当前部署没有 userQuestions 服务，没有可用的提问界面')
        }
        const steps = normalizeSteps(args.steps)
        const result = await runAskFlow({
          userQuestions,
          agent: exec?.agent,
          signal: exec?.signal,
          steps,
          intro: typeof args.intro === 'string' ? args.intro.trim() : undefined,
          log,
        })

        const answered = result.answers.length
        const lines = result.answers.map((item) => {
          const picked = item.selected.length > 0 ? item.selected.join('、') : ''
          const custom = item.custom ? `${picked ? ' + ' : ''}${item.custom}` : ''
          return `- ${item.question} → ${picked}${custom}`
        })
        const waveCount = result.waves.length
        let text
        if (result.cancelled) {
          text = `提问中途被打断（可能是关掉了面板），已收到 ${answered} 个回答${answered > 0 ? `：\n${lines.join('\n')}` : '。'}`
        } else if (answered === 0) {
          text = '没有问到任何问题（所有步骤的条件都不成立）。'
        } else {
          text = `已收到 ${answered} 个回答（分 ${waveCount} 波提问）：\n${lines.join('\n')}`
        }
        if (result.skipped.length > 0) {
          const byId = new Map(steps.map((step) => [step.id, step]))
          const skippedText = result.skipped.map((id) => byId.get(id)?.question ?? id).join('、')
          text += `\n\n因不满足条件而跳过：${skippedText}`
        }
        if (result.backs > 0) text += `\n\n（中途回退了 ${result.backs} 次）`
        return toLosslessJson({
          text,
          answers: result.answers,
          skipped: result.skipped,
          waves: result.waves,
          cancelled: result.cancelled,
        })
      },
    })
  }

  function makeSessionTools() {
    return [
      defineTool({
        name: 'session_list',
        description:
          '列出本机其他会话（标题、id、是否正在跑、工作区）。要给另一个会话发消息前先用它查准 session_id。'
          + '不包含子代理会话和空会话。',
        parameters: {
          query: { type: 'string', description: '关键词，匹配标题 / 工作区路径 / id，可省略' },
          limit: { type: 'integer', description: '最多返回多少条，默认 20，上限 100' },
        },
        output: textOutput({
          sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          total: { type: 'integer' },
        }),
        async execute(args, exec) {
          const selfId = exec?.agent?.id
          const { sessions, total } = await bridge.listSessions({
            query: args.query,
            limit: args.limit,
            signal: exec?.signal,
            excludeSelf: true,
            selfId: selfId === undefined ? undefined : String(selfId),
          })
          const lines = sessions.map((row) => {
            const running = row.running ? ' · 正在运行' : ''
            const cwd = row.cwd ? ` · ${row.cwd}` : ''
            return `- ${row.title} [${row.sessionId}]${running}${cwd}`
          })
          return toLosslessJson({
            text: sessions.length === 0
              ? '没有找到符合条件的会话。'
              : `找到 ${sessions.length} 个会话（共 ${total} 个）：\n${lines.join('\n')}`,
            sessions,
            total,
          })
        },
      }),

      defineTool({
        name: 'session_send',
        description:
          '向另一个会话主动发一条消息并唤醒它（它冷着会自动恢复，正在跑就排进它的队列）。'
          + '这就是跨会话唤醒：另一个会话会像收到通知一样开始干活，消息在它那边显示成通知卡片，能区分是 AI 发的。'
          + '对方看不到本会话的上下文，所以消息里要写清楚你是谁、要它做什么、需要它回什么。'
          + '默认 mode=queue（等它当前回合跑完再处理），mode=steer 会插进它当前回合——除非用户明确要求打断，否则别用 steer。'
          + '发完可以用 session_peek 看它回了什么。探测到会话之间互相来回超过 3 层会被拒绝，别自己跟自己绕圈。',
        parameters: {
          session_id: { type: 'string', required: true, description: '目标会话 id，从 session_list 拿' },
          text: { type: 'string', required: true, description: '消息正文，写给对方会话看的' },
          mode: { type: 'string', description: 'queue（默认，排队）或 steer（打断当前回合）' },
        },
        output: textOutput({
          accepted: { type: 'boolean' },
          sessionId: { type: 'string' },
          mode: { type: 'string' },
          depth: { type: 'integer' },
        }),
        async execute(args, exec) {
          const agent = exec?.agent
          const result = await bridge.sendMessage({
            fromAgent: agent,
            fromTitle: titleOf(ctx, agent),
            sessionId: args.session_id,
            text: args.text,
            mode: args.mode,
            signal: exec?.signal,
          })
          const modeText = result.mode === 'steer' ? '已插进它的当前回合' : '已排进它的队列'
          return toLosslessJson({
            text: `已投递给「${result.title}」（${result.sessionId}），${modeText}。链路深度 ${result.depth}。`
              + `想看它回了什么就用 session_peek。`,
            ...result,
          })
        },
      }),

      defineTool({
        name: 'session_peek',
        description:
          '读另一个会话最近几条用户/助手消息，用来确认跨会话消息发出去之后对方回了什么。'
          + '只读，不会唤醒对方，也不改动它的内容。',
        parameters: {
          session_id: { type: 'string', required: true, description: '目标会话 id' },
          limit: { type: 'integer', description: '最多读几条消息，默认 6，上限 30' },
        },
        output: textOutput({
          messages: { type: 'array', items: { type: 'object', additionalProperties: true } },
        }),
        async execute(args, exec) {
          const { messages } = await bridge.peekSession({
            sessionId: args.session_id,
            limit: args.limit,
            signal: exec?.signal,
          })
          const lines = messages.map((message) => {
            const when = message.at ? new Date(message.at).toISOString().slice(11, 19) : ''
            return `[${message.role}${when ? ` ${when}` : ''}] ${message.text}`
          })
          return toLosslessJson({
            text: messages.length === 0
              ? '这个会话里没读到用户/助手消息。'
              : `最近 ${messages.length} 条：\n${lines.join('\n\n')}`,
            messages,
          })
        },
      }),
    ]
  }

  // ---------------------------------------------------------------- 工具开关

  /** 按当前设置重新注册工具：开关改了就能立刻反映到 agent 的工具列表。 */
  let toolDisposers = []
  function syncTools() {
    for (const dispose of toolDisposers) {
      try { dispose?.() } catch { /* 注销失败不影响重注册 */ }
    }
    toolDisposers = []
    const next = []
    if (settings.askFlow) next.push(makeAskFlowTool())
    if (settings.crossSession) next.push(...makeSessionTools())
    for (const tool of next) toolDisposers.push(ctx.tools.register(tool))
    log(`tools synced: ${next.map((tool) => tool.name).join(', ') || '(none)'}`)
  }

  syncTools()
  ctx.effect(() => () => {
    for (const dispose of toolDisposers) {
      try { dispose?.() } catch { /* 卸载阶段吞掉 */ }
    }
  }, 'interaction: tools')

  // ---------------------------------------------------------------- HTTP 设置端点

  const apiHandler = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) {
      if (typeof next === 'function') return next()
      return json(res, 404, { ok: false, error: 'not found' })
    }
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    try {
      if (req.method === 'GET' && route === '/settings') {
        return json(res, 200, { ok: true, settings })
      }
      if (req.method === 'POST' && route === '/settings') {
        const body = await readBody(req)
        settings = normalizeSettings({ ...settings, ...body }, settings)
        await persistSettings(settings)
        syncTools()
        return json(res, 200, { ok: true, settings })
      }
      if (req.method === 'GET' && route === '/status') {
        return json(res, 200, {
          ok: true,
          status: {
            settings,
            tools: {
              askFlow: settings.askFlow,
              crossSession: settings.crossSession,
              fileSupport: settings.fileSupport,
            },
            userQuestions: ctx.get('userQuestions') !== undefined,
            sessionController: ctx.get('sessionController') !== undefined,
          },
        })
      }
      // 会话里点文件路径：open 用系统默认程序打开，reveal 在文件管理器里定位。
      if (req.method === 'POST' && (route === '/open' || route === '/reveal')) {
        const body = await readBody(req)
        const targetPath = String(body.path || '').trim()
        if (!targetPath) throw new Error('path 不能为空')
        // openWorkspacePath 只验证「映射到 host 文件系统」，不验证存在性；
        // 点不存在的路径会弹系统错误框，所以这里先自己检查一次。
        try {
          await access(targetPath)
        } catch {
          throw new Error(`路径不存在：${targetPath}`)
        }
        const service = ctx.get('sessionController')
        if (service === undefined || typeof service.openWorkspacePath !== 'function') {
          throw new Error('当前部署没有 sessionController，打不开本地文件')
        }
        const abort = new AbortController()
        await service.openWorkspacePath(
          route === '/reveal' ? { path: targetPath, action: 'reveal' } : { path: targetPath },
          abort.signal,
        )
        return json(res, 200, { ok: true, opened: true })
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      log(`http ${req.method} ${route}: ${error?.message || error}`)
      return json(res, 400, { ok: false, error: String(error?.message || error) })
    }
  }

  const webServer = ctx.get('webServer')
  if (webServer && typeof ctx.effect === 'function') {
    ctx.effect(
      () => webServer.register({ kind: 'prefix', path: API_PREFIX, handler: apiHandler }),
      'interaction: api',
    )
  } else {
    log('webServer 不可用：设置页 API 没挂上')
  }
}
