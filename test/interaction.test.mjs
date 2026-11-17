/**
 * 工具层的集成测试：用假 ctx 跑真实的 apply + execute，不依赖 DSH 进程。
 * 跑法：node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, normalizeConfig } from '../index.js'

function fakeCtx({ userQuestions, sessionController, sessionTitle } = {}) {
  const services = { userQuestions, sessionController, sessionTitle }
  const registered = []
  return {
    registered,
    tools: {
      register(tool) {
        registered.push(tool)
        return () => {}
      },
    },
    get(name) {
      return services[name]
    },
    effect(fn) {
      fn()
      return () => {}
    },
    logger: { info() {} },
  }
}

function toolByName(ctx, name) {
  const found = ctx.registered.find((tool) => tool.name === name)
  assert.ok(found, `没有注册工具 ${name}`)
  return found
}

/** 造一个主会话 agent：session.eventAt 从历史里回消息。 */
function fakeAgent({ id = 'session-self', texts = [] } = {}) {
  return {
    id,
    session: {
      seq: texts.length,
      eventAt(seq) {
        const text = texts[seq]
        if (text === undefined) return undefined
        return { type: 'user/message', data: { content: [{ type: 'text', text }] } }
      },
    },
  }
}

const SAMPLE_ITEMS = [
  {
    sessionId: 'session-video',
    running: true,
    agentAvailable: true,
    blank: false,
    cwd: 'C:\\work\\video',
    updatedAt: 3000,
    projections: { values: { title: '视频剪辑插件' } },
  },
  {
    sessionId: 'session-idea',
    running: false,
    agentAvailable: false,
    blank: false,
    cwd: 'C:\\work\\idea',
    updatedAt: 2000,
    projections: { values: { title: '灵感墙' } },
  },
  {
    sessionId: 'session-child',
    origin: 'subagent',
    blank: false,
    running: true,
    updatedAt: 2500,
  },
  {
    sessionId: 'session-blank',
    blank: true,
    running: false,
    updatedAt: 1000,
  },
]

test('注册了四个工具（跨会话默认开启）', () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  assert.deepEqual(ctx.registered.map((tool) => tool.name).sort(), [
    'ask_flow', 'session_list', 'session_peek', 'session_send',
  ])
})

/** 递归找出 schema 里所有「required 不是字符串数组」的节点。 */
function badRequiredNodes(node, path = '$', found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    node.forEach((item, index) => badRequiredNodes(item, `${path}[${index}]`, found))
    return found
  }
  if ('required' in node && !Array.isArray(node.required)) {
    found.push(`${path}.required = ${JSON.stringify(node.required)}`)
  }
  if (Array.isArray(node.required) && node.required.some((key) => typeof key !== 'string')) {
    found.push(`${path}.required 含非字符串项`)
  }
  if ('properties' in node) {
    for (const [key, value] of Object.entries(node.properties)) {
      badRequiredNodes(value, `${path}.properties.${key}`, found)
    }
  }
  if ('items' in node) badRequiredNodes(node.items, `${path}.items`, found)
  return found
}

test('所有工具的 schema 里 required 必须是父对象的字符串数组（嵌套也不能漏）', () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  for (const tool of ctx.registered) {
    assert.deepEqual(badRequiredNodes(tool.parameters), [], `${tool.name} 的参数 schema 不合法`)
    assert.deepEqual(badRequiredNodes(tool.output.schema), [], `${tool.name} 的输出 schema 不合法`)
  }
})

test('ask_flow 的嵌套 items 把 required 提升到了数组', () => {
  const ctx = fakeCtx()
  apply(ctx, {})
  const tool = toolByName(ctx, 'ask_flow')
  const steps = tool.parameters.properties.steps
  assert.deepEqual(steps.items.required, ['id', 'question'])
  assert.deepEqual(steps.items.properties.options.items.required, ['label'])
  assert.equal(steps.items.properties.id.required, undefined)
  assert.equal(steps.items.properties.options.items.properties.label.required, undefined)
})

test('crossSession.enabled=false 时只注册 ask_flow', () => {
  const ctx = fakeCtx()
  apply(ctx, { crossSession: { enabled: false } })
  assert.deepEqual(ctx.registered.map((tool) => tool.name), ['ask_flow'])
})

test('配置容错：乱写的值回落到默认', () => {
  const config = normalizeConfig({ crossSession: { maxDepth: 'abc', rateLimit: null, enabled: 1 } })
  assert.equal(config.crossSession.maxDepth, 3)
  assert.equal(config.crossSession.rateLimit, 3)
  assert.equal(config.crossSession.enabled, true)
})

test('ask_flow 走官方 ask 并返回摘要', async () => {
  const asked = []
  const userQuestions = {
    async ask(request) {
      asked.push(request.questions.map((question) => question.id))
      return {
        answers: request.questions.map((question) => ({
          id: question.id,
          selected: question.id === 'deploy' ? ['A 本地部署'] : ['24G'],
        })),
      }
    },
  }
  const ctx = fakeCtx({ userQuestions })
  apply(ctx, {})
  const tool = toolByName(ctx, 'ask_flow')

  const result = await tool.execute({
    intro: '先确认部署方式',
    steps: [
      {
        id: 'deploy',
        question: '怎么部署？',
        options: [{ label: 'A 本地部署' }, { label: 'B 云端部署' }],
      },
      { id: 'vram', question: '显存多少？', when: { id: 'deploy', in: ['A 本地部署'] } },
      { id: 'cloud', question: '用哪家云？', when: { id: 'deploy', in: ['B 云端部署'] } },
    ],
  }, { agent: fakeAgent() })

  assert.deepEqual(asked, [['deploy'], ['vram']])
  assert.equal(result.cancelled, false)
  assert.deepEqual(result.skipped, ['cloud'])
  assert.match(result.text, /已收到 2 个回答/)
  assert.match(result.text, /A 本地部署/)
  assert.match(result.text, /跳过/)
})

test('ask_flow 在无关面板时给出明确报错', async () => {
  const ctx = fakeCtx({})
  apply(ctx, {})
  const tool = toolByName(ctx, 'ask_flow')
  await assert.rejects(
    () => tool.execute({ steps: [{ id: 'a', question: 'A?' }] }, {}),
    /没有 userQuestions 服务/,
  )
})

test('session_list 过滤子代理和空会话，按时间排序', async () => {
  const sessionController = {
    async list() {
      return { items: SAMPLE_ITEMS }
    },
  }
  const ctx = fakeCtx({ sessionController })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_list')
  const result = await tool.execute({}, { agent: fakeAgent() })
  assert.deepEqual(result.sessions.map((row) => row.sessionId), ['session-video', 'session-idea'])
  assert.equal(result.sessions[0].title, '视频剪辑插件')
  assert.match(result.text, /视频剪辑插件/)
})

test('session_list 支持关键词过滤', async () => {
  const sessionController = { async list() { return { items: SAMPLE_ITEMS } } }
  const ctx = fakeCtx({ sessionController })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_list')
  const result = await tool.execute({ query: '灵感' }, { agent: fakeAgent() })
  assert.deepEqual(result.sessions.map((row) => row.sessionId), ['session-idea'])
})

test('session_send 用 followup 投递，source 不是 user（客户端会渲染成卡片）', async () => {
  const delivered = []
  const sessionController = {
    async list() { return { items: SAMPLE_ITEMS } },
    async resolveAgent() {
      return {
        agent: {
          followup(message) { delivered.push({ channel: 'followup', message }) },
          steer(message) { delivered.push({ channel: 'steer', message }) },
        },
      }
    },
  }
  const ctx = fakeCtx({ sessionController, sessionTitle: { get: () => ({ title: '交互增强' }) } })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_send')

  const result = await tool.execute(
    { session_id: 'session-video', text: '导出接口改好了吗？' },
    { agent: fakeAgent() },
  )

  assert.equal(result.accepted, true)
  assert.equal(result.depth, 1)
  assert.equal(result.mode, 'queue')
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].channel, 'followup')
  const message = delivered[0].message
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'plugin:interaction')
  assert.ok(typeof message.id === 'string' && message.id.startsWith('cross-session-'))
  const sent = message.content[0].text
  assert.match(sent, /【跨会话消息 #depth=1 from=session-self】/)
  assert.match(sent, /来自会话「交互增强」/)
  assert.match(sent, /导出接口改好了吗？/)
})

test('mode=steer 走 agent.steer', async () => {
  const delivered = []
  const sessionController = {
    async list() { return { items: SAMPLE_ITEMS } },
    async resolveAgent() {
      return {
        agent: {
          followup(message) { delivered.push({ channel: 'followup', message }) },
          steer(message) { delivered.push({ channel: 'steer', message }) },
        },
      }
    },
  }
  const ctx = fakeCtx({ sessionController })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_send')
  await tool.execute({ session_id: 'session-video', text: '插队一下', mode: 'steer' }, { agent: fakeAgent() })
  assert.equal(delivered[0].channel, 'steer')
})

test('session_send 拒绝发给自己、空文本和不存在的会话', async () => {
  const sessionController = {
    async list() { return { items: SAMPLE_ITEMS } },
    async prompt() { return { accepted: true } },
  }
  const ctx = fakeCtx({ sessionController })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_send')
  const agent = fakeAgent()

  await assert.rejects(() => tool.execute({ session_id: 'session-self', text: 'hi' }, { agent }), /给自己/)
  await assert.rejects(() => tool.execute({ session_id: 'session-video', text: '   ' }, { agent }), /text 不能为空/)
  await assert.rejects(() => tool.execute({ session_id: 'session-nope', text: 'hi' }, { agent }), /找不到会话/)
})

test('跨会话链路超过 maxDepth 就拒绝', async () => {
  const sessionController = {
    async list() { return { items: SAMPLE_ITEMS } },
    async prompt() { return { accepted: true } },
  }
  const ctx = fakeCtx({ sessionController })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_send')

  // 历史里最后一条是深度 3 的跨会话消息 → 再发就是第 4 层，超过上限 3。
  const agent = fakeAgent({ texts: ['【跨会话消息 #depth=3 from=session-x】\n\n继续'] })
  await assert.rejects(
    () => tool.execute({ session_id: 'session-video', text: '再发一次' }, { agent }),
    /链路已经到第 4 层/,
  )
})

test('同一对会话 60 秒内最多发 rateLimit 条', async () => {
  let now = 1_000_000
  const realNow = Date.now
  Date.now = () => now
  try {
    const sessionController = {
      async list() { return { items: SAMPLE_ITEMS } },
      async resolveAgent() {
        return { agent: { followup() {}, steer() {} } }
      },
    }
    const ctx = fakeCtx({ sessionController })
    apply(ctx, { crossSession: { rateLimit: 2 } })
    const tool = toolByName(ctx, 'session_send')
    const agent = fakeAgent()

    await tool.execute({ session_id: 'session-video', text: '一' }, { agent })
    now += 1000
    await tool.execute({ session_id: 'session-video', text: '二' }, { agent })
    now += 1000
    await assert.rejects(
      () => tool.execute({ session_id: 'session-video', text: '三' }, { agent }),
      /发得太频繁/,
    )
    // 窗口过去之后又能发。
    now += 61_000
    await tool.execute({ session_id: 'session-video', text: '四' }, { agent })
  } finally {
    Date.now = realNow
  }
})

test('session_peek 抽出用户和助手的文本', async () => {
  const sessionController = {
    async list() { return { items: SAMPLE_ITEMS } },
    async events() {
      return {
        hasMore: false,
        records: [
          { type: 'event', event: { type: 'user/message', seq: 1, time: 1000, data: { content: [{ type: 'text', text: '帮我看下导出' }] } } },
          { type: 'event', event: { type: 'tool/call', seq: 2, time: 1100, data: {} } },
          { type: 'event', event: { type: 'assistant/message', seq: 3, time: 1200, data: { content: [{ type: 'text', text: '改好了，你试试' }] } } },
        ],
      }
    },
  }
  const ctx = fakeCtx({ sessionController })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_peek')
  const result = await tool.execute({ session_id: 'session-video' }, { agent: fakeAgent() })
  assert.deepEqual(result.messages.map((message) => message.role), ['用户', '助手'])
  assert.match(result.messages[1].text, /改好了/)
  assert.match(result.text, /最近 2 条/)
})

test('session_peek 过滤系统注入的 runtime-context 快照', async () => {
  const sessionController = {
    async list() { return { items: SAMPLE_ITEMS } },
    async events() {
      return {
        hasMore: false,
        records: [
          {
            type: 'event',
            event: {
              type: 'user/message', seq: 1, time: 900,
              data: {
                source: { kind: 'runtime-context', form: 'snapshot', sections: [] },
                content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier ones.' }],
              },
            },
          },
          {
            type: 'event',
            event: {
              type: 'user/message', seq: 2, time: 950,
              data: {
                source: { kind: 'time-context' },
                content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }],
              },
            },
          },
          { type: 'event', event: { type: 'user/message', seq: 3, time: 1000, data: { content: [{ type: 'text', text: '真的用户消息' }] } } },
          { type: 'event', event: { type: 'assistant/message', seq: 4, time: 1200, data: { content: [{ type: 'text', text: '收到' }] } } },
        ],
      }
    },
  }
  const ctx = fakeCtx({ sessionController })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_peek')
  const result = await tool.execute({ session_id: 'session-video' }, { agent: fakeAgent() })
  assert.deepEqual(result.messages.map((message) => message.text), ['真的用户消息', '收到'])
})

test('session_peek 把跨会话消息标成「跨会话」而不是过滤掉', async () => {
  const sessionController = {
    async list() { return { items: SAMPLE_ITEMS } },
    async events() {
      return {
        hasMore: false,
        records: [
          {
            type: 'event',
            event: {
              type: 'user/message', seq: 1, time: 1000,
              data: {
                source: { kind: 'plugin:interaction' },
                content: [{ type: 'text', text: '【跨会话消息 #depth=1 from=session-x】\n\n来干个活' }],
              },
            },
          },
          { type: 'event', event: { type: 'assistant/message', seq: 2, time: 1100, data: { content: [{ type: 'text', text: '收到。' }] } } },
        ],
      }
    },
  }
  const ctx = fakeCtx({ sessionController })
  apply(ctx, {})
  const tool = toolByName(ctx, 'session_peek')
  const result = await tool.execute({ session_id: 'session-video' }, { agent: fakeAgent() })
  assert.deepEqual(result.messages.map((message) => message.role), ['跨会话', '助手'])
  assert.match(result.messages[0].text, /来干个活/)
})
