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

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/new',
    name: 'NewArticle',
    component: NewArticle
  },
  {
    path: '/generate',
    name: 'GenerateArticle',
    component: GenerateArticle
  },
  {
    path: '/reader/:id',
    name: 'Reader',
    component: Reader,
    props: true,
    meta: { hideMobileTab: true }
  },
  {
    path: '/vocabulary',
    name: 'Vocabulary',
    component: Vocabulary
  },
  {
    path: '/settings',
    name: 'Settings',
    component: Settings
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
  routes
})

export default router
