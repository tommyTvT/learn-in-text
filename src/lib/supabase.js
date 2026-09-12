import { createClient } from '@supabase/supabase-js'
import { useSettingsStore } from '../stores/settings'

// 单例挂在 window/globalThis 上，而不是模块级变量：
// 开发模式下 Vite HMR 会重新执行本模块，模块级变量会被重置，
// 导致每次热更新都 createClient 出新实例，触发 GoTrueClient
// "Multiple GoTrueClient instances" 警告。挂全局后 HMR 也能复用旧实例。
const GLOBAL_KEY = '__learn_in_text_supabase__'
const holder = typeof window !== 'undefined' ? window : globalThis

/** 归一化配置：去首尾空白 + 去掉 URL 末尾多余的斜杠，避免仅因格式差异重建客户端 */
function normalizeConfig(value) {
  return (value || '').trim().replace(/\/+$/, '')
}

/**
 * 获取 Supabase 客户端单例；未配置时返回 null（不抛异常）。
 * 从 settings store 读取 supabaseUrl 和 supabaseAnonKey 动态创建。
 */
export function getSupabaseOrNull() {
  let settings
  try {
    settings = useSettingsStore()
  } catch {
    // Pinia 尚未就绪（极端启动时序）：视为未配置
    return null
  }

  const url = normalizeConfig(settings.supabaseUrl)
  const anonKey = normalizeConfig(settings.supabaseAnonKey)
  if (!url || !anonKey) return null

  let state = holder[GLOBAL_KEY]
  if (!state) {
    state = holder[GLOBAL_KEY] = { client: null, config: null }
  }

  if (!state.client || state.config?.url !== url || state.config?.anonKey !== anonKey) {
    // 重建客户端前必须先停掉旧实例的自动刷新定时器：
    // 否则新旧两个 GoTrueClient 会各自持有同一份 refresh token 并发续期，
    // 触发服务端 refresh token 复用检测（rotation 复用 → 撤销整个会话家族），
    // 表现为「随机掉登录，且必须手动重新登录」。
    try {
      state.client?.auth?.stopAutoRefresh?.()
    } catch {
      // 旧实例已销毁等情况，忽略
    }

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

/**
 * 获取 Supabase 客户端单例。
 * 配置缺失时抛错（调用方需要明确提示用户先完成云存储配置）。
 */
export function getSupabase() {
  const client = getSupabaseOrNull()
  if (!client) {
    throw new Error('请先在设置页填写 Supabase 项目地址和 anon key')
  }
  return client
}
