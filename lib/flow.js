/**
 * 分支提问的纯逻辑层：条件解析、依赖成环检测、波次选择。
 *
 * 这一层不碰任何 DSH 服务，全部可单测。ask.js 只负责把选出来的波次
 * 交给 ctx.userQuestions.ask()。
 */

/** 一条条件规则：某个问题的答案是否命中一组取值。 */
export const RULE_MODES = ['in', 'not_in', 'answered']

/**
 * 把一个 when 声明摊平成规则数组（多个条件之间是 AND）。
 *
 * 支持的写法：
 *   { id: 'q1', in: ['A'] }
 *   { id: 'q1', not_in: ['A'] }
 *   { id: 'q1', answered: true }
 *   [ { id: 'q1', in: ['A'] }, { id: 'q2', in: ['B'] } ]   // AND
 */
export function normalizeWhen(when) {
  if (when === undefined || when === null) return []
  if (Array.isArray(when)) return when.flatMap((item) => normalizeWhen(item))
  if (typeof when !== 'object') return []
  const id = typeof when.id === 'string' ? when.id.trim() : ''
  if (!id) return []
  if (Array.isArray(when.in)) return [{ id, mode: 'in', values: when.in.map((value) => String(value)) }]
  if (Array.isArray(when.not_in)) return [{ id, mode: 'not_in', values: when.not_in.map((value) => String(value)) }]
  if (when.answered === true) return [{ id, mode: 'answered', values: [] }]
  if (when.answered === false) return [{ id, mode: 'in', values: [] }]
  return []
}

/**
 * 校验并规范化 steps。
 * @param {unknown} raw - 模型传进来的 steps 参数。
 * @returns {Array<{id: string, question: string, header?: string, detail?: string, options?: Array<{label: string, description?: string}>, multiSelect?: boolean, rules: Array}>}
 * @throws {Error} 参数不合法时抛出带中文原因的错误。
 */
export function normalizeSteps(raw) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('steps 不能为空，至少给一个问题')
  if (raw.length > 20) throw new Error(`steps 最多 20 个问题，收到 ${raw.length} 个`)

  const steps = raw.map((item, index) => {
    if (item === null || typeof item !== 'object') throw new Error(`steps[${index}] 不是对象`)
    const id = typeof item.id === 'string' ? item.id.trim() : ''
    if (!id) throw new Error(`steps[${index}] 缺少 id`)
    const question = typeof item.question === 'string' ? item.question.trim() : ''
    if (!question) throw new Error(`步骤 "${id}" 缺少 question`)

    let options
    if (Array.isArray(item.options)) {
      if (item.options.length > 12) throw new Error(`步骤 "${id}" 的 options 最多 12 个`)
      options = item.options.map((option, optionIndex) => {
        const label = typeof option?.label === 'string' ? option.label.trim() : ''
        if (!label) throw new Error(`步骤 "${id}" 的 options[${optionIndex}] 缺少 label`)
        const view = { label }
        if (typeof option.description === 'string' && option.description.trim()) {
          view.description = option.description.trim()
        }
        return view
      })
      if (options.length === 0) options = undefined
    }

    const step = {
      id,
      question,
      rules: normalizeWhen(item.when),
    }
    if (typeof item.header === 'string' && item.header.trim()) step.header = item.header.trim()
    if (typeof item.detail === 'string' && item.detail.trim()) step.detail = item.detail.trim()
    if (options !== undefined) step.options = options
    if (item.multi_select === true) step.multiSelect = true
    return step
  })

  const byId = new Map()
  for (const step of steps) {
    if (byId.has(step.id)) throw new Error(`步骤 id 重复："${step.id}"`)
    byId.set(step.id, step)
  }

  for (const step of steps) {
    for (const rule of step.rules) {
      if (rule.id === step.id) throw new Error(`步骤 "${step.id}" 不能依赖自己`)
      if (!byId.has(rule.id)) throw new Error(`步骤 "${step.id}" 的 when 引用了不存在的步骤 "${rule.id}"`)
      // 不能既依赖又要求条件永不成立（无意义的空 in）
      if (rule.mode === 'in' && rule.values.length === 0) {
        throw new Error(`步骤 "${step.id}" 的 when.in 是空数组，这个条件永远不会成立`)
      }
    }
  }

  assertAcyclic(steps)
  return steps
}

/** DFS 检测依赖环，顺便保证依赖链不会无限深。 */
function assertAcyclic(steps) {
  const refs = new Map(steps.map((step) => [step.id, step.rules.map((rule) => rule.id)]))
  const visiting = new Set()
  const done = new Set()

  const visit = (id, path) => {
    if (done.has(id)) return
    if (visiting.has(id)) {
      throw new Error(`步骤依赖成环：${[...path, id].join(' → ')}`)
    }
    visiting.add(id)
    for (const ref of refs.get(id) ?? []) {
      if (refs.has(ref)) visit(ref, [...path, id])
    }
    visiting.delete(id)
    done.add(id)
  }

  for (const step of steps) visit(step.id, [])
}

/** 一条规则在给定状态下的判定结果：true / false / 'pending'（依赖还没答案）。 */
function evaluateRule(rule, state) {
  const known = state.answers.has(rule.id) || state.skipped.has(rule.id)
  if (!known) return 'pending'
  // 依赖的问题被跳过了，依赖它的分支也就不成立。
  if (state.skipped.has(rule.id)) return false
  const entry = state.answers.get(rule.id)
  const picked = entry?.selected ?? []
  const custom = entry?.custom
  const hits = rule.values.some((value) => picked.includes(value) || (custom !== undefined && custom === value))
  if (rule.mode === 'in') return hits
  if (rule.mode === 'not_in') return !hits
  return true
}

/**
 * 判定一个步骤的 when 条件。
 * @returns {true | false | 'pending'}
 */
export function evaluateWhen(rules, state) {
  if (!rules || rules.length === 0) return true
  let pending = false
  for (const rule of rules) {
    const verdict = evaluateRule(rule, state)
    if (verdict === false) return false
    if (verdict === 'pending') pending = true
  }
  return pending ? 'pending' : true
}

/** 新建一份流程状态。 */
export function createFlowState() {
  return {
    answers: new Map(),
    skipped: new Set(),
  }
}

/**
 * 选出当前能问的一波问题。
 *
 * 能进同一波的条件：自身没答没跳过，且所有前置依赖都已定（有答案或已跳过）。
 * 条件判否的步骤会被就地标成 skipped（永久跳过）。
 *
 * @param {Array} steps - normalizeSteps 的结果。
 * @param {{answers: Map, skipped: Set}} state - 会被就地修改。
 * @returns {{wave: Array, changed: boolean, remaining: number}}
 */
export function selectWave(steps, state) {
  const wave = []
  let changed = false
  for (const step of steps) {
    if (state.answers.has(step.id) || state.skipped.has(step.id)) continue
    const verdict = evaluateWhen(step.rules, state)
    if (verdict === true) wave.push(step)
    else if (verdict === false) {
      state.skipped.add(step.id)
      changed = true
    }
  }
  const remaining = steps.filter((step) => !state.answers.has(step.id) && !state.skipped.has(step.id)).length
  return { wave, changed, remaining }
}

/** 把答案条目记进状态。 */
export function recordAnswer(state, id, entry) {
  state.answers.set(id, {
    selected: Array.isArray(entry?.selected) ? entry.selected.map((value) => String(value)) : [],
    ...(typeof entry?.custom === 'string' && entry.custom.trim() ? { custom: entry.custom.trim() } : {}),
  })
}

/** 给模型看的答案摘要行。 */
export function summarizeAnswers(steps, state) {
  const lines = []
  for (const step of steps) {
    const entry = state.answers.get(step.id)
    if (entry === undefined) continue
    const picked = entry.selected.length > 0 ? entry.selected.join('、') : ''
    const custom = entry.custom ? `${picked ? '；' : ''}自定义：${entry.custom}` : ''
    lines.push(`- ${step.question} → ${picked}${custom}`.trim())
  }
  return lines
}
