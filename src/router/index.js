import { createRouter, createWebHistory } from 'vue-router'

const Home = () => import('../views/Home.vue')
const NewArticle = () => import('../views/NewArticle.vue')
const GenerateArticle = () => import('../views/GenerateArticle.vue')
const Reader = () => import('../views/Reader.vue')
const Vocabulary = () => import('../views/Vocabulary.vue')
const Settings = () => import('../views/Settings.vue')
const Login = () => import('../views/Login.vue')
const Register = () => import('../views/Register.vue')
const EmailVerified = () => import('../views/EmailVerified.vue')

// 为每个路由分配 depth（层级）与 order（同级内顺序），用于判断页面切换时的滑动方向：
// - depth 增大（进入更深层）→ 左滑（新页从右滑入，旧页向左推出，视为"前进"）
// - depth 减小（返回更浅层）→ 右滑（反向，视为"返回"）
// - depth 相等时按 order 判断：order 增大 → 左滑（前进），order 减小 → 右滑（返回）
//   order 按底部 Tab 栏的视觉顺序设定：首页(0) → 词库(1) → 设置(2)
// bare 布局页面（登录/注册等）使用淡入淡出，不参与滑动方向判断
const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home,
    meta: { depth: 0, order: 0 }
  },
  {
    path: '/new',
    name: 'NewArticle',
    component: NewArticle,
    meta: { depth: 1, order: 0 }
  },
  {
    path: '/generate',
    name: 'GenerateArticle',
    component: GenerateArticle,
    meta: { depth: 1, order: 1 }
  },
  {
    path: '/reader/:id',
    name: 'Reader',
    component: Reader,
    props: true,
    meta: { hideMobileTab: true, depth: 2, order: 0 }
  },
  {
    path: '/vocabulary',
    name: 'Vocabulary',
    component: Vocabulary,
    meta: { depth: 1, order: 2 }
  },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings,
    meta: { depth: 1, order: 3 }
  },
  {
    path: '/login',
    name: 'Login',
    component: Login,
    meta: { bare: true }
  },
  {
    path: '/register',
    name: 'Register',
    component: Register,
    meta: { bare: true }
  },
  {
    path: '/email-verified',
    name: 'EmailVerified',
    component: EmailVerified,
    meta: { bare: true }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes,
  // 管理路由切换后的滚动位置：
  // - 浏览器前进/后退时恢复原滚动位置（savedPosition）
  // - 其余跳转（点击链接/按钮）回到页面顶部，避免从长页面进入新页时
  //   内容从中部显示、过渡动画结束后再跳动造成"重新加载"的错觉
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    return { top: 0 }
  }
})

export default router
