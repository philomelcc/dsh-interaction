/**
 * 跨会话消息：列表、投递、回读，外加防环与限频。
 *
 * 官方通道：ctx.sessionController.prompt() —— 它会 resolveAgent，目标会话冷着
 * 就自动 resume 再把消息投进 inbox。我们只负责「谁能发、发给谁、发什么」。
 */

import { randomUUID } from 'node:crypto'

/** 跨会话消息的标记行，插件靠它认出「这条是别的会话发来的」并算链路深度。 */
export const CROSS_SESSION_MARK = /^【跨会话消息 #depth=(\d+) from=([^】\s]+)】/

const DEFAULT_MAX_DEPTH = 3
const DEFAULT_RATE_LIMIT = 3
const RATE_WINDOW_MS = 60_000

/** 会话桥：一次插件生命周期内复用，内存状态（重启清零，正好不误伤）。 */
export function createSessionBridge({ ctx, config = {}, log }) {
  const maxDepth = Number.isFinite(config.maxDepth) ? Math.max(1, Math.trunc(config.maxDepth)) : DEFAULT_MAX_DEPTH
  const rateLimit = Number.isFinite(config.rateLimit) ? Math.max(1, Math.trunc(config.rateLimit)) : DEFAULT_RATE_LIMIT
  /** `${from}>${to}` → 最近一次发送时间戳数组。 */
  const sentAt = new Map()

  const controller = () => ctx.get('sessionController')

  function requireController() {
    const service = controller()
    if (service === undefined) {
      throw new Error('当前部署没有 sessionController（跨会话功能需要 web/desktop 装配），无法发送')
    }
    return service
  }

  /** 读会话列表（读不到标题不要紧，至少给 id）。 */
  async function listSessions({ query = '', limit = 20, signal, excludeSelf = false, selfId } = {}) {
    const service = requireController()
    // relay 这类外部调用不传 signal；传给远程服务前兜一个，否则内部 throwIfAborted 会炸。
    const abortSignal = signal ?? new AbortController().signal
    const value = await service.list({}, abortSignal)
    const items = Array.isArray(value?.items) ? value.items : []
    const keyword = String(query || '').trim().toLowerCase()

    const rows = []
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      if (item.origin === 'subagent') continue
      if (item.blank === true) continue
      if (excludeSelf && selfId !== undefined && item.sessionId === selfId) continue
      const title = item.projections?.values?.title ?? null
      const row = {
        sessionId: String(item.sessionId),
        title: typeof title === 'string' && title.trim() ? title.trim() : '(无标题)',
        running: item.running === true,
        agentAvailable: item.agentAvailable === true,
        cwd: typeof item.cwd === 'string' ? item.cwd : undefined,
        updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : undefined,
      }
      if (keyword) {
        const haystack = `${row.title} ${row.sessionId} ${row.cwd ?? ''}`.toLowerCase()
        if (!haystack.includes(keyword)) continue
      }
      rows.push(row)
    }

    rows.sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0))
    const capped = rows.slice(0, Math.max(1, Math.min(Number(limit) || 20, 100)))
    return { sessions: capped, total: rows.length }
  }

  /** 目标会话是否存在（不激活它，只读列表）。 */
  async function findSession(sessionId, signal) {
    const { sessions } = await listSessions({ limit: 100, signal })
    return sessions.find((row) => row.sessionId === sessionId)
  }

  /**
   * 从当前会话最近的历史里找「别的会话发来的跨会话消息」，据此算链路深度。
   * 找不到就是 0（本次是新一轮跨会话对话）。
   */
  function inboundDepth(agent) {
    const session = agent?.session
    if (session === undefined || session === null) return 0
    try {
      const end = typeof session.seq === 'number' ? session.seq : 0
      const floor = Math.max(0, end - 300)
      for (let seq = end - 1; seq >= floor; seq -= 1) {
        const event = session.eventAt(seq)
        if (event?.type !== 'user/message') continue
        const content = event.data?.content
        if (!Array.isArray(content)) continue
        for (const block of content) {
          if (block?.type !== 'text' || typeof block.text !== 'string') continue
          const match = block.text.match(CROSS_SESSION_MARK)
          if (match) return Number.parseInt(match[1], 10) || 0
        }
      }
    } catch {
      // 读历史失败不影响发送，当 0 处理（宁可少拦一次，也不让功能整块挂掉）。
    }
    return 0
  }

  /** 限频检查：同一对会话 60 秒内最多 rateLimit 条。 */
  function checkRate(fromId, toId) {
    const key = `${fromId}>${toId}`
    const now = Date.now()
    const recent = (sentAt.get(key) ?? []).filter((at) => now - at < RATE_WINDOW_MS)
    if (recent.length >= rateLimit) {
      const waitSeconds = Math.max(1, Math.ceil((RATE_WINDOW_MS - (now - recent[0])) / 1000))
      throw new Error(`发得太频繁了：同一会话 60 秒内最多 ${rateLimit} 条，请等约 ${waitSeconds} 秒再发`)
    }
    recent.push(now)
    sentAt.set(key, recent)
  }

  /**
   * 向目标会话投递一条消息。
   * @param {object} options
   * @param {object} [options.fromAgent] - 来源 agent；外部调用（codex relay）传 null。
   * @param {string} [options.fromTitle] - 来源显示名；relay 用 'Codex'。
   * @param {boolean} [options.skipGuards] - 跳过防环与限频（外部 relay 不受会话间护栏约束）。
   * @returns {Promise<{accepted: boolean, sessionId: string, mode: string, depth: number}>}
   */
  async function sendMessage({ fromAgent, fromTitle, sessionId, text, mode = 'queue', signal, skipGuards = false }) {
    const service = requireController()
    const target = String(sessionId || '').trim()
    if (!target) throw new Error('session_id 不能为空')
    const body = String(text || '').trim()
    if (!body) throw new Error('text 不能为空，写清楚要对方做什么')
    if (body.length > 8000) throw new Error('text 太长（上限 8000 字），请精简')

    const fromId = String(fromAgent?.id ?? '')
    if (fromId && target === fromId) throw new Error('不能给自己发跨会话消息，直接说话就行')

    const delivery = mode === 'steer' ? 'steer' : 'queue'
    const session = await findSession(target, signal)
    if (session === undefined) {
      throw new Error(`找不到会话 "${target}"，先用 session_list 查一下准确 id`)
    }

    let depth = 1
    if (!skipGuards) {
      depth = inboundDepth(fromAgent) + 1
      if (depth > maxDepth) {
        throw new Error(`跨会话链路已经到第 ${depth} 层（上限 ${maxDepth} 层），拒绝继续转发，避免两个会话无限互叫`)
      }
      checkRate(fromId || 'unknown', target)
    }

    const fromLabel = String(fromTitle || '').trim() || (fromId ? fromId.slice(0, 18) : '另一个会话')
    const headerLines = [`【跨会话消息 #depth=${depth} from=${fromId || 'unknown'}】`, `来自会话「${fromLabel}」`]
    if (session.cwd) headerLines.push(`目标工作区：${session.cwd}`)
    const marked = `${headerLines.join('\n')}\n\n${body}`

    // 走 agent.followup 而不是 sessionController.prompt：
    // 后者的 source 固定是 'user'，在目标会话里会伪装成用户本人说话。
    // followup 带上生产者自有的 source.kind（不是 'user'），客户端就会把这条消息
    // 渲染成「收到执行请求」折叠卡片（turn-trigger 的默认分支），一眼能看出是 AI 发的。
    const agent = await resolveTargetAgent(service, target)
    const message = {
      id: `cross-session-${randomUUID()}`,
      role: 'user',
      content: [{ type: 'text', text: marked }],
      source: { kind: 'plugin:interaction' },
    }
    if (delivery === 'steer') agent.steer(message)
    else agent.followup(message)

    log?.(`跨会话投递 ${fromId || '?'} → ${target}（depth=${depth}, mode=${delivery}）`)
    return { accepted: true, sessionId: target, mode: delivery, depth, title: session.title }
  }

  /**
   * 拿到目标会话的 live agent（冷会话会被 resume）。
   * @returns {Promise<{followup: Function, steer: Function}>}
   */
  async function resolveTargetAgent(service, target) {
    if (typeof service.resolveAgent !== 'function') {
      throw new Error('当前 dsh 版本的 sessionController 没有 resolveAgent，跨会话投递不可用')
    }
    const found = await service.resolveAgent(target)
    if (found === undefined || found === null) {
      throw new Error(`会话 "${target}" 没有可用的 agent`)
    }
    if (typeof found === 'object' && 'error' in found && found.error) throw found.error
    const agent = typeof found === 'object' && 'agent' in found ? found.agent : found
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
      throw new Error(`会话 "${target}" 拿不到可投递的 agent`)
    }
    return agent
  }

  /**
   * 读目标会话最近的消息，看对方回了什么。
   *
   * 必须过滤掉系统注入的 user 消息（runtime-context 快照、time-context 时间戳之类）：
   * 它们也是 user/message，但 source.kind 不是 `user`，内容又长得离谱，
   * 不过滤的话 peek 出来全是噪声，根本看不到真正的对话。
   * @returns {Promise<{messages: Array<{role: string, seq: number, at: number, text: string}>}>}
   */
  async function peekSession({ sessionId, limit = 6, signal }) {
    const service = requireController()
    const target = String(sessionId || '').trim()
    if (!target) throw new Error('session_id 不能为空')
    const want = Math.max(1, Math.min(Number(limit) || 6, 30))
    // 系统注入消息会占名额，所以多读一截再过滤。
    const page = await service.events({
      address: { kind: 'session', sessionId: target },
      maxMessages: Math.min(want * 6 + 10, 120),
    }, signal ?? new AbortController().signal)

    const records = Array.isArray(page?.records) ? page.records : []
    const messages = []
    for (const record of records) {
      const event = record?.event ?? record
      const type = event?.type
      const sourceKind = event?.data?.source?.kind
      const role = type === 'user/message'
        ? (sourceKind === CROSS_SESSION_SOURCE ? '跨会话' : '用户')
        : type === 'assistant/message' ? '助手' : null
      if (role === null) continue
      if (type === 'user/message' && !isConversationMessage(event?.data)) continue
      const text = extractText(event?.data)
      if (!text) continue
      // 长得离谱的防御性丢弃：真对话不会单条上万字，系统快照会。
      if (text.length > 6000) continue
      messages.push({
        role,
        seq: Number(event.seq) || 0,
        at: Number(event.time) || 0,
        text: text.length > 1200 ? `${text.slice(0, 1200)}…` : text,
      })
    }
    return { messages: messages.slice(-want) }
  }

  return { listSessions, sendMessage, peekSession, findSession }
}

/** 跨会话消息在目标会话里的 source.kind（不是 'user'，所以客户端渲染成折叠卡片）。 */
export const CROSS_SESSION_SOURCE = 'plugin:interaction'

/**
 * 这条 user 消息是不是「真对话」里的一条。
 *
 * 系统注入的上下文（runtime-context 快照、time-context 读数）也是 user/message，
 * 但 source.kind 不是 `user`。真实的用户输入是 `user`；别的会话发来的是
 * `plugin:interaction`（我们自己的）。
 */
export function isConversationMessage(data) {
  const kind = data?.source?.kind
  return kind === undefined || kind === 'user' || kind === CROSS_SESSION_SOURCE
}

/** 从一条 user/assistant 消息事件里抠出纯文本。结构有几种写法，挨个试。 */
export function extractText(data) {
  if (data === null || typeof data !== 'object') return ''
  const candidates = [data.content, data.message?.content, data.blocks]
  for (const content of candidates) {
    if (!Array.isArray(content)) continue
    const parts = []
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
    if (parts.length > 0) return parts.join('\n').trim()
  }
  if (typeof data.text === 'string') return data.text.trim()
  return ''
}
