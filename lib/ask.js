/**
 * 分支提问的编排层：把「波次」交给官方 ctx.userQuestions.ask()，逐波收答案。
 *
 * 为什么走官方 ask：
 * - 卡片样式、多选、自定义输入、键盘操作全部直接用官方 UI，零前端代码；
 * - 只依赖 ctx.userQuestions.ask 这个稳定服务方法，DSH 升级不易坏。
 *
 * 跨波返回：官方卡片提交即结束，没法回退到上一波。这里用「往选项里加一个
 * 返回项」的办法补：用户选了它，当前波作废、退回上一波重问。第一波没有上一波，
 * 所以不显示返回项；另有次数上限防止来回刷。
 */

import { createFlowState, recordAnswer, selectWave } from './flow.js'

/** 返回上一波的哨兵选项文案。用户可见，所以写成正常人话。 */
export const BACK_LABEL = '← 返回上一题'

/** 同一轮里最多允许回退几次（防死循环）。 */
export const MAX_BACKS = 20

/** 用户关掉了提问面板（或被中止）：不是错误，是「不想继续」。 */
export function isCancellation(error) {
  const code = error?.code
  return code === 'NO_PROVIDER' || code === 'ASK_ABORTED' || code === 'ASK_TIMED_OUT'
}

/** 已答问题的前情摘要，放问题的 detail 里（官方会渲染成 markdown）。 */
function contextLines(steps, state) {
  const lines = []
  for (const step of steps) {
    const entry = state.answers.get(step.id)
    if (entry === undefined) continue
    const picked = entry.selected.length > 0 ? entry.selected.join('、') : ''
    const custom = entry.custom ? `${picked ? ' + ' : ''}${entry.custom}` : ''
    if (picked || custom) lines.push(`- **${step.question}** → ${picked}${custom}`)
  }
  return lines
}

/** 回退后重问时，把上一轮的选择提示出来，免得用户以为答案丢了。 */
function backHintLine(step, backHints) {
  const old = backHints?.get(step.id)
  if (old === undefined) return undefined
  const picked = old.selected.filter((label) => label !== BACK_LABEL).join('、')
  const text = picked || old.custom
  if (!text) return undefined
  return `> 上次你选的是「${text}」，重新选一次即可修改。`
}

/** 组装一次 ask 的单个问题条目。 */
function buildQuestion(step, waveIndex, steps, state, intro, canGoBack, backHints) {
  const headerBits = [`第 ${waveIndex} 步`]
  if (step.header) headerBits.push(step.header)

  const detailParts = []
  if (waveIndex === 1 && intro) detailParts.push(intro)
  if (waveIndex > 1) {
    const lines = contextLines(steps, state)
    if (lines.length > 0) detailParts.push(['**目前已确认：**', ...lines].join('\n'))
  }
  const hint = backHintLine(step, backHints)
  if (hint !== undefined) detailParts.push(hint)
  if (step.detail) detailParts.push(step.detail)

  const item = {
    id: step.id,
    question: step.question,
    header: headerBits.join(' · '),
  }
  const options = step.options === undefined ? [] : [...step.options]
  if (canGoBack) {
    options.push({ label: BACK_LABEL, description: '回到上一波重新回答（当前这波的选择会作废）' })
  }
  if (options.length > 0) item.options = options
  if (step.multiSelect) item.multiSelect = true
  if (detailParts.length > 0) item.detail = detailParts.join('\n\n')
  return item
}

/** 要求稳定的一波：条件判否的步骤会被标成跳过，跳过之后可能又有关键依赖变得可判定。 */
function stableWave(steps, state) {
  let selection = selectWave(steps, state)
  while (selection.wave.length === 0 && selection.changed) {
    selection = selectWave(steps, state)
  }
  return selection
}

/**
 * 跑完一张问题图。
 *
 * @param {object} options
 * @param {object} options.userQuestions - ctx.userQuestions 服务。
 * @param {object} [options.agent] - 调用者 agent（live root 才有资格提问）。
 * @param {AbortSignal} [options.signal] - 工具调用的取消信号。
 * @param {Array} options.steps - normalizeSteps 的结果。
 * @param {string} [options.intro] - 第一张卡片的顶部说明。
 * @param {(message: string) => void} [options.log] - 诊断日志。
 * @returns {Promise<{answers: Array, skipped: string[], waves: Array, cancelled: boolean, backs: number}>}
 */
export async function runAskFlow({ userQuestions, agent, signal, steps, intro, log }) {
  const state = createFlowState()
  /** 已完成的波次栈：回退就是弹它。 */
  const history = []
  /** 回退后暂存的旧答案，只用于给用户提示，不参与条件判定。 */
  const backHints = new Map()
  let backs = 0

  for (;;) {
    const selection = stableWave(steps, state)
    if (selection.wave.length === 0) break

    const waveIndex = history.length + 1
    const canGoBack = history.length > 0 && backs < MAX_BACKS
    const questions = selection.wave.map(
      (step) => buildQuestion(step, waveIndex, steps, state, intro, canGoBack, backHints),
    )
    log?.(`第 ${waveIndex} 波：${selection.wave.map((step) => step.id).join(', ')}`)

    let answer
    try {
      answer = await userQuestions.ask({
        questions,
        ...(agent === undefined ? {} : { agent }),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error) {
      if (isCancellation(error)) {
        return {
          answers: snapshotAnswers(steps, state),
          skipped: [...state.skipped],
          waves: history.map((entry, index) => ({ index: index + 1, ids: entry.ids })),
          cancelled: true,
          backs,
        }
      }
      throw error
    }

    const wantsBack = backs < MAX_BACKS
      && history.length > 0
      && (answer?.answers ?? []).some(
        (item) => Array.isArray(item?.selected) && item.selected.includes(BACK_LABEL),
      )
    if (wantsBack) {
      backs += 1
      const previous = history.pop()
      for (const id of previous.ids) {
        const old = state.answers.get(id)
        state.answers.delete(id)
        if (old !== undefined) backHints.set(id, old)
      }
      // skipped 是由「条件不成立」派生出来的缓存。回退改了前面的答案之后，
      // 原来被跳过的分支可能重新成立，必须清掉重新判定，否则会永久漏问。
      state.skipped.clear()
      log?.(`用户要求返回上一波（第 ${previous.ids.join(', ')} 题）`)
      continue
    }

    for (const item of answer?.answers ?? []) {
      const step = selection.wave.find((candidate) => candidate.id === item?.id)
      if (step !== undefined) {
        // 返回哨兵永远不该落进最终答案：它只是一个导航动作。
        recordAnswer(state, step.id, {
          selected: (Array.isArray(item?.selected) ? item.selected : []).filter((label) => label !== BACK_LABEL),
          ...(item?.custom === undefined ? {} : { custom: item.custom }),
        })
      }
    }
    // 官方承诺一道题一个答案；万一某个没回来，也记成「空答案」避免死循环。
    for (const step of selection.wave) {
      if (!state.answers.has(step.id)) recordAnswer(state, step.id, { selected: [] })
    }
    for (const step of selection.wave) backHints.delete(step.id)

    history.push({
      ids: selection.wave.map((step) => step.id),
      answers: new Map(selection.wave.map((step) => [step.id, state.answers.get(step.id)])),
    })
  }

  return {
    answers: snapshotAnswers(steps, state),
    skipped: [...state.skipped],
    waves: history.map((entry, index) => ({ index: index + 1, ids: entry.ids })),
    cancelled: false,
    backs,
  }
}

/** 把内部状态摊平成工具输出。 */
function snapshotAnswers(steps, state) {
  const out = []
  for (const step of steps) {
    const entry = state.answers.get(step.id)
    if (entry === undefined) continue
    out.push({
      id: step.id,
      question: step.question,
      selected: [...entry.selected],
      ...(entry.custom === undefined ? {} : { custom: entry.custom }),
    })
  }
  return out
}
