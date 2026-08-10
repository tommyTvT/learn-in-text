import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

const STORAGE_KEY = 'learn_in_text_settings'

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
const DEFAULT_AUTO_SYNC_INTERVAL_MIN = 5

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
  const autoSyncIntervalMin = ref(DEFAULT_AUTO_SYNC_INTERVAL_MIN)
  const debugMode = ref(false)

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
      supabaseUrl.value = data.supabaseUrl || ''
      supabaseAnonKey.value = data.supabaseAnonKey || ''
      autoSync.value = data.autoSync !== undefined ? !!data.autoSync : DEFAULT_AUTO_SYNC
      // 2026-08-10：默认同步间隔改为 5 分钟，旧存储中的 30（原默认值）一并迁移为 5
      const storedInterval = data.autoSyncIntervalMin
      const migratedInterval = storedInterval === 30 ? 5 : storedInterval
      autoSyncIntervalMin.value = Math.min(1440, Math.max(1, toPositiveNumber(migratedInterval, DEFAULT_AUTO_SYNC_INTERVAL_MIN)))
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
        autoSyncIntervalMin: autoSyncIntervalMin.value,
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
      autoSyncIntervalMin: autoSyncIntervalMin.value,
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
    if (data.autoSyncIntervalMin !== undefined) autoSyncIntervalMin.value = Math.min(1440, Math.max(1, toPositiveNumber(data.autoSyncIntervalMin, DEFAULT_AUTO_SYNC_INTERVAL_MIN)))
    if (data.debugMode !== undefined) debugMode.value = !!data.debugMode
    applyTheme()
    saveSettings()
  }

  loadSettings()

  watch([providers, activeProviderId, theme, maxConcurrency, basicInfoMaxTokens, contextMaxTokens, articleMaxTokens, requestTimeout, username, supabaseUrl, supabaseAnonKey, autoSync, autoSyncIntervalMin, debugMode], saveSettings, { deep: true })

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
    autoSyncIntervalMin,
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
    importSettings
  }
})
