/**
 * 轻量提示服务：基于 uni.showToast（H5 与小程序均可用，零依赖、无需自绘与管理生命周期）。
 * 与 dialog.ts（uni.showModal）保持同风格：返回 Promise 便于 await，任何失败静默处理，
 * 绝不因为提示本身失败而阻断业务流程。
 *
 * 使用约定：只用于「用户主动发起的动作」的结果反馈（导出 / 保存 / 导入 / 删除等）；
 * 后台自动同步等静默流程不要调用，避免打扰。
 */

export type ToastType = 'success' | 'error' | 'none'

export function toast(message: string, type: ToastType = 'success'): Promise<void> {
  return new Promise((resolve) => {
    uni.showToast({
      title: message,
      icon: type === 'success' ? 'success' : type === 'error' ? 'error' : 'none',
      // 错误信息通常更长，停留久一点便于阅读
      duration: type === 'error' ? 2500 : 1800,
      mask: false,
      success: () => resolve(),
      fail: () => resolve(),
    })
  })
}
