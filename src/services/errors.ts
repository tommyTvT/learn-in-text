/**
 * 错误文案归一化：把 unknown 类型的异常转换成可直接展示给用户的中文文案。
 *
 * 背景：services/ai.ts 抛出的消息本身就是可行动的中文（如「请先在设置中配置AI接口」、
 * 「请求失败 (401): ...」），但此前多数展示层只写死一句「XX失败」并把真实原因
 * console.error，用户点「重试」永远失败且无从得知要去改设置。
 * 这里统一把真实原因透出；仅在拿不到可用消息时才回退到 fallback。
 *
 * 展示层只报原因，不带堆栈、不带对象字符串化结果。
 */
export function errorText(e: unknown, fallback: string): string {
  if (e == null) return fallback
  if (typeof e === 'string') return e.trim() || fallback
  if (e instanceof Error) return (e.message || '').trim() || fallback
  if (typeof e === 'object') {
    const raw = (e as { message?: unknown }).message
    if (typeof raw === 'string' && raw.trim()) return raw.trim()
  }
  return fallback
}
