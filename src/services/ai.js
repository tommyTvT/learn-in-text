import OpenAI from 'openai'
import { useSettingsStore, AI_PROVIDERS } from '../stores/settings'

function getClient() {
  const settings = useSettingsStore()
  if (!settings.isConfigured()) {
    throw new Error('请先在设置中配置AI接口')
  }
  return new OpenAI({
    baseURL: settings.aiEndpoint,
    apiKey: settings.aiApiKey,
    dangerouslyAllowBrowser: true
  })
}

function getModel() {
  const settings = useSettingsStore()
  return settings.aiModel || AI_PROVIDERS.deepseek.model
}

function chatOptions(options) {
  const settings = useSettingsStore()
  return {
    ...options,
    thinking: { type: 'disabled' },
    timeout: (settings.requestTimeout || 30) * 1000
  }
}

export async function generateWordBasicInfo(word, context = '') {
  const client = getClient()
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
    ? `请提供单词 "${word}" 的详细信息，参考以下上下文语境理解其含义：\n上下文："${context}"`
    : `请提供单词 "${word}" 的详细信息`

  const response = await client.chat.completions.create(chatOptions({
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
  const client = getClient()
  const model = getModel()

  const systemMessage = `你是英语词典助手。将上下文句子翻译成中文。

翻译规则：必须用 **...** 双星号标记目标单词对应的中文翻译！

返回JSON格式：
{
  "contextTranslation": "完整翻译，目标词用**标记**"
}

示例：
- 单词 read，上下文 "I read an interesting book yesterday" → {"contextTranslation": "我昨天**读**了一本有趣的书"}`

  const response = await client.chat.completions.create(chatOptions({
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
  small: '高中小作文（约80词，简洁正式的应用文）',
  long: '高中大作文（读后续写风格，约150词，以叙事为主，情节完整且有推进）'
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
  const client = getClient()
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

  const response = await client.chat.completions.create(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userContent }
    ],
    max_tokens: maxTokens
  }))

  return response.choices[0].message.content
}

export async function generateArticleTitle(content, options = {}) {
  const client = getClient()
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

  const response = await client.chat.completions.create(chatOptions({
    model,
    messages: [
      {
        role: 'system',
        content: '你是英语写作标题助手。请根据文章内容生成一个简洁的英文标题。标题要求：5-12个单词，切题、吸引人，不要使用引号、句号，不要包含换行。只返回标题本身。'
      },
      {
        role: 'user',
        content: `这是一篇${styleDesc}，请根据以下内容生成一个合适的英文标题：\n\n${content.slice(0, 3000)}`
      }
    ],
    max_tokens: 50
  }))

  return response.choices[0].message.content.trim()
}

export async function testConnection() {
  const client = getClient()
  const model = getModel()

  try {
    const response = await client.chat.completions.create(chatOptions({
      model,
      messages: [{ role: 'user', content: 'Hello' }],
      max_tokens: 5
    }))
    return { success: true, message: '连接成功' }
  } catch (error) {
    return { success: false, message: error.message }
  }
}
