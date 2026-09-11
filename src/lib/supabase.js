import { createClient } from '@supabase/supabase-js'
import { useSettingsStore } from '../stores/settings'

// 单例挂在 window/globalThis 上，而不是模块级变量：
// 开发模式下 Vite HMR 会重新执行本模块，模块级变量会被重置，
// 导致每次热更新都 createClient 出新实例，触发 GoTrueClient
// "Multiple GoTrueClient instances" 警告。挂全局后 HMR 也能复用旧实例。
const GLOBAL_KEY = '__learn_in_text_supabase__'
const holder = typeof window !== 'undefined' ? window : globalThis

/**
 * 获取 Supabase 客户端单例。
 * 从 settings store 读取 supabaseUrl 和 supabaseAnonKey 动态创建。
 * 配置变化时重新创建。
 */
export function getSupabase() {
  const settings = useSettingsStore()
  const url = settings.supabaseUrl?.trim()
  const anonKey = settings.supabaseAnonKey?.trim()

  if (!url || !anonKey) {
    throw new Error('请先在设置页填写 Supabase 项目地址和 anon key')
  }

  let state = holder[GLOBAL_KEY]
  if (!state) {
    state = holder[GLOBAL_KEY] = { client: null, config: null }
  }

  if (!state.client || state.config?.url !== url || state.config?.anonKey !== anonKey) {
    state.client = createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true
      }
    })
    state.config = { url, anonKey }
  }

  return state.client
}
