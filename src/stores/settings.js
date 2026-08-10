import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
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
    model: preset.model,
    apiKey: ''
  }
}

function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null
  if (raw.preset) {
    // 已下架的预设（如阿里百炼）直接丢弃
    if (!PRESET_PROVIDERS[raw.preset]) return null
    // 预设供应商的端点始终跟随预设定义，模型和 apiKey 允许用户自定义
    const base = createPresetProvider(raw.preset)
    return { ...base, model: raw.model || base.model, apiKey: raw.apiKey || '' }
  }
  return {
    id: raw.id || 'custom-' + Date.now().toString(36) + '-' + (++providerSeq),
    name: raw.name || '自定义供应商',
    preset: null,
    endpoint: raw.endpoint || '',
    model: raw.model || '',
    apiKey: raw.apiKey || ''
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const providers = ref([])
  const activeProviderId = ref('')
  const theme = ref('system')
  const maxConcurrency = ref(DEFAULT_MAX_CONCURRENCY)
  const basicInfoMaxTokens = ref(DEFAULT_BASIC_INFO_MAX_TOKENS)
  const contextMaxTokens = ref(DEFAULT_CONTEXT_MAX_TOKENS)
  const articleMaxTokens = ref(DEFAULT_ARTICLE_MAX_TOKENS)
  const requestTimeout = ref(DEFAULT_REQUEST_TIMEOUT)
  const username = ref('')
  const supabaseUrl = ref('')
  const supabaseAnonKey = ref('')
  const autoSync = ref(DEFAULT_AUTO_SYNC)
  const debugMode = ref(false)

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

  const activeProvider = computed(() =>
    providers.value.find(p => p.id === activeProviderId.value) || null
  )
  // 兼容 ai.js 等调用方：始终指向当前激活供应商的配置
  const aiEndpoint = computed(() => activeProvider.value?.endpoint || '')
  const aiApiKey = computed(() => activeProvider.value?.apiKey || '')
  const aiModel = computed(() => activeProvider.value?.model || '')

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

  function toggleTheme() {
    theme.value = isDark.value ? 'light' : 'dark'
    applyTheme()
  }

  function setActiveProvider(id) {
    if (providers.value.some(p => p.id === id)) {
      activeProviderId.value = id
    }
  }

  function addCustomProvider() {
    const customCount = providers.value.filter(p => !p.preset).length
    const provider = {
      id: 'custom-' + Date.now().toString(36) + '-' + (++providerSeq),
      name: `自定义供应商 ${customCount + 1}`,
      preset: null,
      endpoint: '',
      model: '',
      apiKey: ''
    }
    providers.value.push(provider)
    activeProviderId.value = provider.id
    return provider
  }

  function removeProvider(id) {
    const index = providers.value.findIndex(p => p.id === id)
    if (index === -1) return
    providers.value.splice(index, 1)
    if (activeProviderId.value === id) {
      activeProviderId.value = providers.value[0]?.id || ''
    }
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
      activeProviderId.value = providers.value.some(p => p.id === data.activeProviderId)
        ? data.activeProviderId
        : providers.value[0]?.id || ''

      if (THEMES.includes(data.theme)) {
        theme.value = data.theme
      }
      maxConcurrency.value = toPositiveNumber(data.maxConcurrency, DEFAULT_MAX_CONCURRENCY)
      basicInfoMaxTokens.value = toPositiveNumber(data.basicInfoMaxTokens, DEFAULT_BASIC_INFO_MAX_TOKENS)
      contextMaxTokens.value = toPositiveNumber(data.contextMaxTokens, DEFAULT_CONTEXT_MAX_TOKENS)
      articleMaxTokens.value = toPositiveNumber(data.articleMaxTokens, DEFAULT_ARTICLE_MAX_TOKENS)
      requestTimeout.value = toPositiveNumber(data.requestTimeout, DEFAULT_REQUEST_TIMEOUT)
      username.value = data.username || ''
      // 内置云存储配置：未在本地保存过则使用 .env 中的内置值，用户无需手动输入
      supabaseUrl.value = data.supabaseUrl || BUILTIN_SUPABASE_URL
      supabaseAnonKey.value = data.supabaseAnonKey || BUILTIN_SUPABASE_ANON_KEY
      autoSync.value = data.autoSync !== undefined ? !!data.autoSync : DEFAULT_AUTO_SYNC
      debugMode.value = !!data.debugMode
    } catch (e) {
      console.error('加载设置失败:', e)
      if (!providers.value.length) {
        providers.value = [createPresetProvider('deepseek')]
        activeProviderId.value = providers.value[0].id
      }
    }
    applyTheme()
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        providers: providers.value,
        activeProviderId: activeProviderId.value,
        theme: theme.value,
        maxConcurrency: maxConcurrency.value,
        basicInfoMaxTokens: basicInfoMaxTokens.value,
        contextMaxTokens: contextMaxTokens.value,
        articleMaxTokens: articleMaxTokens.value,
        requestTimeout: requestTimeout.value,
        username: username.value,
        supabaseUrl: supabaseUrl.value,
        supabaseAnonKey: supabaseAnonKey.value,
        autoSync: autoSync.value,
        debugMode: debugMode.value
      }))
    } catch (e) {
      console.error('保存设置失败:', e)
    }
  }

  function isConfigured() {
    return !!(aiEndpoint.value && aiApiKey.value)
  }

  function exportSettings() {
    return {
      providers: providers.value,
      activeProviderId: activeProviderId.value,
      theme: theme.value,
      maxConcurrency: maxConcurrency.value,
      basicInfoMaxTokens: basicInfoMaxTokens.value,
      contextMaxTokens: contextMaxTokens.value,
      articleMaxTokens: articleMaxTokens.value,
      requestTimeout: requestTimeout.value,
      username: username.value,
      supabaseUrl: supabaseUrl.value,
      supabaseAnonKey: supabaseAnonKey.value,
      autoSync: autoSync.value,
      debugMode: debugMode.value
    }
  }

  function importSettings(data) {
    if (Array.isArray(data.providers) && data.providers.length) {
      providers.value = data.providers.map(normalizeProvider).filter(Boolean)
      activeProviderId.value = providers.value.some(p => p.id === data.activeProviderId)
        ? data.activeProviderId
        : providers.value[0]?.id || ''
    }
    if (THEMES.includes(data.theme)) theme.value = data.theme
    if (data.maxConcurrency !== undefined) maxConcurrency.value = toPositiveNumber(data.maxConcurrency, DEFAULT_MAX_CONCURRENCY)
    if (data.basicInfoMaxTokens !== undefined) basicInfoMaxTokens.value = toPositiveNumber(data.basicInfoMaxTokens, DEFAULT_BASIC_INFO_MAX_TOKENS)
    if (data.contextMaxTokens !== undefined) contextMaxTokens.value = toPositiveNumber(data.contextMaxTokens, DEFAULT_CONTEXT_MAX_TOKENS)
    if (data.articleMaxTokens !== undefined) articleMaxTokens.value = toPositiveNumber(data.articleMaxTokens, DEFAULT_ARTICLE_MAX_TOKENS)
    if (data.requestTimeout !== undefined) requestTimeout.value = toPositiveNumber(data.requestTimeout, DEFAULT_REQUEST_TIMEOUT)
    if (data.username !== undefined) username.value = data.username
    if (data.supabaseUrl !== undefined) supabaseUrl.value = data.supabaseUrl
    if (data.supabaseAnonKey !== undefined) supabaseAnonKey.value = data.supabaseAnonKey
    if (data.autoSync !== undefined) autoSync.value = !!data.autoSync
    if (data.debugMode !== undefined) debugMode.value = !!data.debugMode
    applyTheme()
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

  loadSettings()
  loadSyncTimes()

  watch([providers, activeProviderId, theme, maxConcurrency, basicInfoMaxTokens, contextMaxTokens, articleMaxTokens, requestTimeout, username, supabaseUrl, supabaseAnonKey, autoSync, debugMode], () => {
    if (silentApply) return
    saveSettings()
    scheduleUpload()
  }, { deep: true })

  return {
    providers,
    activeProviderId,
    activeProvider,
    aiEndpoint,
    aiApiKey,
    aiModel,
    theme,
    maxConcurrency,
    basicInfoMaxTokens,
    contextMaxTokens,
    articleMaxTokens,
    requestTimeout,
    username,
    supabaseUrl,
    supabaseAnonKey,
    autoSync,
    debugMode,
    isDark,
    setActiveProvider,
    addCustomProvider,
    removeProvider,
    loadSettings,
    saveSettings,
    isConfigured,
    toggleTheme,
    applyTheme,
    exportSettings,
    importSettings,
    syncFromCloud,
    pushToCloud,
    cloudSyncing
  }
})
