/**
 * 原生文件选择器
 *
 * 为什么需要它：uni-app 编译器会把模板里的 <input type="file"> 转成
 * <uni-input> 组件，而 uni-input 内部给原生 input 加了 tabindex="-1" 与
 * onFocus → blur()，且不透传 accept / multiple，ref 也指向外层自定义元素，
 * 导致 .click() 无法唤起文件选择、change 事件收不到。
 * 因此改为运行时动态创建原生 input，绕开编译器。
 *
 * 注意：必须在用户手势的同步调用栈内调用（按钮 @click 直接调用即可），
 * 否则浏览器会拦截文件选择弹窗。
 */
export function pickFiles({ accept = '', multiple = false } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    if (accept) input.accept = accept
    if (multiple) input.multiple = true
    // 移出可视区域，避免影响布局
    input.style.position = 'fixed'
    input.style.left = '-9999px'
    input.style.top = '0'
    input.style.opacity = '0'
    const cleanup = (files) => {
      if (input.parentNode) input.parentNode.removeChild(input)
      resolve(files)
    }
    input.addEventListener('change', () => cleanup(Array.from(input.files || [])))
    // 用户取消选择（Chrome 90+ / 部分 WebView）
    input.addEventListener('cancel', () => cleanup([]))
    document.body.appendChild(input)
    input.click()
  })
}
