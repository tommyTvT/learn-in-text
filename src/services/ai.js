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

export async function generateWordBasicInfo(word) {
  const client = getClient()
  const model = getModel()

  const systemMessage = `你是英语词典助手。返回JSON格式，严格遵守以下规则：
1. partOfSpeech 必须使用英文缩写：n. v. adj. adv. pron. prep. conj. art. int.（多个词性用"/"连接，如"v./n."）
2. definitions 最多2个最常用的意思

返回格式：
{
  "phonetic": "音标",
  "definitions": [
    {"partOfSpeech": "英文缩写词性", "meaning": "中文释义"}
  ]
}`

  const response = await client.chat.completions.create(chatOptions({
    model,
    messages: [
      { role: 'system', content: systemMessage },
      { role: 'user', content: `请提供单词 "${word}" 的详细信息` }
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

翻译规则：
1. 只保留主谓宾核心结构，省略修饰语（形容词、副词、时间、地点等非核心成分）
2. 必须用 **...** 双星号标记目标单词对应的中文翻译！

返回JSON格式：
{
  "contextTranslation": "简洁翻译，目标词用**标记**"
}

示例：
- 单词 eat，上下文 "I eat an apple" → {"contextTranslation": "我**吃**苹果"}
- 单词 beautiful，上下文 "She is a beautiful girl" → {"contextTranslation": "**漂亮的**女孩"}
- 单词 run，上下文 "The boy runs quickly in the park" → {"contextTranslation": "男孩**跑**"}
- 单词 read，上下文 "I read an interesting book yesterday" → {"contextTranslation": "我**读**书"}`

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
      batch.map(async (word) => {
        try {
          const info = await generateWordBasicInfo(word)
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

export async function generateArticle(words, topic = '', style = 'general') {
  const client = getClient()
  const model = getModel()

  const styleMap = {
    general: '通用',
    story: '故事',
    news: '新闻',
    academic: '学术',
    dialogue: '对话'
  }

  const response = await client.chat.completions.create(chatOptions({
    model,
    messages: [
      {
        role: 'system',
        content: '你是一个英语写作助手。请根据给定的单词列表生成一篇英语文章，文章要自然地包含这些单词。'
      },
      {
        role: 'user',
        content: `请生成一篇英语文章，要求：
1. 自然地包含以下单词：${words.join(', ')}
2. 文章风格：${styleMap[style] || '通用'}
${topic ? `3. 文章主题：${topic}` : ''}
4. 长度适中（200-400词）
5. 难度适合英语学习者

请直接返回文章内容，不需要额外解释。`
      }
    ],
    max_tokens: useSettingsStore().articleMaxTokens || 2000
  }))

  return response.choices[0].message.content
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
