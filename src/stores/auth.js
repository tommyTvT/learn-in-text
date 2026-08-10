import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getSupabase } from '../lib/supabase'
import * as authService from '../services/auth'
import { useSettingsStore } from './settings'

/**
 * 认证状态 store：统一管理登录态、用户名、注册/登录/登出/会话恢复。
 * 供视图（Login/Register/AppHeader/Settings）与同步服务消费。
 */
export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)        // Supabase Auth 用户对象
  const session = ref(null)     // 当前会话
  const username = ref('')      // profiles 中绑定的业务用户名
  const ready = ref(false)      // 是否已完成会话恢复

  const isLoggedIn = computed(() => !!session.value)

  /** 从 session 同步 user / 用户名 */
  async function syncFromSession(currentSession) {
    session.value = currentSession || null
    user.value = currentSession?.user || null
    if (currentSession?.user) {
      username.value = await authService.fetchUsername(currentSession.user.id)
    } else {
      username.value = ''
    }
  }

  /** 登录/恢复会话后，若已登录则拉取并合并云端设置 */
  async function syncSettingsAfterLogin() {
    if (!session.value) return
    try {
      const settings = useSettingsStore()
      await settings.syncFromCloud()
    } catch (e) {
      console.error('同步云端设置失败:', e)
    }
  }

  /** 应用启动 / 刷新时恢复会话 */
  async function restoreSession() {
    try {
      const currentSession = await authService.getSession()
      await syncFromSession(currentSession)
      await syncSettingsAfterLogin()
    } catch (e) {
      console.error('恢复会话失败:', e)
      session.value = null
      user.value = null
      username.value = ''
    } finally {
      ready.value = true
    }
  }

  /** 注册（注册成功即视为已登录） */
  async function register(payload) {
    const { session: newSession, user: newUser } = await authService.register(payload)
    await syncFromSession(newSession)
    await syncSettingsAfterLogin()
    return { session: newSession, user: newUser }
  }

  /** 登录 */
  async function login(payload) {
    const { session: newSession, user: newUser } = await authService.login(payload)
    await syncFromSession(newSession)
    await syncSettingsAfterLogin()
    return { session: newSession, user: newUser }
  }

  /** 登出：清空登录态 */
  async function logout() {
    await authService.logout()
    session.value = null
    user.value = null
    username.value = ''
  }

  return {
    user,
    session,
    username,
    ready,
    isLoggedIn,
    syncFromSession,
    restoreSession,
    register,
    login,
    logout
  }
})

/** 获取当前登录用户名（供同步服务使用，未登录返回空字符串） */
export function getAuthUsername() {
  const store = useAuthStore()
  return store.username?.trim() || ''
}

/** 是否已登录（供同步服务判断） */
export function isAuthenticated() {
  const store = useAuthStore()
  return store.isLoggedIn
}
