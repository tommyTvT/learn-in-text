/// <reference types="vite/client" />

/** .env 中内置的 Supabase 配置（见 stores/settings.ts） */
interface ImportMetaEnv {
  /** 内置 Supabase 项目地址 */
  readonly VITE_SUPABASE_URL?: string
  /** 内置 Supabase anon key */
  readonly VITE_SUPABASE_ANON_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module '*.vue' {
  import { DefineComponent } from 'vue'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/ban-types
  const component: DefineComponent<{}, {}, any>
  export default component
}
