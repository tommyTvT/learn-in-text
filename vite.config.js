import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  build: {
    // 构建前不清空 dist：产物文件名带内容哈希，index.html 始终引用最新文件，
    // 直接覆盖构建即可（也避免某些环境下清空目录被拦截导致构建失败）
    emptyOutDir: false
  }
})
