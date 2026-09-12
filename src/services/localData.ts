import { db, exportService } from './db'
import type { FullBackupFile } from '../types'

/**
 * 本地数据归属管理：
 * IndexedDB（LearnInText）是全设备单一库、无账号概念，
 * 用 localStorage 标记当前本地数据「属于哪个账号」，
 * 登录/登出时据此决定是否合并或清除，避免多账号数据串库。
 */
const DATA_OWNER_KEY = 'learn_in_text_data_owner'

export function getLocalDataOwner(): string {
  try {
    return localStorage.getItem(DATA_OWNER_KEY) || ''
  } catch {
    return ''
  }
}

export function setLocalDataOwner(username: string): void {
  try {
    localStorage.setItem(DATA_OWNER_KEY, username || '')
  } catch {
    // 忽略存储异常
  }
}

export function clearLocalDataOwner(): void {
  try {
    localStorage.removeItem(DATA_OWNER_KEY)
  } catch {
    // 忽略存储异常
  }
}

const OWNERSHIP_PENDING_KEY = 'learn_in_text_ownership_pending'

/**
 * 标记「本地数据归属决策待定」：登录/注册/邮箱验证成功、但用户尚未在
 * LocalDataModal 中处理残留数据时写入。存在期间所有后台自动同步被抑制
 * （autoSync.runSync 检查），防止弹窗未决时残留数据被推给新账号、
 * 或被误判为「别处已删除」而清掉。决策完成（或取消登录）后清除。
 */
export function setOwnershipPending(username: string): void {
  try {
    localStorage.setItem(OWNERSHIP_PENDING_KEY, username || '')
  } catch {
    // 忽略存储异常
  }
}

export function getOwnershipPending(): string {
  try {
    return localStorage.getItem(OWNERSHIP_PENDING_KEY) || ''
  } catch {
    return ''
  }
}

export function clearOwnershipPending(): void {
  try {
    localStorage.removeItem(OWNERSHIP_PENDING_KEY)
  } catch {
    // 忽略存储异常
  }
}

/** 本地数据概况（登录前的合并决策提示用） */
export async function getLocalDataStats(): Promise<{ articles: number; words: number; wordMarks: number }> {
  const [articles, words, wordMarks] = await Promise.all([
    db.articles.count(),
    db.words.count(),
    db.wordMarks.count()
  ])
  return { articles, words, wordMarks }
}

/** 清空本地全部数据（含同步快照与墓碑，防止残留状态污染下一次同步），并清除归属标记 */
export async function clearLocalData(): Promise<void> {
  await exportService.clearAllData()
  clearLocalDataOwner()
}

/** 导出全量备份并触发浏览器下载 */
export async function downloadFullBackup(settingsExport: unknown = null): Promise<void> {
  const data: FullBackupFile & { settings?: unknown } = await exportService.exportFull()
  if (settingsExport) data.settings = settingsExport
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `learn_in_text_backup_${new Date().toISOString().split('T')[0]}.json`
  a.click()
  URL.revokeObjectURL(url)
}
