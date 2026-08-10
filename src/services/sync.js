import { getSupabase } from '../lib/supabase'
import { exportService, db } from './db'
import { useSettingsStore } from '../stores/settings'

const TABLES = ['articles', 'words', 'word_marks', 'context_translations']

function requireUsername() {
  const settings = useSettingsStore()
  const name = settings.username?.trim()
  if (!name) {
    throw new Error('请先填写用户名')
  }
  return name
}

async function getLocalFull() {
  const full = await exportService.exportFull()
  return full.data
}

/**
 * 测试与 Supabase 的连接是否可用。
 */
export async function testConnection() {
  const supabase = getSupabase()
  const username = requireUsername()
  try {
    const { error } = await supabase
      .from('articles')
      .select('id')
      .eq('username', username)
      .limit(1)
    if (error) throw error
    return { success: true, message: '连接成功' }
  } catch (error) {
    throw new Error('连接失败: ' + error.message)
  }
}

/**
 * 将本地全部数据推送到云端（按用户名覆盖式同步）。
 */
export async function pushAll() {
  const supabase = getSupabase()
  const username = requireUsername()
  const local = await getLocalFull()

  // 先删除该用户在云端的旧数据
  for (const table of TABLES) {
    const { error } = await supabase.from(table).delete().eq('username', username)
    if (error) throw new Error(`清除云端 ${table} 失败: ${error.message}`)
  }

  // 映射本地 id -> 云端 id
  const articleMap = {}
  const wordMap = {}
  let articleCounter = 0
  let wordCounter = 0

  // 1. 文章
  for (const a of local.articles) {
    const { data, error } = await supabase.from('articles').insert({
      username,
      title: a.title,
      content: a.content,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt
    }).select('id').single()
    if (error) throw new Error('推送文章失败: ' + error.message)
    articleMap[a.id] = data.id
    articleCounter++
  }

  // 2. 单词（需将 articleId 映射到云端 id）
  for (const w of local.words) {
    const cloudArticleId = articleMap[w.articleId]
    if (cloudArticleId == null) continue
    const { data, error } = await supabase.from('words').insert({
      username,
      word: w.word,
      articleId: cloudArticleId,
      definitions: w.definitions || [],
      examples: w.examples || [],
      source: w.source || '',
      updatedAt: w.updatedAt
    }).select('id').single()
    if (error) throw new Error('推送单词失败: ' + error.message)
    wordMap[w.id] = data.id
    wordCounter++
  }

  // 3. 单词标记
  for (const m of local.wordMarks) {
    const cloudArticleId = articleMap[m.articleId]
    const cloudWordId = wordMap[m.wordId]
    if (cloudArticleId == null || cloudWordId == null) continue
    const { error } = await supabase.from('word_marks').insert({
      username,
      articleId: cloudArticleId,
      wordId: cloudWordId,
      occKey: m.occKey,
      createdAt: m.createdAt
    })
    if (error) throw new Error('推送标记失败: ' + error.message)
  }

  // 4. 上下文翻译
  for (const t of local.contextTranslations) {
    const cloudArticleId = articleMap[t.articleId]
    const cloudWordId = wordMap[t.wordId]
    if (cloudArticleId == null || cloudWordId == null) continue
    const { error } = await supabase.from('context_translations').insert({
      username,
      wordId: cloudWordId,
      articleId: cloudArticleId,
      occKey: t.occKey,
      translation: t.translation,
      createdAt: t.createdAt
    })
    if (error) throw new Error('推送翻译失败: ' + error.message)
  }

  return {
    success: true,
    message: `推送完成：${articleCounter} 篇文章，${wordCounter} 个单词`
  }
}

/**
 * 从云端拉取数据并合并到本地。
 * 为避免 id 冲突，采用「按标题/词去重」的方式重建本地数据。
 */
export async function pullAll() {
  const supabase = getSupabase()
  const username = requireUsername()

  // 拉取云端数据
  const cloud = {}
  for (const table of TABLES) {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('username', username)
    if (error) throw new Error(`拉取 ${table} 失败: ${error.message}`)
    cloud[table] = data || []
  }

  const cloudArticles = cloud.articles
  const cloudWords = cloud.words
  const cloudMarks = cloud.word_marks
  const cloudTranslations = cloud.context_translations

  // 重建云端的文章 id 映射：云端文章 id -> 本地新 id
  const cloudToLocalArticle = {}
  // 已有本地文章的标题映射
  const existingArticleTitles = new Map()
  for (const a of await db.articles.toArray()) {
    existingArticleTitles.set(a.title, a.id)
  }

  const stats = { articles: 0, words: 0, marks: 0, translations: 0 }

  // 1. 文章：按标题去重，不存在则新建
  for (const a of cloudArticles) {
    const existingId = existingArticleTitles.get(a.title)
    if (existingId) {
      // 更新内容
      await db.articles.update(existingId, {
        content: a.content,
        updatedAt: a.updatedAt
      })
      cloudToLocalArticle[a.id] = existingId
    } else {
      const id = await db.articles.add({
        title: a.title,
        content: a.content,
        createdAt: a.createdAt || new Date(),
        updatedAt: a.updatedAt || new Date()
      })
      cloudToLocalArticle[a.id] = id
      existingArticleTitles.set(a.title, id)
      stats.articles++
    }
  }

  // 已有的本地单词映射：word_articleId -> id
  const existingWordMap = new Map()
  for (const w of await db.words.toArray()) {
    existingWordMap.set(`${w.word}_${w.articleId}`, w.id)
  }

  // 2. 单词：按 word + articleId 去重
  const cloudToLocalWord = {}
  for (const w of cloudWords) {
    const localArticleId = cloudToLocalArticle[w.articleId]
    if (localArticleId == null) continue
    const lower = w.word.toLowerCase()
    const key = `${lower}_${localArticleId}`
    let localId = existingWordMap.get(key)
    if (localId) {
      // 已有则补齐释义
      await db.words.update(localId, {
        definitions: w.definitions || [],
        examples: w.examples || [],
        source: w.source || '',
        updatedAt: w.updatedAt
      })
    } else {
      localId = await db.words.add({
        word: lower,
        articleId: localArticleId,
        definitions: w.definitions || [],
        examples: w.examples || [],
        source: w.source || '',
        updatedAt: w.updatedAt || new Date()
      })
      existingWordMap.set(key, localId)
      stats.words++
    }
    cloudToLocalWord[w.id] = localId
  }

  // 已有标记集合
  const existingMarkSet = new Set()
  for (const m of await db.wordMarks.toArray()) {
    existingMarkSet.add(`${m.wordId}_${m.articleId}_${m.occKey}`)
  }

  // 3. 标记
  for (const m of cloudMarks) {
    const localWordId = cloudToLocalWord[m.wordId]
    const localArticleId = cloudToLocalArticle[m.articleId]
    if (localWordId == null || localArticleId == null) continue
    const key = `${localWordId}_${localArticleId}_${m.occKey}`
    if (!existingMarkSet.has(key)) {
      await db.wordMarks.add({
        wordId: localWordId,
        articleId: localArticleId,
        occKey: m.occKey,
        createdAt: m.createdAt || new Date()
      })
      existingMarkSet.add(key)
      stats.marks++
    }
  }

  // 已有翻译集合
  const existingTranslationSet = new Set()
  for (const t of await db.contextTranslations.toArray()) {
    existingTranslationSet.add(`${t.wordId}_${t.articleId}_${t.occKey || '0'}`)
  }

  // 4. 翻译
  for (const t of cloudTranslations) {
    const localWordId = cloudToLocalWord[t.wordId]
    const localArticleId = cloudToLocalArticle[t.articleId]
    if (localWordId == null || localArticleId == null) continue
    const key = `${localWordId}_${localArticleId}_${t.occKey || '0'}`
    if (!existingTranslationSet.has(key)) {
      await db.contextTranslations.add({
        wordId: localWordId,
        articleId: localArticleId,
        occKey: t.occKey || '0',
        translation: t.translation,
        createdAt: t.createdAt || new Date()
      })
      existingTranslationSet.add(key)
      stats.translations++
    }
  }

  return {
    success: true,
    message: `拉取完成：新增 ${stats.articles} 篇文章，${stats.words} 个单词，${stats.marks} 条标记，${stats.translations} 条翻译`
  }
}

/**
 * 清除该用户在云端的全部数据。
 */
export async function clearCloud() {
  const supabase = getSupabase()
  const username = requireUsername()

  for (const table of TABLES) {
    const { error } = await supabase.from(table).delete().eq('username', username)
    if (error) throw new Error(`清除云端 ${table} 失败: ${error.message}`)
  }

  return { success: true, message: '云端数据已清除' }
}
