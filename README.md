# Learn in Text

> 纯前端英语词汇学习应用，在文章中学习单词。

## 简介

「Learn in Text」让你在阅读英文文章的过程中学习单词：导入文章后自动分词，点击任意单词即可查看释义，右键标记生词建立个人词库，还能借助 AI 批量生成单词信息和专属练习文章。数据全部保存在浏览器本地，无需后端服务。

## 功能

- 导入英文文章，智能分词
- 识别换行智能分段，保持原文段落结构
- 点击单词查看释义（音标 + 常用释义）
- 右键标记生词，建立个人词库
- AI 批量生成单词信息（支持并发 / 超时 / max_tokens 设置）
- AI 生成包含指定单词的文章
- 按文章筛选单词，跳转原文
- 词库导入 / 导出 (JSON)

## 技术栈

| 类别     | 技术                                        |
| -------- | ------------------------------------------- |
| 框架     | Vue 3 + Vite 8                              |
| 状态管理 | Pinia                                       |
| 路由     | Vue Router                                  |
| 样式     | Tailwind CSS 4                              |
| 存储     | Dexie (IndexedDB)                           |
| AI 调用  | OpenAI SDK（兼容协议）                      |

## 项目结构

```
learn-in-text/
├── src/
│   ├── components/     # 通用 / 文章 / 单词 / AI 组件
│   ├── services/       # AI 调用、IndexedDB、文章分词解析
│   ├── stores/         # Pinia 状态（文章 / 词库 / 设置）
│   ├── views/          # 页面（首页 / 阅读 / 词汇 / 设置）
│   ├── utils/          # 工具函数
│   ├── App.vue         # 应用入口
│   └── main.js
├── public/             # 静态资源
├── index.html
└── vite.config.js
```

## 启动

```bash
npm install
npm run dev
```

访问 http://localhost:5174

## 打包

```bash
npm run build
```

产物在 `dist/` 目录，部署到任意静态服务器即可。

## 配置 AI

进入「设置」页面，填写：

- API 端点（OpenAI 兼容协议）
- API Key
- 模型名称
