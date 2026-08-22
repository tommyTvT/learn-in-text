import { useSettingsStore, PRESET_PROVIDERS } from '../stores/settings'

/**
 * 根据模型类型（text / vision）解析对应的供应商与模型配置。
 * - 文本：使用 textModelConfig 的供应商与模型
 * - 视觉：优先使用 visionModelConfig；未配置有效供应商时回退到文本模型（共用供应商）
 */
function getModelConfig(type = 'text') {
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

function getModel(type = 'text') {
  return getModelConfig(type).model
}

function chatOptions(options) {
  return {
    ...options,
    thinking: { type: 'disabled' }
  }
}

// 视觉模型测试用图片：生成一张带固定文字的图片，模型需正确读出该文字才算支持视觉。
// 固定文本降低随机性与 token 开销，避免随机码带来的识别歧义。
const VISION_TEST_TEXT = '123'

function makeTestImage() {
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
function hasImageContent(body) {
  return (body?.messages || []).some(m =>
    Array.isArray(m.content) && m.content.some(part => part?.type === 'image_url')
  )
}

/** 基于 fetch 的 OpenAI 兼容客户端，替代体积较大的 openai SDK */
async function request(path, { baseURL, apiKey, body, timeoutMs, signal }) {
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

async function createChatCompletion(params, type = 'text', signal) {
  const { baseURL, apiKey, timeoutMs } = getModelConfig(type)
  return request('/chat/completions', { baseURL, apiKey, body: params, timeoutMs, signal })
}

/** 估算文本 token 数（粗略近似，仅用于进度条）：英文约 4 字符/token，中文约 1 字符/token */
function estimateTokens(text) {
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
async function streamChatCompletion(params, type = 'text', onDelta, signal) {
  const { baseURL, apiKey, timeoutMs } = getModelConfig(type)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const onOuterAbort = () => ctrl.abort()
  signal?.addEventListener('abort', onOuterAbort)
  try {
    const res = await fetch(baseURL + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ ...params, stream: true }),
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
        const delta = json?.choices?.[0]?.delta
        const text = typeof delta?.content === 'string' ? delta.content : ''
        if (text) {
          full += text
          if (onDelta) onDelta(text, full)
        }
      }
    }
    return full
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

async function listModelsForProvider(provider) {
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

export async function generateWordBasicInfo(word, context = '') {
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
  }))

  return JSON.parse(response.choices[0].message.content)
}

export async function generateWordContextTranslation(word, sentence, context) {
  const model = getModel()

  // 兜底：未提供目标句时退回整段上下文
  if (!sentence) sentence = context || ''

  const systemMessage = `你是英语词典助手。我会在用户消息中提供“完整语境”和“目标句”，只翻译目标句。
翻译规则：
1. 完整语境仅用于理解背景，禁止翻译或输出其中目标句以外的内容
2. 必须用 **...** 双星号标记目标单词对应的中文翻译
返回JSON格式：
{
  "contextTranslation": "目标句的完整翻译，目标词用**标记**"
}

示例：
- 单词 read，完整语境 "Reading is my hobby. I read an interesting book yesterday. It was fun."，目标句 "I read an interesting book yesterday" → {"contextTranslation": "我昨天**读**了一本有趣的书"}`

  const userMessage = context && context !== sentence
    ? `完整语境（仅供理解背景，不要翻译）：\n"${context}"\n\n目标句（只需翻译这一句）：\n"${sentence}"\n\n请只翻译目标句，并标记单词 "${word}" 对应的中文`
    : `句子："${sentence}"\n\n请翻译句子并标记单词 "${word}" 对应的中文`

  const response = await createChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userMessage }
    ],
    response_format: { type: 'json_object' },
    max_tokens: useSettingsStore().contextMaxTokens || 200
  }))

  return JSON.parse(response.choices[0].message.content)
}

/**
 * 划词翻译：翻译用户选中的任意文本（单词/词组/句子/多句）。
 * 沿用「传得多、翻得短」约束：语境仅供理解背景，只翻译选中文本。
 * @param {string} selection 选中的待翻译文本
 * @param {string} context 选中文本所在语境（可为空）
 * @returns {Promise<{translation: string}>}
 */
export async function generateSelectionTranslation(selection, context = '') {
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
  }))

  const parsed = parseJsonSafely(response.choices[0].message.content)
  return { translation: String(parsed.translation || '').trim() }
}

/** 句子成分角色合法枚举（与前端 grammarConstants 的 ROLE_LABELS 对应） */
const COMPONENT_ROLES = ['subject', 'predicate', 'object', 'attributive', 'adverbial', 'complement', 'predicative']

/** 从句大类 → 合法子类枚举（与前端 grammarConstants 的 CLAUSE_SUBTYPE_LABELS 对应） */
const CLAUSE_SUBTYPES = {
  noun: ['subject_clause', 'object_clause', 'predicative_clause', 'appositive_clause'],
  relative: ['restrictive', 'non_restrictive'],
  adverbial: ['time', 'place', 'reason', 'condition', 'concession', 'purpose', 'result', 'manner', 'comparison']
}

/** 名词性从句子类 → 在主句中充当的成分（用于校正 AI 标注） */
const NOUN_CLAUSE_ROLES = {
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
function normalizeForCompare(text) {
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
function normalizeSegment(raw, depth = 0) {
  if (!raw || typeof raw !== 'object') return null
  const text = String(raw.text ?? '')
  if (!text) return null
  const role = COMPONENT_ROLES.includes(raw.role) ? raw.role : 'none'
  const node = { text, role }

  const clause = raw.clause
  if (clause && typeof clause === 'object' && depth < MAX_CLAUSE_DEPTH) {
    const type = Object.prototype.hasOwnProperty.call(CLAUSE_SUBTYPES, clause.type)
      ? clause.type
      : null
    if (type) {
      const subtype = CLAUSE_SUBTYPES[type].includes(clause.subtype) ? clause.subtype : ''
      const children = (Array.isArray(clause.segments) ? clause.segments : [])
        .map(s => normalizeSegment(s, depth + 1))
        .filter(Boolean)
      // 从句内部拼接须还原从句原文，否则视为不可靠结构，降级为普通片段
      const joined = normalizeForCompare(children.map(c => c.text).join(''))
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
 * 句子成分解析的会话级内存缓存（简易 LRU）：
 * 阅读时反复选中同一段文本（含相同语境）直接复用历史解析结果，避免重复 AI 请求。
 */
const componentParseCache = new Map()
const COMPONENT_CACHE_MAX = 50

function componentCacheKey(text, context) {
  return text + '|||' + (context || '')
}

/** LRU 读：命中后移到 Map 尾部（最近使用）；深拷贝返回，避免调用方改动影响缓存 */
function componentCacheGet(key) {
  if (!componentParseCache.has(key)) return undefined
  const value = componentParseCache.get(key)
  componentParseCache.delete(key)
  componentParseCache.set(key, value)
  return structuredClone(value)
}

/** LRU 写：达到上限时淘汰 Map 首个条目（最久未使用）；存入深拷贝，保持缓存数据不被外部改动污染 */
function componentCacheSet(key, value) {
  if (componentParseCache.size >= COMPONENT_CACHE_MAX) {
    componentParseCache.delete(componentParseCache.keys().next().value)
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
export async function parseSelectionComponents(text, context = '', signal) {
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
- none：标点、连词、从句引导词等不单独归入上述成分的部分

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
4. 从句引导词（that/which/who/because/although/if/when 等）作为从句内部第一个片段，role 为 none
5. 非限制性定语从句前的逗号是独立片段（role 为 none），不并入从句
6. 从句片段的 text 是从句完整原文（含引导词）
7. 若文本不是完整句子（单词、词组等），也按其内部结构尽力标注；无从句时片段不带 clause 字段
8. 只返回 JSON，不要任何解释；text 值不加引号或其它包裹符号

返回JSON格式示例一（The book that I bought yesterday is interesting.）：
{ "segments": [
  { "text": "The book ", "role": "subject" },
  { "text": "that I bought yesterday", "role": "attributive", "clause": { "type": "relative", "subtype": "restrictive", "segments": [
    { "text": "that", "role": "none" },
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
    { "text": "that", "role": "none" },
    { "text": "you ", "role": "subject" },
    { "text": "called", "role": "predicate" } ] } },
  { "text": " ", "role": "none" },
  { "text": "when he comes back", "role": "adverbial", "clause": { "type": "adverbial", "subtype": "time", "segments": [
    { "text": "when", "role": "none" },
    { "text": "he ", "role": "subject" },
    { "text": "comes back", "role": "predicate" } ] } },
  { "text": ".", "role": "none" } ] }`

  const contextLine = context
    ? `\n完整语境（仅供理解背景）："${context}"`
    : ''
  const userMessage = `待解析文本（切分结果必须逐字还原此文本）：\n"${text}"${contextLine}`

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
    const response = await createChatCompletion(params, 'text', signal)
    try {
      const parsed = parseJsonSafely(response.choices[0].message.content)
      const segments = (Array.isArray(parsed.segments) ? parsed.segments : [])
        .map(s => normalizeSegment(s, 0))
        .filter(Boolean)
      if (!segments.length) {
        throw new Error('解析结果为空')
      }
      // 顶层拼接须还原原文（忽略空白与引号样式差异），否则视为本次解析失败
      if (normalizeForCompare(segments.map(s => s.text).join('')) !== normalizeForCompare(text)) {
        throw new Error('解析结果与原文不一致')
      }
      // 解析成功（含拼接校验）后写入缓存；失败不缓存，便于重试拿到新结果
      const result = { segments }
      componentCacheSet(cacheKey, result)
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
 * @param {(delta: string, full: string) => void} onDelta 流式增量回调（增量, 累计全文）
 * @param {AbortSignal} signal 外部中止信号（关闭窗口时 abort）
 * @returns {Promise<string>} 完整回答文本
 */
export async function chatAboutSelection(history, text, context = '', onDelta, signal) {
  const model = getModel()

  const contextLine = context
    ? `\n完整语境（仅供理解背景）："${context}"`
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
      // 待解析文本与语境作为首条 user 消息固定传入，同一会话多轮追问时内容不变
      { role: 'user', content: `待解析文本：\n"${text}"${contextLine}` },
      // 固定 assistant 确认，保证 user/assistant 严格交替，兼容严格校验角色交替的供应商
      { role: 'assistant', content: '收到，我已了解这段文本。请针对它提问。' },
      ...trimmedHistory
    ],
    max_tokens: useSettingsStore().selectionChatMaxTokens || 1000
  }), 'text', onDelta, signal)
}

export async function batchGenerateWords(words, onProgress, concurrency) {
  const settings = useSettingsStore()
  if (!concurrency) {
    concurrency = settings.maxConcurrency || 50
  }
  const results = []
  let completed = 0
  const total = words.length

  for (let i = 0; i < total; i += concurrency) {
    const batch = words.slice(i, i + concurrency)
    const batchResults = await Promise.allSettled(
      batch.map(async (item) => {
        try {
          const word = typeof item === 'string' ? item : item.word
          const context = typeof item === 'string' ? '' : item.context
          const info = await generateWordBasicInfo(word, context)
          completed++
          onProgress(completed, total, null)
          return { word, info, success: true }
        } catch (error) {
          completed++
          onProgress(completed, total, error.message)
          return { word, error: error.message, success: false }
        }
      })
    )
    results.push(...batchResults.map(r => r.value || r.reason))
  }

  return results
}

const ARTICLE_STYLE_MAP = {
  general: '通用',
  story: '故事',
  news: '新闻',
  academic: '学术',
  dialogue: '对话'
}

const ESSAY_TYPE_MAP = {
  small: '高中小作文（简洁正式的应用文）',
  long: '高中大作文（读后续写风格，以叙事为主，情节完整且有推进）'
}

const FORMAT_MAP = {
  general: '普通作文（无特定格式，按常规作文书写）',
  recommendation: '推荐信（应用文书信格式，开头称呼，正文说明推荐理由，结尾用 Yours sincerely 并署名 Li Hua）',
  thankYou: '感谢信（应用文书信格式，开头称呼，正文表达感谢及原因，结尾用 Yours sincerely 并署名 Li Hua）',
  invitation: '邀请信（应用文书信格式，开头称呼，正文说明活动时间地点与安排，结尾用 Yours sincerely 并署名 Li Hua）',
  suggestion: '建议信（应用文书信格式，开头称呼，正文给出具体建议及理由，结尾用 Yours sincerely 并署名 Li Hua）',
  application: '申请信（应用文书信格式，开头称呼，正文介绍自己并说明申请理由，结尾用 Yours sincerely 并署名 Li Hua）',
  apology: '道歉信（应用文书信格式，开头称呼，正文诚恳道歉并说明补救措施，结尾用 Yours sincerely 并署名 Li Hua）',
  complaint: '投诉信（应用文书信格式，开头称呼，正文客观说明问题并表达诉求，结尾用 Yours sincerely 并署名 Li Hua）'
}

export async function generateArticle(words, options = {}) {
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
  }))

  return response.choices[0].message.content
}

export async function generateArticleMeta(content, options = {}) {
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
  }))

  const parsed = JSON.parse(response.choices[0].message.content)
  return {
    title: (parsed.title || '').trim(),
    description: (parsed.description || '').trim()
  }
}

export async function fetchModels(providerId) {
  const settings = useSettingsStore()
  const provider = settings.providers.find(p => p.id === providerId)
  if (!provider || !provider.endpoint || !provider.apiKey) {
    throw new Error('请先选择供应商并填写 API Key')
  }
  const list = await listModelsForProvider(provider)
  return list.data.map(m => m.id).sort()
}

export async function testConnection(type = 'text') {
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
      }), type)

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
    }), type)
    return { success: true, message: '连接成功' }
  } catch (error) {
    return { success: false, message: error.message }
  }
}

// ---- 图片识别（视觉模型） ----

/** 构建多模态用户消息：文本指令 + 图片 */
function imageContent(imageDataUrl, text) {
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: imageDataUrl } }
  ]
}

/** 稳健解析模型返回的 JSON：兼容被 markdown 代码块包裹、或前后带杂字的情况 */
function parseJsonSafely(content) {
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

// 图片识别接口的 max_tokens 上限：作为「照片导入」加载动画进度条的最大值
export const IMAGE_MAX_TOKENS = 4000

/**
 * 识别图片中的英文文章，提取标题、描述与正文。
 * @param {string} imageDataUrl 图片 Data URL（base64）
 * @returns {Promise<{title: string, description: string, content: string}>}
 */
export async function extractArticleFromImage(imageDataUrl, onProgress) {
  const model = getModel('vision')

  const systemMessage = `你是英语文章识别助手。图片通常来自试卷、习题册等，可能是某道阅读理解的原文。请识别并提取其中的英文文章正文。

返回JSON格式：
{
  "title": "文章标题（若为试卷中的阅读题，可依据试卷信息判断题目类型，如\"阅读理解\"；有明确文章标题则用标题，无标题可留空字符串）",
  "description": "用中文一句话概括文章大致内容（30-60字，若无法判断可留空字符串）",
  "content": "仅提取文章正文原文，保持原段落换行结构，不要遗漏、不要改写"
}

要求：
1. content 只提取文章正文（如阅读理解的原文，可包含选项内容），不得包含题目要求、题干、页码、水印、广告、装饰等非正文内容
2. 如果图片是试卷中的阅读题，可将题型信息（如"阅读理解"）体现在 title 中，题目要求等信息在 description 中概括说明，不进入 content
3. content 必须完整、逐字准确识别图片中的英文原文，保持原有段落和换行，不要遗漏、不要改写
4. 如果图片模糊导致个别单词无法辨认，用 [illegible] 占位`

  const content = await streamChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: imageContent(imageDataUrl, '请识别并提取以下图片中的英文文章内容。') }
    ],
    response_format: { type: 'json_object' },
    max_tokens: IMAGE_MAX_TOKENS
  }), 'vision', onProgress
    ? (_delta, full) => onProgress(Math.min(IMAGE_MAX_TOKENS, estimateTokens(full)), IMAGE_MAX_TOKENS)
    : undefined)

  const parsed = parseJsonSafely(content)
  return {
    title: String(parsed.title || '').trim(),
    description: String(parsed.description || '').trim(),
    content: String(parsed.content || '').trim()
  }
}

/**
 * 解析图片中的英语写作题目，提取写作要求用于回填生成参数。
 * @param {string} imageDataUrl 图片 Data URL（base64）
 * @returns {Promise<object>} 生成参数对象
 */
export async function extractTaskFromImage(imageDataUrl, onProgress) {
  const model = getModel('vision')

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
- words：题目明确要求必须使用的单词/短语列表，没有则为空数组 []`

  const content = await streamChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: imageContent(imageDataUrl, '请解析以下图片中的英语写作题目，提取写作要求。') }
    ],
    response_format: { type: 'json_object' },
    max_tokens: IMAGE_MAX_TOKENS
  }), 'vision', onProgress
    ? (_delta, full) => onProgress(Math.min(IMAGE_MAX_TOKENS, estimateTokens(full)), IMAGE_MAX_TOKENS)
    : undefined)

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
      ? parsed.words.map(w => String(w).trim()).filter(Boolean)
      : []
  }
}
