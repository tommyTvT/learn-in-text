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

async function createChatCompletion(params, type = 'text') {
  const { baseURL, apiKey, timeoutMs } = getModelConfig(type)
  return request('/chat/completions', { baseURL, apiKey, body: params, timeoutMs })
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
 */
async function streamChatCompletion(params, type = 'text', onDelta) {
  const { baseURL, apiKey, timeoutMs } = getModelConfig(type)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
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

export async function generateWordContextTranslation(word, context) {
  const model = getModel()

  const systemMessage = `你是英语词典助手。将所提供的句子翻译成中文。
翻译规则：必须用 **...** 双星号标记目标单词对应的中文翻译！
返回JSON格式：
{
  "contextTranslation": "完整翻译，目标词用**标记**"
}

示例：
- 单词 read，上下文 "I read an interesting book yesterday" → {"contextTranslation": "我昨天**读**了一本有趣的书"}`

  const response = await createChatCompletion(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: `上下文："${context}"\n\n请翻译句子并标记单词 "${word}" 对应的中文` }
    ],
    response_format: { type: 'json_object' },
    max_tokens: useSettingsStore().contextMaxTokens || 200
  }))

  return JSON.parse(response.choices[0].message.content)
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

  const systemMessage = `你是英语文章识别助手。请识别图片中的英文文章，准确提取其中的文字内容。

返回JSON格式：
{
  "title": "文章标题（若图片中无标题则留空字符串）",
  "description": "用中文一句话概括文章大致内容（30-60字，若无法判断可留空字符串）",
  "content": "完整文章正文，保持原段落换行结构，不要遗漏、不要改写"
}

要求：
1. content 必须完整、逐字准确识别图片中的英文原文，保持原有段落和换行
2. 忽略图片中的水印、页码、广告、装饰等与文章无关的内容
3. 如果图片模糊导致个别单词无法辨认，用 [illegible] 占位`

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
