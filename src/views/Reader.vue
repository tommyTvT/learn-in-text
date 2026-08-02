<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter, onBeforeRouteLeave } from 'vue-router'
import { useArticleStore } from '../stores/article'
import { useWordStore } from '../stores/word'
import { parseArticle, getWordContext } from '../services/parser'
import { wordMarkService, contextTranslationService } from '../services/db'
import { generateWordBasicInfo, generateWordContextTranslation, batchGenerateWords } from '../services/ai'
import WordPopup from '../components/Word/WordPopup.vue'

const route = useRoute()
const router = useRouter()
const articleStore = useArticleStore()
const wordStore = useWordStore()

const article = ref(null)
const parsedContent = ref(null)
const selectedWord = ref(null)
const wordPosition = ref({ x: 0, y: 0 })
const wordInfo = ref(null)
const loadingWord = ref(false)
const loadingContext = ref(false)
const articleWords = ref([])
const crossMarkedWords = ref(new Set())
const saving = ref(false)

const localMarks = ref(new Set())
const dbMarks = ref(new Set())
const contextTranslation = ref(null)
const contextError = ref(false)

const batchProgress = ref({ completed: 0, total: 0, running: false, error: null })

const articleId = computed(() => parseInt(route.params.id))
const fromVocab = computed(() => route.query.fromVocab === '1')
const isManagement = computed(() => fromVocab.value)

const isDirty = computed(() => {
  if (localMarks.value.size !== dbMarks.value.size) return true
  for (const id of localMarks.value) {
    if (!dbMarks.value.has(id)) return true
  }
  return false
})

onBeforeRouteLeave((to, from, next) => {
  if (isDirty.value) {
    if (confirm('有未保存的标记变更，确定离开吗？')) {
      next()
    } else {
      next(false)
    }
  } else {
    next()
  }
})

onMounted(async () => {
  article.value = await articleStore.fetchArticle(articleId.value)
  if (!article.value) {
    alert('文章不存在')
    router.push('/')
    return
  }
  parsedContent.value = parseArticle(article.value.content)
  await loadArticleWords()
  if (isManagement.value) {
    const marks = await wordMarkService.getByArticle(articleId.value)
    const markedIds = new Set(marks.map(m => m.wordId))
    localMarks.value = markedIds
    dbMarks.value = new Set(markedIds)
  }
  await autoGenerateAllWords()
})

async function loadArticleWords() {
  const words = []
  for (const word of parsedContent.value.words) {
    const wordData = await wordStore.getOrCreateWord(word)
    words.push(wordData)
  }
  articleWords.value = words
}

async function saveMarks() {
  saving.value = true
  try {
    const toAdd = [...localMarks.value].filter(id => !dbMarks.value.has(id))
    const toRemove = [...dbMarks.value].filter(id => !localMarks.value.has(id))

    for (const wordId of toAdd) {
      await wordMarkService.add(wordId, articleId.value)
    }
    for (const wordId of toRemove) {
      await wordMarkService.remove(wordId, articleId.value)
    }

    dbMarks.value = new Set(localMarks.value)
    await loadArticleWords()
  } catch (error) {
    alert('保存失败: ' + error.message)
  } finally {
    saving.value = false
  }
}

async function handleWordClick(event, word) {
  event.preventDefault()
  const wordData = await wordStore.getOrCreateWord(word.toLowerCase())
  const isMarked = localMarks.value.has(wordData.id)
  const rect = event.target.getBoundingClientRect()
  wordPosition.value = {
    wordRect: {
      left: rect.left,
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      width: rect.width,
      height: rect.height
    }
  }
  selectedWord.value = word
  loadWordDetails(word)
  if (!isMarked) {
    toggleMark(word)
  }
}

async function handleWordRightClick(event, word) {
  event.preventDefault()
  await toggleMark(word)
}

let wordDetailRequestId = 0

async function loadWordDetails(word) {
  const requestId = ++wordDetailRequestId
  loadingContext.value = false
  contextTranslation.value = null
  contextError.value = false
  wordInfo.value = null
  try {
    const wordData = await wordStore.getOrCreateWord(word)
    const cached = await contextTranslationService.get(wordData.id, articleId.value).catch(() => null)
    if (requestId !== wordDetailRequestId) return
    wordInfo.value = wordData
    const cachedTranslation = cached?.translation || null
    contextTranslation.value = cachedTranslation
    if (!wordData.definitions?.length) {
      await generateBasicInfo(word)
    }
    if (!cachedTranslation) {
      loadContextTranslation(word, requestId)
    }
  } finally {
    if (requestId === wordDetailRequestId) {
      loadingWord.value = false
    }
  }
}

async function toggleMark(word) {
  const wordData = await wordStore.getOrCreateWord(word)
  const newLocalMarks = new Set(localMarks.value)
  const newCrossMarks = new Set(crossMarkedWords.value)

  if (newLocalMarks.has(wordData.id)) {
    newLocalMarks.delete(wordData.id)
    newCrossMarks.delete(wordData.word)
  } else {
    newLocalMarks.add(wordData.id)
    const otherArticleIds = await wordMarkService.getMarkedArticleIds(wordData.id)
    if (otherArticleIds.length > 0) {
      newCrossMarks.add(wordData.word)
    }
  }

  localMarks.value = newLocalMarks
  crossMarkedWords.value = newCrossMarks
}

async function generateBasicInfo(word) {
  loadingWord.value = true
  try {
    const info = await generateWordBasicInfo(word)
    const wordData = await wordStore.getOrCreateWord(word)
    await wordStore.updateWord(wordData.id, {
      phonetic: info.phonetic || wordData.phonetic,
      definitions: info.definitions || wordData.definitions,
      source: 'ai'
    })
    wordInfo.value = await wordStore.getOrCreateWord(word)
  } catch (error) {
    alert('AI生成失败: ' + error.message)
  } finally {
    loadingWord.value = false
  }
}

async function loadContextTranslation(word, requestId) {
  const wordData = await wordStore.getOrCreateWord(word)
  const existing = await contextTranslationService.get(wordData.id, articleId.value).catch(() => null)
  if (requestId !== wordDetailRequestId) return
  if (existing?.translation) {
    contextTranslation.value = existing.translation
    return
  }
  if (existing) {
    await contextTranslationService.set(wordData.id, articleId.value, '')
  }

  contextError.value = false
  loadingContext.value = true
  try {
    const context = getWordContext(article.value.content, word)
    const result = await generateWordContextTranslation(word, context)
    if (requestId !== wordDetailRequestId) return
    if (!result.contextTranslation) {
      throw new Error('翻译结果为空')
    }
    await wordStore.updateContextTranslation(wordData.id, articleId.value, result.contextTranslation)
    contextTranslation.value = result.contextTranslation
  } catch (error) {
    console.error('上下文翻译生成失败:', error.message)
    if (requestId === wordDetailRequestId) {
      contextError.value = true
    }
  } finally {
    if (requestId === wordDetailRequestId) {
      loadingContext.value = false
    }
  }
}

function retryContextTranslation() {
  if (!selectedWord.value) return
  loadContextTranslation(selectedWord.value, wordDetailRequestId)
}

function closePopup() {
  selectedWord.value = null
  wordInfo.value = null
  contextTranslation.value = null
  contextError.value = false
}

async function autoGenerateAllWords() {
  const wordsToGenerate = articleWords.value.filter(w => !w.definitions?.length)
  if (wordsToGenerate.length === 0) {
    return
  }

  const words = wordsToGenerate.map(w => w.word)

  batchProgress.value = { completed: 0, total: words.length, running: true, error: null }

  try {
    const results = await batchGenerateWords(words, (completed, total, error) => {
      batchProgress.value.completed = completed
      batchProgress.value.total = total
      if (error) {
        batchProgress.value.error = error
      }
    })

    for (const result of results) {
      if (result.success) {
        const wordData = await wordStore.getOrCreateWord(result.word)
        await wordStore.updateWord(wordData.id, {
          phonetic: result.info.phonetic || wordData.phonetic,
          definitions: result.info.definitions || wordData.definitions,
          source: 'ai'
        })
      }
    }

    await loadArticleWords()
  } catch (error) {
    console.error('批量生成失败:', error.message)
  } finally {
    batchProgress.value.running = false
  }
}

function getWordHighlight(word) {
  const lower = word.toLowerCase()
  const wordData = articleWords.value.find(w => w.word === lower)
  const wordId = wordData?.id

  if (wordId && localMarks.value.has(wordId)) {
    if (crossMarkedWords.value.has(lower)) {
      return 'bg-yellow-300 dark:bg-yellow-500/80 text-yellow-900 dark:text-yellow-950 underline decoration-red-500 decoration-2'
    }
    return 'bg-yellow-300 dark:bg-yellow-500/80 text-yellow-900 dark:text-yellow-950'
  }

  return ''
}

function getWordHighlightHover(word) {
  return 'hover:bg-yellow-200 dark:hover:bg-yellow-500/40'
}

function renderContent() {
  if (!article.value) return []
  const paragraphs = parseArticle(article.value.content).paragraphs
  const parts = []
  const wordRegex = /[a-zA-Z]+(?:'[a-zA-Z]+)?/g
  let match

  for (const paragraph of paragraphs) {
    const paragraphParts = []
    let lastIndex = 0

    while ((match = wordRegex.exec(paragraph)) !== null) {
      const word = match[0].toLowerCase()
      if (word.length > 1) {
        if (match.index > lastIndex) {
          paragraphParts.push({
            type: 'text',
            content: paragraph.substring(lastIndex, match.index)
          })
        }
        paragraphParts.push({
          type: 'word',
          content: match[0],
          word: word
        })
        lastIndex = match.index + match[0].length
      }
    }

    if (lastIndex < paragraph.length) {
      paragraphParts.push({
        type: 'text',
        content: paragraph.substring(lastIndex)
      })
    }

    parts.push(paragraphParts)
  }

  return parts
}
</script>

<template>
  <div v-if="article">
    <div class="mb-6">
      <button
        @click="router.push('/')"
        class="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 flex items-center"
      >
        <svg class="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
        </svg>
        返回
      </button>
    </div>

    <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-8">
      <div class="flex items-center gap-3 mb-6">
        <h1 class="text-2xl font-bold text-gray-900 dark:text-neutral-100">{{ article.title }}</h1>
        <span v-if="isManagement" class="px-2 py-0.5 text-xs bg-blue-100 dark:bg-neutral-800 text-blue-700 dark:text-neutral-300 rounded-full">📖 管理模式</span>
        <span v-else class="px-2 py-0.5 text-xs bg-green-100 dark:bg-neutral-800 text-green-700 dark:text-neutral-300 rounded-full">📖 学习模式</span>
        <button
          v-if="isDirty"
          @click="saveMarks"
          :disabled="saving"
          class="ml-auto px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {{ saving ? '保存中...' : '💾 保存标记' }}
        </button>
        <span v-else-if="localMarks.size > 0" class="ml-auto text-xs text-gray-400 dark:text-neutral-500">已保存</span>
      </div>

      <div v-if="batchProgress.running" class="mb-4">
        <div class="flex justify-between text-sm text-gray-600 dark:text-neutral-400 mb-1">
          <span>生成进度</span>
          <span>{{ batchProgress.completed }} / {{ batchProgress.total }}</span>
        </div>
        <div class="w-full bg-gray-200 dark:bg-neutral-700 rounded-full h-2">
          <div
            class="bg-purple-600 h-2 rounded-full transition-all duration-300"
            :style="{ width: `${(batchProgress.completed / batchProgress.total) * 100}%` }"
          ></div>
        </div>
        <p v-if="batchProgress.error" class="text-xs text-red-500 dark:text-red-400 mt-1">{{ batchProgress.error }}</p>
      </div>

      <div class="max-w-none leading-relaxed text-gray-800 dark:text-neutral-200">
        <template v-for="(paragraphParts, paragraphIndex) in renderContent()" :key="paragraphIndex">
          <p class="mb-4 last:mb-0">
            <template v-for="(part, index) in paragraphParts" :key="index">
              <span v-if="part.type === 'text'">{{ part.content }}</span>
              <span
                v-else
                @click="handleWordClick($event, part.word)"
                @contextmenu="handleWordRightClick($event, part.word)"
                :class="[
                  'cursor-pointer transition-colors rounded px-0.5',
                  getWordHighlightHover(part.word),
                  getWordHighlight(part.word)
                ]"
              >{{ part.content }}</span>
            </template>
          </p>
        </template>
      </div>
    </div>

    <WordPopup
      v-if="selectedWord"
      :key="selectedWord"
      :word="selectedWord"
      :word-info="wordInfo"
      :position="wordPosition"
      :loading="loadingWord"
      :loading-context="loadingContext"
      :context-translation="contextTranslation"
      :context-error="contextError"
      :article-id="articleId"
      @close="closePopup"
      @auto-generate="generateBasicInfo"
      @retry-context="retryContextTranslation"
    />
  </div>

  <div v-else class="text-center py-12 text-gray-500 dark:text-neutral-400">
    加载中...
  </div>
</template>
