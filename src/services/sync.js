import { getSupabase } from '../lib/supabase'
import { db, tombstoneKey } from './db'
import { useSettingsStore } from '../stores/settings'

const TABLES = ['articles', 'words', 'word_marks', 'context_translations']

// 表格中文名（同步结果提示用）
const TABLE_LABELS = { articles: '文章', words: '单词', word_marks: '标记', context_translations: '翻译' }

const ts = (v) => (v ? new Date(v).getTime() : 0)
const nowIso = () => new Date().toISOString()

function requireUsername() {
  const settings = useSettingsStore()
  const name = settings.username?.trim()
  if (!name) {
    throw new Error('请先填写用户名')
  }
  return name
}

/**
 * 读取本地全部数据（保留 id）。
 */
async function getLocalFull() {
  const [articles, words, wordMarks, contextTranslations] = await Promise.all([
    db.articles.toArray(),
    db.words.toArray(),
    db.wordMarks.toArray(),
    db.contextTranslations.toArray()
  ])
  return { articles, words, wordMarks, contextTranslations }
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

/**
 * 批量插入辅助：分块插入并返回云端 id 数组（与 payloads 顺序一致）。
 */
async function batchInsert(supabase, table, payloads) {
  const CHUNK = 500
  const ids = []
  for (let i = 0; i < payloads.length; i += CHUNK) {
    const slice = payloads.slice(i, i + CHUNK)
    const { data, error } = await supabase.from(table).insert(slice).select('id')
    if (error) throw new Error(`推送 ${table} 失败: ${error.message}`)
    for (const row of (data || [])) ids.push(row.id)
  }
  return ids
}

/**
 * 双向差异同步（LWW + tombstone 删除传播）。
 *
 * 匹配：稳定业务键（db.js tombstoneKey）。云端记录先经会话内映射
 * （云端文章id->本地文章id、云端单词id->本地单词id）再拼本地视角键。
 * 冲突：比较 updatedAt，新者整条覆盖（Last-Write-Wins）。
 * 删除：本地删除写 tombstone；同步时 tombstone 新于云端记录则云端软删，
 *       云端软删新于本地则本地物理删；处理完的 tombstone 清理。
 * 级联：文章被删后，其云端单词/标记/翻译一并软删（孤儿清理）。
 * 已知取舍：删除文章后另一台设备再修改其中单词，该更新随级联一起丢弃。
 */
export async function syncNow() {
  const supabase = getSupabase()
  const username = requireUsername()
  const startedAt = Date.now()

  // ---- 1. 拉取云端全量（含软删记录） ----
  const cloud = {}
  const cloudCounts = {}
  for (const table of TABLES) {
    const { data, error } = await supabase.from(table).select('*').eq('username', username)
    if (error) throw new Error(`拉取 ${table} 失败: ${error.message}`)
    cloud[table] = data || []
    cloudCounts[table] = (data || []).length
  }

  // ---- 2. 本地全量 + tombstones ----
  const local = await getLocalFull()
  const localCounts = {
    articles: local.articles.length,
    words: local.words.length,
    word_marks: local.wordMarks.length,
    context_translations: local.contextTranslations.length
  }
  const tombstones = await db.tombstones.toArray()
  const tombByKey = new Map()
  for (const t of tombstones) tombByKey.set(`${t.table}:${t.key}`, t)

  // 按表细分的同步统计：stats.pushed.articles 等；bump(kind, table) 自增
  const stats = { added: {}, updated: {}, deleted: {}, pushed: {} }
  function bump(kind, table) {
    stats[kind][table] = (stats[kind][table] || 0) + 1
  }
  // 待应用云端变更。insert 项携带本地引用，供依赖表解析云端 id。
  const cloudOps = {
    articles: { insert: [], update: [], softDelete: [] },
    words: { insert: [], update: [], softDelete: [] },
    word_marks: { insert: [], update: [], softDelete: [] },
    context_translations: { insert: [], update: [], softDelete: [] }
  }
  const tombToClear = [] // tombstone 记录 id
  // 会话内 id 映射（合并期维护的「本地->云端」反向映射，新插入的在应用期回填）
  const cloudIdOfLocalArticle = new Map() // localArticleId -> cloudArticleId
  const cloudIdOfLocalWord = new Map() // localWordId -> cloudWordId

  // 本地级联删除（同步语义，不写 tombstone）
  async function deleteLocalArticleCascade(localArticleId) {
    await db.transaction('rw', db.articles, db.words, db.wordMarks, db.contextTranslations, async () => {
      await db.wordMarks.where('articleId').equals(localArticleId).delete()
      await db.contextTranslations.where('articleId').equals(localArticleId).delete()
      await db.words.where('articleId').equals(localArticleId).delete()
      await db.articles.delete(localArticleId)
    })
  }
  async function deleteLocalWordCascade(localWordId) {
    await db.transaction('rw', db.words, db.wordMarks, db.contextTranslations, async () => {
      await db.wordMarks.where('wordId').equals(localWordId).delete()
      await db.contextTranslations.where('wordId').equals(localWordId).delete()
      await db.words.delete(localWordId)
    })
  }

  // ==================== 3. 文章合并 ====================
  {
    const cloudArticleActive = new Set(cloud.articles.filter((c) => !c.deletedAt).map((c) => c.id))

    const localArticleByKey = new Map()
    for (const a of local.articles) {
      const k = tombstoneKey('articles', a)
      if (!localArticleByKey.has(k) || ts(a.updatedAt) > ts(localArticleByKey.get(k).updatedAt)) {
        localArticleByKey.set(k, a)
      }
    }
    const cloudArticleByKey = new Map()
    for (const c of cloud.articles) {
      const k = tombstoneKey('articles', c)
      if (!cloudArticleByKey.has(k)) cloudArticleByKey.set(k, c)
    }

    const allKeys = new Set([...localArticleByKey.keys(), ...cloudArticleByKey.keys()])
    for (const key of allKeys) {
      const l = localArticleByKey.get(key)
      const c = cloudArticleByKey.get(key)
      const tomb = tombByKey.get(`articles:${key}`)
      const cActive = c ? cloudArticleActive.has(c.id) : false

      if (l && c && cActive) {
        if (tomb) tombToClear.push(tomb.id) // 本地已有记录 → 旧的删除标记不再需要
        if (ts(l.updatedAt) > ts(c.updatedAt)) {
          cloudOps.articles.update.push({ id: c.id, patch: { content: l.content, updatedAt: l.updatedAt } })
          bump('updated', 'articles')
        } else if (ts(c.updatedAt) > ts(l.updatedAt)) {
          await db.articles.update(l.id, { content: c.content, updatedAt: c.updatedAt })
          bump('updated', 'articles')
        }
      } else if (l && c && !cActive) {
        if (tomb) tombToClear.push(tomb.id)
        if (ts(l.updatedAt) > ts(c.updatedAt)) {
          // 本地删除后重建（本地新）→ 云端复活
          cloudOps.articles.update.push({
            id: c.id,
            patch: { content: l.content, updatedAt: l.updatedAt, deletedAt: null }
          })
          cloudArticleActive.add(c.id)
          bump('updated', 'articles')
        } else {
          // 云端删除生效 → 本地级联物理删
          await deleteLocalArticleCascade(l.id)
          localArticleByKey.delete(key)
          bump('deleted', 'articles')
        }
      } else if (l && !c) {
        if (tomb) {
          tombToClear.push(tomb.id) // 本地删过且云端本无 → tombstone 无意义
        } else {
          cloudOps.articles.insert.push({
            localId: l.id,
            payload: {
              username,
              title: l.title,
              content: l.content,
              createdAt: l.createdAt,
              updatedAt: l.updatedAt
            }
          })
          bump('pushed', 'articles')
        }
      } else if (!l && c && cActive) {
        if (tomb) {
          if (ts(c.updatedAt) > ts(tomb.createdAt)) {
            // 云端在本地删除后更新过 → 云端赢，拉回本地
            const id = await db.articles.add({
              title: c.title,
              content: c.content,
              createdAt: c.createdAt || new Date(),
              updatedAt: c.updatedAt || new Date()
            })
            localArticleByKey.set(key, { id, title: c.title, content: c.content, createdAt: c.createdAt, updatedAt: c.updatedAt })
            bump('added', 'articles')
          } else {
            // 本地删除生效 → 云端软删
            cloudOps.articles.softDelete.push(c.id)
            cloudArticleActive.delete(c.id)
            bump('deleted', 'articles')
          }
          tombToClear.push(tomb.id)
        } else {
          const id = await db.articles.add({
            title: c.title,
            content: c.content,
            createdAt: c.createdAt || new Date(),
            updatedAt: c.updatedAt || new Date()
          })
          localArticleByKey.set(key, { id, title: c.title, content: c.content, createdAt: c.createdAt, updatedAt: c.updatedAt })
          bump('added', 'articles')
        }
      } else if (!l && c && !cActive) {
        if (tomb) tombToClear.push(tomb.id) // 双方都已删
      }
    }

    // 重建映射：有效云端文章 -> 本地文章（供后续单词/标记/翻译）
    for (const c of cloud.articles) {
      if (!cloudArticleActive.has(c.id)) continue
      const k = tombstoneKey('articles', c)
      const l = localArticleByKey.get(k)
      c.__localArticleId = l ? l.id : undefined
      if (l) cloudIdOfLocalArticle.set(l.id, c.id)
    }
  }

  // 文章阶段可能级联删了单词，重新读取最新单词
  const wordsNow = await db.words.toArray()

  // ==================== 4. 单词合并 ====================
  const cloudWordActive = new Set(cloud.words.filter((w) => !w.deletedAt).map((w) => w.id))
  const cloudWordById = new Map(cloud.words.map((w) => [w.id, w]))
  // 每个云端单词的本地文章 id（文章阶段已给云端文章记录标 __localArticleId）
  const cloudArticleById = new Map(cloud.articles.map((c) => [c.id, c]))
  for (const w of cloud.words) {
    w.__localArticleId = cloudArticleById.get(w.articleId)?.__localArticleId
  }
  const localWordByKey = new Map()
  const localWordById = new Map()
  for (const w of wordsNow) {
    localWordById.set(w.id, w)
    const k = tombstoneKey('words', w)
    if (!localWordByKey.has(k) || ts(w.updatedAt) > ts(localWordByKey.get(k).updatedAt)) {
      localWordByKey.set(k, w)
    }
  }
  {
    const cloudWordByKey = new Map()
    for (const w of cloud.words) {
      if (w.__localArticleId == null) continue
      const k = tombstoneKey('words', { word: w.word, articleId: w.__localArticleId })
      if (!cloudWordByKey.has(k)) cloudWordByKey.set(k, w)
    }

    const allKeys = new Set([...localWordByKey.keys(), ...cloudWordByKey.keys()])
    for (const key of allKeys) {
      const l = localWordByKey.get(key)
      const c = cloudWordByKey.get(key)
      const tomb = tombByKey.get(`words:${key}`)
      const cActive = c ? cloudWordActive.has(c.id) : false

      if (l && c && cActive) {
        if (tomb) tombToClear.push(tomb.id)
        if (ts(l.updatedAt) > ts(c.updatedAt)) {
          cloudOps.words.update.push({
            id: c.id,
            patch: { definitions: l.definitions || [], examples: l.examples || [], source: l.source || '', updatedAt: l.updatedAt }
          })
          bump('updated', 'words')
        } else if (ts(c.updatedAt) > ts(l.updatedAt)) {
          await db.words.update(l.id, {
            definitions: c.definitions || [],
            examples: c.examples || [],
            source: c.source || '',
            updatedAt: c.updatedAt
          })
          bump('updated', 'words')
        }
      } else if (l && c && !cActive) {
        if (tomb) tombToClear.push(tomb.id)
        if (ts(l.updatedAt) > ts(c.updatedAt)) {
          cloudOps.words.update.push({
            id: c.id,
            patch: {
              definitions: l.definitions || [],
              examples: l.examples || [],
              source: l.source || '',
              updatedAt: l.updatedAt,
              deletedAt: null
            }
          })
          cloudWordActive.add(c.id)
          bump('updated', 'words')
        } else {
          await deleteLocalWordCascade(l.id)
          localWordByKey.delete(key)
          localWordById.delete(l.id)
          bump('deleted', 'words')
        }
      } else if (l && !c) {
        if (tomb) {
          tombToClear.push(tomb.id)
        } else {
          cloudOps.words.insert.push({
            localId: l.id,
            localArticleId: l.articleId,
            payload: {
              username,
              word: l.word,
              articleId: null, // 应用期回填
              definitions: l.definitions || [],
              examples: l.examples || [],
              source: l.source || '',
              updatedAt: l.updatedAt
            }
          })
          bump('pushed', 'words')
        }
      } else if (!l && c && cActive) {
        const addLocalWord = async () => {
          const id = await db.words.add({
            word: c.word.toLowerCase(),
            articleId: c.__localArticleId,
            definitions: c.definitions || [],
            examples: c.examples || [],
            source: c.source || '',
            updatedAt: c.updatedAt || new Date()
          })
          const rec = { id, word: c.word.toLowerCase(), articleId: c.__localArticleId, definitions: c.definitions || [], examples: c.examples || [], source: c.source || '', updatedAt: c.updatedAt }
          localWordByKey.set(key, rec)
          localWordById.set(id, rec)
          bump('added', 'words')
        }
        if (tomb) {
          if (ts(c.updatedAt) > ts(tomb.createdAt)) {
            await addLocalWord()
          } else {
            cloudOps.words.softDelete.push(c.id)
            cloudWordActive.delete(c.id)
            bump('deleted', 'words')
          }
          tombToClear.push(tomb.id)
        } else {
          await addLocalWord()
        }
      } else if (!l && c && !cActive) {
        if (tomb) tombToClear.push(tomb.id)
      }
    }

    // 云端孤儿单词（文章已删/不存在）→ 级联软删
    for (const w of cloud.words) {
      if (!cloudWordActive.has(w.id)) continue
      if (w.__localArticleId == null) {
        cloudOps.words.softDelete.push(w.id)
        cloudWordActive.delete(w.id)
        bump('deleted', 'words')
      }
    }

    // 重建映射：有效云端单词 -> 本地单词
    for (const w of cloud.words) {
      if (!cloudWordActive.has(w.id)) continue
      if (w.__localArticleId == null) continue
      const k = tombstoneKey('words', { word: w.word, articleId: w.__localArticleId })
      const l = localWordByKey.get(k)
      w.__localWordId = l ? l.id : undefined
      if (l) cloudIdOfLocalWord.set(l.id, w.id)
    }
  }

  // 单词阶段可能级联删了标记/翻译，重新读取
  let marksNow = await db.wordMarks.toArray()
  let translationsNow = await db.contextTranslations.toArray()

  // 清理历史同步 bug 产生的「无主」标记/翻译（wordId 不在本地单词表中，
  // 例如外键映射缺失时写入的幽灵记录）。它们不可见且会随每次同步重复新增，
  // 属于脏数据，直接物理删除（云端不受影响，下一次合并会重新正确拉回）。
  const validWordIdSet = new Set(localWordById.keys())
  const orphanMarkIds = marksNow.filter((m) => !validWordIdSet.has(m.wordId)).map((m) => m.id)
  if (orphanMarkIds.length) {
    await db.wordMarks.bulkDelete(orphanMarkIds)
    marksNow = marksNow.filter((m) => validWordIdSet.has(m.wordId))
  }
  const orphanTransIds = translationsNow.filter((t) => !validWordIdSet.has(t.wordId)).map((t) => t.id)
  if (orphanTransIds.length) {
    await db.contextTranslations.bulkDelete(orphanTransIds)
    translationsNow = translationsNow.filter((t) => validWordIdSet.has(t.wordId))
  }

  // ==================== 5. 标记合并 ====================
  const cloudMarkActive = new Set(cloud.word_marks.filter((m) => !m.deletedAt).map((m) => m.id))
  {
    const localMarkByKey = new Map()
    for (const m of marksNow) {
      const w = localWordById.get(m.wordId)
      if (!w) continue
      const k = tombstoneKey('word_marks', { word: w.word, articleId: m.articleId, occKey: m.occKey })
      if (!localMarkByKey.has(k)) localMarkByKey.set(k, m)
    }
    const cloudMarkByKey = new Map()
    for (const m of cloud.word_marks) {
      const cw = cloudWordById.get(m.wordId)
      if (!cw || cw.__localWordId == null || cw.__localArticleId == null) continue
      const lw = localWordById.get(cw.__localWordId)
      if (!lw) continue
      const k = tombstoneKey('word_marks', { word: lw.word, articleId: cw.__localArticleId, occKey: m.occKey })
      if (!cloudMarkByKey.has(k)) {
        // 把本地映射挂到云端标记记录上，供「拉回本地」分支写入正确的外键
        m.__localWordId = cw.__localWordId
        m.__localArticleId = cw.__localArticleId
        cloudMarkByKey.set(k, m)
      }
    }

    const allKeys = new Set([...localMarkByKey.keys(), ...cloudMarkByKey.keys()])
    for (const key of allKeys) {
      const l = localMarkByKey.get(key)
      const c = cloudMarkByKey.get(key)
      const tomb = tombByKey.get(`word_marks:${key}`)
      const cActive = c ? cloudMarkActive.has(c.id) : false

      if (l && c && cActive) {
        // 标记是「有无」型，两边都存在 → 无需处理
      } else if (l && c && !cActive) {
        if (tomb) tombToClear.push(tomb.id)
        const lT = ts(l.updatedAt || l.createdAt)
        if (lT > ts(c.updatedAt || c.createdAt)) {
          cloudOps.word_marks.update.push({ id: c.id, patch: { deletedAt: null, updatedAt: l.updatedAt || l.createdAt } })
          cloudMarkActive.add(c.id)
          bump('updated', 'word_marks')
        } else {
          await db.wordMarks.delete(l.id)
          localMarkByKey.delete(key)
          bump('deleted', 'word_marks')
        }
      } else if (l && !c) {
        if (tomb) {
          tombToClear.push(tomb.id)
        } else {
          cloudOps.word_marks.insert.push({
            localWordId: l.wordId,
            localArticleId: l.articleId,
            payload: {
              username,
              articleId: null, // 应用期回填
              wordId: null,
              occKey: l.occKey,
              createdAt: l.createdAt,
              updatedAt: l.updatedAt || l.createdAt
            }
          })
          bump('pushed', 'word_marks')
        }
      } else if (!l && c && cActive) {
        const addLocalMark = async () => {
          await db.wordMarks.add({
            wordId: c.__localWordId,
            articleId: c.__localArticleId,
            occKey: c.occKey,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt || c.createdAt
          })
          localMarkByKey.set(key, { wordId: c.__localWordId, articleId: c.__localArticleId, occKey: c.occKey })
          bump('added', 'word_marks')
        }
        if (tomb) {
          if (ts(c.updatedAt || c.createdAt) > ts(tomb.createdAt)) {
            await addLocalMark()
          } else {
            cloudOps.word_marks.softDelete.push(c.id)
            cloudMarkActive.delete(c.id)
            bump('deleted', 'word_marks')
          }
          tombToClear.push(tomb.id)
        } else {
          await addLocalMark()
        }
      } else if (!l && c && !cActive) {
        if (tomb) tombToClear.push(tomb.id)
      }
    }

    // 云端孤儿标记（所属单词/文章已删）→ 级联软删
    for (const m of cloud.word_marks) {
      if (!cloudMarkActive.has(m.id)) continue
      const cw = cloudWordById.get(m.wordId)
      if (!cw || cw.__localWordId == null || cw.__localArticleId == null) {
        cloudOps.word_marks.softDelete.push(m.id)
        cloudMarkActive.delete(m.id)
        bump('deleted', 'word_marks')
      }
    }
  }

  // ==================== 6. 翻译合并（同构于标记 + translation 字段 LWW） ====================
  const cloudTransActive = new Set(cloud.context_translations.filter((t) => !t.deletedAt).map((t) => t.id))
  {
    const localTransByKey = new Map()
    for (const t of translationsNow) {
      const w = localWordById.get(t.wordId)
      if (!w) continue
      const k = tombstoneKey('context_translations', { word: w.word, articleId: t.articleId, occKey: t.occKey })
      if (!localTransByKey.has(k)) localTransByKey.set(k, t)
    }
    const cloudTransByKey = new Map()
    for (const t of cloud.context_translations) {
      const cw = cloudWordById.get(t.wordId)
      if (!cw || cw.__localWordId == null || cw.__localArticleId == null) continue
      const lw = localWordById.get(cw.__localWordId)
      if (!lw) continue
      const k = tombstoneKey('context_translations', { word: lw.word, articleId: cw.__localArticleId, occKey: t.occKey })
      if (!cloudTransByKey.has(k)) {
        // 把本地映射挂到云端翻译记录上，供「拉回本地」分支写入正确的外键
        t.__localWordId = cw.__localWordId
        t.__localArticleId = cw.__localArticleId
        cloudTransByKey.set(k, t)
      }
    }

    const allKeys = new Set([...localTransByKey.keys(), ...cloudTransByKey.keys()])
    for (const key of allKeys) {
      const l = localTransByKey.get(key)
      const c = cloudTransByKey.get(key)
      const tomb = tombByKey.get(`context_translations:${key}`)
      const cActive = c ? cloudTransActive.has(c.id) : false

      if (l && c && cActive) {
        if (tomb) tombToClear.push(tomb.id)
        const lT = ts(l.updatedAt || l.createdAt)
        const cT = ts(c.updatedAt || c.createdAt)
        if (lT > cT) {
          cloudOps.context_translations.update.push({ id: c.id, patch: { translation: l.translation, updatedAt: l.updatedAt || l.createdAt } })
          bump('updated', 'context_translations')
        } else if (cT > lT) {
          await db.contextTranslations.update(l.id, { translation: c.translation, updatedAt: c.updatedAt || c.createdAt })
          bump('updated', 'context_translations')
        }
      } else if (l && c && !cActive) {
        if (tomb) tombToClear.push(tomb.id)
        const lT = ts(l.updatedAt || l.createdAt)
        if (lT > ts(c.updatedAt || c.createdAt)) {
          cloudOps.context_translations.update.push({
            id: c.id,
            patch: { translation: l.translation, deletedAt: null, updatedAt: l.updatedAt || l.createdAt }
          })
          cloudTransActive.add(c.id)
          bump('updated', 'context_translations')
        } else {
          await db.contextTranslations.delete(l.id)
          localTransByKey.delete(key)
          bump('deleted', 'context_translations')
        }
      } else if (l && !c) {
        if (tomb) {
          tombToClear.push(tomb.id)
        } else {
          cloudOps.context_translations.insert.push({
            localWordId: l.wordId,
            localArticleId: l.articleId,
            payload: {
              username,
              wordId: null, // 应用期回填
              articleId: null,
              occKey: l.occKey || '0',
              translation: l.translation,
              createdAt: l.createdAt,
              updatedAt: l.updatedAt || l.createdAt
            }
          })
          bump('pushed', 'context_translations')
        }
      } else if (!l && c && cActive) {
        const addLocalTrans = async () => {
          await db.contextTranslations.add({
            wordId: c.__localWordId,
            articleId: c.__localArticleId,
            occKey: c.occKey || '0',
            translation: c.translation,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt || c.createdAt
          })
          localTransByKey.set(key, { wordId: c.__localWordId, articleId: c.__localArticleId, occKey: c.occKey, translation: c.translation })
          bump('added', 'context_translations')
        }
        if (tomb) {
          if (ts(c.updatedAt || c.createdAt) > ts(tomb.createdAt)) {
            await addLocalTrans()
          } else {
            cloudOps.context_translations.softDelete.push(c.id)
            cloudTransActive.delete(c.id)
            bump('deleted', 'context_translations')
          }
          tombToClear.push(tomb.id)
        } else {
          await addLocalTrans()
        }
      } else if (!l && c && !cActive) {
        if (tomb) tombToClear.push(tomb.id)
      }
    }

    for (const t of cloud.context_translations) {
      if (!cloudTransActive.has(t.id)) continue
      const cw = cloudWordById.get(t.wordId)
      if (!cw || cw.__localWordId == null || cw.__localArticleId == null) {
        cloudOps.context_translations.softDelete.push(t.id)
        cloudTransActive.delete(t.id)
        bump('deleted', 'context_translations')
      }
    }
  }

  // ==================== 7. 应用云端变更（按依赖顺序：文章→单词→标记→翻译） ====================
  const insertedArticleIds = new Map() // localId -> cloudId
  if (cloudOps.articles.insert.length) {
    const ids = await batchInsert(supabase, 'articles', cloudOps.articles.insert.map((i) => i.payload))
    cloudOps.articles.insert.forEach((i, idx) => insertedArticleIds.set(i.localId, ids[idx]))
  }

  const insertedWordIds = new Map() // localId -> cloudId
  if (cloudOps.words.insert.length) {
    for (const item of cloudOps.words.insert) {
      item.payload.articleId = cloudIdOfLocalArticle.get(item.localArticleId) ?? insertedArticleIds.get(item.localArticleId) ?? null
    }
    const validWords = cloudOps.words.insert.filter((i) => i.payload.articleId != null)
    const ids = validWords.length ? await batchInsert(supabase, 'words', validWords.map((i) => i.payload)) : []
    validWords.forEach((i, idx) => insertedWordIds.set(i.localId, ids[idx]))
  }

  if (cloudOps.word_marks.insert.length) {
    for (const item of cloudOps.word_marks.insert) {
      item.payload.articleId = cloudIdOfLocalArticle.get(item.localArticleId) ?? insertedArticleIds.get(item.localArticleId) ?? null
      item.payload.wordId = cloudIdOfLocalWord.get(item.localWordId) ?? insertedWordIds.get(item.localWordId) ?? null
    }
    const valid = cloudOps.word_marks.insert.filter((i) => i.payload.articleId != null && i.payload.wordId != null)
    if (valid.length) await batchInsert(supabase, 'word_marks', valid.map((i) => i.payload))
  }

  if (cloudOps.context_translations.insert.length) {
    for (const item of cloudOps.context_translations.insert) {
      item.payload.articleId = cloudIdOfLocalArticle.get(item.localArticleId) ?? insertedArticleIds.get(item.localArticleId) ?? null
      item.payload.wordId = cloudIdOfLocalWord.get(item.localWordId) ?? insertedWordIds.get(item.localWordId) ?? null
    }
    const valid = cloudOps.context_translations.insert.filter((i) => i.payload.articleId != null && i.payload.wordId != null)
    if (valid.length) await batchInsert(supabase, 'context_translations', valid.map((i) => i.payload))
  }

  // update / 软删（引用既有云端 id，与 insert 无依赖）
  for (const table of TABLES) {
    const ops = cloudOps[table]
    for (const item of ops.update) {
      const { error } = await supabase.from(table).update(item.patch).eq('id', item.id)
      if (error) throw new Error(`更新云端 ${table} 失败: ${error.message}`)
    }
    for (const id of ops.softDelete) {
      const { error } = await supabase.from(table).update({ deletedAt: nowIso(), updatedAt: nowIso() }).eq('id', id)
      if (error) throw new Error(`删除云端 ${table} 失败: ${error.message}`)
    }
  }

  // ---- 8. 清理已处理的 tombstone ----
  if (tombToClear.length) {
    await db.tombstones.bulkDelete(tombToClear)
  }

  // ---- 9. 汇总提示（按表细分） ----
  const fmt = (label, counts) => {
    const detail = TABLES
      .filter((t) => counts[t])
      .map((t) => `${counts[t]}${TABLE_LABELS[t]}`)
      .join('、')
    return detail ? `${label} ${detail}` : ''
  }
  const parts = [
    fmt('推送云端', stats.pushed),
    fmt('本地新增', stats.added),
    fmt('更新', stats.updated),
    fmt('删除', stats.deleted)
  ].filter(Boolean)
  if (!parts.length) parts.push('数据已一致，无需变动')
  return {
    success: true,
    message: '同步完成：' + parts.join('；'),
    // 调试用详细数据（debug 模式在设置页展示）
    detail: {
      durationMs: Date.now() - startedAt,
      cloud: cloudCounts,
      local: localCounts,
      pushed: { ...stats.pushed },
      added: { ...stats.added },
      updated: { ...stats.updated },
      deleted: { ...stats.deleted }
    }
  }
}
