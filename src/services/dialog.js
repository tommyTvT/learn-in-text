// 统一弹窗服务：替代原生 alert/confirm（App 端无原生弹窗），基于 uni.showModal
// H5 端表现为样式化的模态框，与整体 UI 更协调

/** 提示弹窗（替代原生 alert），返回 Promise 便于 await */
export function alert(message, title = '提示') {
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

/** 确认弹窗（替代原生 confirm），resolve(true/false) 表示用户选择 */
export function confirmDialog(message, title = '确认') {
  return new Promise((resolve) => {
    uni.showModal({
      title,
      content: String(message ?? ''),
      confirmText: '确定',
      cancelText: '取消',
      success: (res) => resolve(!!res.confirm),
      fail: () => resolve(false),
    })
  })
}
