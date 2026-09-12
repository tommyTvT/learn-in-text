import { defineStore } from 'pinia'
import { ref, computed, watch, nextTick } from 'vue'
import { useAuthStore } from './auth'
import { fetchCloudSettings, pushCloudSettings } from '../services/settingsSync'
import type { ModelConfig, PresetProvider, Provider, SettingsData, SettingsImportData, Theme } from '../types'

const STORAGE_KEY = 'learn_in_text_settings'
// 记录本地设置最后修改/同步时间，用于云端设置 LWW 冲突解决
const SETTINGS_TIME_KEY = 'learn_in_text_settings_time'

// 云存储（Supabase）内置配置：来自 .env 中的 VITE_ 环境变量，
// 让用户无需在设置页手动输入。配置为空时需在 .env 中填写。
const BUILTIN_SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL || '').trim()
const BUILTIN_SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim()

export const PRESET_PROVIDERS: Record<string, PresetProvider> = {
  deepseek: {
    name: 'DeepSeek',
    endpoint: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash'
  }
}

const THEMES: Theme[] = ['system', 'light', 'dark']
// 导出数值类默认值：设置页的输入校验需要在非法值（0 / 负数 / 清空）时回退到默认值，
// 直接引用这里可避免两处各写一份、日后改默认值只改一处的遗漏
export const DEFAULT_MAX_CONCURRENCY = 50
export const DEFAULT_BASIC_INFO_MAX_TOKENS = 300
export const DEFAULT_CONTEXT_MAX_TOKENS = 300
export const DEFAULT_ARTICLE_MAX_TOKENS = 2000
export const DEFAULT_REQUEST_TIMEOUT = 30
const DEFAULT_AUTO_SYNC = true
// 划词翻译（选区翻译 + 追问解析）
const DEFAULT_ENABLE_SELECTION_TRANSLATION = true
// 点击单词自动发音（浏览器原生 TTS）
const DEFAULT_AUTO_PRONOUNCE = true
export const DEFAULT_SELECTION_MAX_TOKENS = 500
export const DEFAULT_SELECTION_CHAT_MAX_TOKENS = 1000
// 词义生成：合批请求（把多个单词打包进一次 AI 请求，按所在句子分组）
const DEFAULT_ENABLE_BATCH_WORD_REQUEST = true
// 词义生成：按需生成（进入文章不自动生成词义，仅点击单词时生成）
const DEFAULT_ENABLE_ON_DEMAND_WORD_GENERATION = false

function toPositiveNumber(value: unknown, fallback: number): number {
  const num = Number(value)
  return Number.isFinite(num) && num > 0 ? num : fallback
}

function systemPrefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

let providerSeq = 0

function createPresetProvider(presetKey: string): Provider {
  const preset = PRESET_PROVIDERS[presetKey]
  return {
    id: 'preset-' + presetKey,
    name: preset.name,
    preset: presetKey,
    endpoint: preset.endpoint,
    apiKey: ''
  }
}

/** 规范化暴露模型列表：非数组视为未配置（undefined = 默认全部暴露） */
function normalizeExposedModels(raw: any): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  return raw.filter((m: any) => typeof m === 'string')
}

/** 供应商（共享资源池）只保留连接信息，模型选择下放到「文本模型 / 视觉模型」配置 */
function normalizeProvider(raw: any): Provider | null {
  if (!raw || typeof raw !== 'object') return null
  if (raw.preset) {
    // 已下架的预设直接丢弃
    if (!PRESET_PROVIDERS[raw.preset]) return null
    // 预设供应商的端点始终跟随预设定义，仅 apiKey 允许用户自定义
    const base = createPresetProvider(raw.preset)
    return { ...base, apiKey: raw.apiKey || '', exposedModels: normalizeExposedModels(raw.exposedModels) }
  }
  return {
    id: raw.id || 'custom-' + Date.now().toString(36) + '-' + (++providerSeq),
    name: raw.name || '自定义供应商',
    preset: null,
    endpoint: raw.endpoint || '',
    apiKey: raw.apiKey || '',
    exposedModels: normalizeExposedModels(raw.exposedModels)
  }
}

/** 规范化单份模型配置：{ providerId, model } */
function normalizeModelConfig(raw: any, providers: Provider[]): ModelConfig {
  if (raw && typeof raw === 'object' && providers.some(p => p.id === raw.providerId)) {
    return { providerId: raw.providerId, model: raw.model || '' }
  }
  return { providerId: providers[0]?.id || '', model: '' }
}

/**
 * 解析文本/视觉模型配置，兼容旧结构（供应商内嵌 model/visionModel + activeProviderId）。
 * 返回 { text, vision }。
 */
function resolveModelConfigs(data: any, providers: Provider[]): { text: ModelConfig; vision: ModelConfig } {
  let text = normalizeModelConfig(data?.textModelConfig, providers)
  let vision = normalizeModelConfig(data?.visionModelConfig, providers)

  const oldProviders = Array.isArray(data?.providers) ? data.providers : []
  if (oldProviders.length) {
    const active = oldProviders.find((p: any) => p.id === data?.activeProviderId) || oldProviders[0]
    if (!data?.textModelConfig && active?.model) {
      text = { providerId: active.id, model: active.model }
    }
    if (!data?.visionModelConfig) {
      const vp = oldProviders.find((p: any) => p.visionModel)
      vision = vp
        ? { providerId: vp.id, model: vp.visionModel }
        : { providerId: text.providerId, model: '' }
    }
  }
  return { text, vision }
}

export const useSettingsStore = defineStore('settings', () => {
  const providers = ref<Provider[]>([])
  // 文本模型配置与视觉模型配置：各自独立选择（供应商可共用，模型可不同）
  const textModelConfig = ref<ModelConfig>({ providerId: '', model: '' })
  const visionModelConfig = ref<ModelConfig>({ providerId: '', model: '' })
  const theme = ref<Theme>('system')
  const maxConcurrency = ref(DEFAULT_MAX_CONCURRENCY)
  const basicInfoMaxTokens = ref(DEFAULT_BASIC_INFO_MAX_TOKENS)
  const contextMaxTokens = ref(DEFAULT_CONTEXT_MAX_TOKENS)
  const articleMaxTokens = ref(DEFAULT_ARTICLE_MAX_TOKENS)
  const requestTimeout = ref(DEFAULT_REQUEST_TIMEOUT)
  const supabaseUrl = ref('')
  const supabaseAnonKey = ref('')
  const autoSync = ref(DEFAULT_AUTO_SYNC)
  const debugMode = ref(false)
  const enableSelectionTranslation = ref(DEFAULT_ENABLE_SELECTION_TRANSLATION)
  const selectionMaxTokens = ref(DEFAULT_SELECTION_MAX_TOKENS)
  const selectionChatMaxTokens = ref(DEFAULT_SELECTION_CHAT_MAX_TOKENS)
  const autoPronounce = ref(DEFAULT_AUTO_PRONOUNCE)
  // 词义生成：合批请求 / 按需生成（详见设置页「词义生成」区块）
  const enableBatchWordRequest = ref(DEFAULT_ENABLE_BATCH_WORD_REQUEST)
  const enableOnDemandWordGeneration = ref(DEFAULT_ENABLE_ON_DEMAND_WORD_GENERATION)

  // ---- 设置同步（LWW）状态 ----
  // 本地最后修改时间戳；应用云端设置时不计入「本地修改」，避免触发回传循环
  let silentApply = false
  const syncedAt = ref(0)         // 上次成功与云端同步的时间（成功拉取/推送后更新）
  const cloudSyncing = ref(false) // 同步进行中标志，避免并发

  function loadSyncTimes(): void {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_TIME_KEY) || 'null')
      syncedAt.value = raw?.syncedAt || 0
    } catch {
      syncedAt.value = 0
    }
  }
  function persistSyncTimes(): void {
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

  let systemDarkListener: ((e: MediaQueryListEvent) => void) | null = null

  function applyTheme(): void {
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

  function toggleTheme(): void {
    theme.value = isDark.value ? 'light' : 'dark'
    applyTheme()
  }

  // ---- 供应商管理（共享资源池） ----

  function addCustomProvider(): Provider {
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

  function removeProvider(id: string): void {
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

  function setTextModel(providerId: string, model: string): void {
    const pid = providers.value.some(p => p.id === providerId)
      ? providerId
      : textModelConfig.value.providerId
    textModelConfig.value = { providerId: pid, model: model || '' }
  }

  function setVisionModel(providerId: string, model: string): void {
    const pid = providers.value.some(p => p.id === providerId)
      ? providerId
      : visionModelConfig.value.providerId
    visionModelConfig.value = { providerId: pid, model: model || '' }
  }

  function loadSettings(): void {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      const data = saved ? JSON.parse(saved) : {}

      if (Array.isArray(data.providers) && data.providers.length) {
        providers.value = data.providers.map(normalizeProvider).filter((p: any): p is Provider => p != null)
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
      autoPronounce.value = data.autoPronounce !== undefined ? !!data.autoPronounce : DEFAULT_AUTO_PRONOUNCE
      enableBatchWordRequest.value = data.enableBatchWordRequest !== undefined ? !!data.enableBatchWordRequest : DEFAULT_ENABLE_BATCH_WORD_REQUEST
      enableOnDemandWordGeneration.value = data.enableOnDemandWordGeneration !== undefined ? !!data.enableOnDemandWordGeneration : DEFAULT_ENABLE_ON_DEMAND_WORD_GENERATION
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
  }

  function saveSettings(): void {
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
        enableSelectionTranslation: enableSelectionTranslation.value,
        selectionMaxTokens: selectionMaxTokens.value,
        selectionChatMaxTokens: selectionChatMaxTokens.value,
        autoPronounce: autoPronounce.value,
        enableBatchWordRequest: enableBatchWordRequest.value,
        enableOnDemandWordGeneration: enableOnDemandWordGeneration.value
      }))
    } catch (e) {
      console.error('保存设置失败:', e)
    }
  }

  /** 文本模型是否已配置（供应商 endpoint + apiKey 齐全） */
  function isConfigured(): boolean {
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
      enableSelectionTranslation: enableSelectionTranslation.value,
      selectionMaxTokens: selectionMaxTokens.value,
      selectionChatMaxTokens: selectionChatMaxTokens.value,
      autoPronounce: autoPronounce.value,
      enableBatchWordRequest: enableBatchWordRequest.value,
      enableOnDemandWordGeneration: enableOnDemandWordGeneration.value
    }
  }

  function importSettings(data: SettingsImportData): void {
    if (Array.isArray(data.providers) && data.providers.length) {
      providers.value = data.providers.map(normalizeProvider).filter((p: any): p is Provider => p != null)
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
    if (data.enableSelectionTranslation !== undefined) enableSelectionTranslation.value = !!data.enableSelectionTranslation
    if (data.selectionMaxTokens !== undefined) selectionMaxTokens.value = toPositiveNumber(data.selectionMaxTokens, DEFAULT_SELECTION_MAX_TOKENS)
    if (data.selectionChatMaxTokens !== undefined) selectionChatMaxTokens.value = toPositiveNumber(data.selectionChatMaxTokens, DEFAULT_SELECTION_CHAT_MAX_TOKENS)
    if (data.autoPronounce !== undefined) autoPronounce.value = !!data.autoPronounce
    if (data.enableBatchWordRequest !== undefined) enableBatchWordRequest.value = !!data.enableBatchWordRequest
    if (data.enableOnDemandWordGeneration !== undefined) enableOnDemandWordGeneration.value = !!data.enableOnDemandWordGeneration
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
    // username 并不存在于设置结构中（历史兼容写法），此处断言以保留原有解构语义
    const { supabaseUrl, supabaseAnonKey, username, ...rest } = s as SettingsData & { username?: string }
    return rest
  }

  /** 将云端设置应用到本地（不标记为本地修改）。同样排除环境配置字段。 */
  function applyCloudSettings(payload: any): void {
    const { supabaseUrl, supabaseAnonKey, username, ...rest } = payload || {}
    silentApply = true
    try {
      importSettings(rest)
    } finally {
      // 与 resetSettings 同理：watch 回调为异步 flush，silentApply 必须维持到
      // 回调执行完再复位。否则刚应用的云端设置会被 watcher 当作本地修改，
      // 触发回声推送并以新的 updatedAt 覆盖其他设备尚未上传的真实修改。
      nextTick(() => { silentApply = false })
    }
  }

  /** 登录后从云端拉取设置：云端较新则以云端覆盖本地 */
  async function syncFromCloud(): Promise<void> {
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

  // 拉取/推送后的回声防护窗口（毫秒）：窗口内的上传推迟执行
  const PUSH_ECHO_GUARD_MS = 3000
  // 上传防抖定时器
  let uploadTimer: ReturnType<typeof setTimeout> | null = null

  /** 本地设置变更后上传到云端 */
  async function pushToCloud(): Promise<void> {
    const auth = useAuthStore()
    const username = auth.username?.trim()
    // isLoggedIn 必查：本地身份快照会在未登录时也提供 username，
    // 只判断 username 会在会话失效后仍尝试推送（必然 401/RLS 失败）
    if (!username || !auth.isLoggedIn || cloudSyncing.value) return

    const now = Date.now()
    const waitMs = syncedAt.value + PUSH_ECHO_GUARD_MS - now
    if (waitMs > 0) {
      // 刚完成拉取/推送：推迟到防护窗口结束后再上传，
      // 而不是直接丢弃——丢弃会静默吞掉窗口内的真实修改
      if (uploadTimer) clearTimeout(uploadTimer)
      uploadTimer = setTimeout(() => {
        uploadTimer = null
        pushToCloud()
      }, waitMs)
      return
    }

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
  function scheduleUpload(): void {
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
  async function resetSettings(): Promise<void> {
    silentApply = true
    try {
      providers.value = [createPresetProvider('deepseek')]
      textModelConfig.value = { providerId: providers.value[0].id, model: PRESET_PROVIDERS.deepseek.model }
      visionModelConfig.value = { providerId: providers.value[0].id, model: '' }
      theme.value = 'system'
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
      autoPronounce.value = DEFAULT_AUTO_PRONOUNCE
      enableBatchWordRequest.value = DEFAULT_ENABLE_BATCH_WORD_REQUEST
      enableOnDemandWordGeneration.value = DEFAULT_ENABLE_ON_DEMAND_WORD_GENERATION
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
      await nextTick()
    } finally {
      silentApply = false
    }
  }

  loadSettings()
  loadSyncTimes()

  // 全部设置字段变更 → 保存到本地；其中参与云端同步的字段变更 → 防抖上传。
  // supabaseUrl / supabaseAnonKey 是本机环境配置（导出 payload 时排除），
  // 其变更只存本地，不应触发一次注定无效的云端上传。
  const envOnlyFields = [supabaseUrl, supabaseAnonKey]
  const syncedFields = [providers, textModelConfig, visionModelConfig, theme, maxConcurrency, basicInfoMaxTokens, contextMaxTokens, articleMaxTokens, requestTimeout, autoSync, debugMode, enableSelectionTranslation, selectionMaxTokens, selectionChatMaxTokens, autoPronounce, enableBatchWordRequest, enableOnDemandWordGeneration]
  const allFields = [...syncedFields, ...envOnlyFields]

  watch(allFields, () => {
    if (silentApply) return
    saveSettings()
  }, { deep: true })

  watch(syncedFields, () => {
    if (silentApply) return
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
    enableSelectionTranslation,
    selectionMaxTokens,
    selectionChatMaxTokens,
    autoPronounce,
    enableBatchWordRequest,
    enableOnDemandWordGeneration,
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
    exportSettings,
    importSettings,
    resetSettings,
    syncFromCloud,
    pushToCloud,
    cloudSyncing
  }
})
