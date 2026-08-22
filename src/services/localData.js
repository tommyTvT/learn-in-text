import { db, exportService } from './db'

/**
 * 本地数据归属管理：
 * IndexedDB（LearnInText）是全设备单一库、无账号概念，
 * 用 localStorage 标记当前本地数据「属于哪个账号」，
 * 登录/登出时据此决定是否合并或清除，避免多账号数据串库。
 */
const DATA_OWNER_KEY = 'learn_in_text_data_owner'

export function getLocalDataOwner() {
  try {
    return localStorage.getItem(DATA_OWNER_KEY) || ''
  } catch {
    return ''
  }
}

export function setLocalDataOwner(username) {
  try {
    localStorage.setItem(DATA_OWNER_KEY, username || '')
  } catch {
    // 忽略存储异常
  }
}

export function clearLocalDataOwner() {
  try {
    localStorage.removeItem(DATA_OWNER_KEY)
  } catch {
    // 忽略存储异常
  }
}

/** 本地数据概况（登录前的合并决策提示用） */
export async function getLocalDataStats() {
  const [articles, words, wordMarks] = await Promise.all([
    db.articles.count(),
    db.words.count(),
    db.wordMarks.count()
  ])
  return { articles, words, wordMarks }
}

/** 清空本地全部数据（含 tombstone，防止残留删除标记污染下一次同步），并清除归属标记 */
export async function clearLocalData() {
  await exportService.clearAllData()
  clearLocalDataOwner()
}

/** 导出全量备份并触发浏览器下载 */
export async function downloadFullBackup(settingsExport = null) {
  const data = await exportService.exportFull()
  if (settingsExport) data.settings = settingsExport
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `learn_in_text_backup_${new Date().toISOString().split('T')[0]}.json`
  a.click()
  URL.revokeObjectURL(url)
}
