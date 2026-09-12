import { defineConfig, type Plugin } from "vite";
import uniRaw from "@dcloudio/vite-plugin-uni";
import tailwindcssRaw from "@tailwindcss/vite";

// CJS 插件在 ESM 配置下的 default 互操作处理
const uni = ((uniRaw as any).default ?? uniRaw) as () => Plugin[];
const tailwindcss = ((tailwindcssRaw as any).default ?? tailwindcssRaw) as () => Plugin[];

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [...uni(), tailwindcss()],
  server: {
    // 监听所有网卡地址，局域网内其他设备可通过本机 IP 访问
    host: "0.0.0.0",
    port: 5173,
  },
});
