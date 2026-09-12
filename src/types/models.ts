/**
 * 业务实体类型（纯类型模块，不含任何运行时代码）。
 *
 * 字段与 services/db.ts 中各 Dexie 表结构一一对应；
 * 修改表结构时请同步更新本文件。
 */

/**
 * 时间字段的统一表示：
 * 本地写入时为 Date 实例，云端同步回写的是 ISO 字符串，同步快照中为毫秒时间戳。
 */
export type DateLike = Date | string | number

/** 云端行主键（Supabase 侧可能是 bigint 或 uuid） */
export type CloudRowId = number | string

/** 文章 */
export interface Article {
  /** Dexie 自增主键，仅入库后存在 */
  id?: number
  /** 同步业务键；老数据可能缺失（导出 / 同步前会补齐） */
  uid?: string
  title: string
  description?: string
  content: string
  /** 手动排序序位（升序）；缺失时按 updatedAt 倒序兜底 */
  sortOrder?: number | null
  createdAt: DateLike
  updatedAt: DateLike
}

/** 新建文章入参：id / uid / 时间戳由数据层生成 */
export type ArticleInput = Omit<Article, 'id' | 'uid' | 'createdAt' | 'updatedAt'> & {
  uid?: string
  createdAt?: DateLike
  updatedAt?: DateLike
}

/** 词义条目（由 db 层 splitDefinition 从 "abbr. 释义" 解析而来） */
export interface WordDefinition {
  partOfSpeech: string
  meaning: string
}

/** 单词（word + articleId 组合唯一） */
export interface Word {
  id?: number
  /** 已归一化为小写 */
  word: string
  articleId: number
  definitions?: WordDefinition[]
  examples?: string[]
  /** 词义来源：'common'（内置词表）/ 'ai' / ''（无） */
  source?: string
  phonetic?: string
  updatedAt?: DateLike
}

/** 新建单词入参：id / updatedAt 由数据层生成 */
export type WordInput = Omit<Word, 'id' | 'updatedAt'> & { updatedAt?: DateLike }

/** 标记：文章 × 单词 × 出现位置 */
export interface WordMark {
  id?: number
  wordId: number
  articleId: number
  /** 出现位置键；空串表示按单词维度标记（无具体位置） */
  occKey: string
  createdAt?: DateLike
  updatedAt?: DateLike
}

/** 语境翻译（wordId + articleId + occKey 组合唯一） */
export interface ContextTranslation {
  id?: number
  wordId: number
  articleId: number
  occKey: string
  translation: string
  createdAt?: DateLike
  updatedAt?: DateLike
}

/** 划词翻译缓存（articleId + selectionHash 组合唯一） */
export interface SelectionTranslation {
  id?: number
  articleId: number
  selectionHash: string
  text: string
  translation: string
  createdAt?: DateLike
  updatedAt?: DateLike
}

/** 旧版墓碑（v7 删除黑名单；v8 起仅保留定义供一次性迁移读取） */
export interface Tombstone {
  id?: number
  table: string
  key: string
  createdAt?: DateLike
}

/** 同步快照（v8 白名单：上次同步成功时各表业务键、更新时间与云端 id） */
export interface SyncSnapshot {
  id?: number
  table: string
  key: string
  /** 上次同步时该行的 updatedAt（毫秒时间戳）；合成占位行可能缺失 */
  updatedAt: number | null
  /** 对应云端行 id，增量同步时用于直达记录 */
  cloudId?: CloudRowId | null
}

/** 缓存统计（db.cacheService.getStats） */
export interface CacheStats {
  words: number
  contextTranslations: number
  selectionTranslations: number
}

/** 缓存清理开关 */
export interface CacheClearTypes {
  words?: boolean
  contextTranslations?: boolean
  selectionTranslations?: boolean
}

/** 缓存清理结果（db.cacheService.clearCaches） */
export interface CacheClearResult {
  words: number
  contextTranslations: number
  selectionTranslations: number
}

/** 本地数据量统计（db.exportService.getDataStats） */
export interface DataStats {
  articles: number
  words: number
  wordMarks: number
  contextTranslations: number
  selectionTranslations: number
}

/** 全量备份导入统计（db.exportService.importFull） */
export interface ImportStats {
  articles: number
  words: number
  marks: number
  translations: number
  selectionTranslations: number
  skipped: number
}

/** 导出的词条目（含引用重映射用的业务键） */
export interface ExportedWord {
  word: string
  definitions?: WordDefinition[]
  examples?: string[]
  source?: string
  phonetic?: string
  articleUid?: string | null
}

/** 单篇导出文件（v2） */
export interface ArticleExportFile {
  version: 2
  type: 'article'
  exportDate: string
  article: {
    title: string
    description: string
    content: string
    sortOrder?: number | null
    createdAt?: DateLike
    updatedAt?: DateLike
  }
  words: Array<Pick<Word, 'word' | 'definitions' | 'examples'>>
  markedWords: string[]
}

/** 全量备份文件（v3）。备份内各表行按导出维度裁剪字段（引用改为业务键），
 *  故用宽松行类型承载，导入端逐字段取值并做类型守卫。 */
export interface FullBackupFile {
  version: 3
  type: 'full_backup'
  exportDate: string
  data: {
    articles: Array<Record<string, unknown>>
    words: Array<Record<string, unknown>>
    wordMarks: Array<Record<string, unknown>>
    contextTranslations: Array<Record<string, unknown>>
    selectionTranslations: Array<Record<string, unknown>>
  }
}
