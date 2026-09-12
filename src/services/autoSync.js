import { ref, watch } from 'vue'
import { useSettingsStore } from '../stores/settings'
import { useAuthStore } from '../stores/auth'
import { syncNow } from './sync'
import { getOwnershipPending } from './localData'

const LAST_SYNC_KEY = 'learn_in_text_last_sync'
// 跨标签页同步锁名：优先使用 Web Locks API（原子 try-acquire）
const LOCK_NAME = 'learn_in_text_sync_lock'
// 失败退避窗口（毫秒）：连续失败时避免高频重试
const RETRY_BACKOFF_MS = 60_000
// 自动同步固定间隔（分钟）：同步间隔固定为 5 分钟，不再由用户配置
const AUTO_SYNC_INTERVAL_MIN = 5

let timer = null
let started = false
let running = false
let lastAttemptAt = 0
let bootDelayTimer = null
let stopWatchers = []
// 暂停标志：本地数据归属决策进行中时阻止一切后台自动同步，
// 防止用户在弹窗上选择前，残留数据被 boot/切前台/网络恢复等触发源推给新账号
let paused = false

function readStoredState() {
  try {
    return JSON.parse(localStorage.getItem(LAST_SYNC_KEY) || 'null')
  } catch {
    return null
  }
}

/** 最近一次同步结果（成功/失败），设置页展示用 */
export const lastSyncState = ref(readStoredState())

function storeState(success, message) {
  const state = { success, message, at: Date.now() }
  try {
    localStorage.setItem(LAST_SYNC_KEY, JSON.stringify(state))
  } catch {
    // 忽略存储异常
  }
  lastSyncState.value = state
}

/** 同步触发来源的中文标签（调试输出用） */
const SOURCE_LABELS = {
  manual: '手动同步',
  auto: '自动定时',
  boot: '应用启动',
  visibility: '切回前台',
  online: '网络恢复',
  settings: '设置开启',
  route: '页面切换',
  login: '登录后同步'
}

/** 各表中文名（调试输出用） */
const TABLE_LABELS = {
  articles: '文章',
  words: '单词',
  word_marks: '标记',
  context_translations: '翻译'
}

/** 把统计对象（如 detail.pushed）转为「中文表名 → 数量」，只保留非零项 */
function nonzeroCounts(counts) {
  const out = {}
  for (const [table, value] of Object.entries(counts || {})) {
    if (value) out[TABLE_LABELS[table] || table] = value
  }
  return out
}

/**
 * debug 模式下的同步输出（浏览器控制台），仅当设置中开启「调试模式」时打印。
 * 自动同步每 5 分钟触发一次，为避免刷屏按结果分级输出：
 * - 失败：打印错误信息，便于排查；
 * - 成功但无数据变更：仅打印一行摘要（时间 · 来源 · 耗时）；
 * - 成功且有变更：打印分组详情，表格只列出发生变化的数据表。
 */
function debugLogSync(source, success, message, detail) {
  const settings = useSettingsStore()
  if (!settings.debugMode) return

  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  const sourceLabel = SOURCE_LABELS[source] || source || '未知'

  if (!success) {
    console.group(
      `%c[LearnInText 同步] %c${time} · ${sourceLabel} · ✘ 同步失败`,
      'color:#e5484d;font-weight:bold',
      'color:#8a8a8a'
    )
    console.error(message)
    console.groupEnd()
    return
  }

  const groups = [
    ['推送云端', detail?.pushed],
    ['本地新增', detail?.added],
    ['更新', detail?.updated],
    ['删除', detail?.deleted]
  ].map(([label, counts]) => [label, nonzeroCounts(counts)])
  const duration = detail ? `${(detail.durationMs / 1000).toFixed(2)}s` : '-'

  // 无变更（后台同步最常见的结果）：只留一行，不展开表格
  if (!groups.some(([, counts]) => Object.keys(counts).length)) {
    console.log(
      `%c[LearnInText 同步]%c ${time} · ${sourceLabel} · ✔ 无变更 · 耗时 ${duration}`,
      'color:#4f8cff;font-weight:bold',
      'color:#8a8a8a'
    )
    return
  }

  console.group(
    `%c[LearnInText 同步] %c${time} · ${sourceLabel} · ✔ 同步成功`,
    'color:#4f8cff;font-weight:bold',
    'color:#8a8a8a'
  )
  console.log(message)
  console.log(`耗时 ${duration} · ${detail?.incremental ? '增量同步' : '全量同步'}`)
  console.table(Object.fromEntries(groups.filter(([, counts]) => Object.keys(counts).length)))
  console.groupEnd()
}

/** 手动同步完成后，将结果同步到「上次同步」状态（供设置页展示），并在 debug 模式输出到控制台 */
export function setLastSyncState(success, message, detail = null, source = 'manual') {
  storeState(success, message)
  debugLogSync(source, success, message, detail)
}

/**
 * 登录成功后立即全量同步一次：登录是明确的同步意图，
 * 与手动同步同级，不受自动同步开关 / 失败退避 / paused 限制
 * （syncNow 自带并发合并锁，与进行中的同步安全复用）。
 * 结果写入「上次同步」状态；失败不抛出，不阻塞进入应用，
 * 后续可由自动同步或手动同步重试。
 * onProgress({ label, percent })：可选进度回调，透传给 syncNow 供登录页展示进度条。
 */
export async function syncAfterLogin(onProgress) {
  try {
    const result = await syncNow(onProgress)
    setLastSyncState(true, result.message, result.detail, 'login')
  } catch (error) {
    setLastSyncState(false, error.message || '同步失败', null, 'login')
  }
}

/** 清空本地数据后重置同步状态（登出清除 / 换号清除场景） */
export function resetLastSyncState() {
  try {
    localStorage.removeItem(LAST_SYNC_KEY)
  } catch {
    // 忽略存储异常
  }
  lastSyncState.value = null
}

/** 暂停后台自动同步（本地数据归属决策进行中） */
export function pauseAutoSync() {
  paused = true
}

/** 恢复后台自动同步（归属决策完成） */
export function resumeAutoSync() {
  paused = false
}

// 翻页触发的同步延迟防抖：切换页面后等待一段时间再执行，
// 避免与页面切换动画、首屏渲染抢占资源导致卡顿；多次快速翻页只同步一次。
const ROUTE_SYNC_DELAY_MS = 1500
let routeSyncTimer = null

/**
 * 公开的同步请求入口：受防重入 / 失败退避 / 跨标签页锁保护。
 * 供切换页面（路由）、网络恢复等场景调用；未配置或时机不合适时静默跳过。
 * 路由触发的同步延迟防抖执行，避免翻页瞬间抢资源。
 */
export function requestSync() {
  if (routeSyncTimer) clearTimeout(routeSyncTimer)
  routeSyncTimer = setTimeout(() => {
    routeSyncTimer = null
    runSync('route')
  }, ROUTE_SYNC_DELAY_MS)
}

function isConfigured() {
  const s = useSettingsStore()
  const auth = useAuthStore()
  // auth.ready：会话恢复完成（含用户名拉取）后才允许同步。
  // 否则重新打开页面时 session 已恢复但 username 还在请求中，
  // 同步会误报「请先登录后再同步」并写入上次同步状态。
  // username 为空时同样跳过：syncNow 需要用户名，缺失时静默跳过优于记录失败。
  return !!(
    auth.ready &&
    auth.isLoggedIn &&
    auth.username?.trim() &&
    s.supabaseUrl?.trim() &&
    s.supabaseAnonKey?.trim()
  )
}

/**
 * 自动同步开关是否生效：
 * 手动同步（设置页点击）不经过 runSync，直接调用 syncNow，不受此开关影响。
 * 其余所有自动触发源（翻页/启动/定时/切前台/网络恢复）都受该开关控制。
 */
function autoSyncEnabled() {
  const s = useSettingsStore()
  return !!s.autoSync
}

/**
 * 跨标签页同步锁：优先 Web Locks API（浏览器级原子 try-acquire，
 * 无 TTL 过期问题），不支持的环境退化为无锁执行。
 * 旧的 localStorage 时间戳锁存在读-改-写竞态，且 90s TTL 过期后
 * 慢同步期间其他标签页会并发进入，双写导致云端重复行，故弃用。
 */
function tryWithLock(fn) {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) {
    return Promise.resolve(fn())
  }
  return navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => {
    // 拿不到锁说明其他标签页正在同步：静默跳过本次
    if (!lock) return null
    return fn()
  })
}

/**
 * 执行一次后台同步（完全静默）：
 * 未配置 / 正在同步 / 失败退避期内 / 其他标签页正在同步 → 直接跳过。
 * source 用于调试输出，标明本次同步的触发来源。
 */
async function runSync(source = 'auto') {
  if (paused) return
  // 本地数据归属决策未完成：一切后台自动同步静默跳过。
  // 该标记持久化在 localStorage（区别于内存的 paused），弹窗未决时
  // 关闭/刷新页面后依然生效，防止残留数据被推给新账号或被误判删除。
  if (getOwnershipPending()) return
  if (!autoSyncEnabled()) return
  if (running || !isConfigured()) return
  if (Date.now() - lastAttemptAt < RETRY_BACKOFF_MS) return

  running = true
  lastAttemptAt = Date.now()
  try {
    await tryWithLock(async () => {
      try {
        const result = await syncNow()
        storeState(true, result.message)
        debugLogSync(source, true, result.message, result.detail)
      } catch (error) {
        const message = error.message || '同步失败'
        storeState(false, message)
        debugLogSync(source, false, message, null)
      }
    })
  } finally {
    running = false
  }
}

function intervalMs() {
  return AUTO_SYNC_INTERVAL_MIN * 60_000
}

function clearTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

function scheduleTimer() {
  clearTimer()
  const s = useSettingsStore()
  if (!s.autoSync) return
  timer = setInterval(() => runSync('auto'), intervalMs())
}

function onVisibility() {
  if (document.visibilityState !== 'visible') return
  const s = useSettingsStore()
  if (!s.autoSync) return
  // 切回前台：距上次同步超过间隔（或从未同步过）则立即补一次
  const state = lastSyncState.value
  if (!state || Date.now() - state.at > intervalMs()) {
    runSync('visibility')
  }
}

function onOnline() {
  runSync('online')
}

/**
 * 启动后台自动同步：
 * 1. 打开应用后延迟数秒静默同步一次（等首屏渲染完成，避免抢占资源）；
 * 2. 按设置中的间隔定时同步；
 * 3. 从后台切回前台 / 网络恢复时按需补同步；
 * 4. 自动同步开关或间隔变化时自动重启定时器。
 */
export function startAutoSync() {
  if (started) return
  started = true

  bootDelayTimer = setTimeout(() => runSync('boot'), 3000)

  scheduleTimer()

  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('online', onOnline)

  const settings = useSettingsStore()
  stopWatchers.push(
    watch(
      () => settings.autoSync,
      (newAutoSync, oldAutoSync) => {
        scheduleTimer()
        // 开关刚打开时立即补一次同步
        if (newAutoSync && !oldAutoSync && isConfigured()) {
          runSync('settings')
        }
      }
    )
  )
}

/** 停止后台自动同步（释放定时器、事件监听与 watcher）。 */
export function stopAutoSync() {
  started = false
  if (bootDelayTimer) {
    clearTimeout(bootDelayTimer)
    bootDelayTimer = null
  }
  if (routeSyncTimer) {
    clearTimeout(routeSyncTimer)
    routeSyncTimer = null
  }
  clearTimer()
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('online', onOnline)
  stopWatchers.forEach((fn) => fn())
  stopWatchers = []
}
