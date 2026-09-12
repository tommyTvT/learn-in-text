<script setup>
import { ref, onMounted, onUnmounted, computed, nextTick } from 'vue'
import { useRoute, useRouter, usePageRoute } from '../../composables/routerShim'
import PageLayout from '../../components/Common/PageLayout.vue'
import { useArticleStore } from '../../stores/article'
import { useWordStore } from '../../stores/word'
import { useSettingsStore } from '../../stores/settings'
import { parseArticle, getWordContext, getWordSentenceWithContext, groupWordsBySentence, getSelectionContext, normalizeSelectionText } from '../../services/parser'
import { wordMarkService, contextTranslationService, selectionTranslationService, selectionHash } from '../../services/db'
import { generateWordBasicInfo, generateWordContextTranslation, batchGenerateWords, generateSelectionTranslation } from '../../services/ai'
import { speak } from '../../services/tts'
import WordPopup from '../../components/Word/WordPopup.vue'
import SelectionPopup from '../../components/Word/SelectionPopup.vue'
import SelectionChatModal from '../../components/Word/SelectionChatModal.vue'
import EditArticleModal from '../../components/Article/EditArticleModal.vue'
import { alert, confirmDialog } from '../../services/dialog'
import { errorText } from '../../services/errors'

const route = useRoute()
usePageRoute()
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
// 错误态存「可直接展示的原因文案」，空串表示无错误（原为布尔值，无法说明失败原因）
const contextError = ref('')

// 首屏加载失败原因（空串表示无错误）：读取异常时不再永久停在「加载中...」
const loadError = ref('')

const isViewMode = computed(() => route.query.mode === 'view')
const stickyHighlights = ref(new Map())

// ---- 阅读会话恢复（学习模式） ----
// 误退后重进，stickyHighlights 与滚动位置都在内存里丢掉了（标记数据本身在 wordMarks 表未丢）。
// 会话快照存 localStorage（纯 UI 恢复态，可随时丢弃，不进 Dexie 避免牵动云端同步）；
// 文章底部「结束本次阅读」删快照，之后不再保存（再次标记单词则视为新一轮阅读）
const SESSION_KEY_PREFIX = 'reading-session:'
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000 // 超过 7 天的会话不再提示恢复
const showSessionBanner = ref(false)
const sessionMarkedCount = ref(0)
const sessionProgress = ref(0)
const sessionEnded = ref(false)
let pendingSession = null // 横幅待确认的会话数据（未处理前不覆盖保存）
let scrollSaveTimer = null

const showEditModal = ref(false)

// ---- 划词翻译（选区翻译 + 追问解析） ----
const articleContentRef = ref(null)
const showSelectionBubble = ref(false)
const selectionBubbleStyle = ref({ left: '-9999px', top: '-9999px' })
const selectionText = ref('')
const selectionContext = ref('')
const showSelectionPopup = ref(false)
const selectionTranslation = ref(null)
const loadingSelection = ref(false)
const selectionError = ref('')
let selectionRequestId = 0
const showSelectionChat = ref(false)
let selectionChangeTimer = null

// ---- 移动端自定义划词（长按进入选择 → 滑动逐词扩展 → 边缘自动跟随滚动） ----
// 手机上原生文本选择几乎不可用（选择柄难控、系统菜单遮挡），触屏设备改为完全接管：
// 长按单词 500ms 进入选择 → 手指滑过的单词逐个纳入选区 → 滑到屏幕上下边缘时内容自动跟随滚动 →
// 松手后显示「解析」气泡 → 点击打开底部弹窗（与单词翻译一致的抽屉交互）
// 判定用 (hover: none) and (pointer: coarse)：纯触屏设备才接管，带鼠标的触屏本保持原生拖选
const isCoarsePointer = !!window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches
const customSelecting = ref(false)   // 选择会话进行中（长按已触发，手指未离开）
const customSelAnchor = ref(null)    // 选区锚点 { p, i }（长按落点）
const customSelFocus = ref(null)     // 选区焦点 { p, i }（当前手指位置）
const customSelectionText = ref('')  // 选区文本（气泡点击时使用）
let longPressTimer = null
let autoScrollRaf = null
let touchStartX = 0
let touchStartY = 0
let lastTouchX = 0
let lastTouchY = 0
let suppressClick = false // 长按选择结束后的短暂窗口内吞掉合成的 click，避免误开单词弹窗

async function onArticleSaved() {
  article.value = await articleStore.fetchArticle(article.value.id)
}

const batchProgress = ref({ completed: 0, total: 0, running: false, error: null, failedWords: [] })
let batchAbortController = null

// 取消批量生成：中止在途请求并立即复位进度。
// 已生成的词义不回滚；此后点击单词走按需生成，与正常流程一致
function cancelBatchGenerate() {
  if (batchAbortController) {
    batchAbortController.abort()
    batchAbortController = null
  }
  batchProgress.value.running = false
}

const articleId = computed(() => parseInt(route.params.id))

let autoGenerateTimer = null

onMounted(() => {
  // ⚠️ 事件监听与会话恢复必须同步注册在任何 await 之前。
  // 原实现把这些放在 await 链之后：数据加载抛错或耗时都会让 mouseup/selectionchange
  // 监听器漏注册，表现为「选区能高亮但划词气泡不出现」，而点击查词（模板 @click）不受影响。
  // 划词翻译：PC 拖选/双击（mouseup）与移动端长按选择（selectionchange 防抖）
  document.addEventListener('mouseup', handleDocumentMouseup)
  document.addEventListener('selectionchange', handleSelectionChange)
  // 移动端自定义划词手势：长按 + 滑动（touchmove 需非 passive 才能在选择模式接管滚动）
  document.addEventListener('touchstart', handleTouchStart, { passive: true })
  document.addEventListener('touchmove', handleTouchMove, { passive: false })
  document.addEventListener('touchend', handleTouchEnd)
  document.addEventListener('touchcancel', handleTouchEnd)
  document.addEventListener('contextmenu', handleContextMenu)
  // 阅读会话：进入时检测未完成会话（学习模式），滚动位置实时节流保存
  pendingSession = loadReadingSession()
  if (pendingSession) {
    sessionMarkedCount.value = pendingSession.occKeys?.length || 0
    sessionProgress.value = Math.round((pendingSession.scrollRatio || 0) * 100)
    showSessionBanner.value = true
  }
  window.addEventListener('scroll', handleScrollSave, { passive: true })

  initArticle()
})

/**
 * 首屏加载：抽成可重试函数。
 * 此前 fetchArticle 在 try 之外且 store 不捕获异常，读库失败时
 * onMounted 的 promise 被 reject、article 恒为 null，页面永久停在
 * 「加载中...」，既无提示也没有重试入口。
 */
async function initArticle() {
  loadError.value = ''
  try {
    article.value = await articleStore.fetchArticle(articleId.value)
  } catch (e) {
    console.error('[Reader] 文章读取失败:', e)
    loadError.value = errorText(e, '文章加载失败，请重试')
    return
  }
  if (!article.value) {
    await alert('文章不存在')
    router.push('/')
    return
  }
  parsedContent.value = parseArticle(article.value.content)
  // 数据加载失败不再静默中断（此前异常会让后续逻辑与自动词义生成全部跳过），
  // 打印出来便于定位；划词监听已提前注册，不受此处影响
  try {
    await loadArticleWords()
    const marks = await wordMarkService.getByArticle(articleId.value)
    localMarks.value = new Set(marks.map(m => m.occKey))
    // 学习模式不默认显示历史标记的红色高亮：点击单词时才标红，再点击取消（仅隐藏视觉，不删数据）
    // 延迟批量生成词义，等首屏渲染完成后再发起 AI 请求，避免进入页面瞬间卡顿；
    // 开启「按需生成词义」后不主动生成，仅在点击单词时生成该词（省去整篇的 AI 请求）
    if (!settingsStore.enableOnDemandWordGeneration) {
      autoGenerateTimer = setTimeout(() => autoGenerateAllWords(), 600)
    }
  } catch (error) {
    console.error('[Reader] 文章数据加载失败:', error)
  }
}

onUnmounted(() => {
  if (autoGenerateTimer) {
    clearTimeout(autoGenerateTimer)
    autoGenerateTimer = null
  }
  // 取消进行中的批量生成，避免离开页面后仍继续请求与写库
  if (batchAbortController) {
    batchAbortController.abort()
    batchAbortController = null
  }
  document.removeEventListener('mouseup', handleDocumentMouseup)
  document.removeEventListener('selectionchange', handleSelectionChange)
  document.removeEventListener('touchstart', handleTouchStart)
  document.removeEventListener('touchmove', handleTouchMove)
  document.removeEventListener('touchend', handleTouchEnd)
  document.removeEventListener('touchcancel', handleTouchEnd)
  document.removeEventListener('contextmenu', handleContextMenu)
  if (selectionChangeTimer) {
    clearTimeout(selectionChangeTimer)
    selectionChangeTimer = null
  }
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
  if (autoScrollRaf) {
    cancelAnimationFrame(autoScrollRaf)
    autoScrollRaf = null
  }
  // 阅读会话：移除监听并保存最终快照（误退场景靠这里 + 滚动节流兜底）
  window.removeEventListener('scroll', handleScrollSave)
  if (scrollSaveTimer) {
    clearTimeout(scrollSaveTimer)
    scrollSaveTimer = null
  }
  if (!sessionEnded.value) saveReadingSession()
})

async function loadArticleWords() {
  articleWords.value = await wordStore.getOrCreateMany(parsedContent.value.words, articleId.value)
}

// ---- 阅读会话恢复实现 ----

function sessionKey() {
  return `${SESSION_KEY_PREFIX}${articleId.value}`
}

function getScrollRatio() {
  const scrollable = document.documentElement.scrollHeight - window.innerHeight
  return scrollable > 0 ? window.scrollY / scrollable : 0
}

function saveReadingSession() {
  // 管理模式没有会话概念；横幅未处理前不覆盖待恢复数据
  if (isViewMode.value || pendingSession) return
  try {
    const occKeys = [...stickyHighlights.value.entries()]
    const scrollRatio = getScrollRatio()
    if (occKeys.length === 0 && scrollRatio < 0.01) {
      // 无标记且在顶部：不留会话（避免空记录反复弹横幅）
      localStorage.removeItem(sessionKey())
      return
    }
    localStorage.setItem(sessionKey(), JSON.stringify({
      occKeys,
      scrollRatio,
      lastActiveAt: Date.now()
    }))
  } catch {
    // 忽略存储异常（隐私模式/配额满）
  }
}

function loadReadingSession() {
  if (isViewMode.value) return null
  try {
    const raw = localStorage.getItem(sessionKey())
    if (!raw) return null
    const data = JSON.parse(raw)
    if (!data || Date.now() - (data.lastActiveAt || 0) > SESSION_TTL) {
      localStorage.removeItem(sessionKey())
      return null
    }
    return data
  } catch {
    return null
  }
}

// 滚动节流 500ms 保存；结束阅读后不再保存（等新一轮标记重新开启会话）
function handleScrollSave() {
  if (sessionEnded.value || scrollSaveTimer) return
  scrollSaveTimer = setTimeout(() => {
    scrollSaveTimer = null
    saveReadingSession()
  }, 500)
}

// 标记状态变更（新增/取消/隐藏高亮）后立即保存；用户直接开始标记视为放弃横幅恢复
function onStickyChange() {
  if (pendingSession) {
    pendingSession = null
    showSessionBanner.value = false
  }
  sessionEnded.value = false
  saveReadingSession()
}

async function resumeReading() {
  const data = pendingSession
  if (!data) return
  pendingSession = null
  showSessionBanner.value = false
  // 校验 occKey 仍存在于当前文章（文章可能被编辑过），失配的静默丢弃
  const validOccKeys = new Set()
  for (const paragraphParts of renderedParagraphs.value) {
    for (const part of paragraphParts) {
      if (part.type === 'word') validOccKeys.add(part.occKey)
    }
  }
  stickyHighlights.value = new Map(
    (data.occKeys || []).filter(([occKey]) => validOccKeys.has(occKey))
  )
  if (data.scrollRatio > 0) {
    await nextTick()
    const scrollable = document.documentElement.scrollHeight - window.innerHeight
    if (scrollable > 0) window.scrollTo(0, data.scrollRatio * scrollable)
  }
  saveReadingSession()
}

function discardReadingSession() {
  pendingSession = null
  showSessionBanner.value = false
  try { localStorage.removeItem(sessionKey()) } catch { /* 忽略 */ }
}

function endReadingSession() {
  sessionEnded.value = true
  discardReadingSession()
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

// 双击选词回滚：双击的第一次 click 会先走单词标记逻辑（静默入库+标黄+弹窗），
// 第二次 click 建立选区后才切换到划词翻译入口。双击时间窗内且选区文本与
// 刚标记的词一致时，撤销这次误标记，避免"想双击划词翻译却被标记"
let lastClickAddedMark = null // { occKey, word, color, time }

async function handleWordClick(event, part) {
  event.preventDefault()

  // 移动端长按选择刚结束的短暂窗口内吞掉合成 click，避免误开单词弹窗
  if (suppressClick) return

  // 批量生成词义期间禁止点击单词：此时词库数据尚未就绪，交互会产生并发写库竞态
  if (batchProgress.value.running) return

  // 移动端自定义划词选区存在时：点单词先清选区（不触发单词学习），再次点击恢复正常
  if (customSelectionText.value) {
    clearCustomSelection()
    showSelectionBubble.value = false
    return
  }

  // 拖选/双击产生的非空选区走划词翻译入口，不触发单词学习标记；
  // 但仅当选区实际落在文章内容区内才视为划词意图——弹窗内残留选区（弹窗卸载后
  // 浏览器不会自动重置 Selection，toString() 仍返回非空）会静默拦截单词点击，
  // 表现为黄色标记无法取消，遇到时清除残留选区并继续处理
  const sel = window.getSelection()
  if (sel?.toString()?.trim()) {
    if (isInsideArticleContent(sel.anchorNode) && isInsideArticleContent(sel.focusNode)) return
    sel.removeAllRanges()
  }

  if (!isViewMode.value) {
    const sticky = stickyHighlights.value.get(part.occKey)
    // 红色 = 之前就存在的历史标记：点击仅隐藏本次会话的视觉高亮，不删除数据库记录；
    // 如需真正删除标记，请切换到管理模式点击单词取消
    if (sticky === 'red') {
      stickyHighlights.value.delete(part.occKey)
      onStickyChange()
      closePopup()
      return
    }
    // 黄色 = 本次学习中新增的标记：点击取消并删除数据库记录。
    // 必须先同步更新 UI 再异步删库：remove 与弹窗后台 AI 写库
    // （updateWord/updateContextTranslation）并发时可能抛 DexieError，
    // 旧写法（先 await remove）一旦失败会跳过全部 UI 更新，表现为"黄色点不掉且无反馈"；
    // 红色分支不碰数据库所以无此问题
    if (sticky === 'yellow') {
      stickyHighlights.value.delete(part.occKey)
      onStickyChange()
      const newLocalMarks = new Set(localMarks.value)
      newLocalMarks.delete(part.occKey)
      localMarks.value = newLocalMarks
      closePopup()
      try {
        await wordMarkService.remove(articleId.value, part.occKey)
        wordStore.invalidateMarkCache()
      } catch (error) {
        // 删除失败：回滚高亮并提示；打印 name/inner 便于定位具体 Dexie 错误类型
        console.error('取消黄色标记失败:', error)
        const rollback = new Set(localMarks.value)
        rollback.add(part.occKey)
        localMarks.value = rollback
        stickyHighlights.value.set(part.occKey, 'yellow')
        onStickyChange()
        await alert('取消标记失败，请重试：' + (error?.name || '') + ' ' + (error?.message || error))
      }
      return
    }
    const color = await judgeWordColor(part)
    const wordData = await wordStore.getOrCreateWord(part.word, articleId.value)
    try {
      await wordMarkService.add(wordData.id, articleId.value, part.occKey)
      wordStore.invalidateMarkCache()
    } catch (error) {
      // 库写入失败：UI 尚未更新（先写库后改 UI），提示后直接返回即可
      console.error('添加标记失败:', error)
      await alert('添加标记失败，请重试：' + (error?.name || '') + ' ' + (error?.message || error))
      return
    }
    lastClickAddedMark = { occKey: part.occKey, word: part.word, color, time: Date.now() }
    const newLocalMarks = new Set(localMarks.value)
    newLocalMarks.add(part.occKey)
    localMarks.value = newLocalMarks
    stickyHighlights.value.set(part.occKey, color)
    onStickyChange()
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
  // 先改 UI 再写库（与黄色取消分支同思路：避开与弹窗后台 AI 写库的并发冲突），
  // 但失败时必须回滚高亮，否则出现"看起来已标记但库里没有"的不一致
  try {
    await wordMarkService.add(wordData.id, articleId.value, part.occKey)
    wordStore.invalidateMarkCache()
  } catch (error) {
    console.error('添加标记失败:', error)
    const rollback = new Set(localMarks.value)
    rollback.delete(part.occKey)
    localMarks.value = rollback
    await alert('添加标记失败，请重试：' + (error?.name || '') + ' ' + (error?.message || error))
    return
  }
  lastClickAddedMark = { occKey: part.occKey, word: part.word, color: 'red', time: Date.now() }

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
  clearCustomSelection()
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
  // 点击单词自动发音（可在设置中关闭）
  if (settingsStore.autoPronounce) speak(part.word)
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
  contextError.value = ''
  wordInfo.value = null
  // 重置上一次请求遗留的 loading：前一个单词的 AI 生成在途时切到新词，
  // 其 finally 会因竞态守卫跳过清理，不重置会永久转圈
  loadingWord.value = false
  try {
    const wordData = await wordStore.getOrCreateWord(word, articleId.value)
    const cached = await contextTranslationService.get(wordData.id, articleId.value, occKey).catch(() => null)
    if (requestId !== wordDetailRequestId) return
    wordInfo.value = wordData
    contextTranslation.value = cached?.translation || null
    // 词义与「在文中」同时加载：二者互不依赖（前者只更新 words.definitions，后者只写
    // contextTranslations），并行可让两段内容几乎同时到达。注意三点：
    // 1. 必须统一 await（Promise.all），不能只 await 其中一支：两支各自完成后都会写
    //    自己的状态，「在文中」先完成就更早渲染，无需等另一方；但只 await 词义会让本函数
    //    的收尾（下方 finally）多等一次请求，弹窗切换/关闭的清理被无谓拖慢；
    // 2. wordData 已在此取好并透传，避免两个分支各自 getOrCreate 同一新词并发写库；
    // 3. 不在这里判断上下文缓存命中，交给 loadContextTranslation 内部复用其自身的缓存
    //    查询，缓存存在时它直接返回、不发请求。
    const basicInfoPromise = wordData.definitions?.length
      ? Promise.resolve()
      : generateBasicInfo(word, requestId, wordData)
    const contextPromise = loadContextTranslation(word, occKey, requestId, wordData)
    await Promise.all([basicInfoPromise, contextPromise])
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
  wordStore.invalidateMarkCache()
  if (activeOccKey.value === part.occKey) {
    activeOccKey.value = null
  }
}

// requestId：来自 loadWordDetails 的请求序号，用于竞态守卫；未传（弹窗内
// "点击生成详细释义"按钮）时取发起时刻的当前序号，守卫逻辑一致：
// AI 生成期间用户切换单词后，词义照常入库（缓存复用），但不覆盖当前弹窗
// wordData：调用方已取好的单词记录（loadWordDetails 与上下文释义并行发起时复用，
// 避免并发 getOrCreate 同一新词写出重复记录）；未传时自行获取
async function generateBasicInfo(word, requestId, wordData = null) {
  const rid = requestId ?? wordDetailRequestId
  loadingWord.value = true
  try {
    // 与批量生成保持一致：语境优先取完整句，定位失败回退 50 词窗口
    const context = getWordSentenceWithContext(article.value.content, word, 0).sentence
      || getWordContext(article.value.content, word, 50)
    const info = await generateWordBasicInfo(word, context)
    const target = wordData || await wordStore.getOrCreateWord(word, articleId.value)
    await wordStore.updateWord(target.id, {
      definitions: info.definitions || target.definitions,
      lemma: info.lemma || target.lemma,
      wordForm: info.wordForm || target.wordForm,
      source: 'ai'
    })
    if (rid !== wordDetailRequestId) return
    wordInfo.value = await wordStore.getOrCreateWord(word, articleId.value)
  } catch (error) {
    if (rid === wordDetailRequestId) {
      await alert(errorText(error, 'AI 生成失败，请稍后重试'))
    }
  } finally {
    if (rid === wordDetailRequestId) {
      loadingWord.value = false
    }
  }
}

// wordData 透传同 generateBasicInfo：并行加载时复用调用方已取好的记录，避免重复 getOrCreate
async function loadContextTranslation(word, occKey, requestId, wordData = null) {
  const target = wordData || await wordStore.getOrCreateWord(word, articleId.value)
  const existing = await contextTranslationService.get(target.id, articleId.value, occKey).catch(() => null)
  if (requestId !== wordDetailRequestId) return
  if (existing?.translation) {
    contextTranslation.value = existing.translation
    return
  }
  if (existing) {
    await contextTranslationService.set(target.id, articleId.value, occKey, '')
  }

  contextError.value = ''
  loadingContext.value = true
  try {
    // context：目标词所在句及前后各一句，供 AI 理解语境；用 <w> 标记本次选中的那次出现（词可能重复出现）
    const { markedContext, context } = getWordSentenceWithContext(article.value.content, word, getOccurrence(occKey))
    // 定位失败（markedContext 为空）时退回未标记的语境：system 承诺语境里有 <w> 标记，
    // 只传空串会让模型无从判断，不如给它真实语境（丢了标记，但至少有判断依据）
    const contextText = markedContext || context
    if (!contextText) {
      throw new Error('未能在文章中找到该单词的语境')
    }
    const result = await generateWordContextTranslation(word, contextText)
    if (requestId !== wordDetailRequestId) return
    if (!result.contextTranslation) {
      throw new Error('释义结果为空')
    }
    await wordStore.updateContextTranslation(target.id, articleId.value, occKey, result.contextTranslation)
    contextTranslation.value = result.contextTranslation
  } catch (error) {
    console.error('上下文释义生成失败:', error)
    if (requestId === wordDetailRequestId) {
      contextError.value = errorText(error, '释义生成失败，请重试')
    }
  } finally {
    if (requestId === wordDetailRequestId) {
      loadingContext.value = false
    }
  }
}

function retryContextTranslation() {
  if (!selectedWord.value) return
  // 重试时没有现成的单词记录可复用（第 4 参传 null 让它自己取）；
  // 第 3 参必须是当前请求序号而不是被当成 wordData 传进去 —— 传错位置会让
  // `wordData || await getOrCreateWord(...)` 短路成一个数字，取不到记录。
  loadContextTranslation(selectedWord.value, selectedOccKey.value, wordDetailRequestId, null)
}

function closePopup() {
  selectedWord.value = null
  selectedOccKey.value = null
  wordInfo.value = null
  contextTranslation.value = null
  contextError.value = ''
  activeOccKey.value = null
  // 弹窗即将卸载：若选区残留在弹窗 DOM 内，卸载后浏览器不会自动重置 Selection，
  // 会拦截后续单词点击（黄色标记无法取消），这里趁节点还在时主动清除
  const sel = window.getSelection()
  if (sel && sel.rangeCount > 0 && !isInsideArticleContent(sel.anchorNode) && !isInsideArticleContent(sel.focusNode)) {
    sel.removeAllRanges()
  }
}

// ---- 划词翻译 ----

function isInsideArticleContent(node) {
  return !!(articleContentRef.value && node && articleContentRef.value.contains(node))
}

// 校验选区文本：2~1000 字符；单字符仅允许字母（如 "I"、"a"），过滤单个标点等误触
function isSelectableText(text) {
  if (text.length === 1) return /^[a-zA-Z]$/.test(text)
  return text.length >= 2 && text.length <= 1000
}

// 校验当前选区：仅文章内容区内的有效选区才触发划词翻译
function getValidSelection() {
  const sel = window.getSelection?.()
  if (!sel || sel.rangeCount === 0) return null
  const text = String(sel.toString() || '').trim()
  if (!isSelectableText(text)) return null
  if (!isInsideArticleContent(sel.anchorNode) || !isInsideArticleContent(sel.focusNode)) return null
  return { sel, text }
}

// 气泡定位：选区下方优先（避开上方系统选择菜单），取不到选区矩形时贴屏幕底部
function positionBubble(rect) {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const pad = 8
  // 移动端「解析」胶囊更宽，取较宽值保证水平居中估算
  const bubbleWidth = vw < 640 ? 72 : 44
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
  // 移动端自定义选区激活时不被空的原生选区干扰（touchend 后合成的 mouseup 会走到这）
  if (customSelectionText.value) return
  const found = getValidSelection()
  if (!found) {
    showSelectionBubble.value = false
    return
  }
  // 双击选词时单词弹窗可能已先弹出，检测到选区即切换为划词入口
  if (selectedWord.value) closePopup()
  // 双击的第一次 click 已把该词静默标记入库（写库+标黄+弹窗），确认切换到
  // 划词翻译后撤销这次误标记，避免"想双击划词翻译却被标记"
  rollbackDoubleClickMark(found.text)
  let rect = null
  try {
    rect = found.sel.getRangeAt(0).getBoundingClientRect()
  } catch { /* 部分移动端浏览器取不到矩形，气泡贴底部 */ }
  positionBubble(rect)
  showSelectionBubble.value = true
}

// 撤销双击选词的第一次 click 造成的误标记：仅当仍在双击时间窗内、且选区文本
// 与刚标记的词一致时执行（用户随后点气泡「译/解析」走划词翻译，标记不应保留）
async function rollbackDoubleClickMark(selectionText) {
  const recent = lastClickAddedMark
  if (!recent) return
  if (Date.now() - recent.time > 600) return
  if (recent.word.toLowerCase() !== String(selectionText || '').trim().toLowerCase()) return
  lastClickAddedMark = null
  const newLocalMarks = new Set(localMarks.value)
  newLocalMarks.delete(recent.occKey)
  localMarks.value = newLocalMarks
  stickyHighlights.value.delete(recent.occKey)
  onStickyChange()
  try {
    await wordMarkService.remove(articleId.value, recent.occKey)
    wordStore.invalidateMarkCache()
  } catch (error) {
    // 撤销失败：库中标记仍在，恢复视觉状态保证 UI 与库一致，不打断划词流程
    console.error('撤销双击误标记失败:', error)
    const rollback = new Set(localMarks.value)
    rollback.add(recent.occKey)
    localMarks.value = rollback
    stickyHighlights.value.set(recent.occKey, recent.color || 'yellow')
    onStickyChange()
  }
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

// ---- 移动端自定义划词实现 ----

// 从 DOM 元素解析出对应的单词片段位置 { p, i }（仅文章内容区内的单词 span 带 data-p/data-i）
function partFromElement(el) {
  const span = el?.closest?.('[data-p]')
  if (!span || !articleContentRef.value?.contains(span)) return null
  const p = parseInt(span.dataset.p)
  const i = parseInt(span.dataset.i)
  const part = renderedParagraphs.value[p]?.[i]
  if (!part || part.type !== 'word') return null
  return { p, i }
}

// 取屏幕坐标下的单词片段位置（手指滑动/自动滚动时持续调用）
function partFromPoint(x, y) {
  return partFromElement(document.elementFromPoint(x, y))
}

function spanForPart({ p, i }) {
  return articleContentRef.value?.querySelector(`[data-p="${p}"][data-i="${i}"]`)
}

// 按文档顺序排列锚点/焦点（支持从后往前反向收缩选区）
function orderParts(a, b) {
  return (a.p < b.p || (a.p === b.p && a.i <= b.i)) ? [a, b] : [b, a]
}

// 单词是否落在自定义选区内（含首尾），用于渲染选区高亮
function isPartSelected(p, i) {
  const a = customSelAnchor.value
  const b = customSelFocus.value
  if (!a || !b) return false
  const [from, to] = orderParts(a, b)
  if (p < from.p || p > to.p) return false
  if (p === from.p && i < from.i) return false
  if (p === to.p && i > to.i) return false
  return true
}

// 拼接选区文本：锚点到焦点之间的所有片段（含中间标点空格，跨段落补换行）
function buildCustomSelectionText() {
  const a = customSelAnchor.value
  const b = customSelFocus.value
  if (!a || !b) return ''
  const [from, to] = orderParts(a, b)
  let text = ''
  for (let p = from.p; p <= to.p; p++) {
    const parts = renderedParagraphs.value[p] || []
    const start = p === from.p ? from.i : 0
    const end = p === to.p ? to.i : parts.length - 1
    for (let i = start; i <= end; i++) {
      text += parts[i].content
    }
    if (p < to.p) text += '\n'
  }
  return text.trim()
}

function clearCustomSelection() {
  customSelAnchor.value = null
  customSelFocus.value = null
  customSelectionText.value = ''
}

// touchstart：记录起点并启动 500ms 长按定时器（passive，不阻塞正常滚动/点击）
function handleTouchStart(e) {
  if (!isCoarsePointer) return
  if (e.touches.length > 1) {
    // 多指（缩放等）：取消长按等待
    clearTimeout(longPressTimer)
    longPressTimer = null
    return
  }
  const t = e.touches[0]
  touchStartX = lastTouchX = t.clientX
  touchStartY = lastTouchY = t.clientY
  if (!settingsStore.enableSelectionTranslation) return
  if (showSelectionPopup.value || showSelectionChat.value) return
  const part = partFromElement(e.target)
  if (!part) return
  clearTimeout(longPressTimer)
  longPressTimer = setTimeout(() => beginCustomSelect(part), 500)
}

// 长按触发：进入选择会话，选中落点单词，启动边缘自动滚动循环
function beginCustomSelect(part) {
  if (selectedWord.value) closePopup()
  showSelectionBubble.value = false
  customSelecting.value = true
  customSelAnchor.value = { ...part }
  customSelFocus.value = { ...part }
  window.getSelection()?.removeAllRanges()
  if (navigator.vibrate) navigator.vibrate(12)
  startAutoScrollLoop()
}

// touchmove：选择会话中接管手势（阻止页面滚动，由边缘自动滚动替代），
// 并把手指滑过的单词设为焦点逐词扩展选区；未进入会话时移动超过阈值则取消长按等待
function handleTouchMove(e) {
  const t = e.touches[0]
  lastTouchX = t.clientX
  lastTouchY = t.clientY
  if (customSelecting.value) {
    e.preventDefault()
    if (e.touches.length > 1) return
    const pos = partFromPoint(lastTouchX, lastTouchY)
    if (pos) customSelFocus.value = pos
    return
  }
  if (longPressTimer && (Math.abs(lastTouchX - touchStartX) > 10 || Math.abs(lastTouchY - touchStartY) > 10)) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

// 边缘自动跟随滚动：手指停在屏幕上下边缘附近时持续滚动页面，
// 滚动后手指下方的内容变化，同步把新滑入的单词纳入选区
function startAutoScrollLoop() {
  cancelAnimationFrame(autoScrollRaf)
  const loop = () => {
    if (!customSelecting.value) return
    const vh = window.innerHeight
    const edge = 72
    let dy = 0
    if (lastTouchY > vh - edge) {
      dy = Math.ceil(((lastTouchY - (vh - edge)) / edge) * 12) + 2
    } else if (lastTouchY < edge) {
      dy = -Math.ceil(((edge - lastTouchY) / edge) * 12) - 2
    }
    if (dy !== 0) {
      window.scrollBy(0, dy)
      const pos = partFromPoint(lastTouchX, lastTouchY)
      if (pos) customSelFocus.value = pos
    }
    autoScrollRaf = requestAnimationFrame(loop)
  }
  autoScrollRaf = requestAnimationFrame(loop)
}

// touchend：选择会话收尾（构建文本 + 显示气泡）；
// 普通点按落在气泡/弹窗之外时清除自定义选区
function handleTouchEnd(e) {
  clearTimeout(longPressTimer)
  longPressTimer = null
  if (customSelecting.value) {
    customSelecting.value = false
    if (autoScrollRaf) {
      cancelAnimationFrame(autoScrollRaf)
      autoScrollRaf = null
    }
    finishCustomSelect()
    // 吞掉松手后合成的 click，避免误开单词弹窗
    suppressClick = true
    setTimeout(() => { suppressClick = false }, 400)
    return
  }
  const moved = Math.abs(lastTouchX - touchStartX) > 10 || Math.abs(lastTouchY - touchStartY) > 10
  if (!moved && customSelectionText.value) {
    const t = e.changedTouches?.[0]
    const target = t ? document.elementFromPoint(t.clientX, t.clientY) : null
    if (!target?.closest?.('.selection-bubble')) {
      clearCustomSelection()
      showSelectionBubble.value = false
    }
  }
}

// 选择会话结束：文本有效则记录并在选区末尾显示「解析」气泡，否则丢弃
function finishCustomSelect() {
  const text = buildCustomSelectionText()
  if (isSelectableText(text)) {
    customSelectionText.value = text
    const endPart = orderParts(customSelAnchor.value, customSelFocus.value)[1]
    let rect = null
    try {
      rect = spanForPart(endPart)?.getBoundingClientRect() || null
    } catch { /* 兜底：气泡贴底部 */ }
    positionBubble(rect)
    showSelectionBubble.value = true
  } else {
    clearCustomSelection()
  }
}

// 自定义选择接管时长按不再弹系统菜单（复制/查询等）
function handleContextMenu(e) {
  if (customSelecting.value || customSelectionText.value) e.preventDefault()
}

function handleBubbleClick() {
  // 移动端自定义选区优先（触屏设备原生 selection 已禁用）
  if (customSelectionText.value) {
    openSelectionPopup(customSelectionText.value)
    clearCustomSelection()
    return
  }
  const found = getValidSelection()
  if (!found) {
    showSelectionBubble.value = false
    return
  }
  openSelectionPopup(found.text)
  window.getSelection().removeAllRanges()
}

function openSelectionPopup(text) {
  closePopup()
  showSelectionBubble.value = false
  selectionText.value = text
  // 同步备好上下文：弹窗挂载即触发句子成分解析，解析需要用它消歧
  selectionContext.value = article.value ? getSelectionContext(article.value.content, text) : ''
  selectionTranslation.value = null
  selectionError.value = ''
  showSelectionPopup.value = true
  loadSelectionTranslation(text)
}

async function loadSelectionTranslation(text) {
  const requestId = ++selectionRequestId
  const hash = selectionHash(text)
  loadingSelection.value = true
  selectionError.value = ''
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
    console.error('划词翻译生成失败:', error)
    if (requestId === selectionRequestId) {
      selectionError.value = errorText(error, '翻译失败，请重试')
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
  selectionError.value = ''
  loadingSelection.value = false
}

// 追问解析：关闭翻译弹窗，打开对话窗口（对话历史仅会话内存态，关闭即清）
function openSelectionChat() {
  if (!selectionContext.value && selectionText.value && article.value) {
    selectionContext.value = getSelectionContext(article.value.content, selectionText.value)
  }
  showSelectionPopup.value = false
  showSelectionBubble.value = false
  clearCustomSelection()
  showSelectionChat.value = true
}

function closeSelectionChat() {
  showSelectionChat.value = false
}

async function autoGenerateAllWords() {
  // 防重入：上一次批量生成仍在进行时不重复启动
  if (batchProgress.value.running) return

  const wordsToGenerate = articleWords.value.filter(w => !w.definitions?.length)
  if (wordsToGenerate.length === 0) {
    return
  }

  // 语境优先使用目标词所在的完整句（句子信息优先，同时便于合批按句打包），
  // 句子定位失败的词回退到旧的「50 词窗口」
  const content = article.value.content
  const contextByWord = new Map()
  for (const group of groupWordsBySentence(content, wordsToGenerate.map(w => w.word))) {
    for (const word of group.words) {
      contextByWord.set(word, group.sentence || getWordContext(content, word, 50))
    }
  }
  const words = wordsToGenerate.map(w => ({
    word: w.word,
    context: contextByWord.get(w.word) || getWordContext(content, w.word, 50)
  }))

  // 用局部变量持有 controller：onUnmounted 会把模块变量置 null，
  // 若后续逻辑再读 batchAbortController.signal 会抛 TypeError（本函数在 abort 后才恢复执行）
  const controller = new AbortController()
  batchAbortController = controller
  batchProgress.value = { completed: 0, total: words.length, running: true, error: null, failedWords: [] }

  try {
    const results = await batchGenerateWords(
      words,
      (completed, total, error) => {
        batchProgress.value.completed = completed
        batchProgress.value.total = total
        if (error) {
          batchProgress.value.error = error
        }
      },
      undefined,
      controller.signal
    )

    // 页面已离开（取消）：丢弃结果，不再写库
    if (controller.signal.aborted) return

    const failedWords = []
    for (const result of results) {
      if (result.success) {
        const wordData = await wordStore.getOrCreateWord(result.word, articleId.value)
        await wordStore.updateWord(wordData.id, {
          definitions: result.info.definitions || wordData.definitions,
          lemma: result.info.lemma || wordData.lemma,
          wordForm: result.info.wordForm || wordData.wordForm,
          source: 'ai'
        })
      } else {
        failedWords.push(result)
      }
    }

    batchProgress.value.failedWords = failedWords.map(r => r.word)

    if (failedWords.length > 0) {
      // 调试模式下输出完整失败原因，方便排查（限流/超时/网络等）
      if (settingsStore.debugMode) {
        console.error('[批量生成] 重试后仍失败的单词:', failedWords)
      }
      await alert(`有 ${failedWords.length} 个单词翻译失败：${failedWords.map(r => r.word).join('、')}\n\n可能是请求过于频繁或网络不稳定，退出文章后重新进入可自动重试失败的单词。`)
    }

    await loadArticleWords()
  } catch (error) {
    console.error('批量生成失败:', error.message)
    if (!controller.signal.aborted) {
      await alert(`批量生成词义失败：${error.message}\n\n退出文章后重新进入可自动重试。`)
    }
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
      // 单字母单词（如 "I"、"a"）同样作为可点击单词渲染，与划词选择的单字符支持保持一致；
      // 点击时按需创建词记录，词义由 commonWordDefinitions 兜底，不进自动词表与批量生成
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
  <PageLayout :hide-tab="true">
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

    <div class="reader-card bg-white dark:bg-neutral-900 rounded-lg shadow-sm border border-gray-200 dark:border-neutral-800 p-4 sm:p-6">
      <div class="flex flex-wrap items-center gap-3 mb-4">
        <h1 class="text-lg sm:text-xl font-bold text-gray-900 dark:text-neutral-100">{{ article.title }}</h1>
        <button
          @click="showEditModal = true"
          class="text-gray-400 hover:text-blue-500"
          title="编辑文章"
          aria-label="编辑文章"
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

      <p v-if="!isViewMode" class="text-xs text-gray-400 dark:text-neutral-500 -mt-2 mb-5">点击单词学习:之前标记过的会标红并记入当前文章,陌生的会加入词库并标黄。拖选（手机长按后滑动）文字可翻译词句并自动解析句子成分，可继续追问。</p>

      <!-- 阅读会话恢复横幅：误退重进后恢复本次阅读的视觉标记与滚动位置 -->
      <div
        v-if="showSessionBanner"
        class="mb-4 p-3 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg flex flex-wrap items-center gap-2 text-sm"
      >
        <svg class="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-blue-700 dark:text-blue-300">检测到未完成的阅读<template v-if="sessionMarkedCount > 0">：已标记 {{ sessionMarkedCount }} 处</template><template v-if="sessionProgress > 0">，读到约 {{ sessionProgress }}%</template></span>
        <div class="ml-auto flex gap-2">
          <button @click="resumeReading" class="px-3 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700 text-sm">恢复阅读</button>
          <button @click="discardReadingSession" class="px-3 py-1 text-gray-500 dark:text-neutral-400 hover:text-gray-700 dark:hover:text-neutral-200 rounded-md text-sm">重新开始</button>
        </div>
      </div>

      <div v-if="batchProgress.running || batchProgress.failedWords.length" class="mb-4">
        <template v-if="batchProgress.running">
          <div class="flex justify-between items-center text-sm text-gray-600 dark:text-neutral-400 mb-1">
            <span>正在生成词义，完成后可点击单词</span>
            <div class="flex items-center gap-3">
              <span>{{ batchProgress.completed }} / {{ batchProgress.total }}</span>
              <!-- 批量生成可能持续较久，提供取消入口避免只能等或离开页面 -->
              <button
                @click="cancelBatchGenerate"
                class="text-xs text-gray-500 dark:text-neutral-400 hover:text-red-600 dark:hover:text-red-400 underline"
              >
                取消
              </button>
            </div>
          </div>
          <div class="w-full bg-gray-200 dark:bg-neutral-700 rounded-full h-2">
            <div
              class="bg-purple-600 h-2 rounded-full transition-all duration-300"
              :style="{ width: `${(batchProgress.completed / batchProgress.total) * 100}%` }"
            ></div>
          </div>
          <p v-if="batchProgress.error" class="text-xs text-red-500 dark:text-red-400 mt-1">{{ batchProgress.error }}</p>
        </template>
        <p v-else class="text-xs text-red-500 dark:text-red-400">
          {{ batchProgress.failedWords.length }} 个单词翻译失败：{{ batchProgress.failedWords.join('、') }}，退出文章后重新进入可重试
        </p>
      </div>

      <div
        ref="articleContentRef"
        class="max-w-none leading-relaxed text-gray-800 dark:text-neutral-200"
        :style="isCoarsePointer ? { 'user-select': 'none', '-webkit-user-select': 'none', '-webkit-touch-callout': 'none' } : undefined"
      >
        <template v-for="(paragraphParts, paragraphIndex) in renderedParagraphs" :key="paragraphIndex">
          <p class="mb-4 last:mb-0">
            <template v-for="(part, index) in paragraphParts" :key="index">
              <span v-if="part.type === 'text'">{{ part.content }}</span>
              <!-- 单词是核心交互：补可聚焦与键盘触发，否则键盘/读屏用户完全无法查词 -->
              <span
                v-else
                :data-p="paragraphIndex"
                :data-i="index"
                role="button"
                tabindex="0"
                :aria-label="part.word"
                @click="handleWordClick($event, part)"
                @keydown.enter.prevent="handleWordClick($event, part)"
                @keydown.space.prevent="handleWordClick($event, part)"
                :class="[
                  'transition-colors rounded px-0.5',
                  batchProgress.running
                    ? 'cursor-not-allowed opacity-50'
                    : 'cursor-pointer',
                  batchProgress.running ? '' : getWordHighlightHover(part),
                  isPartSelected(paragraphIndex, index)
                    ? 'bg-blue-500/40 ring-1 ring-blue-500/60'
                    : getWordHighlight(part)
                ]"
              >{{ part.content }}</span>
            </template>
          </p>
        </template>
      </div>

      <!-- 结束本次阅读：删除会话快照，下次进入不再提示恢复 -->
      <div
        v-if="!isViewMode"
        class="mt-8 pt-4 border-t border-gray-200 dark:border-neutral-800 text-center"
      >
        <template v-if="!sessionEnded">
          <button
            @click="endReadingSession"
            class="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 text-sm"
          >✅ 结束本次阅读</button>
          <p class="text-xs text-gray-400 dark:text-neutral-500 mt-2">标记的单词已保存在词库中；结束后下次进入不再恢复本次阅读进度</p>
        </template>
        <p v-else class="text-sm text-green-600 dark:text-green-400">✅ 本次阅读已结束，标记已保存</p>
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

    <!-- 划词翻译气泡：移动端显示「解析」并加大触控热区 -->
    <button
      v-if="showSelectionBubble"
      class="selection-bubble fixed z-40 px-4 py-2 sm:px-3 sm:py-1 rounded-full bg-blue-600 text-white text-base sm:text-sm shadow-lg hover:bg-blue-700 select-none"
      :style="selectionBubbleStyle"
      @mousedown.prevent
      @touchstart.prevent="handleBubbleClick"
      @click="handleBubbleClick"
    ><span class="sm:hidden">解析</span><span class="hidden sm:inline">译</span></button>

    <SelectionPopup
      v-if="showSelectionPopup"
      :text="selectionText"
      :translation="selectionTranslation"
      :loading="loadingSelection"
      :error="selectionError"
      :context="selectionContext"
      @close="closeSelectionPopup"
      @retry="retrySelectionTranslation"
      @ask="openSelectionChat"
    />

    <SelectionChatModal
      v-if="showSelectionChat"
      :text="selectionText"
      :context="selectionContext"
      :full-text="article.value ? article.value.content : ''"
      @close="closeSelectionChat"
    />
  </div>

  <!-- 加载失败：与「加载中」区分，并给出重试入口 -->
  <div v-else-if="loadError" class="text-center py-12">
    <p class="text-sm text-red-500 dark:text-red-400">{{ loadError }}</p>
    <button
      @click="initArticle"
      class="mt-3 px-4 py-1.5 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700"
    >
      重试
    </button>
  </div>
  <div v-else class="text-center py-12 text-gray-500 dark:text-neutral-400">
    加载中...
  </div>
  </PageLayout>
</template>

<style scoped>
/* ============================================================
   手机端：文章主体不再套卡片外框，正文直接铺满屏幕宽度。
   原来是「页面留白 px-4 → 白色卡片边框 + 圆角 + p-4 内边距」两层收窄，
   阅读时左右可用的正文宽度被吃掉约 60px。
   这里去掉卡片的边框/圆角/阴影/底色，并用负外边距抵消页面留白，
   只保留 p-4 作为正文与屏幕边缘的安全距离（约 16px）。
   ============================================================ */
@media (max-width: 639px) {
  .reader-card {
    /* 抵消 PageLayout 的 px-4 */
    margin-left: -1rem;
    margin-right: -1rem;
    background-color: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
}
</style>
