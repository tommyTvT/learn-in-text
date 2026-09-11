import { defineStore } from 'pinia'
import { ref } from 'vue'
import { articleService } from '../services/db'
import { useWordStore } from './word'

export const useArticleStore = defineStore('article', () => {
  const articles = ref([])
  const currentArticle = ref(null)
  const loading = ref(false)

  async function fetchArticles() {
    loading.value = true
    try {
      articles.value = await articleService.getAll()
    } finally {
      loading.value = false
    }
  }

  async function fetchArticle(id) {
    loading.value = true
    try {
      currentArticle.value = await articleService.getById(id)
      return currentArticle.value
    } finally {
      loading.value = false
    }
  }

  async function createArticle(data) {
    const article = await articleService.create(data)
    articles.value.unshift(article)
    return article
  }

  async function updateArticle(id, data) {
    const article = await articleService.update(id, data)
    const index = articles.value.findIndex(a => a.id === id)
    if (index !== -1) {
      articles.value[index] = article
    }
    if (currentArticle.value?.id === id) {
      currentArticle.value = article
    }
    return article
  }

  /**
   * 拖拽排序：把文章从 fromIndex 移动到 toIndex，并持久化整体顺序。
   */
  async function moveArticle(fromIndex, toIndex) {
    const list = articles.value.slice()
    const [moved] = list.splice(fromIndex, 1)
    list.splice(toIndex, 0, moved)
    list.forEach((a, i) => { a.sortOrder = i })
    articles.value = list
    await articleService.updateSortOrders(list.map(a => a.id))
  }

  async function deleteArticle(id) {
    await articleService.delete(id)
    articles.value = articles.value.filter(a => a.id !== id)
    if (currentArticle.value?.id === id) {
      currentArticle.value = null
    }
    // DB 层级联删除了该文章的全部单词与标记，必须同步失效词库内存缓存
    // （markedWords/articleWordsMap），否则词库页仍显示已删文章的幽灵单词与虚高计数。
    // 与 toggleMark/deleteWord 的缓存失效方式保持一致（强制重载）
    await useWordStore().fetchMarkedWords(true)
  }

  return {
    articles,
    currentArticle,
    loading,
    fetchArticles,
    fetchArticle,
    createArticle,
    updateArticle,
    moveArticle,
    deleteArticle
  }
})
