import { useSettingsStore, PRESET_PROVIDERS } from '../stores/settings'

/** 模型类型：文本 / 视觉 */
type ChatModelType = 'text' | 'vision'

/**
 * 根据模型类型（text / vision）解析对应的供应商与模型配置。
 * - 文本：使用 textModelConfig 的供应商与模型
 * - 视觉：优先使用 visionModelConfig；未配置有效供应商时回退到文本模型（共用供应商）
 */
function getModelConfig(type: ChatModelType = 'text') {
  const settings = useSettingsStore()
  let config = type === 'vision' ? settings.visionModelConfig : settings.textModelConfig
  const hasProvider = settings.providers.some(p => p.id === config?.providerId)
  if (type === 'vision' && !hasProvider) {
    config = settings.textModelConfig
  }
  const provider = settings.providers.find(p => p.id === config?.providerId)
  if (!provider || !provider.endpoint || !provider.apiKey) {
    throw new Error('请先在设置中配置AI接口')
  }
  return {
    baseURL: provider.endpoint.replace(/\/+$/, ''),
    apiKey: provider.apiKey,
    model: config.model || settings.textModelConfig.model || PRESET_PROVIDERS.deepseek.model,
    timeoutMs: (settings.requestTimeout || 30) * 1000
  }
}

function getModel(type: ChatModelType = 'text') {
  return getModelConfig(type).model
}

function chatOptions(options: any) {
  return {
    ...options,
    thinking: { type: 'disabled' }
  }
}

// 视觉模型测试用图片：生成一张带固定文字的图片，模型需正确读出该文字才算支持视觉。
// 固定文本降低随机性与 token 开销，避免随机码带来的识别歧义。
const VISION_TEST_TEXT = '123'

function makeTestImage(): string {
  const canvas = document.createElement('canvas')
  canvas.width = 300
  canvas.height = 120
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('当前浏览器不支持生成测试图片')
  }
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.fillStyle = '#111111'
  ctx.font = 'bold 48px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(VISION_TEST_TEXT, canvas.width / 2, canvas.height / 2)
  return canvas.toDataURL('image/png')
}

/** 判断请求体里是否携带了图片（image_url）内容 */
function hasImageContent(body: any): boolean {
  return (body?.messages || []).some((m: any) =>
    Array.isArray(m.content) && m.content.some((part: any) => part?.type === 'image_url')
  )
}

/** 基于 fetch 的 OpenAI 兼容客户端，替代体积较大的 openai SDK */
interface ChatRequestOptions {
  baseURL: string
  apiKey: string
  body: any
  timeoutMs: number
  signal?: AbortSignal
}

async function request(path: string, { baseURL, apiKey, body, timeoutMs, signal }: ChatRequestOptions) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onOuterAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onOuterAbort)
  try {
    const res = await fetch(baseURL + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    if (!res.ok) {
      let detail = ''
      try {
        const err = await res.json()
        detail = err?.error?.message || err?.message || ''
      } catch { /* ignore */ }
      // 携带图片却被拒收 content 类型时，通常是模型不支持图片输入（纯文本模型）
      if (hasImageContent(body) && /item type in content/i.test(detail)) {
        detail += '（当前模型似乎无法识别图片，请更换一个支持视觉/多模态的模型后再试）'
      }
      throw new Error(`请求失败 (${res.status}): ${detail}`.trim())
    }
    return await res.json()
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * 归一化不同供应商的 token 用量字段：
 * - 缓存命中：DeepSeek 用 prompt_cache_hit_tokens，OpenAI 用 prompt_tokens_details.cached_tokens
 * - 缓存未命中：DeepSeek 直接给 prompt_cache_miss_tokens，其余按「输入 - 命中」推算
 * @param {object} usage 接口返回的 usage 字段
 * @returns {{prompt: number, completion: number, total: number, cached: number, miss: number}|null}
 */
function readUsage(usage: any) {
  if (!usage || typeof usage !== 'object') return null
  const prompt = Number(usage.prompt_tokens) || 0
  const completion = Number(usage.completion_tokens) || 0
  const total = Number(usage.total_tokens) || prompt + completion
  const cached = Number(usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens) || 0
  const miss = Number(usage.prompt_cache_miss_tokens ?? Math.max(0, prompt - cached)) || 0
  return { prompt, completion, total, cached, miss }
}

// ---- 费用计算 ----
// 单价表（元 / 百万 tokens）。空闲时段价格为高峰时段的一半。
const USAGE_PRICE = {
  offPeak: { cached: 0.02, miss: 1, output: 4 },
  peak: { cached: 0.04, miss: 2, output: 8 }
}

// 高峰时段：北京时间周一至周五 9:00–12:00、14:00–18:00；其余（含周末）为空闲时段。
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60]
]

/**
 * 取某时刻的北京时间（UTC+8）星期与「时:分」偏移，
 * 不依赖运行设备时区，保证跨时区计算结果一致。
 * @returns {{day: number, minutes: number}} day：0=周日 … 6=周六
 */
function beijingClock(at: number) {
  const d = new Date(at + 8 * 60 * 60 * 1000)
  return { day: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }
}

/** 判断某时刻是否处于空闲时段（高峰：北京时间周一至周五 9:00–12:00、14:00–18:00） */
function isOffPeak(at: number = Date.now()): boolean {
  const { day, minutes } = beijingClock(at)
  if (day === 0 || day === 6) return true // 周末全天空闲
  return !PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end)
}

/** 金额格式化（元）：最多 6 位小数并去掉末尾多余的 0 */
function formatMoney(yuan: number): string {
  if (!(yuan > 0)) return '0 元'
  return `${Number(yuan.toFixed(6))} 元`
}

/** 功能名归一化：去掉「（合批 20 词）」这类参数后缀，便于分组统计 */
function usageGroupLabel(label: string): string {
  return (label || 'AI 请求').replace(/（.*$/, '')
}

/** 按单价计算一条用量的费用明细（元）：输入命中 / 输入未命中 / 输出 */
function usageCost(u: any, price: any) {
  return {
    cached: (u.cached * price.cached) / 1e6,
    miss: (u.miss * price.miss) / 1e6,
    output: (u.completion * price.output) / 1e6
  }
}

// 当前活跃的批量用量收集器：批量多线程生成时逐条打印会刷屏，
// 改为批次内静默累加，批次结束时由 withAiUsageSummary 一次性汇总输出。
let usageBatch: { items: any[]; errors: string[]; start: number; label: string } | null = null

/**
 * 调试模式下的 AI token 用量输出。
 * - 非批量场景：直接打印一行（输入/输出/合计 tokens、缓存命中与本次费用）；
 * - 批量场景（usageBatch 存在）：只累加到批次，由 withAiUsageSummary 在最后统一打印。
 * @param {string} label 功能名（如「单词释义」）
 * @param {string} type 模型类型（text / vision）
 * @param {object} usage 接口返回的 usage 字段
 */
function debugLogAiUsage(label: string, type: string, usage: any): void {
  if (!useSettingsStore().debugMode) return
  const u = readUsage(usage)
  if (!u) return
  if (usageBatch) {
    usageBatch.items.push({ label: usageGroupLabel(label), type, at: Date.now(), ...u })
    return
  }
  const off = isOffPeak()
  const price = off ? USAGE_PRICE.offPeak : USAGE_PRICE.peak
  const cost = usageCost(u, price)
  const typeLabel = type === 'vision' ? '视觉' : '文本'
  const hitPct = u.prompt ? Math.round((u.cached / u.prompt) * 100) : 0
  console.log(
    `%c[LearnInText AI]%c ${label}（${typeLabel}）· 输入 ${u.prompt} tokens（缓存命中 ${u.cached} · ${hitPct}%，未命中 ${u.miss}）· 输出 ${u.completion} tokens · 合计 ${u.total} tokens · ${off ? '空闲' : '高峰'}时段 ${formatMoney(cost.cached + cost.miss + cost.output)}`,
    'color:#22a06b;font-weight:bold',
    'color:inherit'
  )
}

/** 调试模式下的 AI 请求失败输出；批量场景只记录，随汇总一并打印 */
function debugLogAiError(label: string, error: any): void {
  if (!useSettingsStore().debugMode) return
  const message = `${usageGroupLabel(label)}失败: ${error?.message || error}`
  if (usageBatch) {
    usageBatch.errors.push(message)
    return
  }
  console.error(`[LearnInText AI] ${message}`)
}

/**
 * 批量 AI 请求的用量汇总包装器（调试模式）。
 * 批次内所有请求的 token 用量静默累加，结束后一次性打印：
 * 分组用量表、输入/输出/命中合计、按空闲/高峰单价计算的费用合计，以及失败次数。
 * 非调试模式直接执行原逻辑，无任何额外开销。
 * @param {string} label 批次名（如「批量生成单词释义」）
 * @param {() => Promise<any>} fn 批次逻辑
 */
export async function withAiUsageSummary(label: string, fn: () => Promise<any>): Promise<any> {
  if (!useSettingsStore().debugMode) return fn()
  const prev = usageBatch
  const batch = { label, items: [], errors: [], start: Date.now() }
  usageBatch = batch
  try {
    return await fn()
  } finally {
    usageBatch = prev
    printUsageBatchSummary(batch)
  }
}

/** 汇总打印批次用量与费用 */
function printUsageBatchSummary(batch: any): void {
  if (!batch.items.length && !batch.errors.length) return
  const groups = new Map<string, any>()
  const totals: Record<string, number> = { prompt: 0, completion: 0, total: 0, cached: 0, miss: 0 }
  const cost = {
    offPeak: { cached: 0, miss: 0, output: 0 },
    peak: { cached: 0, miss: 0, output: 0 }
  }
  for (const item of batch.items) {
    let g = groups.get(item.label)
    if (!g) {
      g = { 功能: item.label, 请求次数: 0, 输入: 0, 缓存命中: 0, 输出: 0, 合计: 0 }
      groups.set(item.label, g)
    }
    g.请求次数++
    g.输入 += item.prompt
    g.缓存命中 += item.cached
    g.输出 += item.completion
    g.合计 += item.total
    for (const key of ['prompt', 'completion', 'total', 'cached', 'miss']) totals[key] += item[key]
    const off = isOffPeak(item.at)
    const c = usageCost(item, off ? USAGE_PRICE.offPeak : USAGE_PRICE.peak)
    const bucket = off ? cost.offPeak : cost.peak
    bucket.cached += c.cached
    bucket.miss += c.miss
    bucket.output += c.output
  }

  const sumCost = (b: any): number => b.cached + b.miss + b.output
  const hitPct = totals.prompt ? Math.round((totals.cached / totals.prompt) * 100) : 0
  const duration = ((Date.now() - batch.start) / 1000).toFixed(1)
  const costLine = (name: string, b: any): string =>
    `费用（${name}时段）：缓存命中 ${formatMoney(b.cached)} + 未命中 ${formatMoney(b.miss)} + 输出 ${formatMoney(b.output)} = ${formatMoney(sumCost(b))}`

  console.group(
    `%c[LearnInText AI] %c${batch.label} · 汇总 ${batch.items.length} 次请求 · 耗时 ${duration}s`,
    'color:#22a06b;font-weight:bold',
    'color:#8a8a8a'
  )
  if (groups.size > 1) console.table([...groups.values()])
  console.log(`输入 ${totals.prompt} tokens（缓存命中 ${totals.cached} · ${hitPct}%，未命中 ${totals.miss}）`)
  console.log(`输出 ${totals.completion} tokens · 合计 ${totals.total} tokens`)
  if (sumCost(cost.offPeak) > 0) console.log(costLine('空闲', cost.offPeak))
  if (sumCost(cost.peak) > 0) console.log(costLine('高峰', cost.peak))
  console.log(
    `%c合计费用：${formatMoney(sumCost(cost.offPeak) + sumCost(cost.peak))}`,
    'font-weight:bold'
  )
  if (batch.errors.length) {
    console.warn(`请求失败 ${batch.errors.length} 次：\n${[...new Set(batch.errors)].slice(0, 5).join('\n')}`)
  }
  console.groupEnd()
}

async function createChatCompletion(params: any, type: ChatModelType = 'text', signal?: AbortSignal, label = '') {
  const { baseURL, apiKey, timeoutMs } = getModelConfig(type)
  try {
    const res = await request('/chat/completions', { baseURL, apiKey, body: params, timeoutMs, signal })
    debugLogAiUsage(label, type, res?.usage)
    return res
  } catch (error) {
    debugLogAiError(label, error)
    throw error
  }
}

/** 估算文本 token 数（粗略近似，仅用于进度条）：英文约 4 字符/token，中文约 1 字符/token */
function estimateTokens(text: string): number {
  if (!text) return 0
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) || []).length
  const other = text.length - cjk
  return Math.round(cjk + other / 4)
}

/**
 * 流式 chat completion：基于 SSE 逐块读取生成内容，返回累积的完整文本。
 * @param {object} params 请求参数（不含 stream，内部自动加 stream: true）
 * @param {string} type 模型类型（text / vision）
 * @param {(delta: string, full: string) => void} onDelta 每收到一段增量时回调（增量, 累计全文）
 * @param {AbortSignal} signal 外部中止信号（如关闭窗口时 abort）
 */
async function streamChatCompletion(
  params: any,
  type: ChatModelType = 'text',
  onDelta?: (delta: string, full?: string) => void,
  signal?: AbortSignal,
  label = ''
) {
  const { baseURL, apiKey, timeoutMs } = getModelConfig(type)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onOuterAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onOuterAbort)
  try {
    // 调试模式下向流式请求要一份 usage（最终块返回），用于控制台打印 token 用量；
    // 非调试模式不带该参数，避免个别供应商不支持 stream_options 导致请求失败
    const body = { ...params, stream: true }
    if (useSettingsStore().debugMode) body.stream_options = { include_usage: true }
    const res = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(body),
      signal: ctrl.signal
    })
    if (!res.ok) {
      let detail = ''
      try {
        const err = await res.json()
        detail = err?.error?.message || err?.message || ''
      } catch { /* ignore */ }
      if (hasImageContent(params) && /item type in content/i.test(detail)) {
        detail += '（当前模型似乎无法识别图片，请更换一个支持视觉/多模态的模型后再试）'
      }
      throw new Error(`请求失败 (${res.status}): ${detail}`.trim())
    }

    const reader = res.body?.getReader()
    if (!reader) throw new Error('当前环境不支持流式响应')

    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let usage = null
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const data = trimmed.slice(5).trim()
        if (!data || data === '[DONE]') continue
        let json
        try { json = JSON.parse(data) } catch { continue }
        // include_usage 的最终块只带 usage（choices 为空），单独收集
        if (json?.usage) usage = json.usage
        const delta = json?.choices?.[0]?.delta
        const text = typeof delta?.content === 'string' ? delta.content : ''
        if (text) {
          full += text
          if (onDelta) onDelta(text, full)
        }
      }
    }
    debugLogAiUsage(label, type, usage)
    return full
  } catch (error) {
    debugLogAiError(label, error)
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

async function listModelsForProvider(provider: any) {
  const settings = useSettingsStore()
  const baseURL = provider.endpoint.replace(/\/+$/, '')
  const timeoutMs = (settings.requestTimeout || 30) * 1000
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(baseURL + '/models', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${provider.apiKey}` },
      signal: ctrl.signal
    })
    if (!res.ok) throw new Error(`请求失败 (${res.status})`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

export async function generateWordBasicInfo(word: string, context = '', signal?: AbortSignal) {
  const model = getModel()

  const systemMessage = `你是英语词典助手。返回JSON格式，严格遵守以下规则：
1. partOfSpeech 必须使用英文缩写：n. v. adj. adv. pron. prep. conj. art. int.（多个词性用"/"连接，如"v./n."）
2. definitions 最多2个最常用的意思
3. 请结合提供的上下文语境，理解单词在文中使用的含义

返回格式：
{
  "definitions": [
    {"partOfSpeech": "英文缩写词性", "meaning": "中文释义"}
  ]
}`

  const contextPrompt = context
    ? `参考以下上下文语境理解其含义：\n上下文："${context}"，请提供单词 "${word}" 的详细信息，`
    : `请提供单词 "${word}" 的详细信息`

  const response = await createChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: contextPrompt }
    ],
    response_format: { type: 'json_object' },
    max_tokens: useSettingsStore().basicInfoMaxTokens || 300
  }), 'text', signal, '单词释义')

  return JSON.parse(response.choices[0].message.content)
}

export async function generateWordContextTranslation(word: string, sentence: string, context: string) {
  const model = getModel()

  // 兜底：未提供目标句时退回整段上下文
  if (!sentence) sentence = context || ''

  const systemMessage = `你是英语词典助手。我会在用户消息中提供「完整语境」和「目标句」，请说明目标单词在文中（即目标句里）的含义，以及在句中具体起的作用。
说明规则：
1. 完整语境与目标句仅用于判断该词在上下文中的具体用法，禁止翻译、复述或输出整句
2. 必须同时给出两部分，紧接着写、中间用「，」或「；」连接，不要换行、不要分点：
   【含义】该词在此语境下的中文释义，格式为「词性缩写 + 中文含义」，词性用 n. v. adj. adv. pron. prep. conj. art. int.
   【作用】用括号补充说明它在句中的指向和成分，按词性给出关键信息：
   - 代词 pron.：指代前文哪个词/人/物（必须写出被指代的原词），在句中作什么成分
   - 形容词 adj.：修饰哪个名词/代词（必须写出被修饰的词）
   - 副词 adv.：修饰哪个动词/形容词/整句
   - 名词 n.：在句中作什么成分（主语/宾语/表语等），是否承接或指代前文内容
   - 动词 v.：动作的发出者、承受者，以及时态语态
   - 介词/连词/冠词/其他：连接哪两个成分，或限定哪个词
3. 指向说明必须基于目标句和完整语境的实际内容，不能凭空猜测；无法判断时才省略该部分
4. 若该词在此处的含义与其最常见义不同，在末尾用一句话补充含义来源（如时态、搭配、引申）
5. 必须用 **...** 双星号标记该词在此处的核心含义
6. 整体控制在 30 字以内，简洁直白
返回JSON格式：
{
  "contextTranslation": "【含义】（【作用】），核心含义用**标记**"
}

示例：
- 单词 read，完整语境 "Reading is my hobby. I read an interesting book yesterday. It was fun."，目标句 "I read an interesting book yesterday" → {"contextTranslation": "v. **读**；阅读（过去式，主语是 I，宾语是 an interesting book，指昨天读了一本书）"}
- 单词 it，目标句 "I read an interesting book yesterday. It was fun." → {"contextTranslation": "pron. **它**（指代前文的 an interesting book，在句中作主语）"}
- 单词 interesting，目标句 "I read an interesting book yesterday" → {"contextTranslation": "adj. **有趣的**（修饰名词 book，描述这本书令人感兴趣）"}
- 单词 because，目标句 "I stayed home because it was raining" → {"contextTranslation": "conj. **因为**（连接主句 I stayed home 和原因状语从句 it was raining，引出原因）"}`

  const userMessage = context && context !== sentence
    ? `完整语境（仅供理解背景，不要翻译）：\n"${context}"\n\n目标句（单词所在的句子）：\n"${sentence}"\n\n请说明单词 "${word}" 在目标句中的含义，以及它在句中指代、修饰或连接的对象，不要翻译句子`
    : `句子："${sentence}"\n\n请说明单词 "${word}" 在该句中的含义，以及它在句中指代、修饰或连接的对象，不要翻译句子`

  const response = await createChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    max_tokens: useSettingsStore().contextMaxTokens || 200
  }), 'text', undefined, '上下文翻译')

  return JSON.parse(response.choices[0].message.content)
}

/**
 * 划词翻译：翻译用户选中的任意文本（单词/词组/句子/多句）。
 * 沿用「传得多、翻得短」约束：语境仅供理解背景，只翻译选中文本。
 * @param {string} selection 选中的待翻译文本
 * @param {string} context 选中文本所在语境（可为空）
 * @returns {Promise<{translation: string}>}
 */
export async function generateSelectionTranslation(selection: string, context = '') {
  const model = getModel()

  const systemMessage = `你是英语翻译助手。我会在用户消息中提供“完整语境”和“待翻译文本”，只翻译待翻译文本。
翻译规则：
1. 完整语境仅用于理解背景，禁止翻译或输出其中待翻译文本以外的内容
2. 待翻译文本是单词或短语时，输出其词性、释义及在语境中的含义（如 "v. 读；阅读"）
3. 待翻译文本是句子或多句时，输出自然流畅的中文翻译
返回JSON格式：
{
  "translation": "译文"
}`

  const userMessage = context
    ? `完整语境（仅供理解背景，不要翻译）：\n"${context}"\n\n待翻译文本（只需翻译）：\n"${selection}"`
    : `待翻译文本：\n"${selection}"`

  const response = await createChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    max_tokens: useSettingsStore().selectionMaxTokens || 500
  }), 'text', undefined, '划词翻译')

  const parsed = parseJsonSafely(response.choices[0].message.content)
  return { translation: String(parsed.translation || '').trim() }
}

/** 句子成分角色合法枚举（与前端 grammarConstants 的 ROLE_LABELS 对应） */
const COMPONENT_ROLES = ['subject', 'predicate', 'object', 'attributive', 'adverbial', 'complement', 'predicative', 'conjunction']

/** 从句大类 → 合法子类枚举（与前端 grammarConstants 的 CLAUSE_SUBTYPE_LABELS 对应） */
const CLAUSE_SUBTYPES: Record<string, string[]> = {
  noun: ['subject_clause', 'object_clause', 'predicative_clause', 'appositive_clause'],
  relative: ['restrictive', 'non_restrictive'],
  adverbial: ['time', 'place', 'reason', 'condition', 'concession', 'purpose', 'result', 'manner', 'comparison']
}

/** 名词性从句子类 → 在主句中充当的成分（用于校正 AI 标注） */
const NOUN_CLAUSE_ROLES: Record<string, string> = {
  subject_clause: 'subject',
  object_clause: 'object',
  predicative_clause: 'predicative',
  appositive_clause: 'attributive'
}

/** 从句最大嵌套深度（超过按普通片段渲染，防止结构过深难以阅读） */
const MAX_CLAUSE_DEPTH = 3

/**
 * 校验用文本归一化：去除全部空白（AI 可能把空格归入不同片段），
 * 并统一常见排版引号/撇号，避免 AI 转换引号样式导致还原校验误判
 */
function normalizeForCompare(text: string): string {
  return String(text || '')
    .replace(/\s+/g, '')
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
}

/**
 * 递归归一化 AI 返回的成分片段：
 * - 校验 role / clause.type / clause.subtype 合法性
 * - 从句内部片段拼接须还原从句原文，否则该从句降级为普通片段（保留 role，丢弃内部结构）
 * - 限制嵌套深度
 * @param {object} raw AI 返回的单个片段
 * @param {number} depth 当前嵌套深度（顶层为 0）
 * @returns {{text: string, role: string, clause?: {type: string, subtype: string, segments: Array}}|null}
 */
function normalizeSegment(raw: any, depth: number = 0): any {
  if (!raw || typeof raw !== 'object') return null
  const text = String(raw.text ?? '')
  if (!text) return null
  const role = COMPONENT_ROLES.includes(raw.role) ? raw.role : 'none'
  const node: any = { text, role }

  const clause = raw.clause
  if (clause && typeof clause === 'object' && depth < MAX_CLAUSE_DEPTH) {
    const type = Object.prototype.hasOwnProperty.call(CLAUSE_SUBTYPES, clause.type)
      ? clause.type
      : null
    if (type) {
      const subtype = CLAUSE_SUBTYPES[type].includes(clause.subtype) ? clause.subtype : ''
      const children = (Array.isArray(clause.segments) ? clause.segments : [])
        .map((s: any) => normalizeSegment(s, depth + 1))
        .filter(Boolean)
      // 从句内部拼接须还原从句原文，否则视为不可靠结构，降级为普通片段
      const joined = normalizeForCompare(children.map((c: any) => c.text).join(''))
      if (children.length && joined && joined === normalizeForCompare(text)) {
        node.clause = { type, subtype, segments: children }
        // 校正从句在主句中的角色：定语/状语从句固定，名词性从句按子类推导
        if (type === 'noun' && subtype && NOUN_CLAUSE_ROLES[subtype]) {
          node.role = NOUN_CLAUSE_ROLES[subtype]
        } else if (type === 'relative') {
          node.role = 'attributive'
        } else if (type === 'adverbial') {
          node.role = 'adverbial'
        }
      }
    }
  }
  return node
}

/**
 * 剥离首尾「仅由包裹符号构成」的 none 片段：
 * 模型可能把 user message 中包裹文本的引号/边界标记（#）误当作原文切出独立片段。
 * 仅匹配引号/边界/强调符，不含 . ? ! 等句末标点，避免误剥合法片段。
 * @param {Array<{text: string, role: string}>} segments 顶层片段
 * @returns {Array<{text: string, role: string}>} 剥离后的片段（浅拷贝，不改入参）
 */
function stripWrapperSegments(segments: any[]): any[] {
  const list = [...segments]
  const isWrapper = (s: any): boolean => s.role === 'none' && /^[\s"'‘’“”‛″#*`~]{1,3}$/.test(s.text)
  while (list.length && isWrapper(list[0])) list.shift()
  while (list.length && isWrapper(list[list.length - 1])) list.pop()
  return list
}

/**
 * 句子成分解析的会话级内存缓存（简易 LRU）：
 * 阅读时反复选中同一段文本（含相同语境）直接复用历史解析结果，避免重复 AI 请求。
 */
const componentParseCache = new Map<string, any>()
const COMPONENT_CACHE_MAX = 50

function componentCacheKey(text: string, context: string): string {
  return text + '|||' + (context || '')
}

/** LRU 读：命中后移到 Map 尾部（最近使用）；深拷贝返回，避免调用方改动影响缓存 */
function componentCacheGet(key: string): any {
  if (!componentParseCache.has(key)) return undefined
  const value = componentParseCache.get(key)
  componentParseCache.delete(key)
  componentParseCache.set(key, value)
  return structuredClone(value)
}

/** LRU 写：达到上限时淘汰 Map 首个条目（最久未使用）；存入深拷贝，保持缓存数据不被外部改动污染 */
function componentCacheSet(key: string, value: any): void {
  if (componentParseCache.size >= COMPONENT_CACHE_MAX) {
    componentParseCache.delete(componentParseCache.keys().next().value!)
  }
  componentParseCache.set(key, structuredClone(value))
}

/**
 * 句子成分拆分：把选中的英文文本按语法成分（主谓宾定状补表）切分并标注角色，
 * 同时识别从句（名词性/定语/状语从句）并递归标注从句内部成分，用于前端多层次彩色渲染。
 * @param {string} text 选中的待解析文本
 * @param {string} context 选中文本所在语境（仅供 AI 理解背景，可为空）
 * @param {AbortSignal} signal 外部中止信号（关闭窗口时 abort）
 * @returns {Promise<{segments: Array<{text: string, role: string, clause?: object}>}>} 按原文顺序的成分片段（可嵌套从句）
 */
export async function parseSelectionComponents(text: string, context = '', signal?: AbortSignal) {
  // 命中缓存：同文本+语境直接复用历史解析结果
  const cacheKey = componentCacheKey(text, context)
  const cached = componentCacheGet(cacheKey)
  if (cached) return cached

  const model = getModel()

  const systemMessage = `你是英语语法解析助手。请把用户提供的英文文本按句子成分切分并标注角色，同时识别其中所有从句；从句整体标注后在内部继续切分其句子成分（可多层嵌套）。

【最高优先级规则——原文还原】
每个片段的 text 都必须逐字复制待解析文本，禁止改写、增删、翻译任何单词或标点：
- 保持原文的大小写、连字符、撇号、引号样式（如 ' " “ ” ’）完全一致，不得做任何转换
- 所有顶层片段的 text 按顺序拼接（忽略空格差异）必须恰好还原待解析文本，这是硬性校验条件
- 每个从句片段的 clause.segments 按顺序拼接必须恰好还原该从句自身的 text
- 返回前必须逐字自检以上两条拼接，不一致时先修正再输出

一、成分角色（role 字段取值，仅限以下枚举）：
- subject：主语
- predicate：谓语（含助动词、情态动词构成的动词短语）
- object：宾语（直接宾语与间接宾语均标 object）
- attributive：定语（修饰名词的词、短语或从句）
- adverbial：状语（修饰动词、形容词或整句的词、短语或从句）
- complement：补语
- predicative：表语
- conjunction：连词（并列连词 and/but/or/so 等，以及从句引导词 that/which/who/because/although/if/when 等）
- none：标点等不单独归入上述成分的部分

二、从句标注：
从句片段需额外携带 clause 对象，type/subtype 标明从句类型，segments 为从句内部成分（同样规则切分，可再嵌套从句）：
- noun（名词性从句）：subtype ∈ subject_clause 主语从句 / object_clause 宾语从句 / predicative_clause 表语从句 / appositive_clause 同位语从句
- relative（定语从句）：subtype ∈ restrictive 限制性 / non_restrictive 非限制性
- adverbial（状语从句）：subtype ∈ time 时间 / place 地点 / reason 原因 / condition 条件 / concession 让步 / purpose 目的 / result 结果 / manner 方式 / comparison 比较

role 与从句类型的对应（必须遵守）：主语从句→subject，宾语从句→object，表语从句→predicative，同位语从句→attributive，定语从句→attributive，状语从句→adverbial

三、切分要求：
1. 空格并入相邻片段内部，相邻英文单词片段之间必须保留空格；句末标点（. ? ! 等）不得遗漏，作为最后一个片段（role 为 none）
2. 同一成分被标点或连词隔开时拆成多个片段，role 相同
3. 冠词、介词、助动词等随所属成分整体标注（如 "the little girl" 整体为 subject）
4. 从句引导词（that/which/who/because/although/if/when 等）作为从句内部第一个片段，role 为 conjunction
5. 非限制性定语从句前的逗号是独立片段（role 为 none），不并入从句
6. 从句片段的 text 是从句完整原文（含引导词）
7. 若文本不是完整句子（单词、词组等），也按其内部结构尽力标注；无从句时片段不带 clause 字段
8. 只返回 JSON，不要任何解释；text 值不加引号或其它包裹符号

返回JSON格式示例一（The book that I bought yesterday is interesting.）：
{ "segments": [
  { "text": "The book ", "role": "subject" },
  { "text": "that I bought yesterday", "role": "attributive", "clause": { "type": "relative", "subtype": "restrictive", "segments": [
    { "text": "that", "role": "conjunction" },
    { "text": "I ", "role": "subject" },
    { "text": "bought ", "role": "predicate" },
    { "text": "yesterday", "role": "adverbial" } ] } },
  { "text": " is ", "role": "predicate" },
  { "text": "interesting", "role": "predicative" },
  { "text": ".", "role": "none" } ] }

示例二（I will tell him that you called when he comes back.）：
{ "segments": [
  { "text": "I ", "role": "subject" },
  { "text": "will tell ", "role": "predicate" },
  { "text": "him", "role": "object" },
  { "text": " ", "role": "none" },
  { "text": "that you called", "role": "object", "clause": { "type": "noun", "subtype": "object_clause", "segments": [
    { "text": "that", "role": "conjunction" },
    { "text": "you ", "role": "subject" },
    { "text": "called", "role": "predicate" } ] } },
  { "text": " ", "role": "none" },
  { "text": "when he comes back", "role": "adverbial", "clause": { "type": "adverbial", "subtype": "time", "segments": [
    { "text": "when", "role": "conjunction" },
    { "text": "he ", "role": "subject" },
    { "text": "comes back", "role": "predicate" } ] } },
  { "text": ".", "role": "none" } ] }`

  // 用 ### 边界标记代替引号包裹：部分模型（如 qwen）会把包裹引号误当作原文切出首尾片段，导致拼接校验失败
  const contextLine = context
    ? `\n\n完整语境（仅供理解背景，不属于待解析文本，不要切分）：\n###\n${context}\n###`
    : ''
  const userMessage = `待解析文本（首尾的 ### 只是边界标记，不属于文本本身；切分结果必须逐字还原标记之间的文本）：\n###\n${text}\n###${contextLine}`

  const params = chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    // JSON 结构开销远大于纯文本，按字符数放大上限，避免长句输出被截断导致解析失败
    max_tokens: Math.min(6000, Math.max(1000, Math.round(text.length * 4)))
  })

  // AI 输出具有随机性，校验失败时自动补一次请求，尽量避免让用户手动重试
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await createChatCompletion(params, 'text', signal, '句子成分解析')
    try {
      const parsed = parseJsonSafely(response.choices[0].message.content)
      const segments = (Array.isArray(parsed.segments) ? parsed.segments : [])
        .map((s: any) => normalizeSegment(s, 0))
        .filter(Boolean)
      if (!segments.length) {
        throw new Error('解析结果为空')
      }
      // 顶层拼接须还原原文（忽略空白与引号样式差异）；不一致时先剥离首尾包裹符片段复检，
      // 仍不一致才视为本次解析失败（先严格后剥离，避免误伤原文本身以引号开头的合法切分）
      let finalSegments = segments
      if (normalizeForCompare(finalSegments.map((s: any) => s.text).join('')) !== normalizeForCompare(text)) {
        const stripped = stripWrapperSegments(finalSegments)
        if (
          !stripped.length ||
          normalizeForCompare(stripped.map((s: any) => s.text).join('')) !== normalizeForCompare(text)
        ) {
          throw new Error('解析结果与原文不一致')
        }
        finalSegments = stripped
      }
      // 解析成功（含拼接校验）后写入缓存；失败不缓存，便于重试拿到新结果
      const result = { segments: finalSegments }
      componentCacheSet(cacheKey, result)
      return result
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/** 成分角色 → 中文说明（对齐翻译 prompt 中展示切分结果用） */
const ROLE_PROMPT_LABELS: Record<string, string> = {
  subject: '主语',
  predicate: '谓语',
  object: '宾语',
  attributive: '定语',
  adverbial: '状语',
  complement: '补语',
  predicative: '表语',
  conjunction: '连词',
  none: '其他'
}

/** 从句大类 → 中文说明（标注从句整体片段用） */
const CLAUSE_PROMPT_LABELS: Record<string, string> = {
  noun: '名词性从句',
  relative: '定语从句',
  adverbial: '状语从句'
}

/** 对齐翻译的会话级内存缓存（LRU），key 含顶层切分指纹：切分变化时缓存自动失效 */
const alignedTranslationCache = new Map()
const ALIGNED_CACHE_MAX = 50

function alignedCacheKey(text: string, context: string, topSegments: any[]): string {
  return text + '|||' + (context || '') + '|||' + topSegments.map(s => s.text).join('\u0001')
}

function alignedCacheGet(key: string): any {
  if (!alignedTranslationCache.has(key)) return undefined
  const value = alignedTranslationCache.get(key)
  alignedTranslationCache.delete(key)
  alignedTranslationCache.set(key, value)
  return structuredClone(value)
}

function alignedCacheSet(key: string, value: any): void {
  if (alignedTranslationCache.size >= ALIGNED_CACHE_MAX) {
    alignedTranslationCache.delete(alignedTranslationCache.keys().next().value)
  }
  alignedTranslationCache.set(key, structuredClone(value))
}

/**
 * 递归校验从句的逐成分译文 children：enIndex 须与从句内部片段一一对应（不重不漏）；
 * 子片段自身为从句时可嵌套 children（同样规则校验，失败仅丢弃该嵌套层）。
 * 校验失败返回 null（调用方回退该从句的整体译文 zh，不影响其他片段）。
 * @param {Array} rawChildren AI 返回的 children 数组
 * @param {Array} clauseSegments 从句内部片段（parseSelectionComponents 的解析结果）
 * @returns {Array<{enIndex: number, zh: string, children?: Array}>|null}
 */
function normalizeAlignedChildren(rawChildren: any, clauseSegments: any[]): any[] | null {
  if (!Array.isArray(rawChildren) || !clauseSegments?.length) return null
  const out: any[] = []
  const seen = new Set<number>()
  for (const item of rawChildren) {
    const enIndex = Number(item?.enIndex)
    if (!Number.isInteger(enIndex) || enIndex < 0 || enIndex >= clauseSegments.length) return null
    if (seen.has(enIndex)) return null
    seen.add(enIndex)
    const entry: any = { enIndex, zh: String(item?.zh ?? '').trim() }
    const clauseSeg = clauseSegments[enIndex]
    if (clauseSeg?.clause) {
      const children = normalizeAlignedChildren(item?.children, clauseSeg.clause.segments)
      if (children) entry.children = children
    }
    out.push(entry)
  }
  if (seen.size !== clauseSegments.length) return null
  return out
}

/**
 * 对齐翻译（「英式中文」）：把已解析好的顶层成分片段逐个翻译为中文，
 * 每个英文成分恰好对应一个中文片段（enIndex 关联，支持中文语序微调）；
 * 从句片段额外返回 children（从句内部成分逐个对应的中文译文），供前端分层渲染。
 * @param {string} text 选中的原文
 * @param {Array<{text: string, role: string, clause?: object}>} topSegments 顶层成分片段（从句作为整体片段）
 * @param {string} context 选中文本所在语境（仅供 AI 理解背景，可为空）
 * @param {AbortSignal} signal 外部中止信号（关闭窗口时 abort）
 * @returns {Promise<{segments: Array<{enIndex: number, zh: string, children?: Array}>}>} 按中文语序排列的对应片段（enIndex 指向 topSegments 下标；children 的 enIndex 指向从句内部片段下标）
 */
export async function generateAlignedTranslation(text: string, topSegments: any[], context = '', signal?: AbortSignal) {
  const segs = (topSegments || []).filter(s => s && s.text)
  if (!text || !segs.length) return { segments: [] }

  const cacheKey = alignedCacheKey(text, context, segs)
  const cached = alignedCacheGet(cacheKey)
  if (cached) return cached

  const model = getModel()

  const systemMessage = `你是英语翻译助手。我提供一段英文文本及其按语法成分的切分结果（含从句内部切分），请逐成分翻译为中文，输出「成分对应式中文」（与英文成分一一映射的直译）。

翻译规则：
1. 每个英文顶层成分片段必须恰好对应一个顶层中文片段：不得遗漏任何片段、不得把多个片段合并为一个、不得把一个片段拆成多个；输出数组的顺序即最终中文语序，enIndex 标明每个中文片段对应输入列表中的顶层编号（从 0 开始）
2. 从句片段除整体译文 zh 外，还必须提供 children 数组：从句内部成分逐个对应的中文片段，其 enIndex 指向该从句内部切分编号（从 0 开始），同样一一对应不得遗漏；children 的顺序即该从句内部的中文语序（可按中文习惯重排，如时间状语前移）；children 内部若再有从句片段，同样规则嵌套 children；非从句片段不要输出 children 字段
3. 从句整体 zh 是该从句自然通顺的完整译文，children 各片段按顺序连读含义与整体 zh 一致
4. 中文语序：顶层大体保持英文成分顺序（如英文句尾的时间状语仍放在中文句尾）；仅当某成分位置明显违背中文习惯时（如后置的定语从句直译后无法连读），才可把它的中文片段移到更自然的位置
5. 冠词、从句引导词、形式主语等在中文中无实义的成分，zh 输出空字符串 ""
6. 中文需要的结构助词（如"的""了"）并入语义上所属成分的译文，不单独成片段
7. 标点对应转换：. → 。、? → ？、! → ！、, → ，、; → ；、: → ：
8. 相邻中文片段按顺序连读应当基本通顺
9. 输入是单词或短语时正常翻译（单词可带词性释义，如 "v. 读；阅读"），enIndex 对应唯一片段
10. 只返回 JSON，不要任何解释

返回JSON格式（示例输入 "The book that I bought yesterday is interesting."，顶层切分：0 主语 "The book" / 1 定语从句 "that I bought yesterday"（内部切分：0 连词 that / 1 主语 I / 2 谓语 bought / 3 状语 yesterday）/ 2 谓语 is / 3 表语 interesting / 4 标点 .）：
{ "segments": [
  { "enIndex": 0, "zh": "这本书" },
  { "enIndex": 1, "zh": "（我昨天买的）", "children": [
    { "enIndex": 0, "zh": "" },
    { "enIndex": 1, "zh": "我" },
    { "enIndex": 3, "zh": "昨天" },
    { "enIndex": 2, "zh": "买的" } ] },
  { "enIndex": 2, "zh": "是" },
  { "enIndex": 3, "zh": "有趣的" },
  { "enIndex": 4, "zh": "。" } ] }`

  // 递归列出切分结果：顶层编号 i，从句内部编号 i.j（嵌套类推 i.j.k）
  const listSegments = (list: any[], prefix: string): string =>
    (list || []).map((s: any, j: number) => {
      const role = ROLE_PROMPT_LABELS[s.role] || '其他'
      if (!s.clause) return `${prefix}${j}. "${s.text}"（${role}）`
      const note = CLAUSE_PROMPT_LABELS[s.clause.type] || '从句'
      return `${prefix}${j}. "${s.text}"（${role}，${note}整体）\n${listSegments(s.clause.segments, `${prefix}${j}.`)}`
    }).join('\n')

  const segList = segs.map((s, i) => {
    const role = ROLE_PROMPT_LABELS[s.role] || '其他'
    if (!s.clause) return `${i}. "${s.text}"（${role}）`
    const note = CLAUSE_PROMPT_LABELS[s.clause.type] || '从句'
    return `${i}. "${s.text}"（${role}，${note}整体）\n${listSegments(s.clause.segments, `${i}.`)}`
  }).join('\n')

  const contextLine = context
    ? `\n完整语境（仅供理解背景）："${context}"`
    : ''
  const userMessage = `待翻译文本（英文）：\n"${text}"\n\n成分切分（顶层编号即 enIndex；从句内部编号为「顶层编号.内部编号」，children 的 enIndex 取内部编号）：\n${segList}${contextLine}`

  const params = chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    // 嵌套 children 结构开销更大，按字符数放大上限，避免长句输出被截断
    max_tokens: Math.min(4000, Math.max(500, Math.round(text.length * 3)))
  })

  // 与成分解析一致：校验失败自动补一次请求
  let lastError
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await createChatCompletion(params, 'text', signal, '对齐翻译')
    try {
      const parsed = parseJsonSafely(response.choices[0].message.content)
      const raw = Array.isArray(parsed.segments) ? parsed.segments : []
      const out: any[] = []
      const seen = new Set<number>()
      for (const item of raw) {
        const enIndex = Number(item?.enIndex)
        if (!Number.isInteger(enIndex) || enIndex < 0 || enIndex >= segs.length) {
          throw new Error('enIndex 越界')
        }
        if (seen.has(enIndex)) throw new Error('enIndex 重复')
        seen.add(enIndex)
        const entry: any = { enIndex, zh: String(item?.zh ?? '').trim() }
        // 从句片段：校验 children 与内部切分一一对应；失败仅丢弃 children（回退整体译文），不判整次失败
        const seg = segs[enIndex]
        if (seg?.clause) {
          const children = normalizeAlignedChildren(item?.children, seg.clause.segments)
          if (children) entry.children = children
        }
        out.push(entry)
      }
      if (seen.size !== segs.length) throw new Error('存在未对应的成分片段')
      if (!out.some((o: any) => o.zh || o.children?.some((c: any) => c.zh))) throw new Error('对应译文为空')
      const result = { segments: out }
      alignedCacheSet(cacheKey, result)
      return result
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}

/**
 * 划词追问：针对选中文本的多轮对话式解析（语法结构、句子成分、时态语态等），流式输出。
 * @param {Array<{role: 'user'|'assistant', content: string}>} history 对话历史（含本轮用户提问，末尾为 user）
 * @param {string} text 选中的待解析文本
 * @param {string} context 选中文本所在语境（仅供 AI 理解背景，可为空）
 * @param {string} fullText 完整文章全文（供 AI 通读全局背景，可为空）
 * @param {(delta: string, full: string) => void} onDelta 流式增量回调（增量, 累计全文）
 * @param {AbortSignal} signal 外部中止信号（关闭窗口时 abort）
 * @returns {Promise<string>} 完整回答文本
 */
export async function chatAboutSelection(
  history: any[],
  text: string,
  context = '',
  fullText = '',
  onDelta?: (delta: string) => void,
  signal?: AbortSignal
) {
  const model = getModel()

  const contextLine = context
    ? `\n完整语境（仅供理解背景）："${context}"`
    : ''
  const fullTextLine = fullText
    ? `\n完整文章（供通读背景，便于回答与全篇相关的问题）：\n"${fullText}"`
    : ''
  // system 保持纯固定指令（不含待解析文本）：不同选区的追问共享同一 system 前缀，
  // 利于服务端前缀缓存命中；待解析文本改由首条 user 消息固定携带
  const systemMessage = `你是英语学习助教。用户正在精读一篇英语文章，会针对一段选中的文本提问（语法解析、句子结构、时态语态、词汇用法、翻译等）。
回答要求：
1. 使用中文回答，条理清晰，面向中国英语学习者
2. 直接输出内容，不要使用 Markdown 表格、代码块`

  // 历史最多带最近 10 条，防止 token 膨胀；裁剪后若以 assistant 开头，
  // 会与固定确认消息连成两条 assistant，丢弃开头连续的 assistant 直到首个 user
  const trimmedHistory = (history || [])
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .slice(-10)
  while (trimmedHistory.length && trimmedHistory[0].role === 'assistant') {
    trimmedHistory.shift()
  }

  return await streamChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      // 完整文章 + 待解析文本 + 语境作为首条 user 消息固定传入，同一会话多轮追问时内容不变
      { role: 'user', content: `${fullTextLine}${fullTextLine ? '\n' : ''}待解析文本：\n"${text}"${contextLine}` },
      // 固定 assistant 确认，保证 user/assistant 严格交替，兼容严格校验角色交替的供应商
      { role: 'assistant', content: '收到，我已了解这段文本。请针对它提问。' },
      ...trimmedHistory
    ],
    max_tokens: useSettingsStore().selectionChatMaxTokens || 1000
  }), 'text', onDelta, signal, '划词追问')
}

/**
 * 单个单词生成（带重试）：失败后退避重试，全部尝试仍失败才抛出最后一次错误。
 * 限流/网络抖动等瞬时错误可通过重试自愈，避免整批单词静默丢失。
 */
async function generateWordWithRetry(item: any, settings: any, signal?: AbortSignal) {
  const word = typeof item === 'string' ? item : item.word
  const context = typeof item === 'string' ? '' : item.context
  const maxAttempts = 3
  let lastError = null

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    try {
      const info = await generateWordBasicInfo(word, context, signal)
      return { word, info, success: true }
    } catch (error) {
      // 主动取消不重试，直接向上抛
      if (signal?.aborted || (error as Error)?.name === 'AbortError') throw error
      lastError = error
      if (settings.debugMode) {
        console.warn(`[批量生成] "${word}" 第 ${attempt}/${maxAttempts} 次尝试失败: ${(error as Error)?.message}`)
      }
      if (attempt < maxAttempts) {
        // 退避等待（1s、2s），缓解限流压力
        await new Promise(resolve => setTimeout(resolve, attempt * 1000))
      }
    }
  }
  throw lastError
}

/** 合批单词释义的 system 指令：一次请求处理多词，要求逐个返回且 word 原样回填 */
const WORD_BATCH_SYSTEM_MESSAGE = `你是英语词典助手。我会给出多个英文单词及它们各自所在的句子，请为每个单词给出释义。返回JSON格式，严格遵守以下规则：
1. partOfSpeech 必须使用英文缩写：n. v. adj. adv. pron. prep. conj. art. int.（多个词性用"/"连接，如"v./n."）
2. definitions 最多2个最常用的意思
3. 必须结合每个单词所在句子，理解其在文中的含义
4. 必须覆盖我给出的每一个单词，word 字段原样返回

返回格式：
{
  "results": [
    {"word": "单词", "definitions": [{"partOfSpeech": "英文缩写词性", "meaning": "中文释义"}]}
  ]
}`

/** 合批单批上限：词数与字符数双限制，避免单批过大导致输出被截断 */
const WORD_BATCH_MAX_WORDS = 30
const WORD_BATCH_MAX_CHARS = 2000
// 合批请求的批间并发缺省值：实际并发优先取调用方传入值，
// 其次取设置中的「最大并发数」（默认 50），都没有时才用此兜底。
const WORD_BATCH_CONCURRENCY = 8

/**
 * 合批生成单词释义：一次请求处理一批单词（每词携带其所在完整句作为语境），
 * 结果按 word（小写）匹配回填，不依赖数组下标，容错更强。
 * @param {Array<{word: string, context: string}>} items 同批单词及其语境
 * @param {AbortSignal} [signal] 外部中止信号
 * @returns {Promise<Array<{word: string, info?: object, error?: string, success: boolean}>>}
 */
async function generateWordBatch(items: any[], signal?: AbortSignal) {
  const settings = useSettingsStore()
  const model = getModel()

  const lines = items.map((item, i) =>
    item.context
      ? `${i + 1}. 单词 "${item.word}"\n   所在句：${item.context}`
      : `${i + 1}. 单词 "${item.word}"`
  )

  const response = await createChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: WORD_BATCH_SYSTEM_MESSAGE },
      { role: 'user', content: `请为以下 ${items.length} 个单词给出释义：\n${lines.join('\n')}` }
    ],
    response_format: { type: 'json_object' },
    // JSON 数组结构开销大于单对象，按词数放大上限，避免长批输出被截断
    max_tokens: Math.min(8000, Math.max(500, (settings.basicInfoMaxTokens || 300) * items.length))
  }), 'text', signal, `单词释义（合批 ${items.length} 词）`)

  const parsed = parseJsonSafely(response.choices[0].message.content)
  const rawResults = Array.isArray(parsed.results) ? parsed.results : []
  const definitionsByWord = new Map()
  for (const raw of rawResults) {
    const word = String(raw?.word || '').trim().toLowerCase()
    if (!word || definitionsByWord.has(word)) continue
    const definitions = Array.isArray(raw?.definitions) ? raw.definitions : []
    if (definitions.length) definitionsByWord.set(word, definitions)
  }

  return items.map(item => {
    const definitions = definitionsByWord.get(item.word.toLowerCase())
    if (!definitions) {
      return { word: item.word, error: '未返回释义', success: false }
    }
    return { word: item.word, info: { definitions }, success: true }
  })
}

/**
 * 按「词数 + 字符数」双上限，把同语境的单词组顺序打包成多个批次。
 * 同一句子的词共享语境，句子越长单批容纳的词越少（用户要求句子信息优先）。
 * @param {Array<{sentence: string, words: string[]}>} groups 同语境单词组（按句子在文中先后排列）
 * @returns {Array<Array<{word: string, context: string}>>}
 */
function packWordBatches(groups: any[]): any[] {
  const batches: any[][] = []
  let current: any[] = []
  let currentChars = 0
  const flush = () => {
    if (current.length) {
      batches.push(current)
      current = []
      currentChars = 0
    }
  }
  for (const group of groups) {
    const sentenceChars = group.sentence ? group.sentence.length : 0
    for (const word of group.words) {
      const itemChars = word.length + sentenceChars
      if (current.length && (current.length >= WORD_BATCH_MAX_WORDS || currentChars + itemChars > WORD_BATCH_MAX_CHARS)) {
        flush()
      }
      current.push({ word, context: group.sentence || '' })
      currentChars += itemChars
    }
  }
  flush()
  return batches
}

/**
 * 处理单个合批批次：整批成功直接返回；批内缺词或整批失败时降级为逐词请求
 * （复用 generateWordWithRetry 的退避重试），保证「不丢词」。
 * 约定：每个词的进度回调（report）恰好触发一次；被取消的词不上报（与历史逐词实现一致）。
 * @param {Array<{word: string, context: string}>} batch
 * @param {object} settings settings store 实例
 * @param {(error: string|null) => void} report 单词粒度的进度回调（仅传错误信息）
 * @param {AbortSignal} [signal]
 */
async function runWordBatch(
  batch: any,
  settings: any,
  report: (error: string | null) => void,
  signal?: AbortSignal
) {
  const canceled = () => batch.map((it: any) => ({ word: it.word, error: '已取消', success: false }))
  if (signal?.aborted) return canceled()

  // 逐词降级：对给定单词并发发起单请求，成功/失败均按词上报进度
  const retryOneByOne = async (list: any[]): Promise<any[]> => {
    const settled = await Promise.allSettled(
      list.map((item: any) => generateWordWithRetry(item, settings, signal))
    )
    return settled.map((r, i) => {
      const word = list[i].word
      if (r.status === 'fulfilled') {
        report(null)
        return r.value
      }
      if (signal?.aborted) return { word, error: '已取消', success: false }
      report(r.reason?.message)
      return { word, error: r.reason?.message, success: false }
    })
  }

  try {
    const batchResults = await generateWordBatch(batch, signal)
    if (signal?.aborted) return canceled()

    const results: any[] = []
    const missing: any[] = []
    for (const result of batchResults) {
      if (result.success) {
        report(null)
        results.push(result)
      } else {
        missing.push(batch.find((item: any) => item.word === result.word) || { word: result.word, context: '' })
      }
    }
    if (missing.length) {
      if (settings.debugMode) {
        console.warn(`[批量生成] 合批响应缺少 ${missing.length} 个词的释义，降级逐词重试`)
      }
      results.push(...await retryOneByOne(missing))
    }
    return results
  } catch (error) {
    if (signal?.aborted) return canceled()
    if (settings.debugMode) {
      console.warn(`[批量生成] 合批请求失败，降级逐词重试（${batch.length} 个词）: ${(error as Error)?.message}`)
    }
    return await retryOneByOne(batch)
  }
}

/**
 * 批量生成单词释义，两种模式：
 * - 合批（settings.enableBatchWordRequest 为 true，默认）：同语境的词打包进一次请求
 * - 逐词（开关关闭）：沿用原有并发逐词请求，行为与历史版本完全一致
 * 两种模式的进度回调均为「单词」粒度，返回元素结构均为 { word, info } / { word, error }。
 * @param {Array<string|{word: string, context: string}>} words
 * @param {(completed: number, total: number, error: string|null) => void} onProgress
 * @param {number} [concurrency] 逐词模式为请求并发数；合批模式为批间并发数
 * @param {AbortSignal} [signal]
 */
export async function batchGenerateWords(
  words: any[],
  onProgress?: (completed: number, total: number, error: string | null) => void,
  concurrency?: number,
  signal?: AbortSignal
) {
  // 批量多线程生成会并发/分批发出多次请求，调试模式下把整批用量汇总到最后一次性打印
  return withAiUsageSummary('批量生成单词释义', () =>
    runBatchGenerateWords(words, onProgress, concurrency, signal)
  )
}

async function runBatchGenerateWords(
  words: any[],
  onProgress?: (completed: number, total: number, error: string | null) => void,
  concurrency?: number,
  signal?: AbortSignal
) {
  const settings = useSettingsStore()
  const items = (words || []).map((item: any) => ({
    word: typeof item === 'string' ? item : item.word,
    context: typeof item === 'string' ? '' : (item.context || '')
  }))
  const total = items.length
  let completed = 0
  const report = (error: string | null): void => {
    completed++
    onProgress!(completed, total, error || null)
  }

  // 逐词模式：与原实现保持一致
  if (!settings.enableBatchWordRequest) {
    if (!concurrency) {
      concurrency = settings.maxConcurrency || 50
    }
    const results = []
    for (let i = 0; i < total; i += concurrency) {
      if (signal?.aborted) break
      const batch = items.slice(i, i + concurrency)
      const batchResults = await Promise.allSettled(
        batch.map(async (item) => {
          try {
            const result = await generateWordWithRetry(item, settings, signal)
            report(null)
            return result
          } catch (error) {
            if (signal?.aborted) return { word: item.word, error: '已取消', success: false }
            report((error as Error)?.message)
            return { word: item.word, error: (error as Error)?.message, success: false }
          }
        })
      )
      results.push(...batchResults.map((r: any) => r.value || r.reason))
    }
    return results
  }

  // 合批模式：按语境（完整句子）分组后顺序打包成批
  const groupMap = new Map()
  for (const item of items) {
    const key = item.context || ''
    if (!groupMap.has(key)) groupMap.set(key, { sentence: key, words: [] })
    groupMap.get(key).words.push(item.word)
  }
  const batches = packWordBatches([...groupMap.values()])

  // 批间并发：不再硬性封顶为 3，改为跟随调用方传入值 / 设置里的「最大并发数」，
  // 让多个句子所在的批可以同时请求（词多时批次数才会多于并发数，届时按批排队）
  const batchConcurrency = Math.max(
    1,
    Number(concurrency) || settings.maxConcurrency || WORD_BATCH_CONCURRENCY
  )
  const results = []
  for (let i = 0; i < batches.length; i += batchConcurrency) {
    if (signal?.aborted) break
    const slice = batches.slice(i, i + batchConcurrency)
    const settled = await Promise.allSettled(
      slice.map(batch => runWordBatch(batch, settings, report, signal))
    )
    for (const r of settled) {
      results.push(...(r.status === 'fulfilled' ? r.value : (r.reason || [])))
    }
  }
  return results
}

const ARTICLE_STYLE_MAP: Record<string, string> = {
  general: '通用',
  story: '故事',
  news: '新闻',
  academic: '学术',
  dialogue: '对话'
}

const ESSAY_TYPE_MAP: Record<string, string> = {
  small: '高中小作文（简洁正式的应用文）',
  long: '高中大作文（读后续写风格，以叙事为主，情节完整且有推进）'
}

const FORMAT_MAP: Record<string, string> = {
  general: '普通作文（无特定格式，按常规作文书写）',
  recommendation: '推荐信（应用文书信格式，开头称呼，正文说明推荐理由，结尾用 Yours sincerely 并署名 Li Hua）',
  thankYou: '感谢信（应用文书信格式，开头称呼，正文表达感谢及原因，结尾用 Yours sincerely 并署名 Li Hua）',
  invitation: '邀请信（应用文书信格式，开头称呼，正文说明活动时间地点与安排，结尾用 Yours sincerely 并署名 Li Hua）',
  suggestion: '建议信（应用文书信格式，开头称呼，正文给出具体建议及理由，结尾用 Yours sincerely 并署名 Li Hua）',
  application: '申请信（应用文书信格式，开头称呼，正文介绍自己并说明申请理由，结尾用 Yours sincerely 并署名 Li Hua）',
  apology: '道歉信（应用文书信格式，开头称呼，正文诚恳道歉并说明补救措施，结尾用 Yours sincerely 并署名 Li Hua）',
  complaint: '投诉信（应用文书信格式，开头称呼，正文客观说明问题并表达诉求，结尾用 Yours sincerely 并署名 Li Hua）'
}

export async function generateArticle(words: string[], options: any = {}, signal?: AbortSignal) {
  const model = getModel()

  const {
    mode = 'essay',
    essayType = 'small',
    format = 'general',
    style = 'general',
    wordCount = 80,
    customDescription = '',
    sourceArticle = ''
  } = options

  const isEssay = mode === 'essay'
  const isContinuation = isEssay && essayType === 'long'
  const count = Math.min(2000, Math.max(20, Math.round(Number(wordCount) || 80)))
  const para = Math.max(2, Math.min(6, Math.round(count / 80)))
  const maxTokens = Math.min(8192, Math.max(500, count * 3))

  let systemMessage
  let userContent

  if (isContinuation) {
    const lines = [
      '请根据以下阅读材料续写文章。',
      '',
      '【阅读材料与题目说明】',
      sourceArticle,
      '',
      '【续写要求】',
      `- 续写长度：约 ${count} 个英文单词（允许 ±10% 浮动），分 ${para} 段`,
      '- 时态与叙事风格需与阅读材料保持一致',
      '- 情节合理连贯，有清晰的发展和自然的结局',
      '- 若材料中给出了段落开头句，续写的各段必须以此开头'
    ]
    if (words.length) lines.push('- 尽量自然地包含以下单词：' + words.join(', '))
    if (customDescription) lines.push('- 其他要求：' + customDescription)
    lines.push('')
    lines.push('请只返回续写正文内容，不要标题、不要任何额外解释。')

    systemMessage = '你是英语续写助手。请根据给定阅读材料进行读后续写，保持与原文一致的时态、人称和叙事风格，情节衔接自然，内容完整。'
    userContent = lines.join('\n')
  } else {
    const lines = [
      '1. 自然地包含以下单词：' + (words.length ? words.join(', ') : '（不限）')
    ]
    if (isEssay) {
      lines.push('2. 作文类型：' + (ESSAY_TYPE_MAP[essayType] || ESSAY_TYPE_MAP.small))
      if (essayType === 'small') {
        lines.push('3. 写作格式：' + (FORMAT_MAP[format] || FORMAT_MAP.general))
      }
    } else {
      lines.push('2. 文章风格：' + (ARTICLE_STYLE_MAP[style] || '通用'))
    }
    lines.push('4. 难度：高中水平，词汇与句式符合高中生英语写作要求')
    lines.push(`5. 长度：约 ${count} 个英文单词（允许 ±10% 浮动）`)
    lines.push(`6. 段落数：约 ${para} 段`)
    if (customDescription) lines.push('7. 其他要求：' + customDescription)
    lines.push('请只返回文章正文内容，不要标题、不要任何额外解释。')

    systemMessage = '你是一个英语写作助手。请根据给定的单词列表生成一篇英语文章，文章要自然地包含这些单词，供英语学习者阅读。'
    userContent = '请生成一篇英语文章，要求：\n' + lines.join('\n')
  }

  const response = await createChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userContent }
    ],
    max_tokens: maxTokens
  }), 'text', signal, '文章生成')

  return response.choices[0].message.content
}

export async function generateArticleMeta(content: string, options: any = {}) {
  const model = getModel()

  const {
    mode = 'essay',
    essayType = 'small',
    style = 'general'
  } = options

  let styleDesc
  if (mode === 'essay') {
    styleDesc = essayType === 'long' ? '读后续写文章' : '高中英语作文'
  } else {
    styleDesc = ARTICLE_STYLE_MAP[style] || '英语文章'
  }

  const response = await createChatCompletion(chatOptions({
    model,
    messages: [
      {
        role: 'system',
        content: `你是英语写作助手。请根据文章内容生成英文标题与中文描述，返回JSON格式：
{
  "title": "英文标题",
  "description": "中文描述"
}
要求：
1. title：5-12个单词，切题、吸引人，不要使用引号、句号，不要包含换行
2. description：必须使用中文，一句话概括文章大致内容（30-60字），供学习者快速了解文章`
      },
      {
        role: 'user',
        content: `这是一篇${styleDesc}，请根据以下内容生成英文标题与中文描述：\n\n${content.slice(0, 3000)}`
      }
    ],
    response_format: { type: 'json_object' },
    max_tokens: 150
  }), 'text', undefined, '文章标题描述')

  const parsed = JSON.parse(response.choices[0].message.content)
  return {
    title: (parsed.title || '').trim(),
    description: (parsed.description || '').trim()
  }
}

export async function fetchModels(providerId: string) {
  const settings = useSettingsStore()
  const provider = settings.providers.find(p => p.id === providerId)
  if (!provider || !provider.endpoint || !provider.apiKey) {
    throw new Error('请先选择供应商并填写 API Key')
  }
  const list = await listModelsForProvider(provider)
  return list.data.map((m: any) => m.id).sort()
}

export async function testConnection(type: ChatModelType = 'text') {
  try {
    const model = getModel(type)

    if (type === 'vision') {
      // 视觉模型：发送带固定文字的图片，要求模型读出文字，只有正确识别才判定支持视觉。
      // max_tokens 需给足：支持思考的模型（如 deepseek-reasoner、qwen3 系列）会先输出思考链，
      // 若上限过小会导致最终答案 content 被截断为空，从而被误判失败。
      const response = await createChatCompletion(chatOptions({
        model,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: '请直接读出图片中的文字并输出，不要输出思考过程或任何解释' },
            { type: 'image_url', image_url: { url: makeTestImage() } }
          ]
        }],
        max_tokens: 10
      }), type, undefined, '视觉连通测试')

      // content 为空时回退到 reasoning_content（部分思考模型答案被截断到思考字段里）
      const message = response?.choices?.[0]?.message || {}
      const rawReply = String(message.content || message.reasoning_content || '').trim()
      const normalized = rawReply.replace(/\s+/g, '').toLowerCase()
      if (normalized.includes(VISION_TEST_TEXT.toLowerCase())) {
        return { success: true, message: '连接成功，视觉能力正常' }
      }
      const replyHint = rawReply
        ? `\n模型回复内容：${rawReply.length > 200 ? rawReply.slice(0, 200) + '…' : rawReply}`
        : ''
      return {
        success: false,
        message: '该模型未能正确识别图片内容，可能不支持视觉/多模态输入，请更换支持视觉的模型' + replyHint
      }
    }

    // 文本模型：仅验证接口连通
    await createChatCompletion(chatOptions({
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 10
    }), type, undefined, '文本连通测试')
    return { success: true, message: '连接成功' }
  } catch (error) {
    return { success: false, message: (error as Error)?.message }
  }
}

// ---- 图片识别（视觉模型） ----

/** 构建多模态用户消息：文本指令 + 多张图片（按传入顺序） */
function imageContent(imageDataUrls: string[], text: string) {
  const parts: any[] = [{ type: 'text', text }]
  for (const url of imageDataUrls) {
    parts.push({ type: 'image_url', image_url: { url } })
  }
  return parts
}

/** 稳健解析模型返回的 JSON：兼容被 markdown 代码块包裹、或前后带杂字的情况 */
function parseJsonSafely(content: string): any {
  const text = (content || '').trim()
  try {
    return JSON.parse(text)
  } catch {
    // 去掉 ```json ... ``` 代码块包裹
    const fenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
    try {
      return JSON.parse(fenced)
    } catch {
      // 提取首个 { ... } 块
      const start = text.indexOf('{')
      const end = text.lastIndexOf('}')
      if (start !== -1 && end > start) {
        return JSON.parse(text.slice(start, end + 1))
      }
      throw new Error('AI 返回内容无法解析')
    }
  }
}

// 图片识别接口的 max_tokens 上限（API 请求参数，多张图片时不再放大）
export const IMAGE_MAX_TOKENS = 4000
// 进度条预算：每张图片默认 1000 tokens，仅用于「照片导入」加载动画的进度估算
export const IMAGE_TOKENS_BUDGET = 1000

/**
 * 识别图片中的英文文章，提取标题、描述与正文。支持一次传入多张图片（同一篇文章按顺序的多个部分）。
 * @param {string[]} imageDataUrls 图片 Data URL（base64）数组
 * @returns {Promise<{title: string, description: string, content: string}>}
 */
export async function extractArticleFromImages(
  imageDataUrls: string[],
  onProgress?: (current: number, total: number) => void,
  signal?: AbortSignal
) {
  const model = getModel('vision')
  const budget = IMAGE_TOKENS_BUDGET * imageDataUrls.length

  const multiImageHint = imageDataUrls.length > 1
    ? `\n5. 本次传入多张图片，它们是同一篇文章按顺序的多个部分，请跨越图片边界拼接为完整正文，不要在图片衔接处遗漏或重复内容\n`
    : ''

  const systemMessage = `你是英语文章识别助手。图片通常来自试卷、习题册等，可能是某道阅读理解的原文。请识别并提取其中的英文文章正文。

返回JSON格式：
{
  "title": "文章标题（若为试卷中的阅读题，可依据试卷信息判断题目类型，如\\"阅读理解\\"；有明确文章标题则用标题，无标题可留空字符串）",
  "description": "用中文一句话概括文章大致内容（30-60字，若无法判断可留空字符串）",
  "content": "仅提取文章正文原文，保持原段落换行结构，不要遗漏、不要改写"
}

要求：
1. content 只提取文章正文（如阅读理解的原文，可包含选项内容），不得包含题目要求、题干、页码、水印、广告、装饰等非正文内容
2. 如果图片是试卷中的阅读题，可将题型信息（如"阅读理解"）体现在 title 中，题目要求等信息在 description 中概括说明，不进入 content
3. content 必须完整、逐字准确识别图片中的英文原文，保持原有段落和换行，不要遗漏、不要改写
4. 如果图片模糊导致个别单词无法辨认，用 [illegible] 占位${multiImageHint}`

  const content = await streamChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: imageContent(imageDataUrls, '请识别并提取以下图片中的英文文章内容。') }
    ],
    response_format: { type: 'json_object' },
    max_tokens: IMAGE_MAX_TOKENS
    // 原调用缺少 signal 占位，导致 label 落在 signal 参数位（运行时无效信号，等价于未传）；
    // 此处补占位使参数归位，并把外部传入的 signal 透传给请求层（取消即中止在途 fetch）
  }), 'vision', onProgress
    ? (_delta: string, full?: string) => onProgress(Math.min(budget, estimateTokens(full || '')), budget)
    : undefined, signal, '图片识别文章')

  const parsed = parseJsonSafely(content)
  return {
    title: String(parsed.title || '').trim(),
    description: String(parsed.description || '').trim(),
    content: String(parsed.content || '').trim()
  }
}

/**
 * 解析图片中的英语写作题目，提取写作要求用于回填生成参数。支持一次传入多张图片（可能构成同一题目/材料）。
 * @param {string[]} imageDataUrls 图片 Data URL（base64）数组
 * @returns {Promise<object>} 生成参数对象
 */
export async function extractTaskFromImages(
  imageDataUrls: string[],
  onProgress?: (current: number, total: number) => void
) {
  const model = getModel('vision')
  const budget = IMAGE_TOKENS_BUDGET * imageDataUrls.length

  const multiImageHint = imageDataUrls.length > 1
    ? `- 多张图片可能构成同一道题目或同一份材料（如读后续写跨页），请综合所有图片内容提取要求、拼接材料原文，不要遗漏或重复`
    : ''

  const systemMessage = `你是英语写作命题解析助手。请仔细阅读图片中的英语作文题目/考试题目，提取其中的写作要求。

返回JSON格式（字段值必须严格来自下面给出的枚举）：
{
  "mode": "essay" 或 "article",
  "essayType": "small" 或 "long",
  "format": "general" / "recommendation" / "thankYou" / "invitation" / "suggestion" / "application" / "apology" / "complaint",
  "style": "general" / "story" / "news" / "academic" / "dialogue",
  "wordCount": 80,
  "customDescription": "其它写作要求的中文概括",
  "sourceArticle": "读后续写的阅读材料原文（含段落开头句，若没有则为空字符串）",
  "words": ["需要包含的单词1", "需要包含的单词2"]
}

字段说明：
- mode：图片是「作文/题目」→ "essay"；是「普通命题文章」→ "article"
- essayType：高中小作文/应用文 → "small"；读后续写/大作文 → "long"
- format：写作格式。普通无特定格式 → "general"；推荐信 → "recommendation"；感谢信 → "thankYou"；邀请信 → "invitation"；建议信 → "suggestion"；申请信 → "application"；道歉信 → "apology"；投诉信 → "complaint"
- style：普通文章的风格。通用 → "general"；故事 → "story"；新闻 → "news"；学术 → "academic"；对话 → "dialogue"
- wordCount：题目要求字数（数字，无明确要求则填 80）
- customDescription：除上述字段外，题目中的其它具体要求（用中文概括），没有则空字符串
- sourceArticle：如果是读后续写，完整提取阅读材料原文及段落开头句；否则空字符串
- words：题目明确要求必须使用的单词/短语列表，没有则为空数组 []
${multiImageHint}`

  const content = await streamChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: imageContent(imageDataUrls, '请解析以下图片中的英语写作题目，提取写作要求。') }
    ],
    response_format: { type: 'json_object' },
    max_tokens: IMAGE_MAX_TOKENS
    // 同 extractArticleFromImages：补 undefined 占位使 label 归位（signal 原本无效，语义一致）
  }), 'vision', onProgress
    ? (_delta: string, full?: string) => onProgress(Math.min(budget, estimateTokens(full || '')), budget)
    : undefined, undefined, '图片识别题目')

  const parsed = parseJsonSafely(content)
  return {
    mode: parsed.mode === 'article' ? 'article' : 'essay',
    essayType: parsed.essayType === 'long' ? 'long' : 'small',
    format: FORMAT_MAP[parsed.format] ? parsed.format : 'general',
    style: ARTICLE_STYLE_MAP[parsed.style] ? parsed.style : 'general',
    wordCount: Number.isFinite(Number(parsed.wordCount))
      ? Math.round(Number(parsed.wordCount))
      : 80,
    customDescription: String(parsed.customDescription || '').trim(),
    sourceArticle: String(parsed.sourceArticle || '').trim(),
    words: Array.isArray(parsed.words)
      ? parsed.words.map((w: any) => String(w).trim()).filter(Boolean)
      : []
  }
}
