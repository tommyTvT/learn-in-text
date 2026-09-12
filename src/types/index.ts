/**
 * 类型统一出口：下游使用 `import type { Article } from '@/types'` 消费。
 *
 * 约定：本目录只允许声明类型（interface / type），禁止出现运行时代码，
 * 以保证类型层是零运行时耦合的叶子节点。
 */
export type * from './models'
export type * from './settings'
