/**
 * 分支提问的纯逻辑 + 编排单测。
 * 跑法：node --test test/
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createFlowState, normalizeSteps, selectWave } from '../lib/flow.js'
import { runAskFlow } from '../lib/ask.js'

/** 按预设答案 mock 一次 ask，记录每次问了哪些题。 */
function mockAsk(plan) {
  const calls = []
  return {
    calls,
    async ask(request) {
      calls.push(request.questions.map((question) => question.id))
      return {
        answers: request.questions.map((question) => {
          const pick = plan[question.id]
          return {
            id: question.id,
            selected: pick?.selected ?? [],
            ...(pick?.custom === undefined ? {} : { custom: pick.custom }),
          }
        }),
      }
    },
  }
}

const DEPLOY_STEPS = [
  {
    id: 'deploy',
    question: '你打算怎么部署？',
    options: [{ label: 'A 本地部署' }, { label: 'B 云端部署' }],
  },
  {
    id: 'vram',
    question: '本地显存多少？',
    when: { id: 'deploy', in: ['A 本地部署'] },
  },
  {
    id: 'cloud',
    question: '用哪家云？',
    when: { id: 'deploy', in: ['B 云端部署'] },
  },
]

test('无依赖的问题合并成一波', () => {
  const steps = normalizeSteps([
    { id: 'a', question: 'A?' },
    { id: 'b', question: 'B?' },
  ])
  const state = createFlowState()
  const { wave } = selectWave(steps, state)
  assert.deepEqual(wave.map((step) => step.id), ['a', 'b'])
})

test('选 A 只问 A 的后续，选 B 只问 B 的后续', async () => {
  const steps = normalizeSteps(DEPLOY_STEPS)

  const local = mockAsk({ deploy: { selected: ['A 本地部署'] }, vram: { selected: ['24G'] } })
  const resultA = await runAskFlow({ userQuestions: local, steps })
  assert.deepEqual(local.calls, [['deploy'], ['vram']])
  assert.equal(resultA.cancelled, false)
  assert.deepEqual(resultA.skipped, ['cloud'])
  assert.deepEqual(resultA.answers.map((item) => item.id), ['deploy', 'vram'])

  const cloud = mockAsk({ deploy: { selected: ['B 云端部署'] }, cloud: { selected: ['阿里云'] } })
  const resultB = await runAskFlow({ userQuestions: cloud, steps })
  assert.deepEqual(cloud.calls, [['deploy'], ['cloud']])
  assert.deepEqual(resultB.skipped, ['vram'])
  assert.deepEqual(resultB.answers.map((item) => item.id), ['deploy', 'cloud'])
})

test('三级依赖链按顺序分三波', async () => {
  const steps = normalizeSteps([
    { id: 'one', question: '一?' },
    { id: 'two', question: '二?', when: { id: 'one', in: ['x'] } },
    { id: 'three', question: '三?', when: { id: 'two', in: ['y'] } },
  ])
  const ask = mockAsk({
    one: { selected: ['x'] },
    two: { selected: ['y'] },
    three: { selected: ['z'] },
  })
  const result = await runAskFlow({ userQuestions: ask, steps })
  assert.deepEqual(ask.calls, [['one'], ['two'], ['three']])
  assert.equal(result.waves.length, 3)
})

test('not_in 条件：选了别的才问', async () => {
  const steps = normalizeSteps([
    { id: 'one', question: '一?', options: [{ label: 'A' }, { label: 'B' }] },
    { id: 'follow', question: '不问 A 时?', when: { id: 'one', not_in: ['A'] } },
  ])
  const askA = mockAsk({ one: { selected: ['A'] } })
  const resultA = await runAskFlow({ userQuestions: askA, steps })
  assert.deepEqual(askA.calls, [['one']])
  assert.deepEqual(resultA.skipped, ['follow'])

  const askB = mockAsk({ one: { selected: ['B'] }, follow: { selected: [] } })
  const resultB = await runAskFlow({ userQuestions: askB, steps })
  assert.deepEqual(askB.calls, [['one'], ['follow']])
  assert.deepEqual(resultB.skipped, [])
})

test('自定义输入也能命中 in 条件', async () => {
  const steps = normalizeSteps([
    { id: 'deploy', question: '怎么部署？', options: [{ label: 'A 本地部署' }] },
    { id: 'vram', question: '显存？', when: { id: 'deploy', in: ['自己搞'] } },
  ])
  const ask = mockAsk({ deploy: { selected: [], custom: '自己搞' }, vram: { selected: [] } })
  const result = await runAskFlow({ userQuestions: ask, steps })
  assert.deepEqual(ask.calls, [['deploy'], ['vram']])
  assert.deepEqual(result.skipped, [])
})

test('依赖被跳过时，下游也一起跳过', async () => {
  const steps = normalizeSteps([
    { id: 'a', question: 'A?', options: [{ label: 'no' }] },
    { id: 'b', question: 'B?', when: { id: 'a', in: ['yes'] } },
    { id: 'c', question: 'C?', when: { id: 'b', in: ['anything'] } },
  ])
  const ask = mockAsk({ a: { selected: ['no'] } })
  const result = await runAskFlow({ userQuestions: ask, steps })
  assert.deepEqual(ask.calls, [['a']])
  assert.deepEqual(result.skipped.sort(), ['b', 'c'])
})

test('用户中途关面板：返回 cancelled 且带上已答部分', async () => {
  const steps = normalizeSteps(DEPLOY_STEPS)
  let call = 0
  const userQuestions = {
    async ask(request) {
      call += 1
      if (call === 1) return { answers: [{ id: 'deploy', selected: ['A 本地部署'] }] }
      const error = new Error('没有可用界面')
      error.code = 'NO_PROVIDER'
      throw error
    },
  }
  const result = await runAskFlow({ userQuestions, steps })
  assert.equal(result.cancelled, true)
  assert.deepEqual(result.answers.map((item) => item.id), ['deploy'])
  assert.equal(result.waves.length, 1)
})

test('连环依赖成环直接报错', () => {
  assert.throws(
    () => normalizeSteps([
      { id: 'a', question: 'A?', when: { id: 'b', in: ['x'] } },
      { id: 'b', question: 'B?', when: { id: 'a', in: ['x'] } },
    ]),
    /成环/,
  )
})

test('when 引用不存在的步骤报错', () => {
  assert.throws(
    () => normalizeSteps([{ id: 'a', question: 'A?', when: { id: 'nope', in: ['x'] } }]),
    /不存在的步骤/,
  )
})

test('步骤 id 重复与空 steps 都报错', () => {
  assert.throws(() => normalizeSteps([{ id: 'a', question: 'A?' }, { id: 'a', question: 'B?' }]), /重复/)
  assert.throws(() => normalizeSteps([]), /不能为空/)
})

test('每一步都带上第 N 步的进度 header', async () => {
  const steps = normalizeSteps(DEPLOY_STEPS)
  const seen = []
  const userQuestions = {
    async ask(request) {
      for (const question of request.questions) seen.push({ id: question.id, header: question.header })
      return {
        answers: request.questions.map((question) => ({
          id: question.id,
          selected: question.id === 'deploy' ? ['A 本地部署'] : [],
        })),
      }
    },
  }
  await runAskFlow({ userQuestions, steps, intro: '先把部署方式定下来' })
  assert.deepEqual(seen.map((item) => item.header), ['第 1 步', '第 2 步'])
})

test('第二波起详情里带上已确认项', async () => {
  const steps = normalizeSteps(DEPLOY_STEPS)
  const details = []
  const userQuestions = {
    async ask(request) {
      for (const question of request.questions) details.push({ id: question.id, detail: question.detail })
      const answers = request.questions.map((question) => ({
        id: question.id,
        selected: question.id === 'deploy' ? ['A 本地部署'] : ['24G'],
      }))
      return { answers }
    },
  }
  await runAskFlow({ userQuestions, steps })
  const vram = details.find((item) => item.id === 'vram')
  assert.match(vram.detail, /目前已确认/)
  assert.match(vram.detail, /A 本地部署/)
})

// ---------------------------------------------------------------- 跨波返回

const BACK = '← 返回上一题'

function twoWaveSteps() {
  return normalizeSteps([
    { id: 'a', question: '第一题？', options: [{ label: 'x' }, { label: 'y' }] },
    { id: 'b', question: '第二题？', when: { id: 'a', in: ['x'] } },
  ])
}

test('第一波不给返回选项，第二波才给', async () => {
  const steps = twoWaveSteps()
  const optionsSeen = []
  const userQuestions = {
    async ask(request) {
      optionsSeen.push(request.questions.map((question) => (question.options ?? []).map((option) => option.label)))
      const answers = request.questions.map((question) => ({
        id: question.id,
        selected: question.id === 'a' ? ['x'] : ['z'],
      }))
      return { answers }
    },
  }
  await runAskFlow({ userQuestions, steps })
  const [first, second] = optionsSeen
  assert.deepEqual(first[0], ['x', 'y'])
  assert.ok(second[0].includes(BACK), '第二波应带返回选项')
})

test('第二波选返回：退回第一波重问，旧答案被清掉', async () => {
  const steps = twoWaveSteps()
  const script = [
    { a: ['x'] },
    { b: [BACK] },
    { a: ['x'] },
    { b: ['z'] },
  ]
  let call = 0
  const ordered = []
  const userQuestions = {
    async ask(request) {
      for (const question of request.questions) ordered.push(question.id)
      const plan = script[call++] ?? {}
      return {
        answers: request.questions.map((question) => ({ id: question.id, selected: plan[question.id] ?? [] })),
      }
    },
  }
  const result = await runAskFlow({ userQuestions, steps })

  assert.equal(call, 4, '应该问了四轮（第一波、第二波返回、第一波重问、第二波）')
  assert.deepEqual(ordered, ['a', 'b', 'a', 'b'])
  assert.equal(result.backs, 1)
  assert.equal(result.cancelled, false)
  assert.deepEqual(result.answers.map((item) => [item.id, item.selected]), [['a', ['x']], ['b', ['z']]])
})

test('返回后重问会提示上次的选择', async () => {
  const steps = twoWaveSteps()
  const script = [{ a: ['x'] }, { b: [BACK] }, { a: ['x'] }, { b: ['z'] }]
  let call = 0
  const details = []
  const userQuestions = {
    async ask(request) {
      if (call === 2) details.push(request.questions[0].detail)
      const plan = script[call++] ?? {}
      return {
        answers: request.questions.map((question) => ({ id: question.id, selected: plan[question.id] ?? [] })),
      }
    },
  }
  await runAskFlow({ userQuestions, steps })
  assert.match(details[0], /上次你选的是「x」/)
})

test('回退改答案后，之前被跳过的分支会重新出现', async () => {
  const steps = normalizeSteps([
    { id: 'a', question: '走哪条路？', options: [{ label: 'A路径' }, { label: 'B路径' }] },
    { id: 'b', question: 'A 的问题？', when: { id: 'a', in: ['A路径'] }, options: [{ label: 'x' }] },
    { id: 'c', question: 'B 的问题？', when: { id: 'a', in: ['B路径'] }, options: [{ label: 'y' }] },
  ])
  // 先选 A（c 被跳过），在 b 点返回，改选 B —— c 必须重新出现。
  const script = [{ a: ['A路径'] }, { b: [BACK] }, { a: ['B路径'] }, { c: ['y'] }]
  let call = 0
  const ordered = []
  const userQuestions = {
    async ask(request) {
      for (const question of request.questions) ordered.push(question.id)
      const plan = script[call++] ?? {}
      return {
        answers: request.questions.map((question) => ({ id: question.id, selected: plan[question.id] ?? [] })),
      }
    },
  }
  const result = await runAskFlow({ userQuestions, steps })
  assert.deepEqual(ordered, ['a', 'b', 'a', 'c'], '回退后应问 c 而不是 b')
  assert.deepEqual(result.skipped, ['b'])
  assert.deepEqual(result.answers.map((item) => item.id), ['a', 'c'])
})

test('一直点返回最多回退 20 次，之后不再提供返回选项', async () => {
  const steps = twoWaveSteps()
  const backOptionSeen = []
  const userQuestions = {
    async ask(request) {
      const question = request.questions[0]
      if (question.id === 'b') {
        backOptionSeen.push((question.options ?? []).some((option) => option.label === BACK))
      }
      return {
        answers: [{
          id: question.id,
          selected: question.id === 'a' ? ['x'] : [BACK],
        }],
      }
    },
  }
  const result = await runAskFlow({ userQuestions, steps })
  assert.equal(result.backs, 20, '回退次数上限是 20')
  assert.equal(backOptionSeen.at(-1), false, '超过上限后第二波不再提供返回选项')
  assert.equal(result.cancelled, false)
})
