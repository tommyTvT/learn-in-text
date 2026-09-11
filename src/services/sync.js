import { getSupabase } from '../lib/supabase'
import { db, stableKey, newUid } from './db'
import { useAuthStore } from '../stores/auth'
import { useWordStore } from '../stores/word'
import { useArticleStore } from '../stores/article'

const TABLES = ['articles', 'words', 'word_marks', 'context_translations']

// 模块级并发锁：同步进行中再次调用 syncNow 时复用同一 Promise（合并为一次同步），
// 避免手动同步与自动同步并发导致重复推送/插入。
let inflightSync = null

// 表格中文名（同步结果提示用）
const TABLE_LABELS = { articles: '文章', words: '单词', word_marks: '标记', context_translations: '翻译' }

const ts = (v) => (v ? new Date(v).getTime() : 0)

/**
 * 同一业务键在云端存在多行时的防御性选行（历史脏数据），
 * 取 updatedAt（缺省 createdAt）更新的一行作为代表参与差分。
 */
function betterRep(a, b) {
  return ts(a.updatedAt || a.createdAt) > ts(b.updatedAt || b.createdAt)
}

function requireUsername() {
  const auth = useAuthStore()
  const name = auth.username?.trim()
  if (!name) {
    throw new Error('请先登录后再同步')
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
 * 清除该用户在云端的全部数据（物理删除）。
 */
export async function clearCloud() {
  const supabase = getSupabase()
  const username = requireUsername()

  for (const table of TABLES) {
    // delete 同样受服务端 max-rows（默认 1000 行）限制，单次请求删不干净，
    // 循环删除直到该表清零；一轮删除后剩余行数不再下降则报错，防死循环
    let remaining = null
    for (;;) {
      const { error } = await supabase.from(table).delete().eq('username', username)
      if (error) throw new Error(`清除云端 ${table} 失败: ${error.message}`)
      const { count, error: countError } = await supabase
        .from(table)
        .select('id', { count: 'exact', head: true })
        .eq('username', username)
      if (countError) throw new Error(`查询云端 ${table} 剩余量失败: ${countError.message}`)
      if (!count) break
      if (remaining != null && count >= remaining) {
        throw new Error(`清除云端 ${table} 失败: 删除未生效（剩余 ${count} 行）`)
      }
      remaining = count
    }
  }

  return { success: true, message: '云端数据已清除' }
}

/**
 * 分页拉取该用户在某张云端表的全部记录。
 * PostgREST 服务端对单次查询有 max-rows 上限（Supabase 默认 1000 行），
 * 一次性 select('*') 的超出部分会被静默截断：
 *   - 截断的记录永远拉不到本地（表现为「部分数据无法同步」）；
 *   - 合并算法会把拉不到的云端记录当作「云端不存在」，
 *     本地记录被重复推送插入，云端数据越堆越多。
 * 因此必须按主键稳定排序 + range 分页循环取全。
 * 性能：大数据量时逐页串行会累积网络往返延迟，首页探测后改为
 * 每轮并行拉取 4 页（order by id 稳定 + range 互不重叠，可安全并行；
 * 超出总量的 range 返回空数组而非错误）。
 */
async function fetchAllCloud(supabase, table, username) {
  const PAGE_SIZE = 1000
  const PARALLEL_PAGES = 4
  const fetchPage = async (from) => {
    const { data, error } = await supabase
      .from(table)
      .select('*')
      .eq('username', username)
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`拉取 ${table} 失败: ${error.message}`)
    return data || []
  }
  const rows = await fetchPage(0)
  if (rows.length < PAGE_SIZE) return rows
  for (let from = PAGE_SIZE; ; from += PARALLEL_PAGES * PAGE_SIZE) {
    const pages = await Promise.all(
      Array.from({ length: PARALLEL_PAGES }, (_, i) => fetchPage(from + i * PAGE_SIZE))
    )
    let total = 0
    for (const page of pages) {
      rows.push(...page)
      total += page.length
    }
    // 任一页未满说明已到末尾（其后页均为空）
    if (total < PARALLEL_PAGES * PAGE_SIZE) return rows
  }
}

/**
 * 批量插入辅助：分块有限并行插入，返回云端 id 数组（与 payloads 顺序一致）。
 * 单块不超过服务端单请求行数上限（CHUNK=500）；块与块之间是互不依赖的
 * 纯插入，并行发出以缩短大账号首次同步耗时（部分块失败时已插入的行
 * 会被下次同步的幂等合并正确处理，无需回滚）。
 */
async function batchInsert(supabase, table, payloads) {
  const CHUNK = 500
  const CONCURRENCY = 3
  const chunks = []
  for (let i = 0; i < payloads.length; i += CHUNK) chunks.push(payloads.slice(i, i + CHUNK))
  const idChunks = new Array(chunks.length)
  let next = 0
  const worker = async () => {
    while (next < chunks.length) {
      const idx = next++
      const { data, error } = await supabase.from(table).insert(chunks[idx]).select('id')
      if (error) throw new Error(`推送 ${table} 失败: ${error.message}`)
      idChunks[idx] = (data || []).map((row) => row.id)
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker))
  return idChunks.flat()
}

/**
 * 批量物理删除云端行（分批控制 in-filter 长度，避免超出服务端 URL 上限）。
 */
async function batchHardDelete(supabase, table, ids) {
  const CHUNK = 200
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { error } = await supabase.from(table).delete().in('id', ids.slice(i, i + CHUNK))
    if (error) throw new Error(`删除云端 ${table} 失败: ${error.message}`)
  }
}

/**
 * 三方差分决策（快照差分同步的核心）。
 *
 * 对每个业务键，比较「本地 / 云端 / 上次同步快照」三方状态与时间戳：
 *   - lTs / cTs 为 null 表示该侧不存在记录
 *   - sTs 为 null 表示上次同步时该键不存在（含首次同步无快照的情形）
 *   - legacyTomb：v7 及以前本地墓碑记录过该键的删除（仅在首次新同步迁移时出现）
 *
 * 决策矩阵：
 *   本地+云端都有        → LWW：新者覆盖旧者（push-update / pull-update / none）
 *   本地有、云端无       → 本地新建/改过 → 推送插入（push-insert）
 *                         本地未动而云端消失 → 别处删除 → 本地跟删（pull-delete）
 *   本地无、云端有       → 云端新建/改过 → 拉回本地（pull-insert）
 *                         云端未动而本地消失 → 本地删除 → 云端硬删（push-delete）
 *                         无快照 + 有旧墓碑 → 迁移期本地删除 → 云端硬删（push-delete）
 *   双方都无            → 无操作（快照重写时该键自然消失）
 *
 * 已知取舍：云端删除不留时间戳，无法与本地修改精确比较——
 * 本地改过而云端被删时一律复活（推送），与旧软删方案绝大多数场景行为一致。
 */
function decideAction(lTs, cTs, sTs, legacyTomb) {
  if (lTs != null && cTs != null) {
    if (lTs > cTs) return 'push-update'
    if (cTs > lTs) return 'pull-update'
    return 'none'
  }
  if (lTs != null) {
    // 本地有、云端无（含云端仅剩软删残留行的情形，软删行拉取时已过滤）
    return sTs == null || lTs > sTs ? 'push-insert' : 'pull-delete'
  }
  if (cTs != null) {
    if (sTs != null) return cTs > sTs ? 'pull-insert' : 'push-delete'
    return legacyTomb ? 'push-delete' : 'pull-insert'
  }
  return 'none'
}

/**
 * 双向差分同步（LWW + 快照删除传播，全部物理删除）。
 *
 * 匹配：稳定业务键（db.js stableKey）。云端记录先经会话内映射
 * （云端文章id->本地文章id、云端单词id->本地单词id）再拼本地视角键。
 * 冲突：比较 updatedAt，新者整条覆盖（Last-Write-Wins）。
 * 删除：本地删除即物理删；同步时「快照有、本地无、云端未动」→ 云端硬删，
 *       「快照有、云端无、本地未动」→ 本地跟删。全部不再产生软删行。
 * 级联：云端行映射不到本地父记录（文章/单词已删）→ 视为孤儿硬删。
 * 迁移：v7 墓碑机制残留的 tombstones 表在首次新同步时按「本地删除」消化，
 *       云端遗留软删行（deletedAt 非空）统一物理清理。
 */
export async function syncNow(...args) {
  if (inflightSync) return inflightSync
  inflightSync = doSync(...args).finally(() => {
    inflightSync = null
  })
  return inflightSync
}

async function doSync(onProgress) {
  const supabase = getSupabase()
  const username = requireUsername()
  const startedAt = Date.now()

  // 阶段进度上报：onProgress({ label, percent })，供登录页展示同步进度条；
  // 未传回调时静默（手动/自动同步路径不受影响）。
  const PROGRESS_TOTAL = 13
  let progressStep = 0
  const report = (label) => {
    progressStep++
    onProgress?.({
      label,
      percent: Math.min(100, Math.round((progressStep / PROGRESS_TOTAL) * 100))
    })
  }

  // ---- 1. 拉取云端全量（分页取全；四表只读并行，互不依赖） ----
  // 云端遗留的软删行（v7 机制残留）过滤为「不存在」，其 id 收集后统一物理清理
  const cloud = {}
  const staleCloudIds = { articles: [], words: [], word_marks: [], context_translations: [] }
  const cloudCounts = {}
  report('正在拉取云端数据…')
  await Promise.all(
    TABLES.map(async (table) => {
      const rows = await fetchAllCloud(supabase, table, username)
      cloud[table] = rows.filter((r) => {
        if (r.deletedAt) {
          staleCloudIds[table].push(r.id)
          return false
        }
        return true
      })
      cloudCounts[table] = cloud[table].length
      report(`正在拉取云端数据…（${Object.keys(cloudCounts).length}/4）`)
    })
  )

  // ---- 2. 本地全量 + 同步快照 + 旧墓碑（迁移用），并行读取 ----
  const [local, snapshotRows, tombstoneRows] = await Promise.all([
    getLocalFull(),
    db.syncSnapshots.toArray(),
    db.tombstones.toArray()
  ])
  const localCounts = {
    articles: local.articles.length,
    words: local.words.length,
    word_marks: local.wordMarks.length,
    context_translations: local.contextTranslations.length
  }
  // 快照按表分组：Map(key -> 上次同步时的 updatedAt 时间戳)
  const snapshotByTable = new Map()
  for (const row of snapshotRows) {
    if (!snapshotByTable.has(row.table)) snapshotByTable.set(row.table, new Map())
    snapshotByTable.get(row.table).set(row.key, row.updatedAt)
  }
  const hasSnapshot = snapshotRows.length > 0
  // 旧墓碑键集合（table:key），仅在无快照的首次迁移同步中使用
  const legacyTombKeys = new Set(tombstoneRows.map((t) => `${t.table}:${t.key}`))

  // 按表细分的同步统计：stats.pushed.articles 等；bump(kind, table) 自增
  const stats = { added: {}, updated: {}, deleted: {}, pushed: {} }
  function bump(kind, table) {
    stats[kind][table] = (stats[kind][table] || 0) + 1
  }
  // 待应用云端变更。insert 项携带本地引用，供依赖表解析云端 id。
  const cloudOps = {
    articles: { insert: [], update: [], hardDelete: new Set() },
    words: { insert: [], update: [], hardDelete: new Set() },
    word_marks: { insert: [], update: [], hardDelete: new Set() },
    context_translations: { insert: [], update: [], hardDelete: new Set() }
  }
  // 本次同步成功后要写入的新快照：Map(table -> Map(key -> finalTs))
  const nextSnapshot = new Map()
  const setSnap = (table, key, t) => {
    if (!nextSnapshot.has(table)) nextSnapshot.set(table, new Map())
    nextSnapshot.get(table).set(key, t)
  }
  // 会话内 id 映射（合并期维护的「本地->云端」反向映射，新插入的在应用期回填）
  const cloudIdOfLocalArticle = new Map() // localArticleId -> cloudArticleId
  const cloudIdOfLocalWord = new Map() // localWordId -> cloudWordId

  // 本地级联删除（同步语义）
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
  // 文章业务键为 uid（创建时生成，全局唯一）：改标题只是普通字段更新，随 LWW 补丁同步。
  // 性能：块内逐条 db 写（补 uid / 拉回 / 更新 / 级联删）包进单个事务，
  // 避免每条写各自提交一次 IndexedDB 事务（大量数据时提交开销远超写入本身）。
  report('正在合并文章…')
  const mergeArticles = async () => {
    // 双方记录一律补齐 uid：本地兜底早期记录；云端异常缺 uid 的生成后随更新回写
    for (const l of local.articles) {
      if (!l.uid) {
        l.uid = newUid()
        await db.articles.update(l.id, { uid: l.uid })
      }
    }
    for (const c of cloud.articles) {
      if (!c.uid) {
        c.uid = newUid()
        cloudOps.articles.update.push({ id: c.id, patch: { uid: c.uid } })
      }
    }

    const pullArticleToLocal = async (c) => {
      const id = await db.articles.add({
        uid: c.uid,
        title: c.title,
        description: c.description || '',
        content: c.content,
        sortOrder: c.sortOrder ?? null,
        createdAt: c.createdAt || new Date(),
        updatedAt: c.updatedAt || new Date()
      })
      c.__localArticleId = id
      cloudIdOfLocalArticle.set(id, c.id)
      bump('added', 'articles')
    }

    const localArticleByUid = new Map(local.articles.map((a) => [a.uid, a]))
    const cloudArticleByUid = new Map()
    for (const c of cloud.articles) {
      const prev = cloudArticleByUid.get(c.uid)
      if (!prev || betterRep(c, prev)) cloudArticleByUid.set(c.uid, c)
    }

    const snap = snapshotByTable.get('articles')
    const allUids = new Set([...localArticleByUid.keys(), ...cloudArticleByUid.keys()])
    for (const uid of allUids) {
      const l = localArticleByUid.get(uid)
      const c = cloudArticleByUid.get(uid)
      const key = `u:${uid}`
      const lTs = l ? ts(l.updatedAt) : null
      const cTs = c ? ts(c.updatedAt) : null
      const action = decideAction(lTs, cTs, snap?.get(key), !hasSnapshot && legacyTombKeys.has(`articles:${key}`))

      switch (action) {
        case 'push-update':
          cloudOps.articles.update.push({
            id: c.id,
            patch: { title: l.title, description: l.description || '', content: l.content, sortOrder: l.sortOrder ?? null, updatedAt: l.updatedAt }
          })
          bump('updated', 'articles')
          setSnap('articles', key, lTs)
          c.__localArticleId = l.id
          cloudIdOfLocalArticle.set(l.id, c.id)
          break
        case 'pull-update':
          await db.articles.update(l.id, { title: c.title, description: c.description || '', content: c.content, sortOrder: c.sortOrder ?? null, updatedAt: c.updatedAt })
          bump('updated', 'articles')
          setSnap('articles', key, cTs)
          c.__localArticleId = l.id
          cloudIdOfLocalArticle.set(l.id, c.id)
          break
        case 'push-insert':
          cloudOps.articles.insert.push({
            localId: l.id,
            payload: {
              username,
              uid: l.uid,
              title: l.title,
              description: l.description || '',
              content: l.content,
              sortOrder: l.sortOrder ?? null,
              createdAt: l.createdAt,
              updatedAt: l.updatedAt
            }
          })
          bump('pushed', 'articles')
          setSnap('articles', key, lTs)
          break
        case 'pull-insert':
          await pullArticleToLocal(c)
          setSnap('articles', key, cTs)
          break
        case 'push-delete':
          // 云端硬删且不设 id 映射：其子行（单词等）将落入孤儿分支被级联硬删
          cloudOps.articles.hardDelete.add(c.id)
          bump('deleted', 'articles')
          break
        case 'pull-delete':
          await deleteLocalArticleCascade(l.id)
          bump('deleted', 'articles')
          break
        default:
          // 两边一致：键保留在快照中，维持 id 映射供子表使用
          setSnap('articles', key, lTs)
          c.__localArticleId = l.id
          cloudIdOfLocalArticle.set(l.id, c.id)
      }
    }

    // 云端孤儿文章（uid 映射不到任何活跃路径的异常行）不在此处理：
    // 所有拉回的云端文章都已设 __localArticleId，删除传播见上方矩阵
  }
  await db.transaction('rw', db.articles, db.words, db.wordMarks, db.contextTranslations, mergeArticles)

  // 文章阶段可能级联删了单词，重新读取最新单词
  const wordsNow = await db.words.toArray()

  // ==================== 4. 单词合并 ====================
  // 性能：合并写同样包进单个事务（原因见文章合并说明）
  report('正在合并单词…')
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
    const k = stableKey('words', w)
    if (!localWordByKey.has(k) || ts(w.updatedAt) > ts(localWordByKey.get(k).updatedAt)) {
      localWordByKey.set(k, w)
    }
  }
  const mergeWords = async () => {
    const cloudWordByKey = new Map()
    for (const w of cloud.words) {
      if (w.__localArticleId == null) continue
      const k = stableKey('words', { word: w.word, articleId: w.__localArticleId })
      const prev = cloudWordByKey.get(k)
      if (!prev || betterRep(w, prev)) cloudWordByKey.set(k, w)
    }

    const snap = snapshotByTable.get('words')
    const allKeys = new Set([...localWordByKey.keys(), ...cloudWordByKey.keys()])
    for (const key of allKeys) {
      const l = localWordByKey.get(key)
      const c = cloudWordByKey.get(key)
      const lTs = l ? ts(l.updatedAt) : null
      const cTs = c ? ts(c.updatedAt) : null
      const action = decideAction(lTs, cTs, snap?.get(key), !hasSnapshot && legacyTombKeys.has(`words:${key}`))

      switch (action) {
        case 'push-update':
          cloudOps.words.update.push({
            id: c.id,
            patch: { definitions: l.definitions || [], examples: l.examples || [], source: l.source || '', updatedAt: l.updatedAt }
          })
          bump('updated', 'words')
          setSnap('words', key, lTs)
          c.__localWordId = l.id
          cloudIdOfLocalWord.set(l.id, c.id)
          break
        case 'pull-update':
          await db.words.update(l.id, {
            definitions: c.definitions || [],
            examples: c.examples || [],
            source: c.source || '',
            updatedAt: c.updatedAt
          })
          l.updatedAt = c.updatedAt
          bump('updated', 'words')
          setSnap('words', key, cTs)
          c.__localWordId = l.id
          cloudIdOfLocalWord.set(l.id, c.id)
          break
        case 'push-insert':
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
          setSnap('words', key, lTs)
          break
        case 'pull-insert': {
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
          c.__localWordId = id
          cloudIdOfLocalWord.set(id, c.id)
          bump('added', 'words')
          setSnap('words', key, cTs)
          break
        }
        case 'push-delete':
          // 云端硬删且不设 id 映射：其子行（标记/翻译）将落入孤儿分支被级联硬删
          cloudOps.words.hardDelete.add(c.id)
          bump('deleted', 'words')
          break
        case 'pull-delete':
          await deleteLocalWordCascade(l.id)
          localWordByKey.delete(key)
          localWordById.delete(l.id)
          bump('deleted', 'words')
          break
        default:
          setSnap('words', key, lTs)
          c.__localWordId = l.id
          cloudIdOfLocalWord.set(l.id, c.id)
      }
    }

    // 云端孤儿单词（所属文章已删/映射不到）→ 硬删（差分级联）
    for (const w of cloud.words) {
      if (w.__localArticleId == null && !cloudOps.words.hardDelete.has(w.id)) {
        cloudOps.words.hardDelete.add(w.id)
        bump('deleted', 'words')
      }
    }
  }
  await db.transaction('rw', db.words, db.wordMarks, db.contextTranslations, mergeWords)

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
  // 性能：合并写同样包进单个事务（原因见文章合并说明）
  report('正在合并标记…')
  const mergeMarks = async () => {
    const localMarkByKey = new Map()
    for (const m of marksNow) {
      const w = localWordById.get(m.wordId)
      if (!w) continue
      const k = stableKey('word_marks', { word: w.word, articleId: m.articleId, occKey: m.occKey })
      if (!localMarkByKey.has(k)) localMarkByKey.set(k, m)
    }
    const cloudMarkByKey = new Map()
    for (const m of cloud.word_marks) {
      const cw = cloudWordById.get(m.wordId)
      if (!cw || cw.__localWordId == null || cw.__localArticleId == null) continue
      const lw = localWordById.get(cw.__localWordId)
      if (!lw) continue
      const k = stableKey('word_marks', { word: lw.word, articleId: cw.__localArticleId, occKey: m.occKey })
      const prev = cloudMarkByKey.get(k)
      if (!prev || betterRep(m, prev)) {
        // 把本地映射挂到云端标记记录上，供「拉回本地」分支写入正确的外键
        m.__localWordId = cw.__localWordId
        m.__localArticleId = cw.__localArticleId
        cloudMarkByKey.set(k, m)
      }
    }

    const snap = snapshotByTable.get('word_marks')
    const allKeys = new Set([...localMarkByKey.keys(), ...cloudMarkByKey.keys()])
    for (const key of allKeys) {
      const l = localMarkByKey.get(key)
      const c = cloudMarkByKey.get(key)
      const lTs = l ? ts(l.updatedAt || l.createdAt) : null
      const cTs = c ? ts(c.updatedAt || c.createdAt) : null
      const action = decideAction(lTs, cTs, snap?.get(key), !hasSnapshot && legacyTombKeys.has(`word_marks:${key}`))

      switch (action) {
        case 'push-update':
          // 标记是「有无」型，两边都存在时新者无字段差异，仅维持快照
          setSnap('word_marks', key, lTs)
          break
        case 'pull-update':
          setSnap('word_marks', key, cTs)
          break
        case 'push-insert':
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
          setSnap('word_marks', key, lTs)
          break
        case 'pull-insert':
          await db.wordMarks.add({
            wordId: c.__localWordId,
            articleId: c.__localArticleId,
            occKey: c.occKey,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt || c.createdAt
          })
          bump('added', 'word_marks')
          setSnap('word_marks', key, cTs)
          break
        case 'push-delete':
          cloudOps.word_marks.hardDelete.add(c.id)
          bump('deleted', 'word_marks')
          break
        case 'pull-delete':
          await db.wordMarks.delete(l.id)
          localMarkByKey.delete(key)
          bump('deleted', 'word_marks')
          break
        default:
          setSnap('word_marks', key, lTs)
      }
    }

    // 云端孤儿标记（所属单词/文章已删）→ 硬删（差分级联）
    for (const m of cloud.word_marks) {
      const cw = cloudWordById.get(m.wordId)
      if (!cw || cw.__localWordId == null || cw.__localArticleId == null) {
        if (!cloudOps.word_marks.hardDelete.has(m.id)) {
          cloudOps.word_marks.hardDelete.add(m.id)
          bump('deleted', 'word_marks')
        }
      }
    }
  }
  await db.transaction('rw', db.wordMarks, mergeMarks)

  // ==================== 6. 翻译合并（同构于标记 + translation 字段 LWW） ====================
  // 性能：合并写同样包进单个事务（原因见文章合并说明）
  report('正在合并翻译…')
  const mergeTranslations = async () => {
    const localTransByKey = new Map()
    for (const t of translationsNow) {
      const w = localWordById.get(t.wordId)
      if (!w) continue
      const k = stableKey('context_translations', { word: w.word, articleId: t.articleId, occKey: t.occKey })
      if (!localTransByKey.has(k)) localTransByKey.set(k, t)
    }
    const cloudTransByKey = new Map()
    for (const t of cloud.context_translations) {
      const cw = cloudWordById.get(t.wordId)
      if (!cw || cw.__localWordId == null || cw.__localArticleId == null) continue
      const lw = localWordById.get(cw.__localWordId)
      if (!lw) continue
      const k = stableKey('context_translations', { word: lw.word, articleId: cw.__localArticleId, occKey: t.occKey })
      const prev = cloudTransByKey.get(k)
      if (!prev || betterRep(t, prev)) {
        // 把本地映射挂到云端翻译记录上，供「拉回本地」分支写入正确的外键
        t.__localWordId = cw.__localWordId
        t.__localArticleId = cw.__localArticleId
        cloudTransByKey.set(k, t)
      }
    }

    const snap = snapshotByTable.get('context_translations')
    const allKeys = new Set([...localTransByKey.keys(), ...cloudTransByKey.keys()])
    for (const key of allKeys) {
      const l = localTransByKey.get(key)
      const c = cloudTransByKey.get(key)
      const lTs = l ? ts(l.updatedAt || l.createdAt) : null
      const cTs = c ? ts(c.updatedAt || c.createdAt) : null
      const action = decideAction(lTs, cTs, snap?.get(key), !hasSnapshot && legacyTombKeys.has(`context_translations:${key}`))

      switch (action) {
        case 'push-update':
          cloudOps.context_translations.update.push({ id: c.id, patch: { translation: l.translation, updatedAt: l.updatedAt || l.createdAt } })
          bump('updated', 'context_translations')
          setSnap('context_translations', key, lTs)
          break
        case 'pull-update':
          await db.contextTranslations.update(l.id, { translation: c.translation, updatedAt: c.updatedAt || c.createdAt })
          bump('updated', 'context_translations')
          setSnap('context_translations', key, cTs)
          break
        case 'push-insert':
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
          setSnap('context_translations', key, lTs)
          break
        case 'pull-insert':
          await db.contextTranslations.add({
            wordId: c.__localWordId,
            articleId: c.__localArticleId,
            occKey: c.occKey || '0',
            translation: c.translation,
            createdAt: c.createdAt,
            updatedAt: c.updatedAt || c.createdAt
          })
          bump('added', 'context_translations')
          setSnap('context_translations', key, cTs)
          break
        case 'push-delete':
          cloudOps.context_translations.hardDelete.add(c.id)
          bump('deleted', 'context_translations')
          break
        case 'pull-delete':
          await db.contextTranslations.delete(l.id)
          localTransByKey.delete(key)
          bump('deleted', 'context_translations')
          break
        default:
          setSnap('context_translations', key, lTs)
      }
    }

    // 云端孤儿翻译（所属单词/文章已删）→ 硬删（差分级联）
    for (const t of cloud.context_translations) {
      const cw = cloudWordById.get(t.wordId)
      if (!cw || cw.__localWordId == null || cw.__localArticleId == null) {
        if (!cloudOps.context_translations.hardDelete.has(t.id)) {
          cloudOps.context_translations.hardDelete.add(t.id)
          bump('deleted', 'context_translations')
        }
      }
    }
  }
  await db.transaction('rw', db.contextTranslations, mergeTranslations)

  // ==================== 7. 应用云端变更（按依赖顺序：文章→单词→（标记、翻译并行）） ====================
  report('正在推送新增数据…')
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

  // 标记/翻译的插入只依赖文章与单词的云端 id，两表互不依赖 → 并行推送
  const insertMarks = async () => {
    if (!cloudOps.word_marks.insert.length) return
    for (const item of cloudOps.word_marks.insert) {
      item.payload.articleId = cloudIdOfLocalArticle.get(item.localArticleId) ?? insertedArticleIds.get(item.localArticleId) ?? null
      item.payload.wordId = cloudIdOfLocalWord.get(item.localWordId) ?? insertedWordIds.get(item.localWordId) ?? null
    }
    const valid = cloudOps.word_marks.insert.filter((i) => i.payload.articleId != null && i.payload.wordId != null)
    if (valid.length) await batchInsert(supabase, 'word_marks', valid.map((i) => i.payload))
  }
  const insertTranslations = async () => {
    if (!cloudOps.context_translations.insert.length) return
    for (const item of cloudOps.context_translations.insert) {
      item.payload.articleId = cloudIdOfLocalArticle.get(item.localArticleId) ?? insertedArticleIds.get(item.localArticleId) ?? null
      item.payload.wordId = cloudIdOfLocalWord.get(item.localWordId) ?? insertedWordIds.get(item.localWordId) ?? null
    }
    const valid = cloudOps.context_translations.insert.filter((i) => i.payload.articleId != null && i.payload.wordId != null)
    if (valid.length) await batchInsert(supabase, 'context_translations', valid.map((i) => i.payload))
  }
  await Promise.all([insertMarks(), insertTranslations()])

  // ---- 8. update / 物理删除（引用既有云端 id，与 insert 无依赖） ----
  // update 的 patch 各不相同，无法合并单请求，有限并发执行；
  // 硬删按 id 集合分批执行，同时清理差分删除与云端遗留的软删行
  report('正在推送更新与删除…')
  const UPDATE_CONCURRENCY = 8
  for (const table of TABLES) {
    const ops = cloudOps[table]
    for (let i = 0; i < ops.update.length; i += UPDATE_CONCURRENCY) {
      const batch = ops.update.slice(i, i + UPDATE_CONCURRENCY)
      await Promise.all(batch.map(async (item) => {
        const { error } = await supabase.from(table).update(item.patch).eq('id', item.id)
        if (error) throw new Error(`更新云端 ${table} 失败: ${error.message}`)
      }))
    }
    const deleteIds = [...ops.hardDelete, ...staleCloudIds[table]]
    if (deleteIds.length) {
      await batchHardDelete(supabase, table, deleteIds)
    }
  }

  // ---- 9. 全部云端变更成功：重写同步快照 + 清空旧墓碑（一次性迁移） ----
  // 快照失败或前置任一步骤失败时快照保持原状，下次同步基于旧基线重跑（操作幂等）
  report('正在写入同步快照…')
  await db.transaction('rw', db.syncSnapshots, db.tombstones, async () => {
    await db.syncSnapshots.clear()
    const rows = []
    for (const [table, keys] of nextSnapshot) {
      for (const [key, updatedAt] of keys) {
        rows.push({ table, key, updatedAt })
      }
    }
    if (rows.length) await db.syncSnapshots.bulkPut(rows)
    // 旧墓碑已在本次差分中消化（无快照的迁移同步按 push-delete 处理），清空退役
    if (tombstoneRows.length) await db.tombstones.clear()
  })

  // ---- 10. 同步改变了本地数据：刷新内存缓存 ----
  // 词库等页面的数据来自 word/article store 的内存缓存（loaded 标记复用），
  // 登录后首次同步或后台同步把云端数据写入本地库后若不强制重载，
  // 词库页会一直展示旧数据，需手动刷新页面才能看到最新内容。
  const localChanged = ['articles', 'words', 'word_marks'].some(
    (t) => stats.added[t] || stats.updated[t] || stats.deleted[t]
  )
  if (localChanged) {
    const wordStore = useWordStore()
    const articleStore = useArticleStore()
    await Promise.all([
      wordStore.fetchMarkedWords(true),
      articleStore.fetchArticles()
    ])
  }

  // ---- 11. 汇总提示（按表细分） ----
  report('同步完成')
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
