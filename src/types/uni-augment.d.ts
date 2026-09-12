/// <reference types='@dcloudio/types' />
import 'vue'

// 合并自原根目录 shims-uni.d.ts 与 src/shime-uni.d.ts（后者拼写有误，已删除）：
// 让 App / Page 的生命周期回调（onLaunch/onShow/onLoad/onHide…）可作为组件选项被识别。
//
// 刻意增强 `vue` 而不是 `@vue/runtime-core`，原因：
// 1. `vue` 是唯一确定的顶层包，而 @vue/runtime-core 在 node_modules 里可以出现多份副本
//    （vue → @vue/runtime-dom → @vue/runtime-core 内嵌那份才是真正生效的目标）。
//    历史问题：devDependencies 曾直接依赖 "@vue/runtime-core": "^3.4.21"，顶层装成 3.5.42，
//    增强打在 3.5.42 上，而 vue@3.4.21 消费的是内嵌的 3.4.21 —— 增强静默失效。
// 2. `vue` 通过 `export * from '@vue/runtime-dom'` 再导出 runtime-core 的声明，
//    在此对同名 interface 的声明会与 runtime-core 中的原始声明合并，
//    因此同样能作用于 defineComponent 的 ComponentCustomOptions 校验（Vue 官方推荐写法）。
// 结论：不要为了本文件而把 @vue/runtime-core 加回依赖。
declare module 'vue' {
  type Hooks = App.AppInstance & Page.PageInstance;

  interface ComponentCustomOptions extends Hooks {

  }
}
