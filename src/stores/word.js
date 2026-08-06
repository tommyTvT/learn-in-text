import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { wordService, exportService, wordMarkService, contextTranslationService, articleService } from '../services/db'

function downloadFile(content, filename, type = 'application/json') {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function formatDate() {
  return new Date().toISOString().split('T')[0]
}

export const useWordStore = defineStore('word', () => {
  const words = ref([])
  const markedWords = ref([])
  const loading = ref(false)
  const articleWordsMap = ref({})

  const markedCount = computed(() => markedWords.value.length)

  async function fetchMarkedWords() {
    loading.value = true
    try {
      const allMarks = await wordMarkService.getAll()
      const allWords = await wordService.getAll()
      const wordMap = {}
      allWords.forEach(w => { wordMap[w.id] = w })
      const wordIds = [...new Set(allMarks.map(m => m.wordId))]
      const markedRecords = wordIds.map(id => wordMap[id]).filter(Boolean)
      markedWords.value = dedupeByWord(markedRecords)
      await fetchArticleWords()
    } finally {
      loading.value = false
    }
  }

  function dedupeByWord(records) {
    const map = new Map()
    for (const record of records) {
      const existing = map.get(record.word)
      if (!existing || new Date(record.updatedAt) > new Date(existing.updatedAt)) {
        map.set(record.word, record)
      }
    }
    return [...map.values()]
  }

  async function fetchArticleWords() {
    const allArticles = await articleService.getAll()
    const wordArticleMap = await wordMarkService.getAllWordArticleMap()
    const allWords = await wordService.getAll()
    const wordMap = {}
    allWords.forEach(w => { wordMap[w.id] = w })

    const result = {}
    for (const article of allArticles) {
      const wordIds = [...new Set(wordArticleMap[article.id] || [])]
      const articleWords = wordIds.map(id => wordMap[id]).filter(Boolean)
      if (articleWords.length > 0) {
        result[article.id] = articleWords
      }
    }
    articleWordsMap.value = result
  }

  function getArticleWords(articleId) {
    return articleWordsMap.value[articleId] || []
  }

  async function getOrCreateWord(word, articleId) {
    return await wordService.getOrCreate(word, articleId)
  }

  async function updateWord(id, data) {
    const word = await wordService.update(id, data)
    const index = markedWords.value.findIndex(w => w.id === id)
    if (index !== -1) {
      markedWords.value[index] = word
    }
    return word
  }

  async function updateContextTranslation(wordId, articleId, occKey, translation) {
    return await contextTranslationService.set(wordId, articleId, occKey, translation)
  }

  async function toggleMark(wordId, articleId, occKey = '0') {
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
    return isNowMarked
  }

  async function deleteWord(id) {
    const record = await wordService.getById(id)
    if (!record) return
    await wordService.deleteBySpelling(record.word)
    markedWords.value = markedWords.value.filter(w => w.word !== record.word)
    await fetchArticleWords()
  }

  function exportArticleWordsTxt(articleId, title, selectedIds = []) {
    const words = articleWordsMap.value[articleId] || []
    let exportList = words
    if (selectedIds.length > 0) {
      exportList = words.filter(w => selectedIds.includes(w.id))
    }
    const content = exportList.map(w => w.word).join('\n')
    const safeTitle = (title || 'article').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 30)
    downloadFile(content, `words_${safeTitle}_${formatDate()}.txt`, 'text/plain')
  }

  function exportSelectedWordsTxt(selectedIds) {
    const words = markedWords.value.filter(w => selectedIds.includes(w.id))
    const content = words.map(w => w.word).join('\n')
    downloadFile(content, `selected_words_${formatDate()}.txt`, 'text/plain')
  }

  async function exportArticle(articleId) {
    return await exportService.exportArticle(articleId)
  }

  async function exportArticleAndDownload(articleId, title) {
    const data = await exportService.exportArticle(articleId)
    const safeTitle = (title || 'article').replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_').substring(0, 30)
    downloadFile(JSON.stringify(data, null, 2), `article_${safeTitle}_${formatDate()}.json`)
  }

  async function importArticle(data) {
    const articleId = await exportService.importArticle(data)
    await fetchMarkedWords()
    return articleId
  }

  return {
    words,
    markedWords,
    loading,
    markedCount,
    articleWordsMap,
    fetchMarkedWords,
    getArticleWords,
    getOrCreateWord,
    updateWord,
    updateContextTranslation,
    toggleMark,
    deleteWord,
    exportArticleWordsTxt,
    exportSelectedWordsTxt,
    exportArticle,
    exportArticleAndDownload,
    importArticle
  }
})
