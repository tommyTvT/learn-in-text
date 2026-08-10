import { createClient } from '@supabase/supabase-js'
import { useSettingsStore } from '../stores/settings'

let client = null
let clientConfig = null

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

  if (!client || clientConfig?.url !== url || clientConfig?.anonKey !== anonKey) {
    client = createClient(url, anonKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false
      }
    })
    clientConfig = { url, anonKey }
  }

  return client
}
