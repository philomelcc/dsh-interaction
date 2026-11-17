/**
 * dsh-interaction · 交互增强
 *
 * 两块能力：
 *  1. ask_flow      —— 分支式提问：声明一张问题图，按依赖分波提问，选 A 就只问 A 那条线。
 *  2. session_*     —— 跨会话消息：列会话、投递消息（会唤醒冷会话）、回读对方回复。
 *
 * Host 半只有工具，没有前端。提问面板复用官方 UI（ctx.userQuestions.ask），
 * 跨会话投递复用官方通道（ctx.sessionController.prompt）。
 */

import {
  defineTool,
  textOutput,
  toLosslessJson,
} from './lib/tool.js'
import { normalizeSteps } from './lib/flow.js'
import { runAskFlow } from './lib/ask.js'
import { createSessionBridge } from './lib/sessions.js'

export const name = 'interaction'
// 只 inject 一定存在的服务；userQuestions / sessionController / sessionTitle
// 都是运行时 ctx.get() 取，缺了对应工具给一条明确报错，不影响插件加载。
export const inject = ['tools']

const DEFAULTS = {
  crossSession: {
    enabled: true,
    maxDepth: 3,
    rateLimit: 3,
  },
}

/** 配置容错：cordis.patch.yml 里写错类型不该让插件起不来。 */
export function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {}
  const cross = input.crossSession && typeof input.crossSession === 'object' ? input.crossSession : {}
  return {
    crossSession: {
      enabled: cross.enabled === undefined ? DEFAULTS.crossSession.enabled : cross.enabled !== false,
      maxDepth: Number.isFinite(cross.maxDepth) ? cross.maxDepth : DEFAULTS.crossSession.maxDepth,
      rateLimit: Number.isFinite(cross.rateLimit) ? cross.rateLimit : DEFAULTS.crossSession.rateLimit,
    },
  }
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

export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  const log = (message) => {
    try { ctx?.logger?.info?.(`[interaction] ${message}`) } catch { /* logger 不可用就静默 */ }
  }

  const bridge = createSessionBridge({ ctx, config: config.crossSession, log })

  const tools = []

  // ---------------------------------------------------------------- 分支提问

  tools.push(defineTool({
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
      + '每一波之间用户看得到进度（第 N 步），但跨波无法回退改答案，所以依赖关系要设计得有必要、别分层太碎。',
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
  }))

  // ---------------------------------------------------------------- 跨会话

  if (config.crossSession.enabled) {
    tools.push(defineTool({
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
    }))

    tools.push(defineTool({
      name: 'session_send',
      description:
        '向另一个会话主动发一条消息并唤醒它（它冷着会自动恢复，正在跑就排进它的队列）。'
        + '这就是跨会话唤醒：另一个会话会像收到用户消息一样开始干活。'
        + '对方看不到本会话的上下文，所以消息里要写清楚你是谁、要它做什么、需要它回什么。'
        + '默认 mode=queue（等它当前回合跑完再处理），mode=steer 会插进它当前回合——除非用户明确要求打断，否则别用 steer。'
        + '发完可以用 session_peek 看它回了什么。探测到会话之间互相来回超过 3 层会被拒绝，别自己跟自己绕圈。',
      parameters: {
        session_id: { type: 'string', required: true, description: '目标会话 id，从 session_list 拿' },
        text: { type: 'string', required: true, description: '消息正文，写给对方会话看的' },
        mode: { type: 'string', description: "queue（默认，排队）或 steer（打断当前回合）" },
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
    }))

    tools.push(defineTool({
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
    }))
  }

  const disposers = tools.map((tool) => ctx.tools.register(tool))
  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try { dispose?.() } catch { /* 卸载阶段吞掉 */ }
    }
  }, 'interaction: tools')
}
