#!/usr/bin/env node
/**
 * codex → DSH relay CLI
 *
 * 给外部 agent（codex）用的：发指令 → 等 DSH 会话跑完 → 读结果 → 再发修改意见。
 * 循环由 codex 自己驱动（每条命令都是一次独立的 HTTP 调用），这里只提供原子能力。
 *
 * 用法：
 *   node relay.mjs sessions [--query 关键词]
 *   node relay.mjs send   --session <id> --text "指令" [--mode queue|steer]
 *   node relay.mjs wait   --session <id> [--timeout 180] [--afterSeq 12]
 *   node relay.mjs peek   --session <id> [--limit 6]
 *   node relay.mjs ask    --session <id> --text "指令" [--timeout 180]   # send + wait
 *
 * 输出：一行 JSON 到 stdout（示例）
 *   ask  → { ok, sessionId, reason: "idle"|"input-required"|"timeout", text, messages }
 *   send → { ok, accepted, sessionId, mode }
 *   wait → { ok, reason, running, text, messages }
 *
 * 失败时输出 { ok: false, error }，退出码 1。
 * 服务地址默认 http://127.0.0.1:3080（web profile），可用 --base 或 DSH_RELAY_BASE 覆盖。
 */

const BASE = process.env.DSH_RELAY_BASE || 'http://127.0.0.1:3080'
const API = '/plugins/dsh-interaction/api/relay'

function parseArgs(args) {
  const out = { _: [] }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (!arg.startsWith('--')) {
      out._.push(arg)
      continue
    }
    const key = arg.slice(2)
    const next = args[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out[key] = true
      continue
    }
    out[key] = next
    i += 1
  }
  return out
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

async function call(path, init) {
  const response = await fetch(BASE + API + path, {
    cache: 'no-store',
    ...init,
  })
  let data = null
  try {
    data = await response.json()
  } catch {
    data = null
  }
  if (!data || data.ok !== true) {
    throw new Error((data && data.error) || `HTTP ${response.status}`)
  }
  return data
}

/** 取目标会话最后一条消息的 seq，作为「本次指令之后」的基线。 */
async function lastSeq(sessionId) {
  const data = await call(`/peek?sessionId=${encodeURIComponent(sessionId)}&limit=1`)
  const messages = data.messages || []
  return messages.length > 0 ? Number(messages[messages.length - 1].seq) || 0 : 0
}

/** 轮询式等待：单次最多 20 秒，避免被长连接超时掐断。 */
async function waitForDone(sessionId, timeoutSec, afterSeq) {
  const deadline = Date.now() + timeoutSec * 1000
  let last = null
  while (Date.now() < deadline) {
    const sliceMs = Math.max(5000, Math.min(20000, deadline - Date.now()))
    const params = new URLSearchParams({ sessionId, timeoutMs: String(sliceMs) })
    if (afterSeq !== undefined && afterSeq !== null) params.set('afterSeq', String(afterSeq))
    const data = await call(`/wait?${params.toString()}`)
    last = data
    if (data.reason === 'idle' || data.reason === 'input-required') return data
  }
  return last ?? { ok: true, sessionId, reason: 'timeout', messages: [], text: '' }
}

const USAGE = `codex → DSH relay

  node relay.mjs sessions [--query 关键词]
  node relay.mjs send   --session <id> --text "指令" [--mode queue|steer]
  node relay.mjs wait   --session <id> [--timeout 180] [--afterSeq 12]
  node relay.mjs peek   --session <id> [--limit 6]
  node relay.mjs ask    --session <id> --text "指令" [--timeout 180]

--base 默认 ${BASE}，也可用环境变量 DSH_RELAY_BASE。`

async function main() {
  const argv = process.argv.slice(2)
  const command = argv[0]
  const opts = parseArgs(argv.slice(1))
  if (opts.base && typeof opts.base === 'string') {
    // 允许临时指向别的 host。
    globalThis.__DSH_RELAY_BASE_OVERRIDE__ = opts.base
  }
  const base = globalThis.__DSH_RELAY_BASE_OVERRIDE__
  if (base) {
    // call() 用常量 BASE，这里用替换后的地址重写一次（保持实现简单）。
    const original = globalThis.fetch
    globalThis.fetch = (url, init) => original(String(url).replace(BASE, base), init)
  }

  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(`${USAGE}\n`)
    return
  }

  if (command === 'sessions') {
    const query = typeof opts.query === 'string' ? opts.query : ''
    const data = await call(`/sessions?query=${encodeURIComponent(query)}`)
    print({ ok: true, total: data.total, sessions: data.sessions })
    return
  }

  if (command === 'peek') {
    if (!opts.session) throw new Error('缺少 --session')
    const data = await call(`/peek?sessionId=${encodeURIComponent(opts.session)}&limit=${opts.limit || 6}`)
    print({ ok: true, sessionId: data.sessionId, messages: data.messages })
    return
  }

  if (command === 'send') {
    if (!opts.session) throw new Error('缺少 --session')
    if (typeof opts.text !== 'string' || !opts.text.trim()) throw new Error('缺少 --text')
    const data = await call('/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: opts.session, text: opts.text, mode: opts.mode }),
    })
    print({ ok: true, accepted: data.accepted, sessionId: data.sessionId, mode: data.mode })
    return
  }

  if (command === 'wait') {
    if (!opts.session) throw new Error('缺少 --session')
    const timeout = Number(opts.timeout) || 180
    const afterSeq = opts.afterSeq === undefined ? undefined : Number(opts.afterSeq)
    const data = await waitForDone(opts.session, timeout, afterSeq)
    print({
      ok: true,
      sessionId: opts.session,
      reason: data.reason,
      running: data.running === true,
      text: data.text || '',
      messages: data.messages || [],
    })
    return
  }

  if (command === 'ask') {
    if (!opts.session) throw new Error('缺少 --session')
    if (typeof opts.text !== 'string' || !opts.text.trim()) throw new Error('缺少 --text')
    const baseline = await lastSeq(opts.session)
    const sent = await call('/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: opts.session, text: opts.text, mode: opts.mode }),
    })
    const timeout = Number(opts.timeout) || 180
    const done = await waitForDone(opts.session, timeout, baseline)
    print({
      ok: true,
      sessionId: opts.session,
      accepted: sent.accepted,
      reason: done.reason,
      running: done.running === true,
      text: done.text || '',
      messages: done.messages || [],
    })
    return
  }

  throw new Error(`未知命令：${command}\n${USAGE}`)
}

main().catch((error) => {
  print({ ok: false, error: String((error && error.message) || error) })
  process.exitCode = 1
})
