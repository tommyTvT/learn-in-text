import { defineStore } from 'pinia'
import { ref, computed, watch, nextTick } from 'vue'
import { useAuthStore } from './auth'
import { fetchCloudSettings, pushCloudSettings } from '../services/settingsSync'

const STORAGE_KEY = 'learn_in_text_settings'
// 记录本地设置最后修改/同步时间，用于云端设置 LWW 冲突解决
const SETTINGS_TIME_KEY = 'learn_in_text_settings_time'

// 云存储（Supabase）内置配置：来自 .env 中的 VITE_ 环境变量，
// 让用户无需在设置页手动输入。配置为空时需在 .env 中填写。
const BUILTIN_SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').trim()
const BUILTIN_SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()

export const PRESET_PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash'
  }
}

const THEMES = ['system', 'light', 'dark']
const DEFAULT_MAX_CONCURRENCY = 50
const DEFAULT_BASIC_INFO_MAX_TOKENS = 300
const DEFAULT_CONTEXT_MAX_TOKENS = 200
const DEFAULT_ARTICLE_MAX_TOKENS = 2000
const DEFAULT_REQUEST_TIMEOUT = 30
const DEFAULT_AUTO_SYNC = true
// 划词翻译（选区翻译 + 追问解析）
const DEFAULT_ENABLE_SELECTION_TRANSLATION = true
const DEFAULT_SELECTION_MAX_TOKENS = 500
const DEFAULT_SELECTION_CHAT_MAX_TOKENS = 1000
// 字体大小（百分比）：100% = 浏览器默认根字号（16px），由用户在设置页调整。
// 界面元素的字号已直接按「旧版 175% 的效果」焊死在 CSS 值中
// （见 style.css 的 @theme 文字刻度重定义），因此根字号保持 100% 时
// 界面即呈现旧版 175% 的放大阅读效果；用户拖动滑块只是在此基准上
// 进一步等比缩放所有 rem 尺寸。
const DEFAULT_FONT_SIZE = 100
const FONT_SIZE_MIN = 60
const FONT_SIZE_MAX = 200

function toPositiveNumber(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : fallback
}

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

let providerSeq = 0

function createPresetProvider(presetKey) {
  const preset = PRESET_PROVIDERS[presetKey]
  return {
    id: 'preset-' + presetKey,
    name: preset.name,
    preset: presetKey,
    endpoint: preset.endpoint,
    apiKey: ''
  }
}

/** 供应商（共享资源池）只保留连接信息，模型选择下放到「文本模型 / 视觉模型」配置 */
function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.preset) {
    // 已下架的预设直接丢弃
    if (!PRESET_PROVIDERS[raw.preset]) return null
    // 预设供应商的端点始终跟随预设定义，仅 apiKey 允许用户自定义
    const base = createPresetProvider(raw.preset)
    return { ...base, apiKey: raw.apiKey || '' }
  }
  return {
    id: raw.id || 'custom-' + Date.now().toString(36) + '-' + (++providerSeq),
    name: raw.name || '自定义供应商',
    preset: null,
    endpoint: raw.endpoint || '',
    apiKey: raw.apiKey || ''
  }
}

/** 规范化单份模型配置：{ providerId, model } */
function normalizeModelConfig(raw, providers) {
  if (raw && typeof raw === 'object' && providers.some(p => p.id === raw.providerId)) {
    return { providerId: raw.providerId, model: raw.model || '' }
  }
  return { providerId: providers[0]?.id || '', model: '' }
}

/**
 * 解析文本/视觉模型配置，兼容旧结构（供应商内嵌 model/visionModel + activeProviderId）。
 * 返回 { text, vision }。
 */
function resolveModelConfigs(data, providers) {
  let text = normalizeModelConfig(data?.textModelConfig, providers)
  let vision = normalizeModelConfig(data?.visionModelConfig, providers)

  const oldProviders = Array.isArray(data?.providers) ? data.providers : []
  if (oldProviders.length) {
    const active = oldProviders.find(p => p.id === data?.activeProviderId) || oldProviders[0]
    if (!data?.textModelConfig && active?.model) {
      text = { providerId: active.id, model: active.model }
    }
    if (!data?.visionModelConfig) {
      const vp = oldProviders.find(p => p.visionModel)
      vision = vp
        ? { providerId: vp.id, model: vp.visionModel }
        : { providerId: text.providerId, model: '' }
    }
  }
  return { text, vision }
}

export const useSettingsStore = defineStore('settings', () => {
  const providers = ref([])
  // 文本模型配置与视觉模型配置：各自独立选择（供应商可共用，模型可不同）
  const textModelConfig = ref({ providerId: '', model: '' })
  const visionModelConfig = ref({ providerId: '', model: '' })
  const theme = ref('system')
  const maxConcurrency = ref(DEFAULT_MAX_CONCURRENCY)
  const basicInfoMaxTokens = ref(DEFAULT_BASIC_INFO_MAX_TOKENS)
  const contextMaxTokens = ref(DEFAULT_CONTEXT_MAX_TOKENS)
  const articleMaxTokens = ref(DEFAULT_ARTICLE_MAX_TOKENS)
  const requestTimeout = ref(DEFAULT_REQUEST_TIMEOUT)
  const supabaseUrl = ref('')
  const supabaseAnonKey = ref('')
  const autoSync = ref(DEFAULT_AUTO_SYNC)
  const debugMode = ref(false)
  const fontSize = ref(DEFAULT_FONT_SIZE)
  const enableSelectionTranslation = ref(DEFAULT_ENABLE_SELECTION_TRANSLATION)
  const selectionMaxTokens = ref(DEFAULT_SELECTION_MAX_TOKENS)
  const selectionChatMaxTokens = ref(DEFAULT_SELECTION_CHAT_MAX_TOKENS)

  // ---- 设置同步（LWW）状态 ----
  // 本地最后修改时间戳；应用云端设置时不计入「本地修改」，避免触发回传循环
  let silentApply = false
  const syncedAt = ref(0)         // 上次成功与云端同步的时间（成功拉取/推送后更新）
  const cloudSyncing = ref(false) // 同步进行中标志，避免并发

  function loadSyncTimes() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_TIME_KEY) || 'null')
      syncedAt.value = raw?.syncedAt || 0
    } catch {
      syncedAt.value = 0
    }
  }
  function persistSyncTimes() {
    try {
      localStorage.setItem(SETTINGS_TIME_KEY, JSON.stringify({ syncedAt: syncedAt.value }))
    } catch {
      // 忽略存储异常
    }
  }

  // 文本模型当前使用的供应商
  const textProvider = computed(() =>
    providers.value.find(p => p.id === textModelConfig.value.providerId) || null
  )
  // 视觉模型当前使用的供应商
  const visionProvider = computed(() =>
    providers.value.find(p => p.id === visionModelConfig.value.providerId) || null
  )

  const isDark = computed(() => {
    if (theme.value === 'system') return systemPrefersDark()
    return theme.value === 'dark'
  })

  let systemDarkListener = null

  function applyTheme() {
    const dark = isDark.value
    document.documentElement.classList.toggle('dark', dark)

    if (systemDarkListener) {
      window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', systemDarkListener)
      systemDarkListener = null
    }

    if (theme.value === 'system') {
      systemDarkListener = (e) => {
        document.documentElement.classList.toggle('dark', e.matches)
      }
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', systemDarkListener)
    }
  }

  function applyFontSize() {
    const v = toPositiveNumber(fontSize.value, DEFAULT_FONT_SIZE)
    const clamped = Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, v))
    // 直接以百分比设置根字号；界面默认效果（旧版 175%）已由 style.css 的文字刻度承担
    document.documentElement.style.fontSize = clamped + '%'
  }

  function toggleTheme() {
    theme.value = isDark.value ? 'light' : 'dark'
    applyTheme()
  }

  // ---- 供应商管理（共享资源池） ----

  function addCustomProvider() {
    const customCount = providers.value.filter(p => !p.preset).length
    const provider = {
      id: 'custom-' + Date.now().toString(36) + '-' + (++providerSeq),
      name: `自定义供应商 ${customCount + 1}`,
      preset: null,
      endpoint: '',
      apiKey: ''
    }
    providers.value.push(provider)
    return provider
  }

  function removeProvider(id) {
    const index = providers.value.findIndex(p => p.id === id)
    if (index === -1) return
    providers.value.splice(index, 1)
    const fallbackId = providers.value[0]?.id || ''
    if (textModelConfig.value.providerId === id) {
      textModelConfig.value.providerId = fallbackId
    }
    if (visionModelConfig.value.providerId === id) {
      visionModelConfig.value.providerId = fallbackId
    }
  }

  // ---- 模型配置（供 UI 直接读写） ----

  function setTextModel(providerId, model) {
    const pid = providers.value.some(p => p.id === providerId)
      ? providerId
      : textModelConfig.value.providerId
    textModelConfig.value = { providerId: pid, model: model || '' }
  }

  function setVisionModel(providerId, model) {
    const pid = providers.value.some(p => p.id === providerId)
      ? providerId
      : visionModelConfig.value.providerId
    visionModelConfig.value = { providerId: pid, model: model || '' }
  }

  function loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      const data = saved ? JSON.parse(saved) : {}

      if (Array.isArray(data.providers) && data.providers.length) {
        providers.value = data.providers.map(normalizeProvider).filter(Boolean)
      }
      if (!providers.value.length) {
        providers.value = [createPresetProvider('deepseek')]
      }

      const { text, vision } = resolveModelConfigs(data, providers.value)
      textModelConfig.value = text
      visionModelConfig.value = vision

      // 全新用户：文本模型使用预设默认模型名
      if (!textModelConfig.value.model) {
        const p = providers.value.find(x => x.id === textModelConfig.value.providerId)
        if (p?.preset && PRESET_PROVIDERS[p.preset]) {
          textModelConfig.value.model = PRESET_PROVIDERS[p.preset].model
        }
      }

      if (THEMES.includes(data.theme)) {
        theme.value = data.theme
      }
      fontSize.value = toPositiveNumber(data.fontSize, DEFAULT_FONT_SIZE)
      maxConcurrency.value = toPositiveNumber(data.maxConcurrency, DEFAULT_MAX_CONCURRENCY)
      basicInfoMaxTokens.value = toPositiveNumber(data.basicInfoMaxTokens, DEFAULT_BASIC_INFO_MAX_TOKENS)
      contextMaxTokens.value = toPositiveNumber(data.contextMaxTokens, DEFAULT_CONTEXT_MAX_TOKENS)
      articleMaxTokens.value = toPositiveNumber(data.articleMaxTokens, DEFAULT_ARTICLE_MAX_TOKENS)
      requestTimeout.value = toPositiveNumber(data.requestTimeout, DEFAULT_REQUEST_TIMEOUT)
      // 内置云存储配置：未在本地保存过则使用 .env 中的内置值，用户无需手动输入
      supabaseUrl.value = data.supabaseUrl || BUILTIN_SUPABASE_URL
      supabaseAnonKey.value = data.supabaseAnonKey || BUILTIN_SUPABASE_ANON_KEY
      autoSync.value = data.autoSync !== undefined ? !!data.autoSync : DEFAULT_AUTO_SYNC
      debugMode.value = !!data.debugMode
      enableSelectionTranslation.value = data.enableSelectionTranslation !== undefined ? !!data.enableSelectionTranslation : DEFAULT_ENABLE_SELECTION_TRANSLATION
      selectionMaxTokens.value = toPositiveNumber(data.selectionMaxTokens, DEFAULT_SELECTION_MAX_TOKENS)
      selectionChatMaxTokens.value = toPositiveNumber(data.selectionChatMaxTokens, DEFAULT_SELECTION_CHAT_MAX_TOKENS)
    } catch (e) {
      console.error('加载设置失败:', e)
      if (!providers.value.length) {
        providers.value = [createPresetProvider('deepseek')]
      }
      if (!textModelConfig.value.providerId) {
        textModelConfig.value = { providerId: providers.value[0]?.id || '', model: '' }
      }
      if (!visionModelConfig.value.providerId) {
        visionModelConfig.value = { providerId: providers.value[0]?.id || '', model: '' }
      }
    }
    applyTheme()
    applyFontSize()
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        providers: providers.value,
        textModelConfig: textModelConfig.value,
        visionModelConfig: visionModelConfig.value,
        theme: theme.value,
        maxConcurrency: maxConcurrency.value,
        basicInfoMaxTokens: basicInfoMaxTokens.value,
        contextMaxTokens: contextMaxTokens.value,
        articleMaxTokens: articleMaxTokens.value,
        requestTimeout: requestTimeout.value,
        supabaseUrl: supabaseUrl.value,
        supabaseAnonKey: supabaseAnonKey.value,
        autoSync: autoSync.value,
        debugMode: debugMode.value,
        fontSize: fontSize.value,
        enableSelectionTranslation: enableSelectionTranslation.value,
        selectionMaxTokens: selectionMaxTokens.value,
        selectionChatMaxTokens: selectionChatMaxTokens.value
      }))
    } catch (e) {
      console.error('保存设置失败:', e)
    }
  }

  /** 文本模型是否已配置（供应商 endpoint + apiKey 齐全） */
  function isConfigured() {
    return !!(textProvider.value?.endpoint && textProvider.value?.apiKey)
  }

  function exportSettings() {
    return {
      providers: providers.value,
      textModelConfig: textModelConfig.value,
      visionModelConfig: visionModelConfig.value,
      theme: theme.value,
      maxConcurrency: maxConcurrency.value,
      basicInfoMaxTokens: basicInfoMaxTokens.value,
      contextMaxTokens: contextMaxTokens.value,
      articleMaxTokens: articleMaxTokens.value,
      requestTimeout: requestTimeout.value,
      supabaseUrl: supabaseUrl.value,
      supabaseAnonKey: supabaseAnonKey.value,
      autoSync: autoSync.value,
      debugMode: debugMode.value,
      fontSize: fontSize.value,
      enableSelectionTranslation: enableSelectionTranslation.value,
      selectionMaxTokens: selectionMaxTokens.value,
      selectionChatMaxTokens: selectionChatMaxTokens.value
    }
  }

  function importSettings(data) {
    if (Array.isArray(data.providers) && data.providers.length) {
      providers.value = data.providers.map(normalizeProvider).filter(Boolean)
    }
    const { text, vision } = resolveModelConfigs(data, providers.value)
    textModelConfig.value = text
    visionModelConfig.value = vision

    if (THEMES.includes(data.theme)) theme.value = data.theme
    if (data.maxConcurrency !== undefined) maxConcurrency.value = toPositiveNumber(data.maxConcurrency, DEFAULT_MAX_CONCURRENCY)
    if (data.basicInfoMaxTokens !== undefined) basicInfoMaxTokens.value = toPositiveNumber(data.basicInfoMaxTokens, DEFAULT_BASIC_INFO_MAX_TOKENS)
    if (data.contextMaxTokens !== undefined) contextMaxTokens.value = toPositiveNumber(data.contextMaxTokens, DEFAULT_CONTEXT_MAX_TOKENS)
    if (data.articleMaxTokens !== undefined) articleMaxTokens.value = toPositiveNumber(data.articleMaxTokens, DEFAULT_ARTICLE_MAX_TOKENS)
    if (data.requestTimeout !== undefined) requestTimeout.value = toPositiveNumber(data.requestTimeout, DEFAULT_REQUEST_TIMEOUT)
    if (data.supabaseUrl !== undefined) supabaseUrl.value = data.supabaseUrl
    if (data.supabaseAnonKey !== undefined) supabaseAnonKey.value = data.supabaseAnonKey
    if (data.autoSync !== undefined) autoSync.value = !!data.autoSync
    if (data.debugMode !== undefined) debugMode.value = !!data.debugMode
    if (data.fontSize !== undefined) fontSize.value = toPositiveNumber(data.fontSize, DEFAULT_FONT_SIZE)
    if (data.enableSelectionTranslation !== undefined) enableSelectionTranslation.value = !!data.enableSelectionTranslation
    if (data.selectionMaxTokens !== undefined) selectionMaxTokens.value = toPositiveNumber(data.selectionMaxTokens, DEFAULT_SELECTION_MAX_TOKENS)
    if (data.selectionChatMaxTokens !== undefined) selectionChatMaxTokens.value = toPositiveNumber(data.selectionChatMaxTokens, DEFAULT_SELECTION_CHAT_MAX_TOKENS)
    applyTheme()
    applyFontSize()
    saveSettings()
    // 从备份导入设置视为本地修改，触发云端回传；应用云端设置时跳过
    if (!silentApply) scheduleUpload()
  }

  // ---- 设置同步方法 ----

  /** 将当前设置整体导出为 JSON 对象（用于云端存储）。
   *  排除 supabaseUrl / supabaseAnonKey / username：这些是本机环境配置（.env 内置），
   *  不应被云端设置覆盖。 */
  function exportSettingsPayload() {
    const s = exportSettings()
    const { supabaseUrl, supabaseAnonKey, username, ...rest } = s
    return rest
  }

  /** 将云端设置应用到本地（不标记为本地修改）。同样排除环境配置字段。 */
  function applyCloudSettings(payload) {
    const { supabaseUrl, supabaseAnonKey, username, ...rest } = payload || {}
    silentApply = true
    try {
      importSettings(rest)
    } finally {
      silentApply = false
    }
  }

  /** 登录后从云端拉取设置：云端较新则以云端覆盖本地 */
  async function syncFromCloud() {
    const auth = useAuthStore()
    const username = auth.username?.trim()
    if (!username) return

    cloudSyncing.value = true
    try {
      const cloud = await fetchCloudSettings(username)
      if (!cloud) {
        // 云端无记录：上传本地设置（首登）
        syncedAt.value = Date.now()
        persistSyncTimes()
        await pushCloudSettings(username, exportSettingsPayload(), syncedAt.value)
        return
      }
      // LWW：仅当云端较新且本地未在云端之后修改过 → 用云端覆盖本地
      if (cloud.updatedAt > syncedAt.value) {
        applyCloudSettings(cloud.settings)
      }
      syncedAt.value = Math.max(syncedAt.value, cloud.updatedAt)
      persistSyncTimes()
    } finally {
      cloudSyncing.value = false
    }
  }

  /** 本地设置变更后上传到云端 */
  async function pushToCloud() {
    const auth = useAuthStore()
    const username = auth.username?.trim()
    if (!username || cloudSyncing.value) return

    const now = Date.now()
    if (now - syncedAt.value < 3000) return // 与拉取刚同步后避免立即回传

    cloudSyncing.value = true
    try {
      syncedAt.value = now
      persistSyncTimes()
      await pushCloudSettings(username, exportSettingsPayload(), now)
    } finally {
      cloudSyncing.value = false
    }
  }

  // 上传防抖
  let uploadTimer = null
  function scheduleUpload() {
    if (uploadTimer) clearTimeout(uploadTimer)
    uploadTimer = setTimeout(() => {
      uploadTimer = null
      pushToCloud()
    }, 800)
  }

  /**
   * 重置为出厂默认设置并清除本地存储（登出 / 换号清除场景）。
   * silentApply 需维持到 watcher 回调执行完（watch 默认异步 flush），
   * 否则重置会被当作本地修改触发 saveSettings + 云端回传。
   */
  async function resetSettings() {
    silentApply = true
    try {
      providers.value = [createPresetProvider('deepseek')]
      textModelConfig.value = { providerId: providers.value[0].id, model: PRESET_PROVIDERS.deepseek.model }
      visionModelConfig.value = { providerId: providers.value[0].id, model: '' }
      theme.value = 'system'
      fontSize.value = DEFAULT_FONT_SIZE
      maxConcurrency.value = DEFAULT_MAX_CONCURRENCY
      basicInfoMaxTokens.value = DEFAULT_BASIC_INFO_MAX_TOKENS
      contextMaxTokens.value = DEFAULT_CONTEXT_MAX_TOKENS
      articleMaxTokens.value = DEFAULT_ARTICLE_MAX_TOKENS
      requestTimeout.value = DEFAULT_REQUEST_TIMEOUT
      supabaseUrl.value = BUILTIN_SUPABASE_URL
      supabaseAnonKey.value = BUILTIN_SUPABASE_ANON_KEY
      autoSync.value = DEFAULT_AUTO_SYNC
      debugMode.value = false
      enableSelectionTranslation.value = DEFAULT_ENABLE_SELECTION_TRANSLATION
      selectionMaxTokens.value = DEFAULT_SELECTION_MAX_TOKENS
      selectionChatMaxTokens.value = DEFAULT_SELECTION_CHAT_MAX_TOKENS
      // 同步时间一并清零：重置后的本地设置不再参与 LWW 比较，
      // 下次登录时以云端（或默认值首推）为准
      syncedAt.value = 0
      try {
        localStorage.removeItem(STORAGE_KEY)
        localStorage.removeItem(SETTINGS_TIME_KEY)
      } catch {
        // 忽略存储异常
      }
      applyTheme()
      applyFontSize()
      await nextTick()
    } finally {
      silentApply = false
    }
  }

  loadSettings()
  loadSyncTimes()

  watch([providers, textModelConfig, visionModelConfig, theme, fontSize, maxConcurrency, basicInfoMaxTokens, contextMaxTokens, articleMaxTokens, requestTimeout, supabaseUrl, supabaseAnonKey, autoSync, debugMode, enableSelectionTranslation, selectionMaxTokens, selectionChatMaxTokens], () => {
    if (silentApply) return
    applyFontSize()
    saveSettings()
    scheduleUpload()
  }, { deep: true })

  return {
    providers,
    textModelConfig,
    visionModelConfig,
    textProvider,
    visionProvider,
    theme,
    maxConcurrency,
    basicInfoMaxTokens,
    contextMaxTokens,
    articleMaxTokens,
    requestTimeout,
    supabaseUrl,
    supabaseAnonKey,
    autoSync,
    debugMode,
    fontSize,
    enableSelectionTranslation,
    selectionMaxTokens,
    selectionChatMaxTokens,
    isDark,
    addCustomProvider,
    removeProvider,
    setTextModel,
    setVisionModel,
    loadSettings,
    saveSettings,
    isConfigured,
    toggleTheme,
    applyTheme,
    applyFontSize,
    exportSettings,
    importSettings,
    resetSettings,
    syncFromCloud,
    pushToCloud,
    cloudSyncing
  }
})
