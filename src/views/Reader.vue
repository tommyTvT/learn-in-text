<script setup>
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useArticleStore } from '../stores/article'
import { useWordStore } from '../stores/word'
import { useSettingsStore } from '../stores/settings'
import { parseArticle, getWordContext, getWordSentenceWithContext, getSelectionContext, normalizeSelectionText } from '../services/parser'
import { wordMarkService, contextTranslationService, selectionTranslationService, selectionHash } from '../services/db'
import { generateWordBasicInfo, generateWordContextTranslation, batchGenerateWords, generateSelectionTranslation } from '../services/ai'
import WordPopup from '../components/Word/WordPopup.vue'
import SelectionPopup from '../components/Word/SelectionPopup.vue'
import SelectionChatModal from '../components/Word/SelectionChatModal.vue'
import EditArticleModal from '../components/Article/EditArticleModal.vue'

const route = useRoute()
const router = useRouter()
const articleStore = useArticleStore()
const wordStore = useWordStore()
const settingsStore = useSettingsStore()

const article = ref(null)
const parsedContent = ref(null)
const selectedWord = ref(null)
const selectedOccKey = ref(null)
const wordPosition = ref({ x: 0, y: 0 })
const wordInfo = ref(null)
const loadingWord = ref(false)
const loadingContext = ref(false)
const articleWords = ref([])

const localMarks = ref(new Set())
const activeOccKey = ref(null)
const contextTranslation = ref(null)
const contextError = ref(false)

const isViewMode = computed(() => route.query.mode === 'view')
const stickyHighlights = ref(new Map())

const showEditModal = ref(false)

// ---- 划词翻译（选区翻译 + 追问解析） ----
const articleContentRef = ref(null)
const showSelectionBubble = ref(false)
const selectionBubbleStyle = ref({ left: '-9999px', top: '-9999px' })
const selectionText = ref('')
const selectionRect = ref(null)
const selectionContext = ref('')
const showSelectionPopup = ref(false)
const selectionTranslation = ref(null)
const loadingSelection = ref(false)
const selectionError = ref(false)
let selectionRequestId = 0
const showSelectionChat = ref(false)
let selectionChangeTimer = null

async function onArticleSaved() {
  article.value = await articleStore.fetchArticle(article.value.id)
}

const batchProgress = ref({ completed: 0, total: 0, running: false, error: null })

const articleId = computed(() => parseInt(route.params.id))

let autoGenerateTimer = null

onMounted(async () => {
  article.value = await articleStore.fetchArticle(articleId.value)
  if (!article.value) {
    alert('文章不存在')
    router.push('/')
    return
  }
  parsedContent.value = parseArticle(article.value.content)
  await loadArticleWords()
  const marks = await wordMarkService.getByArticle(articleId.value)
  localMarks.value = new Set(marks.map(m => m.occKey))
  // 延迟批量生成词义，等首屏渲染完成后再发起 AI 请求，避免进入页面瞬间卡顿
  autoGenerateTimer = setTimeout(() => autoGenerateAllWords(), 600)
  // 划词翻译：PC 拖选/双击（mouseup）与移动端长按选择（selectionchange 防抖）
  document.addEventListener('mouseup', handleDocumentMouseup)
  document.addEventListener('selectionchange', handleSelectionChange)
})

onUnmounted(() => {
  if (autoGenerateTimer) {
    clearTimeout(autoGenerateTimer)
    autoGenerateTimer = null
  }
  document.removeEventListener('mouseup', handleDocumentMouseup)
  document.removeEventListener('selectionchange', handleSelectionChange)
  if (selectionChangeTimer) {
    clearTimeout(selectionChangeTimer)
    selectionChangeTimer = null
  }
})

async function loadArticleWords() {
  articleWords.value = await wordStore.getOrCreateMany(parsedContent.value.words, articleId.value)
}

function buildOccKeyWordMap() {
  const map = new Map()
  for (const paragraphParts of renderedParagraphs.value) {
    for (const part of paragraphParts) {
      if (part.type === 'word' && !map.has(part.occKey)) {
        const wordData = articleWords.value.find(w => w.word === part.word)
        if (wordData) {
          map.set(part.occKey, wordData.id)
        }
      }
    }
  }
  return map
}

function getMarkedWordIdsInArticle() {
  const wordIds = new Set()
  const occKeyWordMap = buildOccKeyWordMap()
  for (const occKey of localMarks.value) {
    const wordId = occKeyWordMap.get(occKey)
    if (wordId) {
      wordIds.add(wordId)
    }
  }
  return wordIds
}

async function handleWordClick(event, part) {
  event.preventDefault()

  // 拖选/双击产生的非空选区走划词翻译入口，不触发单词学习标记
  if (window.getSelection()?.toString()?.trim()) return

  if (!isViewMode.value) {
    const sticky = stickyHighlights.value.get(part.occKey)
    if (sticky === 'red') {
      stickyHighlights.value.delete(part.occKey)
      closePopup()
      return
    }
    if (sticky === 'yellow') {
      await wordMarkService.remove(articleId.value, part.occKey)
      const newLocalMarks = new Set(localMarks.value)
      newLocalMarks.delete(part.occKey)
      localMarks.value = newLocalMarks
      stickyHighlights.value.delete(part.occKey)
      closePopup()
      return
    }
    const color = await judgeWordColor(part)
    const wordData = await wordStore.getOrCreateWord(part.word, articleId.value)
    await wordMarkService.add(wordData.id, articleId.value, part.occKey)
    const newLocalMarks = new Set(localMarks.value)
    newLocalMarks.add(part.occKey)
    localMarks.value = newLocalMarks
    stickyHighlights.value.set(part.occKey, color)
    openPopup(event, part)
    return
  }

  if (localMarks.value.has(part.occKey)) {
    await toggleMark(part)
    closePopup()
    return
  }

  const wordData = await wordStore.getOrCreateWord(part.word, articleId.value)

  const newLocalMarks = new Set(localMarks.value)
  newLocalMarks.add(part.occKey)
  localMarks.value = newLocalMarks
  await wordMarkService.add(wordData.id, articleId.value, part.occKey)

  activeOccKey.value = part.occKey

  openPopup(event, part)
}

async function judgeWordColor(part) {
  if (localMarks.value.has(part.occKey)) return 'red'
  const wordData = await wordStore.getOrCreateWord(part.word, articleId.value)
  const markedHereBefore = getMarkedWordIdsInArticle().has(wordData.id)
  const otherArticleIds = await wordMarkService.getMarkedArticleIdsByWord(part.word, articleId.value)
  const markedElsewhere = otherArticleIds.length > 0
  return (markedHereBefore || markedElsewhere) ? 'red' : 'yellow'
}

function openPopup(event, part) {
  // 单词弹窗与划词翻译互斥
  showSelectionBubble.value = false
  if (showSelectionPopup.value) closeSelectionPopup()

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
  selectedWord.value = part.word
  selectedOccKey.value = part.occKey
  loadWordDetails(part.word, part.occKey)
}

let wordDetailRequestId = 0

function getOccurrence(occKey) {
  const index = occKey.lastIndexOf(':')
  return index >= 0 ? parseInt(occKey.slice(index + 1)) || 0 : 0
}

async function loadWordDetails(word, occKey) {
  const requestId = ++wordDetailRequestId
  loadingContext.value = false
  contextTranslation.value = null
  contextError.value = false
  wordInfo.value = null
  try {
    const wordData = await wordStore.getOrCreateWord(word, articleId.value)
    const cached = await contextTranslationService.get(wordData.id, articleId.value, occKey).catch(() => null)
    if (requestId !== wordDetailRequestId) return
    wordInfo.value = wordData
    const cachedTranslation = cached?.translation || null
    contextTranslation.value = cachedTranslation
    if (!wordData.definitions?.length) {
      await generateBasicInfo(word)
    }
    if (!cachedTranslation) {
      loadContextTranslation(word, occKey, requestId)
    }
  } finally {
    if (requestId === wordDetailRequestId) {
      loadingWord.value = false
    }
  }
}

async function toggleMark(part) {
  const newLocalMarks = new Set(localMarks.value)
  const wordData = await wordStore.getOrCreateWord(part.word, articleId.value)
  let isNowMarked = false
  if (newLocalMarks.has(part.occKey)) {
    newLocalMarks.delete(part.occKey)
  } else {
    newLocalMarks.add(part.occKey)
    isNowMarked = true
  }
  localMarks.value = newLocalMarks
  if (isNowMarked) {
    await wordMarkService.add(wordData.id, articleId.value, part.occKey)
  } else {
    await wordMarkService.remove(articleId.value, part.occKey)
  }
  if (activeOccKey.value === part.occKey) {
    activeOccKey.value = null
  }
}

async function generateBasicInfo(word) {
  loadingWord.value = true
  try {
    const context = getWordContext(article.value.content, word, 50)
    const info = await generateWordBasicInfo(word, context)
    const wordData = await wordStore.getOrCreateWord(word, articleId.value)
    await wordStore.updateWord(wordData.id, {
      definitions: info.definitions || wordData.definitions,
      source: 'ai'
    })
    wordInfo.value = await wordStore.getOrCreateWord(word, articleId.value)
  } catch (error) {
    alert('AI生成失败: ' + error.message)
  } finally {
    loadingWord.value = false
  }
}

async function loadContextTranslation(word, occKey, requestId) {
  const wordData = await wordStore.getOrCreateWord(word, articleId.value)
  const existing = await contextTranslationService.get(wordData.id, articleId.value, occKey).catch(() => null)
  if (requestId !== wordDetailRequestId) return
  if (existing?.translation) {
    contextTranslation.value = existing.translation
    return
  }
  if (existing) {
    await contextTranslationService.set(wordData.id, articleId.value, occKey, '')
  }

  contextError.value = false
  loadingContext.value = true
  try {
    // sentence：目标词所在单句（限定翻译输出范围）；context：前后各多带一句，供 AI 理解语境
    const { sentence, context } = getWordSentenceWithContext(article.value.content, word, getOccurrence(occKey))
    const result = await generateWordContextTranslation(word, sentence, context)
    if (requestId !== wordDetailRequestId) return
    if (!result.contextTranslation) {
      throw new Error('翻译结果为空')
    }
    await wordStore.updateContextTranslation(wordData.id, articleId.value, occKey, result.contextTranslation)
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
  loadContextTranslation(selectedWord.value, selectedOccKey.value, wordDetailRequestId)
}

function closePopup() {
  selectedWord.value = null
  selectedOccKey.value = null
  wordInfo.value = null
  contextTranslation.value = null
  contextError.value = false
  activeOccKey.value = null
}

// ---- 划词翻译 ----

function isInsideArticleContent(node) {
  return !!(articleContentRef.value && node && articleContentRef.value.contains(node))
}

// 校验当前选区：仅文章内容区内、长度 2~1000 字符的选区才触发划词翻译
function getValidSelection() {
  const sel = window.getSelection?.()
  if (!sel || sel.rangeCount === 0) return null
  const text = String(sel.toString() || '').trim()
  if (text.length < 2 || text.length > 1000) return null
  if (!isInsideArticleContent(sel.anchorNode) || !isInsideArticleContent(sel.focusNode)) return null
  return { sel, text }
}

// 气泡定位：选区下方优先（避开上方系统选择菜单），取不到选区矩形时贴屏幕底部
function positionBubble(rect) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const pad = 8
  const bubbleWidth = 44
  let left = rect ? rect.left + rect.width / 2 - bubbleWidth / 2 : vw / 2 - bubbleWidth / 2
  left = Math.max(pad, Math.min(left, vw - bubbleWidth - pad))
  let top
  if (rect && rect.bottom + 40 <= vh) {
    top = rect.bottom + 8
  } else if (rect && rect.top > 48) {
    top = rect.top - 40
  } else {
    top = vh - 64
  }
  selectionBubbleStyle.value = { left: `${left}px`, top: `${top}px` }
}

function handleSelectionDetected() {
  if (!settingsStore.enableSelectionTranslation) return
  if (showSelectionPopup.value || showSelectionChat.value) return
  const found = getValidSelection()
  if (!found) {
    showSelectionBubble.value = false
    return
  }
  // 双击选词时单词弹窗可能已先弹出，检测到选区即切换为划词入口
  if (selectedWord.value) closePopup()
  let rect = null
  try {
    rect = found.sel.getRangeAt(0).getBoundingClientRect()
  } catch { /* 部分移动端浏览器取不到矩形，气泡贴底部 */ }
  positionBubble(rect)
  showSelectionBubble.value = true
}

function handleDocumentMouseup(event) {
  // 点击气泡自身不处理（气泡有自己的点击逻辑，避免误收起）
  if (event?.target?.closest?.('.selection-bubble')) return
  handleSelectionDetected()
}

// 移动端长按选择走 selectionchange，防抖 250ms
function handleSelectionChange() {
  if (selectionChangeTimer) clearTimeout(selectionChangeTimer)
  selectionChangeTimer = setTimeout(() => {
    selectionChangeTimer = null
    handleSelectionDetected()
  }, 250)
}

function handleBubbleClick() {
  const found = getValidSelection()
  if (!found) {
    showSelectionBubble.value = false
    return
  }
  let rect = null
  try {
    rect = found.sel.getRangeAt(0).getBoundingClientRect()
  } catch { /* 取不到矩形时弹窗退化为视口中心定位 */ }
  openSelectionPopup(found.text, rect)
  window.getSelection().removeAllRanges()
}

function openSelectionPopup(text, rect) {
  closePopup()
  showSelectionBubble.value = false
  selectionText.value = text
  selectionRect.value = rect
    ? {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height
      }
    : null
  selectionContext.value = ''
  selectionTranslation.value = null
  selectionError.value = false
  showSelectionPopup.value = true
  loadSelectionTranslation(text)
}

async function loadSelectionTranslation(text) {
  const requestId = ++selectionRequestId
  const hash = selectionHash(text)
  loadingSelection.value = true
  selectionError.value = false
  selectionTranslation.value = null
  try {
    const cached = await selectionTranslationService.get(articleId.value, hash).catch(() => null)
    if (requestId !== selectionRequestId) return
    // 命中缓存：规范化后文本一致才使用（防哈希碰撞）
    if (cached?.translation && normalizeSelectionText(cached.text) === normalizeSelectionText(text)) {
      selectionTranslation.value = cached.translation
      if (!selectionContext.value) {
        selectionContext.value = getSelectionContext(article.value.content, text)
      }
      return
    }

    const context = getSelectionContext(article.value.content, text)
    if (requestId !== selectionRequestId) return
    selectionContext.value = context

    const result = await generateSelectionTranslation(text, context)
    if (requestId !== selectionRequestId) return
    if (!result.translation) {
      throw new Error('翻译结果为空')
    }
    await selectionTranslationService.set(articleId.value, hash, text, result.translation)
    selectionTranslation.value = result.translation
  } catch (error) {
    console.error('划词翻译生成失败:', error.message)
    if (requestId === selectionRequestId) {
      selectionError.value = true
    }
  } finally {
    if (requestId === selectionRequestId) {
      loadingSelection.value = false
    }
  }
}

function retrySelectionTranslation() {
  if (!selectionText.value) return
  loadSelectionTranslation(selectionText.value)
}

function closeSelectionPopup() {
  showSelectionPopup.value = false
  selectionTranslation.value = null
  selectionError.value = false
  loadingSelection.value = false
}

// 追问解析：关闭翻译弹窗，打开对话窗口（对话历史仅会话内存态，关闭即清）
function openSelectionChat() {
  if (!selectionContext.value && selectionText.value && article.value) {
    selectionContext.value = getSelectionContext(article.value.content, selectionText.value)
  }
  showSelectionPopup.value = false
  showSelectionBubble.value = false
  showSelectionChat.value = true
}

function closeSelectionChat() {
  showSelectionChat.value = false
}

async function autoGenerateAllWords() {
  const wordsToGenerate = articleWords.value.filter(w => !w.definitions?.length)
  if (wordsToGenerate.length === 0) {
    return
  }

  const words = wordsToGenerate.map(w => ({
    word: w.word,
    context: getWordContext(article.value.content, w.word, 50)
  }))

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
        const wordData = await wordStore.getOrCreateWord(result.word, articleId.value)
        await wordStore.updateWord(wordData.id, {
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

function getWordHighlight(part) {
  if (isViewMode.value) {
    if (localMarks.value.has(part.occKey)) {
      return 'bg-yellow-300 dark:bg-yellow-500/80 text-yellow-900 dark:text-yellow-950'
    }
    return ''
  }
  const sticky = stickyHighlights.value.get(part.occKey)
  if (sticky === 'red') {
    return 'bg-red-300 dark:bg-red-500/80 text-red-900 dark:text-red-950'
  }
  if (sticky === 'yellow') {
    return 'bg-yellow-300 dark:bg-yellow-500/80 text-yellow-900 dark:text-yellow-950'
  }
  return ''
}

function getWordHighlightHover(part) {
  if (isViewMode.value) {
    return 'hover:bg-yellow-200 dark:hover:bg-yellow-500/40'
  }
  const sticky = stickyHighlights.value.get(part.occKey)
  if (sticky === 'red') {
    return 'hover:bg-red-200 dark:hover:bg-red-500/40'
  }
  if (sticky === 'yellow') {
    return 'hover:bg-yellow-200 dark:hover:bg-yellow-500/40'
  }
  return 'hover:bg-gray-100 dark:hover:bg-neutral-800'
}

const renderedParagraphs = computed(() => {
  if (!article.value) return []
  const paragraphs = parseArticle(article.value.content).paragraphs
  const parts = []
  const wordRegex = /[a-zA-Z]+(?:'[a-zA-Z]+)?/g
  const occCounts = {}
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
        const count = occCounts[word] || 0
        occCounts[word] = count + 1
        paragraphParts.push({
          type: 'word',
          content: match[0],
          word: word,
          occKey: `${word}:${count}`
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
})
</script>

<template>
  <div v-if="article">
    <div class="mb-4">
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

    <div class="bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-4 sm:p-6">
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <h1 class="text-lg sm:text-xl font-bold text-gray-900 dark:text-neutral-100">{{ article.title }}</h1>
        <button
          @click="showEditModal = true"
          class="text-gray-400 hover:text-blue-500"
          title="编辑文章"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
        </button>
        <span v-if="!isViewMode" class="px-2 py-0.5 text-xs bg-green-100 dark:bg-neutral-800 text-green-700 dark:text-neutral-300 rounded-full">📖 学习模式</span>
        <span v-else class="px-2 py-0.5 text-xs bg-purple-100 dark:bg-neutral-800 text-purple-700 dark:text-neutral-300 rounded-full">📚 管理模式</span>
        <span v-if="isViewMode && localMarks.size > 0" class="ml-auto text-xs text-gray-400 dark:text-neutral-500">已标记 {{ localMarks.size }} 处</span>
      </div>

      <p v-if="article.description" class="text-sm text-gray-500 dark:text-neutral-400 -mt-2 mb-5">{{ article.description }}</p>

      <p v-if="!isViewMode" class="text-xs text-gray-400 dark:text-neutral-500 -mt-2 mb-5">点击单词学习:之前标记过的会标红并记入当前文章,陌生的会加入词库并标黄。拖选文字可翻译词句，译文下方可追问语法解析。</p>

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

      <div ref="articleContentRef" class="max-w-none leading-relaxed text-gray-800 dark:text-neutral-200">
        <template v-for="(paragraphParts, paragraphIndex) in renderedParagraphs" :key="paragraphIndex">
          <p class="mb-4 last:mb-0">
            <template v-for="(part, index) in paragraphParts" :key="index">
              <span v-if="part.type === 'text'">{{ part.content }}</span>
              <span
                v-else
                @click="handleWordClick($event, part)"
                :class="[
                  'cursor-pointer transition-colors rounded px-0.5',
                  getWordHighlightHover(part),
                  getWordHighlight(part)
                ]"
              >{{ part.content }}</span>
            </template>
          </p>
        </template>
      </div>
    </div>

    <EditArticleModal
      v-if="showEditModal"
      :article="article"
      @close="showEditModal = false"
      @saved="onArticleSaved"
    />

    <WordPopup
      v-if="selectedWord"
      :key="`${selectedWord}:${selectedOccKey}`"
      :word="selectedWord"
      :word-info="wordInfo"
      :position="wordPosition"
      :loading="loadingWord"
      :loading-context="loadingContext"
      :context-translation="contextTranslation"
      :context-error="contextError"
      :article-id="articleId"
      :is-marked="activeOccKey ? localMarks.has(activeOccKey) : false"
      @close="closePopup"
      @auto-generate="generateBasicInfo"
      @retry-context="retryContextTranslation"
    />

    <!-- 划词翻译气泡 -->
    <button
      v-if="showSelectionBubble"
      class="selection-bubble fixed z-40 px-3 py-1 rounded-full bg-blue-600 text-white text-sm shadow-lg hover:bg-blue-700 select-none"
      :style="selectionBubbleStyle"
      @mousedown.prevent
      @touchstart.prevent="handleBubbleClick"
      @click="handleBubbleClick"
    >译</button>

    <SelectionPopup
      v-if="showSelectionPopup"
      :text="selectionText"
      :translation="selectionTranslation"
      :loading="loadingSelection"
      :error="selectionError"
      :position="selectionRect"
      @close="closeSelectionPopup"
      @retry="retrySelectionTranslation"
      @ask="openSelectionChat"
    />

    <SelectionChatModal
      v-if="showSelectionChat"
      :text="selectionText"
      :context="selectionContext"
      @close="closeSelectionChat"
    />
  </div>

  <div v-else class="text-center py-12 text-gray-500 dark:text-neutral-400">
    加载中...
  </div>
</template>
