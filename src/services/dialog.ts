// 统一弹窗服务：替代原生 alert/confirm（App 端无原生弹窗），基于 uni.showModal
// H5 端表现为样式化的模态框，与整体 UI 更协调

/** 提示弹窗（替代原生 alert），返回 Promise 便于 await */
export function alert(message: unknown, title = '提示'): Promise<void> {
  return new Promise((resolve) => {
    uni.showModal({
      title,
      content: String(message ?? ''),
      showCancel: false,
      confirmText: '确定',
      success: () => resolve(),
      fail: () => resolve(),
    })
  })
}

// 确认按钮配色：必须显式指定——平台默认文案色与弹窗背景几乎重合，确认按钮会「看不见」。
// 普通确认用页面主色，只有真正的破坏性操作（删除/清除且不可恢复）才用红色。
const CONFIRM_NEUTRAL_COLOR = '#2563eb'
const CONFIRM_DANGER_COLOR = '#dd524d'

/**
 * 确认弹窗（替代原生 confirm），resolve(true/false) 表示用户选择。
 * @param opts.destructive 破坏性操作（删除/清除且不可恢复）→ 确认按钮红色且默认文案为「删除」；
 *                         默认 false → 与页面主按钮一致的蓝色
 * @param opts.confirmColor 直接指定颜色，优先级高于 destructive（跨端只保证 #RRGGBB 生效）
 */
export function confirmDialog(
  message: unknown,
  title = '确认',
  opts: { confirmText?: string; cancelText?: string; destructive?: boolean; confirmColor?: string } = {},
): Promise<boolean> {
  return new Promise((resolve) => {
    uni.showModal({
      title,
      content: String(message ?? ''),
      confirmText: opts.confirmText ?? (opts.destructive ? '删除' : '确定'),
      cancelText: opts.cancelText ?? '取消',
      confirmColor: opts.confirmColor ?? (opts.destructive ? CONFIRM_DANGER_COLOR : CONFIRM_NEUTRAL_COLOR),
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    })
  })
}
