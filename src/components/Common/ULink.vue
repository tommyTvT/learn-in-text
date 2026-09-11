<script setup>
import { computed } from 'vue'
import { currentRoute, navigate } from '../../composables/routerShim'

// RouterLink 兼容组件：接收 to / active-class，内部走 uni 导航
const props = defineProps({
  to: { type: [String, Object], required: true },
  activeClass: { type: String, default: '' },
})

const isActive = computed(() => {
  const target = typeof props.to === 'object' ? props.to?.path : props.to
  return !!target && currentRoute.path === target
})

function go() {
  navigate(props.to, 'push')
}
</script>

<template>
  <a :class="[isActive ? activeClass : '']" href="javascript:;" @click="go">
    <slot />
  </a>
</template>
