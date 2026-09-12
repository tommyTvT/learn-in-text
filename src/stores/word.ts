import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { wordService, exportService, wordMarkService, contextTranslationService, articleService } from '../services/db'
import { errorText } from '../services/errors'
import type { ArticleExportFile, Word } from '../types'

function downloadFile(content: string, filename: string, type = 'application/json'): void {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function formatDate(): string {
  return new Date().toISOString().split('T')[0]
}

export const useWordStore = defineStore('word', () => {
  const words = ref<Word[]>([])
  const markedWords = ref<Word[]>([])
  const loading = ref(false)
  // 加载失败原因（空串表示无错误）。本 store 刻意不 rethrow（同步主流程会复用它强刷），
  // 因此需要把失败状态记录下来，交给页面区分「加载失败」与「确实没有数据」。
  const loadError = ref('')
  // 以文章 id（number）为键：读取方 getArticleWords(articleId) 与构建方 fetchArticleWords
  // （内部使用 Record<number, Word[]>）保持一致，避免两套键类型只在运行时靠隐式转换侥幸成立
  const articleWordsMap = ref<Record<number, Word[]>>({})
  // 是否已从本地库完成首次全量加载，供词库等页面复用，避免每次进入重复读全量数据
  const loaded = ref(false)
  // 加载请求序号：并发触发多次 fetchMarkedWords 时（如同步完成强制刷新与
  // 页面挂载加载重叠），防止先发起的旧请求后完成、用旧数据覆盖新数据
  let fetchSeq = 0

  const markedCount = computed(() => markedWords.value.length)

  async function fetchMarkedWords(force = false): Promise<void> {
    // 已加载过且未强制刷新时直接返回，复用内存中的缓存数据
    if (!force && loaded.value) return
    const seq = ++fetchSeq
    loading.value = true
    loadError.value = ''
    try {
      const allMarks = await wordMarkService.getAll()
      const allWords = await wordService.getAll()
      if (seq !== fetchSeq) return // 已有更新的加载请求，丢弃本次旧结果
      const wordMap: Record<number, Word> = {}
      allWords.forEach(w => { wordMap[w.id!] = w })
      const wordIds = [...new Set(allMarks.map(m => m.wordId))]
      const markedRecords = wordIds.map(id => wordMap[id]).filter(Boolean)
      markedWords.value = dedupeByWord(markedRecords)
      await fetchArticleWords()
      if (seq !== fetchSeq) return
      loaded.value = true
    } catch (error) {
      // 错误显形：此前异常被上层静默吞掉，词库页表现为空列表且无从排查。
      // 不 rethrow：sync.js 同步完成后也会调本方法强刷，刷新失败不应拖垮同步主流程
      console.error('[wordStore] 词库加载失败:', error)
      if (seq === fetchSeq) {
        loadError.value = errorText(error, '词库加载失败，请重试')
      }
    } finally {
      if (seq === fetchSeq) {
        loading.value = false
      }
    }
  }

  /**
   * 失效词库内存缓存（仅重置 loaded 标记，开销为零）。
   * 阅读/学习页直接通过 wordMarkService 写库（绕过 store），
   * 写库成功后必须调用本方法，否则词库页复用旧缓存、看不到最新标记。
   */
  function invalidateMarkCache() {
    loaded.value = false
  }

  function dedupeByWord(records: Word[]): Word[] {
    const map = new Map<string, Word>()
    for (const record of records) {
      const existing = map.get(record.word)
      if (!existing || new Date(record.updatedAt as any).getTime() > new Date(existing.updatedAt as any).getTime()) {
        map.set(record.word, record)
      }
    }
    return [...map.values()]
  }

  async function fetchArticleWords(): Promise<void> {
    const allArticles = await articleService.getAll()
    const wordArticleMap = await wordMarkService.getAllWordArticleMap()
    const allWords = await wordService.getAll()
    const wordMap: Record<number, Word> = {}
    allWords.forEach(w => { wordMap[w.id!] = w })

    const result: Record<number, Word[]> = {}
    for (const article of allArticles) {
      const wordIds = [...new Set<number>(wordArticleMap[article.id!] || [])]
      const articleWords = wordIds.map(id => wordMap[id]).filter(Boolean)
      if (articleWords.length > 0) {
        result[article.id!] = articleWords
      }
    }
    articleWordsMap.value = result
  }

  function getArticleWords(articleId: number): Word[] {
    return articleWordsMap.value[articleId] || []
  }

  async function getOrCreateWord(word: string, articleId: number): Promise<Word | undefined> {
    return await wordService.getOrCreate(word, articleId)
  }

  async function getOrCreateMany(words: string[], articleId: number): Promise<Word[]> {
    return await wordService.getOrCreateMany(words, articleId)
  }

  async function updateWord(id: number, data: Partial<Word>): Promise<Word | undefined> {
    const word = await wordService.update(id, data)
    // 记录可能已被删除（update 返回 undefined）：此时不可把 undefined 写进内存列表
    if (!word) return undefined
    const index = markedWords.value.findIndex(w => w.id === id)
    if (index !== -1) {
      markedWords.value[index] = word
    }
    return word
  }

  async function updateContextTranslation(
    wordId: number,
    articleId: number,
    occKey: string | undefined,
    translation: string
  ) {
    return await contextTranslationService.set(wordId, articleId, occKey, translation)
  }

  async function toggleMark(wordId: number, articleId: number, occKey = '0'): Promise<boolean> {
    const isNowMarked = await wordMarkService.toggleMark(wordId, articleId, occKey)
    if (isNowMarked) {
      const word = await wordService.getById(wordId)
      if (word && !markedWords.value.find(w => w.id === wordId)) {
        markedWords.value.push(word)
      }
    } else {
      const remainingIds = await wordMarkService.getMarkedArticleIds(wordId)
      if (remainingIds.length === 0) {
        markedWords.value = markedWords.value.filter(w => w.id !== wordId)
      }
    }
    await fetchArticleWords()
    loaded.value = false // 标记状态已变更，失效缓存，下次进入词库重新加载
    return isNowMarked
  }

  async function deleteWord(id: number): Promise<void> {
    const record = await wordService.getById(id)
    if (!record) return
    await wordService.deleteBySpelling(record.word)
    markedWords.value = markedWords.value.filter(w => w.word !== record.word)
    await fetchArticleWords()
    loaded.value = false // 数据已变更，失效缓存
  }

  /**
   * 按 id 解析单词记录（含「同一拼写在多篇文章各有一条记录」的全部记录）。
   * 词库页勾选的是 articleWordsMap 里的记录 id，而 markedWords 是按拼写去重后的列表，
   * 用 markedWords 按 id 回查会丢掉较旧记录的 id，表现为勾选后「AI 生成文章 / 导出选中」
   * 静默丢词。这里直接按 id 全集解析，保证与勾选来源同域。
   */
  async function getWordsByIds(ids: number[]): Promise<Word[]> {
    if (!ids.length) return []
    const idSet = new Set(ids)
    const allWords = await wordService.getAll()
    return allWords.filter(w => w.id != null && idSet.has(w.id))
  }

  /**
   * 批量删除选中单词（底层 deleteBySpelling 按拼写跨文章生效，此语义保持不变）。
   * 原实现由调用方逐个 await deleteWord，而 deleteWord 每次都会全量重读词库，
   * N 个单词是 O(N²) 级读放大；这里先去重拼写、循环删除，末尾只刷新一次。
   */
  async function deleteWordsByIds(ids: number[]): Promise<number> {
    if (!ids.length) return 0
    const words = await getWordsByIds(ids)
    const spellings = [...new Set(words.map(w => w.word))]
    if (spellings.length === 0) return 0
    for (const spelling of spellings) {
      await wordService.deleteBySpelling(spelling)
    }
    const deleted = new Set(spellings)
    markedWords.value = markedWords.value.filter(w => !deleted.has(w.word))
    await fetchArticleWords()
    loaded.value = false // 数据已变更，失效缓存
    return spellings.length
  }

  function exportArticleWordsTxt(articleId: number, title: string | undefined, selectedIds: number[] = []): void {
    const words = articleWordsMap.value[articleId] || []
    let exportList = words
    if (selectedIds.length > 0) {
      exportList = words.filter(w => w.id != null && selectedIds.includes(w.id))
    }
    const content = exportList.map(w => w.word).join('\n')
    const safeTitle = (title || 'article').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 30)
    downloadFile(content, `words_${safeTitle}_${formatDate()}.txt`, 'text/plain')
  }

  async function exportSelectedWordsTxt(selectedIds: number[]): Promise<void> {
    // 与勾选来源同域：按 id 全集解析，避免 markedWords 去重导致的静默丢词
    const words = await getWordsByIds(selectedIds)
    const content = words.map(w => w.word).join('\n')
    downloadFile(content, `selected_words_${formatDate()}.txt`, 'text/plain')
  }

  async function exportArticle(articleId: number): Promise<ArticleExportFile> {
    return await exportService.exportArticle(articleId)
  }

  async function exportArticleAndDownload(articleId: number, title: string | undefined): Promise<void> {
    const data = await exportService.exportArticle(articleId)
    const safeTitle = (title || 'article').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 30)
    downloadFile(JSON.stringify(data, null, 2), `article_${safeTitle}_${formatDate()}.json`)
  }

  async function importArticle(data: any): Promise<number> {
    const articleId = await exportService.importArticle(data)
    await fetchMarkedWords(true)
    return articleId
  }

  return {
    words,
    markedWords,
    loading,
    loadError,
    loaded,
    markedCount,
    articleWordsMap,
    fetchMarkedWords,
    invalidateMarkCache,
    getArticleWords,
    getOrCreateWord,
    getOrCreateMany,
    updateWord,
    updateContextTranslation,
    toggleMark,
    deleteWord,
    deleteWordsByIds,
    getWordsByIds,
    exportArticleWordsTxt,
    exportSelectedWordsTxt,
    exportArticle,
    exportArticleAndDownload,
    importArticle
  }
})
