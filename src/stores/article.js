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
    deleteArticle
  }
})
