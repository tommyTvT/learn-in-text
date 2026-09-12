import { onBeforeUnmount, onMounted, watch, nextTick, type Ref } from 'vue'

/**
 * 弹窗无障碍基座：把「对话框语义 + Esc 关闭 + 焦点移入/归还 + Tab 循环」
 * 收敛到一处，避免 8 个弹窗各自复制一份实现（行为不一致、易漏）。
 *
 * 使用方式：
 * ```ts
 * const panelRef = ref(null)
 * useDialogA11y({ isOpen: () => props.open, onClose: () => emit('close'), panelRef })
 * ```
 * 模板里面板元素需要：`ref="panelRef" role="dialog" aria-modal="true" aria-label="标题"`。
 *
 * 跨端：非 H5 端没有 document/window，整体降级为空操作（不监听、不聚焦、不报错），
 * 与 stores/auth.ts、services/tts.ts 既有的 `typeof window` 守卫写法保持一致。
 */
export interface DialogA11yOptions {
  /** 弹窗是否打开（函数形式，内部始终读取最新值） */
  isOpen: () => boolean
  /** 关闭回调（Esc 触发） */
  onClose: () => void
  /** 面板元素 ref：焦点移入、Tab 循环、关闭时归还焦点的范围基准 */
  panelRef?: Ref<HTMLElement | null>
  /** 打开时优先聚焦的选择器（默认取面板内第一个可聚焦元素） */
  initialFocusSelector?: string
  /** 是否允许 Esc 关闭（如「正在清除/提交」期间应返回 false 禁止关闭） */
  canClose?: () => boolean
}

// 可聚焦元素选择器：与浏览器默认 Tab 序列尽量对齐
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

export function useDialogA11y(options: DialogA11yOptions): void {
  const hasDom = typeof window !== 'undefined' && typeof document !== 'undefined'
  // 打开前的焦点元素，关闭后归还（键盘用户不该被「丢」在文档开头）
  let lastActive: HTMLElement | null = null

  function getFocusables(): HTMLElement[] {
    const panel = options.panelRef?.value
    if (!panel) return []
    return Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
      .filter((el) => el.offsetParent !== null || el === document.activeElement)
  }

  function focusSafely(el: HTMLElement | null | undefined) {
    if (!el || typeof el.focus !== 'function') return
    try {
      // preventScroll：聚焦不应让页面跳动（弹窗常出现在滚动位置之外）
      el.focus({ preventScroll: true })
    } catch {
      el.focus()
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (!options.isOpen()) return

    if (e.key === 'Escape') {
      if (options.canClose && !options.canClose()) return
      // stopPropagation：避免与外层/其它监听器（如模型下拉的 Esc）重复处理
      e.stopPropagation()
      options.onClose()
      return
    }

    if (e.key !== 'Tab') return
    const panel = options.panelRef?.value
    if (!panel) return
    const list = getFocusables()
    if (list.length === 0) {
      // 面板内没有可聚焦元素时把焦点留在面板上，避免 Tab 逃到背后的页面
      e.preventDefault()
      focusSafely(panel)
      return
    }
    const first = list[0]
    const last = list[list.length - 1]
    const active = document.activeElement as HTMLElement | null
    if (!active || !panel.contains(active)) {
      e.preventDefault()
      focusSafely(first)
      return
    }
    if (e.shiftKey && active === first) {
      e.preventDefault()
      focusSafely(last)
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      focusSafely(first)
    }
  }

  watch(
    () => options.isOpen(),
    async (open) => {
      if (!hasDom) return
      if (open) {
        lastActive = document.activeElement as HTMLElement | null
        await nextTick()
        // 弹窗常用 <Transition> 包裹，首帧可能还没挂载，补一帧再找
        if (!options.panelRef?.value) {
          await new Promise<void>((resolve) => {
            if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve())
            else setTimeout(resolve, 0)
          })
        }
        const panel = options.panelRef?.value
        if (!panel) return
        const preferred = options.initialFocusSelector
          ? panel.querySelector<HTMLElement>(options.initialFocusSelector)
          : null
        // 默认不把焦点放到「关闭」等破坏性按钮上：优先第一个可聚焦元素
        focusSafely(preferred || getFocusables()[0] || panel)
      } else {
        focusSafely(lastActive)
        lastActive = null
      }
    },
    { immediate: true }
  )

  onMounted(() => {
    if (hasDom) document.addEventListener('keydown', handleKeydown)
  })

  onBeforeUnmount(() => {
    if (!hasDom) return
    document.removeEventListener('keydown', handleKeydown)
    // 组件直接卸载（未走 isOpen=false）时同样归还焦点
    focusSafely(lastActive)
    lastActive = null
  })
}
