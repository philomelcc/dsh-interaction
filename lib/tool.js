/**
 * 工具定义的小工具。
 *
 * 刻意不 import @deepseek-ai/dsh-tools：本地 link 安装的插件解析不到
 * profile 里的包（真实踩过的坑）。这里只造 DSH 认的最小形状。
 */

/**
 * 递归编译简写参数表。
 *
 * 简写约定：值里写 `required: true` 表示这个 key 必填。
 * 注意必须递归进 `items`——模型 API 只认 JSON Schema 的
 * `required: ['a','b']`（父对象上的数组），property 里残留一个
 * `required: true` 会被判成 "true is not of type array" 直接整条工具作废。
 */
function compilePropertyTable(parameters) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters ?? {})) {
    const { required: isRequired, ...rest } = spec ?? {}
    properties[key] = compileValueSpec(rest)
    if (isRequired === true) required.push(key)
  }
  return { properties, required }
}

/** 编译单个参数 / 数组项的 schema，递归处理 items。 */
function compileValueSpec(spec) {
  const out = { ...spec }
  if (out.items !== undefined && out.items !== null && typeof out.items === 'object') {
    const items = { ...out.items }
    if (items.properties !== undefined && typeof items.properties === 'object') {
      const nested = compilePropertyTable(items.properties)
      items.properties = nested.properties
      if (nested.required.length > 0) items.required = nested.required
      else delete items.required
    }
    out.items = items
  }
  return out
}

/** 把简写参数表编译成 JSON Schema。 */
export function compileParameters(parameters = {}) {
  const { properties, required } = compilePropertyTable(parameters)
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  }
}

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

/** 按 schema 校验入参类型（DSH 只做基础校验，这里补一层）。 */
export function validateArguments(schema, args) {
  const violations = []
  const value = args && typeof args === 'object' ? args : {}
  for (const key of schema.required ?? []) {
    if (value[key] === undefined || value[key] === null) violations.push(`缺少必填参数: ${key}`)
  }
  for (const [key, propSchema] of Object.entries(schema.properties ?? {})) {
    const given = value[key]
    if (given === undefined || given === null) continue
    const expected = propSchema.type
    if (!expected) continue
    const actual = typeOf(given)
    const ok = expected === 'number'
      ? actual === 'number' || actual === 'integer'
      : expected === 'integer'
        ? actual === 'integer'
        : actual === expected
    if (!ok) violations.push(`参数 ${key} 应为 ${expected}，收到 ${actual}`)
  }
  return violations
}

/**
 * 定义一个工具：参数校验 + 错误码 + output 声明。
 * DSH 要求每个工具都声明 output { schema, render }，缺了插件直接加载失败。
 */
export function defineTool(options) {
  const schema = compileParameters(options.parameters)
  return {
    name: options.name,
    description: options.description,
    parameters: schema,
    output: options.output,
    async execute(args, exec) {
      const violations = validateArguments(schema, args)
      if (violations.length > 0) {
        const error = new Error(`参数不合法: ${violations.join('; ')}`)
        error.code = 'invalid_arguments'
        throw error
      }
      return await options.execute(args ?? {}, exec)
    },
  }
}

/** 统一输出形状：text 给模型读，结构化字段自己留着。 */
export function textOutput(properties = {}) {
  return {
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        text: { type: 'string' },
        ...properties,
      },
    },
    render(_args, value) {
      const text = typeof value?.text === 'string' ? value.text : JSON.stringify(value ?? null)
      return [{ type: 'text', text }]
    },
  }
}

/** 把任意值收敛成可持久化 JSON（丢掉 undefined / NaN）。 */
export function toLosslessJson(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(toLosslessJson)
  const out = {}
  for (const [key, item] of Object.entries(value)) out[key] = toLosslessJson(item)
  return out
}
