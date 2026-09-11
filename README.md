# Learn in Text

> 基于 uni-app 的英语词汇学习应用，在文章中学习单词。

## 简介

「Learn in Text」让你在阅读英文文章的过程中学习单词：导入文章后自动分词，点击任意单词即可查看释义，右键 / 长按标记生词建立个人词库，还能借助 AI 批量生成单词信息和专属练习文章。数据默认保存在浏览器本地，可通过 Supabase 云同步实现跨设备备份与同步。

项目基于 uni-app（Vue 3 + Vite）开发，一套代码可编译到 H5 与各小程序 / App 平台，当前主推 H5 与安卓 App（WebView 渲染）。

## 功能

- 导入英文文章，智能分词
- 拍照导入：手动导入与 AI 生成文章界面均可拍照/上传图片，AI 自动识别英文文章内容或作文题目要求（需配置支持视觉输入的模型）
- 识别换行智能分段，保持原文段落结构
- 点击单词查看释义（音标 + 常用释义），单字母单词（I、a 等）同样可点击
- 选中单词查看上下文翻译，支持单字母选区（自动过滤标点等误触）
- 标记生词，建立个人词库（桌面端右键 / 触摸端长按 / 双指划词）
- 按文章筛选单词，跳转原文
- AI 批量生成单词信息（并发数 / 请求超时 / max_tokens 均可调）
- AI 生成包含指定单词的练习文章
- 多供应商 AI 配置：预设 DeepSeek，也支持自定义任意 OpenAI 兼容接口（阿里百炼、OpenAI 等），模型列表可一键拉取
- 深色模式 / 主题切换（跟随系统 / 浅色 / 深色）
- 响应式布局：移动端自动切换底部标签栏；界面字号按屏幕宽度自适应（小屏自动降档），无需手动设置
- 单词发音（TTS）：H5 端可用，不支持语音合成的运行环境自动隐藏发音入口
- 词库导入 / 导出（JSON 全量备份）
- Supabase 双向差异云同步（LWW 合并 + 软删除传播）
- 后台自动云同步：打开应用、切回前台、定时间隔自动静默同步，也支持手动同步与调试模式

## 技术栈

| 类别     | 技术                                        |
| -------- | ------------------------------------------- |
| 框架     | uni-app（Vue 3 + Vite 5）                   |
| 状态管理 | Pinia                                       |
| 路由     | pages.json + uni 导航 API（routerShim 兼容层，保留 vue-router 风格调用） |
| 样式     | Tailwind CSS 4                              |
| 图标     | lucide-vue-next                             |
| 拖拽排序 | SortableJS                                  |
| 本地存储 | Dexie (IndexedDB)                           |
| 云同步   | @supabase/supabase-js                       |
| AI 调用  | 原生 fetch（OpenAI 兼容协议）               |

## 项目结构

```
learn-in-text/
├── src/
│   ├── pages/              # 页面（首页 / 新建文章 / AI 生成文章 / 阅读 / 词汇 / 设置 / 登录 / 注册 / 邮箱验证）
│   ├── components/
│   │   ├── AI/             # AI 配置弹窗、图片导入弹窗等
│   │   ├── Article/        # 文章相关组件
│   │   ├── Common/         # 通用组件（顶栏 / 移动端标签栏 / 主题切换 / 页面布局 / ULink / 缓存管理）
│   │   └── Word/           # 单词弹窗、划词与语法分析组件
│   ├── composables/        # routerShim：vue-router → uni 导航兼容层
│   ├── lib/                # Supabase 客户端封装
│   ├── services/           # AI 调用 / 自动同步 / IndexedDB / 分词解析 / 云端同步 / 对话框 / 文件选择 / TTS
│   ├── stores/             # Pinia 状态（文章 / 词库 / 设置 / 登录）
│   ├── static/             # 静态资源（logo）
│   ├── App.vue             # 应用生命周期（恢复登录会话、启动后台自动同步）
│   ├── main.ts             # 应用入口（createSSRApp + Pinia）
│   ├── manifest.json       # uni-app 应用配置（应用名 / H5 hash 路由等）
│   ├── pages.json          # 页面注册与全局窗口样式
│   ├── style.css
│   └── uni.scss
├── supabase/
│   ├── init.sql            # 全量合并基线（新项目一键初始化）
│   └── migrations/         # 建表、RLS 强认证与安全加固迁移 SQL（增量更新）
├── index.html              # H5 模板（含暗色主题防闪烁脚本）
├── vite.config.mts         # uni 插件 + Tailwind 4 插件
├── tsconfig.json
├── shims-uni.d.ts
└── package.json
```

## 启动

```bash
npm install
npm run dev:h5
```

访问 http://localhost:5173

其他平台（微信小程序、支付宝小程序、字节小程序等）的开发命令为 `npm run dev:mp-weixin` 等，完整列表见 `package.json` 的 scripts。

> 说明：页面注册在 `src/pages.json`，导航统一走 `src/composables/routerShim.js`（保持 vue-router 风格调用，内部转换为 uni 导航 API），应用级生命周期位于 `src/App.vue`。

## 打包

```bash
npm run build:h5
```

H5 产物在 `dist/build/h5`，使用 hash 路由（`manifest.json` 中配置），部署到任意静态服务器即可，无需额外服务端配置。

其他平台构建命令为 `npm run build:mp-weixin` 等，产物同样在 `dist/build/<平台>` 目录；小程序产物用对应开发者工具导入即可。

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

数据默认仅存于浏览器本地，清除浏览器数据会丢失。如需跨设备同步（Supabase Auth 账号体系，数据按登录用户隔离），可接入 Supabase：

1. 在 Supabase 新建项目，进入 Dashboard → SQL Editor → New query
2. 粘贴 `supabase/init.sql` 全部内容 → Run，一步完成建表、RLS 强认证、注册触发器与 RPC（该文件是 `migrations/0001 ~ 0010` 的全量合并基线，幂等可重复执行）
3. 按需开启邮箱确认：Dashboard → Authentication → Providers → Email → Confirm email
4. 在应用内注册账号（邮箱 + 密码 + 用户名）并登录，开启「自动同步」或点击「立即同步」即可


### 前端配置

在「设置 → 云同步」中填写（或通过 `.env` 内置，见下）：

- Supabase 项目地址（`https://xxxx.supabase.co`）
- Supabase anon key

> 两种方式二选一即可；`init.sql` 供人工执行，请勿移入 `migrations/` 目录。存量库也可直接执行 `init.sql`：数据不受影响，并会顺带开启 `profiles` 的 RLS（原迁移链缺失此句）、回收 anon 的表权限。

### 内置云存储配置（可选）

Supabase 项目地址与 anon key 已通过环境变量内置，**默认无需在设置页手动输入**：

- 项目根目录的 `.env` 中配置了 `VITE_SUPABASE_URL` 与 `VITE_SUPABASE_ANON_KEY`
- 构建/运行时自动注入，应用会将其作为云同步默认值
- 如需更换云库，直接修改 `.env`，或在设置页手动覆盖

> ⚠️ **Git 忽略说明**：`.env` 已加入 `.gitignore`，不会被提交到仓库（anon key 属敏感信息）。仓库仅保留 `.env.example` 模板。克隆项目后请先 `cp .env.example .env` 并填入自己的配置，否则云同步默认值将为空。

> 安全提示：数据按 `username` 隔离，行级安全（RLS）要求请求来自该用户名绑定的 Supabase Auth 登录会话（authenticated 角色）；anon 仅可调用注册/登录所需的 RPC，无法直接读写业务表。

> 邮箱验证回调：H5 使用 hash 路由，`emailRedirectTo` 指向 `origin/#/email-verified`；本地开发与线上部署时请将该地址加入 Supabase Dashboard → Authentication → URL Configuration 的 Redirect URLs。
