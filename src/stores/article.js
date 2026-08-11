import { defineStore } from 'pinia'
import { ref } from 'vue'
import { articleService } from '../services/db'

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
