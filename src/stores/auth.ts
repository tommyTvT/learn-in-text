import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getSupabaseOrNull } from '../lib/supabase'
import * as authService from '../services/auth'
import { getLocalDataOwner } from '../services/localData'
import { useSettingsStore } from './settings'
import type { Session, User } from '@supabase/supabase-js'
import type { IdentitySnapshot } from '../services/auth'

/**
 * 认证状态 store：统一管理登录态、用户名、登录/登出/会话恢复。
 * 供视图（Login/AppHeader/Settings）与同步服务消费。
 *
 * 「登录保持」设计要点（历史上会随机掉登录的根因）：
 * 1. access token 过期后需要联网刷新。若此时离线/网络抖动，SDK 会返回
 *    「可重试错误」而不是「无会话」，本地 refresh token 其实还在。
 *    旧实现把任何异常都当作未登录，且启动只尝试一次、之后不再重试，
 *    于是用户必须手动重新登录。现在：区分可重试错误 + 自动重试 + 订阅
 *    onAuthStateChange，等 SDK 自动刷新成功后自动恢复登录态。
 * 2. 只有确认「会话已被云端撤销 / 本地确实没有会话」时才判定需要重新登录，
 *    且此时不清除本地学习数据与身份快照。
 * 3. 用户名从 JWT 元数据即时取得（无需网络），profiles 表查询只做后台校正，
 *    避免一次网络失败导致 username 为空、整个应用「像没登录」。
 */

// 会话恢复的短重试节奏（毫秒）：仅在「可重试错误」时使用。
// 更长期的恢复交给 SDK 自身的自动刷新（30s 一次）与 onAuthStateChange。
const RESTORE_RETRY_DELAYS = [1500, 4000, 9000]

export const useAuthStore = defineStore('auth', () => {
  const user = ref<User | null>(null)        // Supabase Auth 用户对象
  const session = ref<Session | null>(null)  // 当前会话
  const username = ref('')      // profiles 中绑定的业务用户名
  const ready = ref(false)      // 是否已完成会话恢复（首次尝试结束）
  // 本地是否存在「曾经登录过」的身份快照：用于区分「从未登录」与「登录态丢失」
  const identity = ref<IdentitySnapshot | null>(authService.readIdentity())
  // 会话是否只是「暂时读不出来」（离线/网络抖动/服务端故障）：为 true 时会自动重试
  const recoverable = ref(false)
  // 会话已被云端撤销 / refresh token 失效：需要用户重新登录
  const needsLogin = ref(false)
  // 最近一次恢复失败的可读原因（供登录页提示）
  const sessionError = ref('')

  const isLoggedIn = computed(() => !!session.value)
  const hasLocalIdentity = computed(() => !!identity.value?.userId)

  let authListenerBound = false
  let authSubscription: { unsubscribe?: () => void } | null = null
  let recoveryHooksBound = false
  let retryTimers: Array<ReturnType<typeof setTimeout>> = []
  // 主动登出时间戳：用于把「用户点了退出登录」和「SDK 判定会话失效」区分开
  let manualLogoutAt = 0

  function isManualLogout(): boolean {
    return Date.now() - manualLogoutAt < 5000
  }

  /** 记录/更新身份快照（含用户名校正） */
  function persistIdentity(currentSession: Session, name?: string): void {
    identity.value = {
      userId: currentSession.user.id,
      username: name || '',
      email: currentSession.user.email || '',
      at: Date.now()
    }
    authService.persistIdentity(currentSession.user, name)
  }

  /**
   * 用会话对象更新内存态（同步部分，不等待网络）。
   * 用户名优先取 JWT 元数据：离线/慢网时也能立即得到正确的账号身份。
   */
  function applySession(currentSession: Session | null): void {
    session.value = currentSession || null
    user.value = currentSession?.user || null

    if (!currentSession?.user) {
      // 会话不可用：保留身份快照中的用户名，让本地数据归属判断仍可进行
      username.value = identity.value?.username || ''
      return
    }

    const metaUsername = currentSession.user.user_metadata?.username || ''
    username.value = metaUsername || identity.value?.username || ''
    persistIdentity(currentSession, username.value)
    // 后台以 profiles 表为准校正（表数据可能比 JWT 元数据新），失败静默保留上面的值
    void refreshUsernameFromProfile(currentSession.user.id, metaUsername)
  }

  async function refreshUsernameFromProfile(userId: string, fallback: string): Promise<void> {
    const resolved = await authService.fetchUsername(userId, fallback)
    if (!resolved || resolved === username.value) return
    // 期间可能已切换账号/登出，确认仍是同一用户再写入
    if (session.value?.user?.id !== userId) return
    username.value = resolved
    persistIdentity(session.value!, resolved)
  }

  /** 登录/注册/恢复成功后，若已登录则拉取并合并云端设置。
   *  注意：login/register 不再自动调用（需先完成本地数据归属决策，
   *  否则会把上一账号的本地设置直接推给新账号云端），由视图在决策后调用。 */
  async function syncSettingsAfterLogin(): Promise<void> {
    if (!session.value) return
    try {
      const settings = useSettingsStore()
      await settings.syncFromCloud()
    } catch (e) {
      console.error('同步云端设置失败:', e)
    }
  }

  /** 仅当本地数据归属与当前账号一致时才同步云端设置：
   *  归属不一致（换号残留 / 邮箱验证场景）时必须先完成归属决策，
   *  否则 syncFromCloud 的「云端无记录则首推本地」分支会把上一账号
   *  的本地设置整包推给新账号的云端，造成跨账号设置污染。 */
  async function syncSettingsIfOwnerMatches(): Promise<void> {
    if (!session.value?.user) return
    if (getLocalDataOwner() !== username.value) return
    await syncSettingsAfterLogin()
  }

  /** 会话恢复成功后的收尾（设置同步等，不阻塞登录态生效） */
  async function finishRestore(): Promise<void> {
    await syncSettingsIfOwnerMatches()
  }

  function clearRetryTimers(): void {
    retryTimers.forEach((timer) => clearTimeout(timer))
    retryTimers = []
  }

  /** 会话已恢复/已登出：停止一切恢复重试 */
  function clearRecovery(): void {
    recoverable.value = false
    needsLogin.value = false
    clearRetryTimers()
  }

  /**
   * 单次恢复尝试。返回：
   * - 'ok'    ：拿到会话
   * - 'retry' ：暂时读不出来（本地会话仍在），应稍后重试
   * - 'none'  ：本地确实没有可用会话（未登录 / 已被撤销）
   */
  async function attemptRestore(): Promise<'ok' | 'retry' | 'none'> {
    const { session: current, error } = await authService.loadSession()

    if (current) {
      applySession(current)
      sessionError.value = ''
      await finishRestore()
      return 'ok'
    }

    if (error && authService.isRetryableAuthError(error)) {
      // 暂时性失败：本地 refresh token 仍在，等待自动重试/自动刷新
      sessionError.value = authService.readableError(error)
      return 'retry'
    }

    // 本地没有会话：可能是从未登录，也可能是 refresh token 已被云端撤销
    applySession(null)
    if (error) {
      sessionError.value = authService.readableError(error)
      needsLogin.value = true
    } else if (hasLocalIdentity.value) {
      // 有身份快照却没有会话 → 登录态确实丢了，需要重新登录
      sessionError.value = '登录状态已过期，请重新登录'
      needsLogin.value = true
    } else {
      sessionError.value = ''
    }
    return 'none'
  }

  /** 网络恢复 / 切回前台时立即补一次恢复尝试（同一客户端内的刷新会被 SDK 内部去重） */
  function ensureRecoveryHooks(): void {
    if (recoveryHooksBound || typeof window === 'undefined') return
    recoveryHooksBound = true
    window.addEventListener('online', () => {
      void retryRestore()
    })
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void retryRestore()
    })
  }

  /** 短时间内自动重试：只针对「暂时读不出来」的会话 */
  function scheduleRetry(): void {
    clearRetryTimers()
    ensureRecoveryHooks()
    RESTORE_RETRY_DELAYS.forEach((delay) => {
      retryTimers.push(setTimeout(() => {
        void retryRestore()
      }, delay))
    })
  }

  /** 重试恢复会话（可重入保护；已登录时直接返回） */
  async function retryRestore(): Promise<void> {
    if (session.value || needsLogin.value) return
    if (!recoverable.value) return
    const outcome = await attemptRestore()
    if (outcome === 'ok') {
      clearRecovery()
      return
    }
    if (outcome === 'none') {
      recoverable.value = false
      clearRetryTimers()
    }
  }

  /**
   * 订阅 Supabase 鉴权状态变化。
   * 关键作用：长时间关闭浏览器后重开，若首次恢复因为网络失败而未登录，
   * SDK 自身的自动刷新（30s 一次）成功后会发出 TOKEN_REFRESHED / SIGNED_IN，
   * 这里自动把应用切回已登录状态 —— 即「本地自动重登录」，无需手动输入密码。
   */
  function ensureAuthListener(): void {
    if (authListenerBound) return
    const supabase = getSupabaseOrNull()
    if (!supabase) return
    authListenerBound = true
    const { data } = supabase.auth.onAuthStateChange((event, newSession) => {
      // 回调在 SDK 内部锁中同步执行：不能直接调用其他 auth API（会死锁），
      // 因此更新应用状态的动作推迟到下一个宏任务。
      setTimeout(() => {
        void handleAuthEvent(event, newSession)
      }, 0)
    })
    authSubscription = data?.subscription || null
  }

  async function handleAuthEvent(event: string, newSession: Session | null): Promise<void> {
    if (event === 'SIGNED_OUT') {
      // 可能是用户主动登出，也可能是 SDK 判定会话失效后的清理。
      // 这里只清内存态：不清身份快照、不动本地数据，便于网络恢复后自动重登。
      if (session.value) applySession(null)
      if (!isManualLogout()) {
        // 运行期被判定会话失效（refresh token 被撤销等）：标记需重新登录并停止重试
        recoverable.value = false
        clearRetryTimers()
        needsLogin.value = true
        sessionError.value = '登录状态已过期，请重新登录'
      }
      return
    }
    if (!newSession) return

    const wasLoggedIn = !!session.value
    applySession(newSession)
    recoverable.value = false
    needsLogin.value = false
    sessionError.value = ''
    ready.value = true
    clearRetryTimers()

    if (!wasLoggedIn) {
      // 会话在运行期自动恢复（断网期间 access token 到期 → 恢复网络后刷新成功）
      await finishRestore()
    }
  }

  /**
   * 应用启动 / 刷新时恢复会话。
   * 短暂失败不判死：先完成首次尝试让 UI 就绪，再在后台按节奏自动重试。
   */
  async function restoreSession(): Promise<void> {
    const settings = useSettingsStore()
    if (!settings.supabaseUrl?.trim() || !settings.supabaseAnonKey?.trim()) {
      // 未配置云存储：无登录概念，直接标记就绪
      ready.value = true
      return
    }

    ensureAuthListener()

    try {
      const outcome = await attemptRestore()
      if (outcome === 'ok') {
        clearRecovery()
      } else if (outcome === 'retry') {
        recoverable.value = true
        scheduleRetry()
      }
    } catch (e) {
      console.error('恢复会话失败:', e)
      sessionError.value = authService.readableError(e)
      if (authService.isRetryableAuthError(e)) {
        recoverable.value = true
        scheduleRetry()
      }
    } finally {
      ready.value = true
    }
  }

  /** 兼容旧调用：更新内存态并在返回前取到用户名（邮箱验证等需要立刻用 username 的场景） */
  async function syncFromSession(currentSession: Session | null): Promise<void> {
    applySession(currentSession)
    if (currentSession?.user) {
      const resolved = await authService.fetchUsername(
        currentSession.user.id,
        currentSession.user.user_metadata?.username || ''
      )
      if (resolved && resolved !== username.value && session.value?.user?.id === currentSession.user.id) {
        username.value = resolved
        persistIdentity(currentSession, resolved)
      }
    }
    if (currentSession) {
      recoverable.value = false
      needsLogin.value = false
      sessionError.value = ''
      clearRetryTimers()
    }
  }

  /** 登录（邮箱直登）；云端设置同步由视图在归属决策后调用 syncSettingsAfterLogin */
  async function login(payload: { email: string; password: string }) {
    const { session: newSession, user: newUser } = await authService.login(payload)
    await syncFromSession(newSession)
    return { session: newSession, user: newUser }
  }

  /** 首次登录绑定用户名：手动创建的账号 profiles.username 为空时由视图引导调用。
   *  绑定成功后立即以 profiles 为准刷新本地用户名并更新身份快照。 */
  async function setUsername(name: string): Promise<void> {
    await authService.setUsername(name)
    if (session.value?.user) {
      const resolved = await authService.fetchUsername(session.value.user.id, name)
      const finalName = resolved || name
      username.value = finalName
      persistIdentity(session.value, finalName)
    }
  }

  /** 登出：清空登录态与本地身份快照。
   *  auth-js 的 signOut 在撤销令牌失败（如网络错误）时会返回错误，
   *  但本地会话实际已被清除；若此时中断，会出现「store 认为已登录、
   *  Supabase 本地已登出」的半登出状态。因此无论撤销成败都清空内存态。 */
  async function logout(): Promise<void> {
    manualLogoutAt = Date.now()
    try {
      await authService.logout()
    } catch (e) {
      console.warn('撤销云端会话失败（本地将照常登出）:', e)
    } finally {
      applySession(null)
      authService.clearIdentity()
      identity.value = null
      username.value = ''
      sessionError.value = ''
      clearRecovery()
    }
  }

  /** 释放订阅（热更新/测试场景用） */
  function dispose(): void {
    try {
      authSubscription?.unsubscribe?.()
    } catch {
      // 忽略
    }
    authSubscription = null
    authListenerBound = false
    clearRecovery()
  }

  return {
    user,
    session,
    username,
    ready,
    identity,
    recoverable,
    needsLogin,
    sessionError,
    hasLocalIdentity,
    isLoggedIn,
    syncFromSession,
    syncSettingsAfterLogin,
    restoreSession,
    retryRestore,
    setUsername,
    login,
    logout,
    dispose
  }
})

/** 获取当前登录用户名（供同步服务使用，未登录返回空字符串） */
export function getAuthUsername(): string {
  const store = useAuthStore()
  return store.username?.trim() || ''
}

/** 是否已登录（供同步服务判断） */
export function isAuthenticated(): boolean {
  const store = useAuthStore()
  return store.isLoggedIn
}
