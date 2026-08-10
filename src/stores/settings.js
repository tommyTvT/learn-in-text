import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'

const STORAGE_KEY = 'learn_in_text_settings'

export const AI_PROVIDERS = {
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash'
  }
}

const CUSTOM = 'custom'
const THEMES = ['system', 'light', 'dark']
const DEFAULT_MAX_CONCURRENCY = 50
const DEFAULT_BASIC_INFO_MAX_TOKENS = 300
const DEFAULT_CONTEXT_MAX_TOKENS = 200
const DEFAULT_ARTICLE_MAX_TOKENS = 2000
const DEFAULT_REQUEST_TIMEOUT = 30

function toPositiveNumber(value, fallback) {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : fallback
}

function systemPrefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

export const useSettingsStore = defineStore('settings', () => {
  const aiProvider = ref('deepseek')
  const aiEndpoint = ref('')
  const aiApiKey = ref('')
  const aiModel = ref('')
  const theme = ref('system')
  const maxConcurrency = ref(DEFAULT_MAX_CONCURRENCY)
  const basicInfoMaxTokens = ref(DEFAULT_BASIC_INFO_MAX_TOKENS)
  const contextMaxTokens = ref(DEFAULT_CONTEXT_MAX_TOKENS)
  const articleMaxTokens = ref(DEFAULT_ARTICLE_MAX_TOKENS)
  const requestTimeout = ref(DEFAULT_REQUEST_TIMEOUT)
  const username = ref('')
  const supabaseUrl = ref('')
  const supabaseAnonKey = ref('')

  const selectedProvider = computed(() => AI_PROVIDERS[aiProvider.value] || null)
  const isPreset = computed(() => aiProvider.value !== CUSTOM)

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

  function applyProvider(name) {
    aiProvider.value = name
    const preset = AI_PROVIDERS[name]
    if (preset) {
      aiEndpoint.value = preset.endpoint
      aiModel.value = preset.model
    }
  }

  function loadSettings() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const data = JSON.parse(saved)
        aiApiKey.value = data.aiApiKey || ''
        if (THEMES.includes(data.theme)) {
          theme.value = data.theme
        }
        if (data.aiProvider && AI_PROVIDERS[data.aiProvider]) {
          applyProvider(data.aiProvider)
        } else if (data.aiEndpoint) {
          const matched = Object.values(AI_PROVIDERS).find(p => p.endpoint === data.aiEndpoint)
          aiProvider.value = matched ? (Object.keys(AI_PROVIDERS).find(k => AI_PROVIDERS[k] === matched)) : CUSTOM
          aiEndpoint.value = data.aiEndpoint || ''
          aiModel.value = data.aiModel || ''
        } else {
          applyProvider('deepseek')
        }
        maxConcurrency.value = toPositiveNumber(data.maxConcurrency, DEFAULT_MAX_CONCURRENCY)
        basicInfoMaxTokens.value = toPositiveNumber(data.basicInfoMaxTokens, DEFAULT_BASIC_INFO_MAX_TOKENS)
        contextMaxTokens.value = toPositiveNumber(data.contextMaxTokens, DEFAULT_CONTEXT_MAX_TOKENS)
        articleMaxTokens.value = toPositiveNumber(data.articleMaxTokens, DEFAULT_ARTICLE_MAX_TOKENS)
        requestTimeout.value = toPositiveNumber(data.requestTimeout, DEFAULT_REQUEST_TIMEOUT)
        username.value = data.username || ''
        supabaseUrl.value = data.supabaseUrl || ''
        supabaseAnonKey.value = data.supabaseAnonKey || ''
      } else {
        applyProvider('deepseek')
      }
    } catch (e) {
      console.error('加载设置失败:', e)
    }
    applyTheme()
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        aiProvider: aiProvider.value,
        aiEndpoint: aiEndpoint.value,
        aiApiKey: aiApiKey.value,
        aiModel: aiModel.value,
        theme: theme.value,
        maxConcurrency: maxConcurrency.value,
        basicInfoMaxTokens: basicInfoMaxTokens.value,
        contextMaxTokens: contextMaxTokens.value,
        articleMaxTokens: articleMaxTokens.value,
        requestTimeout: requestTimeout.value,
        username: username.value,
        supabaseUrl: supabaseUrl.value,
        supabaseAnonKey: supabaseAnonKey.value
      }))
    } catch (e) {
      console.error('保存设置失败:', e)
    }
  }

  function isConfigured() {
    return aiEndpoint.value && aiApiKey.value
  }

  function exportSettings() {
    return {
      aiProvider: aiProvider.value,
      aiEndpoint: aiEndpoint.value,
      aiApiKey: aiApiKey.value,
      aiModel: aiModel.value,
      theme: theme.value,
      maxConcurrency: maxConcurrency.value,
      basicInfoMaxTokens: basicInfoMaxTokens.value,
      contextMaxTokens: contextMaxTokens.value,
      articleMaxTokens: articleMaxTokens.value,
      requestTimeout: requestTimeout.value,
      username: username.value,
      supabaseUrl: supabaseUrl.value,
      supabaseAnonKey: supabaseAnonKey.value
    }
  }

  function importSettings(data) {
    if (data.aiProvider !== undefined && AI_PROVIDERS[data.aiProvider]) {
      applyProvider(data.aiProvider)
    } else {
      aiProvider.value = CUSTOM
    }
    if (data.aiEndpoint !== undefined) aiEndpoint.value = data.aiEndpoint
    if (data.aiApiKey !== undefined) aiApiKey.value = data.aiApiKey
    if (data.aiModel !== undefined) aiModel.value = data.aiModel
    if (THEMES.includes(data.theme)) theme.value = data.theme
    if (data.maxConcurrency !== undefined) maxConcurrency.value = toPositiveNumber(data.maxConcurrency, DEFAULT_MAX_CONCURRENCY)
    if (data.basicInfoMaxTokens !== undefined) basicInfoMaxTokens.value = toPositiveNumber(data.basicInfoMaxTokens, DEFAULT_BASIC_INFO_MAX_TOKENS)
    if (data.contextMaxTokens !== undefined) contextMaxTokens.value = toPositiveNumber(data.contextMaxTokens, DEFAULT_CONTEXT_MAX_TOKENS)
    if (data.articleMaxTokens !== undefined) articleMaxTokens.value = toPositiveNumber(data.articleMaxTokens, DEFAULT_ARTICLE_MAX_TOKENS)
    if (data.requestTimeout !== undefined) requestTimeout.value = toPositiveNumber(data.requestTimeout, DEFAULT_REQUEST_TIMEOUT)
    if (data.username !== undefined) username.value = data.username
    if (data.supabaseUrl !== undefined) supabaseUrl.value = data.supabaseUrl
    if (data.supabaseAnonKey !== undefined) supabaseAnonKey.value = data.supabaseAnonKey
    applyTheme()
    saveSettings()
  }

  loadSettings()

  watch([aiProvider, aiEndpoint, aiApiKey, aiModel, theme, maxConcurrency, basicInfoMaxTokens, contextMaxTokens, articleMaxTokens, requestTimeout, username, supabaseUrl, supabaseAnonKey], saveSettings)

  return {
    aiProvider,
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
    selectedProvider,
    isPreset,
    isDark,
    applyProvider,
    loadSettings,
    saveSettings,
    isConfigured,
    toggleTheme,
    applyTheme,
    exportSettings,
    importSettings
  }
})
