import Dexie from 'dexie'
import { commonWordDefinitions, getAllOccKeys } from './parser'

function splitDefinition(def) {
  const match = def.match(/^((?:[a-z]+\.)+(?:\/(?:[a-z]+\.)+)*)\s*(.+)$/i)
  if (match) return { partOfSpeech: match[1], meaning: match[2] }
  return { partOfSpeech: '', meaning: def }
}

export const db = new Dexie('LearnInText')

db.version(5).stores({
  articles: '++id, title, content, createdAt, updatedAt',
  words: '++id, &[word+articleId], word, articleId, definitions, examples, source, updatedAt',
  wordMarks: '++id, articleId, wordId, occKey, [articleId+wordId], [articleId+occKey], createdAt',
  contextTranslations: '++id, wordId, articleId, occKey, &[wordId+articleId+occKey], translation, createdAt'
})

async function ensureSchema() {
  try {
    await db.open()
  } catch (error) {
    if (error.name === 'VersionError' || error.name === 'SchemaError' || error.name === 'ConstraintError') {
      await Dexie.delete('LearnInText')
      await db.open()
    } else {
      throw error
    }
  }
}

await ensureSchema()

export const articleService = {
  async getAll() {
    return await db.articles.orderBy('updatedAt').reverse().toArray()
  },

  async getById(id) {
    return await db.articles.get(id)
  },

  async create(article) {
    const now = new Date()
    const id = await db.articles.add({
      ...article,
      createdAt: now,
      updatedAt: now
    })
    return await db.articles.get(id)
  },

  async update(id, data) {
    await db.articles.update(id, {
      ...data,
      updatedAt: new Date()
    })
    return await db.articles.get(id)
  },

  async delete(id) {
    await db.transaction('rw', db.articles, db.words, db.wordMarks, db.contextTranslations, async () => {
      await db.wordMarks.where('articleId').equals(id).delete()
      await db.contextTranslations.where('articleId').equals(id).delete()
      await db.words.where('articleId').equals(id).delete()
      await db.articles.delete(id)
    })
  }
}

export const wordService = {
  async getAll() {
    return await db.words.toArray()
  },

  async getById(id) {
    return await db.words.get(id)
  },

  async getByIds(ids) {
    if (ids.length === 0) return []
    return await db.words.where('id').anyOf(ids).toArray()
  },

  async getByWord(word, articleId) {
    const lower = word.toLowerCase()
    return await db.words.where({ word: lower, articleId }).first()
  },

  async getByWordAllArticles(word) {
    const lower = word.toLowerCase()
    return await db.words.where('word').equals(lower).toArray()
  },

  async getOrCreate(word, articleId) {
    const lower = word.toLowerCase()
    let existing = await this.getByWord(lower, articleId)
    if (!existing) {
      const commonDef = commonWordDefinitions[lower]
      const id = await db.words.add({
        word: lower,
        articleId,
        definitions: commonDef ? [splitDefinition(commonDef.definition)] : [],
        examples: [],
        source: commonDef ? 'common' : '',
        updatedAt: new Date()
      })
      existing = await db.words.get(id)
    } else if (!existing.definitions?.length) {
      const commonDef = commonWordDefinitions[existing.word]
      if (commonDef) {
        await db.words.update(existing.id, {
          definitions: [splitDefinition(commonDef.definition)],
          source: 'common',
          updatedAt: new Date()
        })
        existing = await db.words.get(existing.id)
      }
    }
    return existing
  },

  async update(id, data) {
    await db.words.update(id, {
      ...data,
      updatedAt: new Date()
    })
    return await db.words.get(id)
  },

  async delete(id) {
    await db.transaction('rw', db.words, db.wordMarks, db.contextTranslations, async () => {
      await db.wordMarks.where('wordId').equals(id).delete()
      await db.contextTranslations.where('wordId').equals(id).delete()
      await db.words.delete(id)
    })
  },

  async deleteBySpelling(word) {
    const records = await this.getByWordAllArticles(word)
    await db.transaction('rw', db.words, db.wordMarks, db.contextTranslations, async () => {
      for (const record of records) {
        await db.wordMarks.where('wordId').equals(record.id).delete()
        await db.contextTranslations.where('wordId').equals(record.id).delete()
        await db.words.delete(record.id)
      }
    })
  }
}

export const wordMarkService = {
  async getMarkedByArticle(articleId) {
    const marks = await db.wordMarks.where('articleId').equals(articleId).toArray()
    const wordIds = [...new Set(marks.map(m => m.wordId))]
    return await wordService.getByIds(wordIds)
  },

  async getMarkedArticleIds(wordId) {
    const marks = await db.wordMarks.where('wordId').equals(wordId).toArray()
    return [...new Set(marks.map(m => m.articleId))]
  },

  async getMarkedArticleIdsByWord(word, excludeArticleId) {
    const records = await wordService.getByWordAllArticles(word)
    const ids = records.map(r => r.id)
    if (ids.length === 0) return []
    const marks = await db.wordMarks.where('wordId').anyOf(ids).toArray()
    return [...new Set(marks.map(m => m.articleId))].filter(a => a !== excludeArticleId)
  },

  async toggleMark(wordId, articleId, occKey) {
    const existing = await db.wordMarks.where({ articleId, occKey }).first()
    if (existing) {
      await db.wordMarks.delete(existing.id)
      return false
    } else {
      await db.wordMarks.add({ wordId, articleId, occKey, createdAt: new Date() })
      return true
    }
  },

  async add(wordId, articleId, occKey) {
    const existing = await db.wordMarks.where({ articleId, occKey }).first()
    if (!existing) {
      await db.wordMarks.add({ wordId, articleId, occKey, createdAt: new Date() })
    }
  },

  async remove(articleId, occKey) {
    const existing = await db.wordMarks.where({ articleId, occKey }).first()
    if (existing) {
      await db.wordMarks.delete(existing.id)
    }
  },

  async getAll() {
    return await db.wordMarks.toArray()
  },

  async getByArticle(articleId) {
    return await db.wordMarks.where('articleId').equals(articleId).toArray()
  },

  async getByWord(wordId) {
    return await db.wordMarks.where('wordId').equals(wordId).toArray()
  },

  async getAllArticleWordMap() {
    const marks = await db.wordMarks.toArray()
    const map = {}
    for (const m of marks) {
      if (!map[m.wordId]) map[m.wordId] = []
      map[m.wordId].push(m.articleId)
    }
    return map
  },

  async getAllWordArticleMap() {
    const marks = await db.wordMarks.toArray()
    const map = {}
    for (const m of marks) {
      if (!map[m.articleId]) map[m.articleId] = new Set()
      map[m.articleId].add(m.wordId)
    }
    for (const articleId in map) {
      map[articleId] = [...map[articleId]]
    }
    return map
  }
}

export const contextTranslationService = {
  async get(wordId, articleId, occKey = '0') {
    return await db.contextTranslations.where({ wordId, articleId, occKey }).first()
  },

  async set(wordId, articleId, occKey = '0', translation) {
    const existing = await db.contextTranslations.where({ wordId, articleId, occKey }).first()
    if (!translation) {
      if (existing) {
        await db.contextTranslations.delete(existing.id)
      }
      return null
    }
    if (existing) {
      await db.contextTranslations.update(existing.id, { translation })
      return await db.contextTranslations.get(existing.id)
    } else {
      const id = await db.contextTranslations.add({
        wordId,
        articleId,
        occKey,
        translation,
        createdAt: new Date()
      })
      return await db.contextTranslations.get(id)
    }
  }
}

export const exportService = {
  async exportArticle(articleId) {
    const article = await db.articles.get(articleId)
    if (!article) throw new Error('文章不存在')

    const marks = await db.wordMarks.where('articleId').equals(articleId).toArray()
    const wordIds = [...new Set(marks.map(m => m.wordId))]
    const words = await wordService.getByIds(wordIds)

    return {
      version: 2,
      type: 'article',
      exportDate: new Date().toISOString(),
      article: {
        title: article.title,
        content: article.content,
        createdAt: article.createdAt,
        updatedAt: article.updatedAt
      },
      words: words.map(({ word, definitions, examples }) => ({
        word,
        definitions,
        examples
      })),
      markedWords: words.map(w => w.word)
    }
  },

  async importArticle(data) {
    if (data.type !== 'article' || data.version !== 2) {
      throw new Error('不是文章导出文件')
    }

    const now = new Date()
    const articleId = await db.articles.add({
      title: data.article.title,
      content: data.article.content,
      createdAt: data.article.createdAt || now,
      updatedAt: now
    })

    const wordIdMap = []
    await db.transaction('rw', db.words, db.wordMarks, async () => {
      for (const w of data.words) {
        const existing = await wordService.getByWord(w.word, articleId)
        if (existing) {
          wordIdMap.push(existing.id)
          if (!existing.definitions?.length && w.definitions?.length) {
            await db.words.update(existing.id, {
              definitions: w.definitions,
              examples: w.examples,
              source: 'ai',
              updatedAt: new Date()
            })
          }
        } else {
          const id = await db.words.add({
            word: w.word.toLowerCase(),
            articleId,
            definitions: w.definitions || [],
            examples: w.examples || [],
            source: w.definitions?.length ? 'ai' : '',
            updatedAt: new Date()
          })
          wordIdMap.push(id)
        }
      }

      const markedSet = new Set((data.markedWords || data.words.map(w => w.word)).map(w => w.toLowerCase()))
      const occKeys = getAllOccKeys(data.article.content)
      for (let i = 0; i < data.words.length; i++) {
        const wordId = wordIdMap[i]
        const word = data.words[i].word.toLowerCase()
        if (wordId && markedSet.has(word)) {
          for (const occKey of occKeys) {
            if (occKey.startsWith(`${word}:`)) {
              await wordMarkService.add(wordId, articleId, occKey)
            }
          }
        }
      }
    })

    return articleId
  },

  async exportFull() {
    const articles = await db.articles.toArray()
    const words = await db.words.toArray()
    const wordMarks = await db.wordMarks.toArray()
    const contextTranslations = await db.contextTranslations.toArray()

    return {
      version: 2,
      type: 'full_backup',
      exportDate: new Date().toISOString(),
      data: {
        articles: articles.map(({ id, ...rest }) => rest),
        words: words.map(({ id, phonetic, ...rest }) => rest),
        wordMarks: wordMarks.map(({ id, ...rest }) => rest),
        contextTranslations: contextTranslations.map(({ id, ...rest }) => rest)
      }
    }
  },

  async importFull(data) {
    if (data.type !== 'full_backup' || data.version !== 2) {
      throw new Error('不是全量备份文件')
    }

    const { articles, words, wordMarks, contextTranslations } = data.data
    const stats = { articles: 0, words: 0, marks: 0, translations: 0, skipped: 0 }

    await db.transaction('rw', db.articles, db.words, db.wordMarks, db.contextTranslations, async () => {
      const existingArticles = await db.articles.toArray()
      const articleTitleMap = {}
      existingArticles.forEach(a => { articleTitleMap[a.title] = a.id })

      const articleIdMap = {}
      for (let i = 0; i < articles.length; i++) {
        const a = articles[i]
        if (articleTitleMap[a.title]) {
          articleIdMap[i] = articleTitleMap[a.title]
          stats.skipped++
        } else {
          const id = await db.articles.add({
            ...a,
            createdAt: a.createdAt || new Date(),
            updatedAt: a.updatedAt || new Date()
          })
          articleIdMap[i] = id
          stats.articles++
        }
      }

      const existingWords = await db.words.toArray()
      const wordMap = {}
      existingWords.forEach(w => { wordMap[`${w.word}_${w.articleId}`] = w.id })

      const wordIdMap = {}
      for (let i = 0; i < words.length; i++) {
        const w = words[i]
        const lower = w.word.toLowerCase()
        const articleId = articleIdMap[w.articleId]
        if (articleId == null) continue
        const key = `${lower}_${articleId}`
        if (wordMap[key]) {
          wordIdMap[i] = wordMap[key]
        } else {
          const { phonetic, articleId: oldArticleId, ...wRest } = w
          const id = await db.words.add({
            ...wRest,
            word: lower,
            articleId,
            updatedAt: w.updatedAt || new Date()
          })
          wordIdMap[i] = id
          stats.words++
        }
      }

      const existingMarks = await db.wordMarks.toArray()
      const markSet = new Set(existingMarks.map(m => `${m.wordId}_${m.articleId}_${m.occKey}`))

      for (const m of wordMarks) {
        const wordId = wordIdMap[m.wordId]
        const articleId = articleIdMap[m.articleId]
        if (wordId && articleId) {
          const key = `${wordId}_${articleId}_${m.occKey}`
          if (!markSet.has(key)) {
            await db.wordMarks.add({
              wordId,
              articleId,
              occKey: m.occKey || '0',
              createdAt: m.createdAt || new Date()
            })
            markSet.add(key)
            stats.marks++
          }
        }
      }

      const existingTranslations = await db.contextTranslations.toArray()
      const translationSet = new Set(existingTranslations.map(t => `${t.wordId}_${t.articleId}_${t.occKey || '0'}`))

      for (const t of contextTranslations) {
        const wordId = wordIdMap[t.wordId]
        const articleId = articleIdMap[t.articleId]
        if (wordId && articleId) {
          const key = `${wordId}_${articleId}_${t.occKey || '0'}`
          if (!translationSet.has(key)) {
            await db.contextTranslations.add({
              wordId,
              articleId,
              occKey: t.occKey || '0',
              translation: t.translation,
              createdAt: t.createdAt || new Date()
            })
            translationSet.add(key)
            stats.translations++
          }
        }
      }
    })

    return stats
  },

  async clearAllData() {
    await db.transaction('rw', db.articles, db.words, db.wordMarks, db.contextTranslations, async () => {
      await db.articles.clear()
      await db.words.clear()
      await db.wordMarks.clear()
      await db.contextTranslations.clear()
    })
  },

  async getDataStats() {
    return {
      articles: await db.articles.count(),
      words: await db.words.count(),
      wordMarks: await db.wordMarks.count(),
      contextTranslations: await db.contextTranslations.count()
    }
  },

  async deleteDatabase() {
    db.close()
    await Dexie.delete('LearnInText')
  }
}
