import Dexie from 'dexie'
import { commonWordDefinitions, getAllOccKeys } from './parser'

function splitDefinition(def) {
  const match = def.match(/^((?:[a-z]+\.)+(?:\/(?:[a-z]+\.)+)*)\s*(.+)$/i)
  if (match) return { partOfSpeech: match[1], meaning: match[2] }
  return { partOfSpeech: '', meaning: def }
}

export const db = new Dexie('LearnInText')

db.version(6).stores({
  articles: '++id, title, content, createdAt, updatedAt',
  words: '++id, &[word+articleId], word, articleId, definitions, examples, source, updatedAt',
  wordMarks: '++id, articleId, wordId, occKey, [articleId+wordId], [articleId+occKey], createdAt',
  contextTranslations: '++id, wordId, articleId, occKey, &[wordId+articleId+occKey], translation, createdAt',
  tombstones: '++id, &[table+key], table, key, createdAt'
})

// v7：新增划词翻译缓存表（按 文章 + 选区哈希 唯一）
db.version(7).stores({
  articles: '++id, title, content, createdAt, updatedAt',
  words: '++id, &[word+articleId], word, articleId, definitions, examples, source, updatedAt',
  wordMarks: '++id, articleId, wordId, occKey, [articleId+wordId], [articleId+occKey], createdAt',
  contextTranslations: '++id, wordId, articleId, occKey, &[wordId+articleId+occKey], translation, createdAt',
  selectionTranslations: '++id, articleId, selectionHash, &[articleId+selectionHash]',
  tombstones: '++id, &[table+key], table, key, createdAt'
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

/**
 * 生成全局唯一 id（文章业务键）。
 * crypto.randomUUID 需安全上下文（https/localhost），http 场景降级为随机串。
 */
export function newUid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })
}

/**
 * 稳定业务键（本地视角）：同步时云端记录经会话内 id 映射后也用同一规则拼键。
 * - articles: uid（带 "u:" 前缀；无 uid 返回空串，不记 tombstone）
 * - words: word|本地articleId
 * - word_marks / context_translations: word|本地articleId|occKey
 * mark/translation 的 r 需带 word 字段（或 wordId 可查）。
 */
export function tombstoneKey(table, r) {
  switch (table) {
    case 'articles':
      return r.uid ? `u:${r.uid}` : ''
    case 'words':
      return `${r.word}|${r.articleId}`
    case 'word_marks':
    case 'context_translations':
      return `${r.word}|${r.articleId}|${r.occKey || ''}`
    default:
      return ''
  }
}

/**
 * 划词翻译缓存键：选中文本规范化（小写 + 空白折叠 + trim）后的 djb2 哈希（36 进制）。
 * 哈希碰撞概率极低，读取缓存时再比对存储的 text 二次校验。
 */
export function selectionHash(text) {
  const normalized = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim()
  let h = 5381
  for (let i = 0; i < normalized.length; i++) {
    h = ((h << 5) + h + normalized.charCodeAt(i)) | 0
  }
  return (h >>> 0).toString(36)
}

/** 记录一次本地删除事实（tombstone），供云端同步做删除传播。 */
async function recordTombstone(table, r) {
  let record = r
  if (!r.word && (r.wordId != null)) {
    const w = await db.words.get(r.wordId)
    if (!w) return // 找不到对应单词，无法拼稳定键，放弃（同步侧会按级联处理）
    record = { ...r, word: w.word }
  }
  const key = tombstoneKey(table, record)
  if (!key) return
  await db.tombstones.put({ table, key, createdAt: new Date() })
}

export const articleService = {
  async getAll() {
    // 手动排序（sortOrder 升序）优先；无 sortOrder 的旧数据按更新时间倒序兜底
    const list = await db.articles.toArray()
    return list.sort((a, b) => {
      const sa = a.sortOrder ?? Number.MAX_SAFE_INTEGER
      const sb = b.sortOrder ?? Number.MAX_SAFE_INTEGER
      if (sa !== sb) return sa - sb
      return new Date(b.updatedAt) - new Date(a.updatedAt)
    })
  },

  async getById(id) {
    return await db.articles.get(id)
  },

  async create(article) {
    const now = new Date()
    // 新文章排到最前：取当前最小 sortOrder 再减一
    const all = await db.articles.toArray()
    const minOrder = all.reduce((m, a) => (a.sortOrder != null && a.sortOrder < m ? a.sortOrder : m), 0)
    const id = await db.articles.add({
      ...article,
      uid: newUid(),
      sortOrder: minOrder - 1,
      createdAt: now,
      updatedAt: now
    })
    return await db.articles.get(id)
  },

  /**
   * 批量写入手动排序结果（sortOrder = 数组下标）。
   * 同时刷新 updatedAt：云端同步以 updatedAt 做 LWW，
   * 刷新后排序结果才能随同步覆盖到其他设备。
   */
  async updateSortOrders(orderedIds) {
    const now = new Date()
    await db.transaction('rw', db.articles, async () => {
      await Promise.all(orderedIds.map((id, index) =>
        db.articles.update(id, { sortOrder: index, updatedAt: now })
      ))
    })
  },

  async update(id, data) {
    await db.articles.update(id, {
      ...data,
      updatedAt: new Date()
    })
    return await db.articles.get(id)
  },

  async delete(id) {
    const article = await db.articles.get(id)
    if (!article) return
    await db.transaction('rw', db.articles, db.words, db.wordMarks, db.contextTranslations, db.selectionTranslations, db.tombstones, async () => {
      await db.wordMarks.where('articleId').equals(id).delete()
      await db.contextTranslations.where('articleId').equals(id).delete()
      await db.selectionTranslations.where('articleId').equals(id).delete()
      await db.words.where('articleId').equals(id).delete()
      await db.articles.delete(id)
      await recordTombstone('articles', article)
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

  /**
   * 批量获取/创建一篇文章的单词（保持与 getOrCreate 相同的语义）：
   * - 已有的直接复用；有 common 词义但缺 definitions 的补齐；
   * - 不存在的批量写入（避免逐词 await 多次 IndexedDB 查询）。
   * 返回顺序与入参（去重后）一致。
   */
  async getOrCreateMany(words, articleId) {
    const lowerWords = [...new Set(words.map(w => w.toLowerCase()))]
    if (lowerWords.length === 0) return []

    const existing = await db.words.where('articleId').equals(articleId).toArray()
    const existingMap = new Map(existing.map(w => [w.word, w]))
    const result = []
    const toAdd = []

    for (const word of lowerWords) {
      const found = existingMap.get(word)
      if (found) {
        // 与 getOrCreate 一致：已有记录但缺 common 词义时补齐
        if (!found.definitions?.length) {
          const commonDef = commonWordDefinitions[found.word]
          if (commonDef) {
            await db.words.update(found.id, {
              definitions: [splitDefinition(commonDef.definition)],
              source: 'common',
              updatedAt: new Date()
            })
            found.definitions = [splitDefinition(commonDef.definition)]
            found.source = 'common'
          }
        }
        result.push(found)
      } else {
        const commonDef = commonWordDefinitions[word]
        const record = {
          word,
          articleId,
          definitions: commonDef ? [splitDefinition(commonDef.definition)] : [],
          examples: [],
          source: commonDef ? 'common' : '',
          updatedAt: new Date()
        }
        toAdd.push(record)
        result.push(record)
      }
    }

    if (toAdd.length) {
      const ids = await db.words.bulkAdd(toAdd)
      toAdd.forEach((r, i) => { r.id = ids[i] })
    }
    return result
  },

  async update(id, data) {
    await db.words.update(id, {
      ...data,
      updatedAt: new Date()
    })
    return await db.words.get(id)
  },

  async delete(id) {
    const word = await db.words.get(id)
    if (!word) return
    await db.transaction('rw', db.words, db.wordMarks, db.contextTranslations, db.tombstones, async () => {
      await db.wordMarks.where('wordId').equals(id).delete()
      await db.contextTranslations.where('wordId').equals(id).delete()
      await db.words.delete(id)
      await recordTombstone('words', word)
    })
  },

  async deleteBySpelling(word) {
    const records = await this.getByWordAllArticles(word)
    await db.transaction('rw', db.words, db.wordMarks, db.contextTranslations, db.tombstones, async () => {
      for (const record of records) {
        await db.wordMarks.where('wordId').equals(record.id).delete()
        await db.contextTranslations.where('wordId').equals(record.id).delete()
        await db.words.delete(record.id)
        await recordTombstone('words', record)
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
    occKey = occKey || ''
    const existing = await db.wordMarks.where({ articleId, occKey }).first()
    if (existing) {
      await db.transaction('rw', db.wordMarks, db.tombstones, db.words, async () => {
        await db.wordMarks.delete(existing.id)
        await recordTombstone('word_marks', existing)
      })
      return false
    } else {
      await db.wordMarks.add({ wordId, articleId, occKey, createdAt: new Date(), updatedAt: new Date() })
      return true
    }
  },

  async add(wordId, articleId, occKey) {
    occKey = occKey || ''
    const existing = await db.wordMarks.where({ articleId, occKey }).first()
    if (!existing) {
      await db.wordMarks.add({ wordId, articleId, occKey, createdAt: new Date(), updatedAt: new Date() })
    }
  },

  async remove(articleId, occKey) {
    occKey = occKey || ''
    const existing = await db.wordMarks.where({ articleId, occKey }).first()
    if (existing) {
      await db.transaction('rw', db.wordMarks, db.tombstones, db.words, async () => {
        await db.wordMarks.delete(existing.id)
        await recordTombstone('word_marks', existing)
      })
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
  async get(wordId, articleId, occKey) {
    occKey = occKey || '0'
    return await db.contextTranslations.where({ wordId, articleId, occKey }).first()
  },

  async set(wordId, articleId, occKey, translation) {
    occKey = occKey || '0'
    const existing = await db.contextTranslations.where({ wordId, articleId, occKey }).first()
    if (!translation) {
      if (existing) {
        await db.transaction('rw', db.contextTranslations, db.tombstones, db.words, async () => {
          await db.contextTranslations.delete(existing.id)
          await recordTombstone('context_translations', existing)
        })
      }
      return null
    }
    if (existing) {
      await db.contextTranslations.update(existing.id, { translation, updatedAt: new Date() })
      return await db.contextTranslations.get(existing.id)
    } else {
      const id = await db.contextTranslations.add({
        wordId,
        articleId,
        occKey,
        translation,
        createdAt: new Date(),
        updatedAt: new Date()
      })
      return await db.contextTranslations.get(id)
    }
  }
}

export const selectionTranslationService = {
  async get(articleId, hash) {
    return await db.selectionTranslations.where({ articleId, selectionHash: hash }).first()
  },

  async set(articleId, hash, text, translation) {
    const existing = await db.selectionTranslations.where({ articleId, selectionHash: hash }).first()
    if (existing) {
      await db.selectionTranslations.update(existing.id, { text, translation, updatedAt: new Date() })
      return await db.selectionTranslations.get(existing.id)
    }
    const id = await db.selectionTranslations.add({
      articleId,
      selectionHash: hash,
      text,
      translation,
      createdAt: new Date(),
      updatedAt: new Date()
    })
    return await db.selectionTranslations.get(id)
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
        description: article.description || '',
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
    const all = await db.articles.toArray()
    const minOrder = all.reduce((m, a) => (a.sortOrder != null && a.sortOrder < m ? a.sortOrder : m), 0)
    const articleId = await db.articles.add({
      title: data.article.title,
      description: data.article.description || '',
      content: data.article.content,
      uid: newUid(), // 单篇导入总是生成新 uid，避免与已有文章撞身份
      sortOrder: data.article.sortOrder ?? minOrder - 1,
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
    const selectionTranslations = await db.selectionTranslations.toArray()

    return {
      version: 2,
      type: 'full_backup',
      exportDate: new Date().toISOString(),
      data: {
        articles: articles.map(({ id, ...rest }) => rest),
        words: words.map(({ id, phonetic, ...rest }) => rest),
        wordMarks: wordMarks.map(({ id, ...rest }) => rest),
        contextTranslations: contextTranslations.map(({ id, ...rest }) => rest),
        selectionTranslations: selectionTranslations.map(({ id, ...rest }) => rest)
      }
    }
  },

  async importFull(data) {
    if (data.type !== 'full_backup' || data.version !== 2) {
      throw new Error('不是全量备份文件')
    }

    const { articles, words, wordMarks, contextTranslations, selectionTranslations } = data.data
    const stats = { articles: 0, words: 0, marks: 0, translations: 0, selectionTranslations: 0, skipped: 0 }

    await db.transaction('rw', db.articles, db.words, db.wordMarks, db.contextTranslations, db.selectionTranslations, async () => {
      const existingArticles = await db.articles.toArray()
      const articleUidMap = {}
      existingArticles.forEach(a => { if (a.uid) articleUidMap[a.uid] = a.id })

      const articleIdMap = {}
      for (let i = 0; i < articles.length; i++) {
        const a = articles[i]
        const existingId = a.uid && articleUidMap[a.uid]
        if (existingId) {
          articleIdMap[i] = existingId
          stats.skipped++
        } else {
          const id = await db.articles.add({
            ...a,
            uid: a.uid || newUid(),
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

      // 划词翻译缓存（旧备份无此字段时降级为空数组，兼容不报错）
      const existingSelectionTranslations = await db.selectionTranslations.toArray()
      const selectionSet = new Set(existingSelectionTranslations.map(t => `${t.articleId}_${t.selectionHash}`))

      for (const t of (selectionTranslations || [])) {
        const articleId = articleIdMap[t.articleId]
        if (articleId == null) continue
        const key = `${articleId}_${t.selectionHash}`
        if (!selectionSet.has(key)) {
          await db.selectionTranslations.add({
            articleId,
            selectionHash: t.selectionHash,
            text: t.text || '',
            translation: t.translation || '',
            createdAt: t.createdAt || new Date(),
            updatedAt: t.updatedAt || new Date()
          })
          selectionSet.add(key)
          stats.selectionTranslations++
        }
      }
    })

    return stats
  },

  // 清空本地数据必须连同 tombstone 一起清：残留其他账号的删除标记，
  // 会在换账号同步时按稳定键误软删当前账号的云端记录
  async clearAllData() {
    await db.transaction('rw', db.articles, db.words, db.wordMarks, db.contextTranslations, db.selectionTranslations, db.tombstones, async () => {
      await db.articles.clear()
      await db.words.clear()
      await db.wordMarks.clear()
      await db.contextTranslations.clear()
      await db.selectionTranslations.clear()
      await db.tombstones.clear()
    })
  },

  async getDataStats() {
    return {
      articles: await db.articles.count(),
      words: await db.words.count(),
      wordMarks: await db.wordMarks.count(),
      contextTranslations: await db.contextTranslations.count(),
      selectionTranslations: await db.selectionTranslations.count()
    }
  },

  async deleteDatabase() {
    db.close()
    await Dexie.delete('LearnInText')
  }
}
