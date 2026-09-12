/**
 * 设置域类型（纯类型模块，不含任何运行时代码）。
 *
 * 与 stores/settings.ts 的持久化结构保持一致：
 * 本地 localStorage、云端设置快照、设置备份文件共用同一套字段定义。
 */

/** 主题模式 */
export type Theme = 'system' | 'light' | 'dark'

/** 内置预设供应商定义（不可编辑，仅用于展开初始连接信息） */
export interface PresetProvider {
  name: string
  endpoint: string
  model: string
}

/** 供应商（共享资源池）：preset 非空表示由内置预设展开而来 */
export interface Provider {
  id: string
  name: string
  preset: string | null
  endpoint: string
  apiKey: string
  /**
   * 暴露给用户的模型 id 列表（供应商管理中勾选）。
   * undefined = 未配置，默认全部模型可暴露（兼容存量配置）；
   * 数组（含空数组）= 仅列表内的模型出现在用户可选模型列表中。
   */
  exposedModels?: string[]
}

/** 模型配置：文本 / 视觉各自独立选择供应商与模型名 */
export interface ModelConfig {
  providerId: string
  model: string
}

/** 设置的完整持久化结构 */
export interface SettingsData {
  providers: Provider[]
  textModelConfig: ModelConfig
  visionModelConfig: ModelConfig
  theme: Theme
  maxConcurrency: number
  basicInfoMaxTokens: number
  contextMaxTokens: number
  articleMaxTokens: number
  requestTimeout: number
  supabaseUrl: string
  supabaseAnonKey: string
  autoSync: boolean
  debugMode: boolean
  enableSelectionTranslation: boolean
  selectionMaxTokens: number
  selectionChatMaxTokens: number
  autoPronounce: boolean
  enableBatchWordRequest: boolean
  enableOnDemandWordGeneration: boolean
}

/**
 * 参与云端同步的设置字段。
 * supabaseUrl / supabaseAnonKey 属于本机环境配置，不随云端设置覆盖，故排除。
 */
export type SyncedSettings = Omit<SettingsData, 'supabaseUrl' | 'supabaseAnonKey'>

/**
 * 设置导入 / 应用的宽松入参：
 * 来源可能是旧版本本地存储、备份文件或云端快照，字段不完整且结构会演进，
 * 因此按「外部不可控数据」处理，由 store 内逐字段做类型守卫后再写入。
 */
export type SettingsImportData = Record<string, any>

/** 云端设置记录（services/settingsSync.ts） */
export interface CloudSettingsRecord {
  /** 云端记录的最后更新时间（毫秒时间戳） */
  updatedAt: number
  settings: Partial<SettingsData>
}
