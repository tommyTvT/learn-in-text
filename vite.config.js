import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue(), tailwindcss()],
  build: {
    // 注意：不能改为 emptyOutDir: true。
    // 本环境（CodeBuddy）的文件删除有安全防护，一次删除超过阈值会被拦截导致构建失败，
    // 所以才保持 false。如需清理旧产物，运行 npm run clean:dist 手动清理。
    emptyOutDir: false,
    rolldownOptions: {
      output: {
        // 把体积较大的第三方库单独分包，利用浏览器缓存，加快二次访问
        codeSplitting: {
          groups: [
            {
              name: 'supabase',
              test: /node_modules[\\/]@supabase/
            },
            {
              name: 'vendor',
              test: /node_modules[\\/](vue|vue-router|pinia)/
            }
          ]
        }
      }
    }
  }
})
