import { createRouter, createWebHistory } from 'vue-router'
import Home from '../views/Home.vue'
import Reader from '../views/Reader.vue'
import Vocabulary from '../views/Vocabulary.vue'
import Settings from '../views/Settings.vue'

const routes = [
  {
    path: '/',
    name: 'Home',
    component: Home
  },
  {
    path: '/reader/:id',
    name: 'Reader',
    component: Reader,
    props: true
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
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

export default router
