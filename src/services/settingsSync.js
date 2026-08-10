import { getSupabase } from '../lib/supabase'

/**
 * 设置同步 API 层：读写云端 user_settings 表。
 * 冲突解决采用 LWW（最近修改者胜出），由调用方比较 updatedAt 决定方向。
 */

/** 拉取云端设置（返回 null 表示云端无记录） */
export async function fetchCloudSettings(username) {
  const supabase = getSupabase()
  const { data, error } = await supabase
    .from('user_settings')
    .select('settings, updatedAt')
    .eq('username', username)
    .maybeSingle()
  if (error) throw new Error('拉取云端设置失败：' + error.message)
  if (!data) return null
  return {
    settings: data.settings || {},
    updatedAt: data.updatedAt ? new Date(data.updatedAt).getTime() : 0
  }
}

/** 推送本地设置到云端（upsert，按 username 唯一） */
export async function pushCloudSettings(username, settings, updatedAt) {
  const supabase = getSupabase()
  const payload = {
    username,
    settings,
    updatedAt: new Date(updatedAt).toISOString()
  }
  const { error } = await supabase.from('user_settings').upsert(payload, { onConflict: 'username' })
  if (error) throw new Error('上传云端设置失败：' + error.message)
}
