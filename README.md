# Learn in Text

> 纯前端英语词汇学习应用，在文章中学习单词。

## 简介

「Learn in Text」让你在阅读英文文章的过程中学习单词：导入文章后自动分词，点击任意单词即可查看释义，右键标记生词建立个人词库，还能借助 AI 批量生成单词信息和专属练习文章。数据默认保存在浏览器本地，可通过 Supabase 云同步实现跨设备备份与同步。

## 功能

- 导入英文文章，智能分词
- 拍照导入：手动导入与 AI 生成文章界面均可拍照/上传图片，AI 自动识别英文文章内容或作文题目要求（需配置支持视觉输入的模型）
- 识别换行智能分段，保持原文段落结构
- 点击单词查看释义（音标 + 常用释义）
- 选中单词查看上下文翻译
- 右键标记生词，建立个人词库
- 按文章筛选单词，跳转原文
- AI 批量生成单词信息（并发数 / 请求超时 / max_tokens 均可调）
- AI 生成包含指定单词的练习文章
- 多供应商 AI 配置：预设 DeepSeek，也支持自定义任意 OpenAI 兼容接口（阿里百炼、OpenAI 等），模型列表可一键拉取
- 深色模式 / 主题切换（跟随系统 / 浅色 / 深色）
- 响应式布局，移动端自动切换底部标签栏
- 词库导入 / 导出（JSON 全量备份）
- Supabase 双向差异云同步（LWW 合并 + 软删除传播）
- 后台自动云同步：打开应用、切回前台、定时间隔自动静默同步，也支持手动同步与调试模式

## 技术栈

| 类别     | 技术                                        |
| -------- | ------------------------------------------- |
| 框架     | Vue 3 + Vite 8                              |
| 状态管理 | Pinia                                       |
| 路由     | Vue Router                                  |
| 样式     | Tailwind CSS 4                              |
| 本地存储 | Dexie (IndexedDB)                           |
| 云同步   | @supabase/supabase-js                       |
| AI 调用  | 原生 fetch（OpenAI 兼容协议）               |

## 项目结构

```
learn-in-text/
├── src/
│   ├── components/
│   │   ├── Common/        # 通用组件（顶栏 / 移动端标签栏 / 主题切换）
│   │   └── Word/          # 单词弹窗等
│   ├── lib/               # Supabase 客户端封装
│   ├── router/            # Vue Router 路由定义
│   ├── services/          # AI 调用 / 自动同步 / IndexedDB / 分词解析 / 云端同步
│   ├── stores/            # Pinia 状态（文章 / 词库 / 设置）
│   ├── views/             # 页面（首页 / 新建文章 / AI 生成文章 / 阅读 / 词汇 / 设置）
│   ├── App.vue
│   ├── main.js
│   └── style.css
├── supabase/
│   └── migrations/        # 云端数据库建表与 RLS 迁移 SQL
├── public/                # 静态资源
├── index.html
├── vite.config.js
└── package.json
```

## 启动

```bash
npm install
npm run dev
```

访问 http://localhost:5173

## 打包

```bash
npm run build
```

产物在 `dist/` 目录，部署到任意静态服务器即可。

> 说明：`vite.config.js` 中设置了 `build.emptyOutDir: false`（产物文件名带内容哈希，index.html 始终引用最新文件，直接覆盖构建即可），这是为避免某些环境下清空目录被拦截导致构建失败而保留的写法。

> 体积优化：构建产物已移除 OpenAI SDK（改用原生 fetch 调用 OpenAI 兼容协议），原始 JS/CSS 体积明显下降。部署时静态服务器（Nginx、Cloudflare Pages 等）会自动对资源做 gzip/brotli 压缩，无需在构建阶段额外生成压缩文件。

## 配置 AI

进入「设置」页面，在「AI 接口配置」中：

- 「管理供应商」：供应商为共享资源，预设了 DeepSeek（只需填 API Key），也可添加自定义供应商（API 端点 + API Key）
- 「文本模型」与「视觉模型」两个入口，分别选择供应商与模型：
  - 文本模型用于查词释义、生成文章等文本任务
  - 视觉模型用于「拍照导入」的图片识别，留空则复用文本模型
  - 两者可选用同一供应商，也可不同；模型支持切换，支持同一供应商下的不同模型
  - 模型可手动填写，或点击「获取模型列表」从所选供应商拉取后选择
- 「开发者选项」中可调：最大并发数、请求超时（秒）、各类请求的 max_tokens、调试模式开关

## 云同步配置（Supabase）

数据默认仅存于浏览器本地，清除浏览器数据会丢失。如需跨设备同步，可接入 Supabase：

1. 在 Supabase 新建项目，进入 Dashboard → SQL Editor → New query
2. 依次执行 `supabase/migrations/` 下的迁移脚本（按顺序）：
   - `0001_init.sql`：创建 `articles` / `words` / `word_marks` / `context_translations` 四张业务表，并开启最小化的行级安全（RLS）——请求必须携带请求头 `x-sync-user`，且其值须与行 `username` 一致才允许读写
   - `0002_add_deleted_at.sql`：为四张表补齐 `deletedAt` 软删除列与 `updatedAt` 更新依据（用于 LWW 冲突解决与删除传播）
   - 两个脚本均为幂等，可重复执行，不会删除已有数据
3. 在「设置 → 云同步」中填写：
   - 用户名（跨设备输入相同用户名即可共享数据）
   - Supabase 项目地址（`https://xxxx.supabase.co`）
   - Supabase anon key
4. 开启「自动同步」或点击「立即同步」即可

### 内置云存储配置（可选）

Supabase 项目地址与 anon key 已通过环境变量内置，**默认无需在设置页手动输入**：

- 项目根目录的 `.env` 中配置了 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`
- 构建/运行时自动注入，应用会将其作为云同步默认值
- 如需更换云库，直接修改 `.env`，或在设置页手动覆盖

> ⚠️ **Git 忽略说明**：`.env` 已加入 `.gitignore`，不会被提交到仓库（anon key 属敏感信息）。仓库仅保留 `.env.example` 模板。克隆项目后请先 `cp .env.example .env` 并填入自己的配置，否则云同步默认值将为空。

> 安全提示：云库按 `username` 在应用层隔离，`x-sync-user` 为自报身份、非强认证，多人共用同一云库时请谨慎。

## 数据说明

- 所有文章、单词、标记与翻译均存储在浏览器 IndexedDB 中，建议通过「设置 → 开发者选项 → 导出所有数据」定期备份
- 项目处于开发阶段，数据库结构调整时以最新迁移脚本为准，历史兼容不在考虑范围内
