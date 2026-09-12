// 句子成分与从句标注的共享常量与工具：
// SelectionChatModal（图例 / 结构树 / 悬浮提示）与 ClauseSegment（行内递归渲染）共用

/** 句子成分角色 */
export type Role =
  | 'subject'
  | 'predicate'
  | 'object'
  | 'attributive'
  | 'adverbial'
  | 'complement'
  | 'predicative'
  | 'conjunction'

/** 未被识别为句子成分的角色（标点、包裹符等），由解析结果的兜底逻辑产生 */
export type NoneRole = 'none'

/** 实际可能落地的角色：service 层对非法角色会兜底成 'none' */
export type AnyRole = Role | NoneRole

/** 从句大类 */
export type ClauseType = 'noun' | 'relative' | 'adverbial'

/** 从句描述对象（解析结果中的 clause 字段） */
export interface ClauseDescriptor {
  type?: ClauseType
  subtype?: string
}

/** 成分角色 → 中文标签（none 为占位空串，保证用任意角色取值都是 string） */
export const ROLE_LABELS: Record<AnyRole, string> = {
  subject: '主语',
  predicate: '谓语',
  object: '宾语',
  attributive: '定语',
  adverbial: '状语',
  complement: '补语',
  predicative: '表语',
  conjunction: '连词',
  none: ''
}

/** 成分片段高亮配色：浅色模式浅底深字 / 深色模式半透明底亮字 */
export const ROLE_CLASSES: Record<AnyRole, string> = {
  subject: 'bg-blue-200/70 dark:bg-blue-500/25 text-blue-900 dark:text-blue-200',
  predicate: 'bg-red-200/70 dark:bg-red-500/25 text-red-900 dark:text-red-200',
  object: 'bg-green-200/70 dark:bg-green-500/25 text-green-900 dark:text-green-200',
  attributive: 'bg-purple-200/70 dark:bg-purple-500/25 text-purple-900 dark:text-purple-200',
  adverbial: 'bg-orange-200/70 dark:bg-orange-500/25 text-orange-900 dark:text-orange-200',
  complement: 'bg-teal-200/70 dark:bg-teal-500/25 text-teal-900 dark:text-teal-200',
  predicative: 'bg-pink-200/70 dark:bg-pink-500/25 text-pink-900 dark:text-pink-200',
  conjunction: 'bg-slate-200/70 dark:bg-slate-500/25 text-slate-900 dark:text-slate-200',
  none: ''
}

/** 成分被悬停 / 锁定时的加深配色：底色加深一档 + 下划线（同成分同步高亮用） */
export const ROLE_ACTIVE_CLASSES: Record<AnyRole, string> = {
  subject: 'bg-blue-300 dark:bg-blue-500/55 text-blue-950 dark:text-blue-100 underline decoration-2 decoration-blue-500 underline-offset-2',
  predicate: 'bg-red-300 dark:bg-red-500/55 text-red-950 dark:text-red-100 underline decoration-2 decoration-red-500 underline-offset-2',
  object: 'bg-green-300 dark:bg-green-500/55 text-green-950 dark:text-green-100 underline decoration-2 decoration-green-500 underline-offset-2',
  attributive: 'bg-purple-300 dark:bg-purple-500/55 text-purple-950 dark:text-purple-100 underline decoration-2 decoration-purple-500 underline-offset-2',
  adverbial: 'bg-orange-300 dark:bg-orange-500/55 text-orange-950 dark:text-orange-100 underline decoration-2 decoration-orange-500 underline-offset-2',
  complement: 'bg-teal-300 dark:bg-teal-500/55 text-teal-950 dark:text-teal-100 underline decoration-2 decoration-teal-500 underline-offset-2',
  predicative: 'bg-pink-300 dark:bg-pink-500/55 text-pink-950 dark:text-pink-100 underline decoration-2 decoration-pink-500 underline-offset-2',
  conjunction: 'bg-slate-300 dark:bg-slate-500/55 text-slate-950 dark:text-slate-100 underline decoration-2 decoration-slate-500 underline-offset-2',
  none: ''
}

/** 图例色块（实色小方块，保持较高对比度便于辨识成分对应关系；none 不进入图例） */
export const ROLE_CHIP_CLASSES: Record<AnyRole, string> = {
  subject: 'bg-blue-500 dark:bg-blue-400',
  predicate: 'bg-red-500 dark:bg-red-400',
  object: 'bg-green-500 dark:bg-green-400',
  attributive: 'bg-purple-500 dark:bg-purple-400',
  adverbial: 'bg-orange-500 dark:bg-orange-400',
  complement: 'bg-teal-500 dark:bg-teal-400',
  predicative: 'bg-pink-500 dark:bg-pink-400',
  conjunction: 'bg-slate-500 dark:bg-slate-400',
  none: ''
}

/** 从句大类 → 中文标签 */
export const CLAUSE_TYPE_LABELS: Record<string, string> = {
  noun: '名词性从句',
  relative: '定语从句',
  adverbial: '状语从句'
}

/** 从句子类 → 中文标签 */
export const CLAUSE_SUBTYPE_LABELS: Record<string, string> = {
  subject_clause: '主语从句',
  object_clause: '宾语从句',
  predicative_clause: '表语从句',
  appositive_clause: '同位语从句',
  restrictive: '限制性',
  non_restrictive: '非限制性',
  time: '时间',
  place: '地点',
  reason: '原因',
  condition: '条件',
  concession: '让步',
  purpose: '目的',
  result: '结果',
  manner: '方式',
  comparison: '比较'
}

/** 从句边框配色（虚线边框按大类着色，与成分背景色正交） */
export const CLAUSE_BORDER_CLASSES: Record<string, string> = {
  noun: 'border-blue-400 dark:border-blue-500',
  relative: 'border-green-400 dark:border-green-500',
  adverbial: 'border-orange-400 dark:border-orange-500'
}

/** 从句左上角角标配色（实色底白字，高对比小标签） */
export const CLAUSE_CHIP_CLASSES: Record<string, string> = {
  noun: 'bg-blue-500/90 dark:bg-blue-600/90',
  relative: 'bg-green-600/90 dark:bg-green-600/90',
  adverbial: 'bg-orange-500/90 dark:bg-orange-600/90'
}

/** 从句激活（悬停 / 锁定 / 图例联动）时的背景色 */
export const CLAUSE_ACTIVE_CLASSES: Record<string, string> = {
  noun: 'bg-blue-100/70 dark:bg-blue-500/15',
  relative: 'bg-green-100/70 dark:bg-green-500/15',
  adverbial: 'bg-orange-100/70 dark:bg-orange-500/15'
}

/** 图例从句色块（虚线描边小方块，示意从句边框样式，保持较高对比度） */
export const CLAUSE_LEGEND_CHIP_CLASSES: Record<string, string> = {
  noun: 'bg-blue-200 dark:bg-blue-500/30 border-blue-500 dark:border-blue-400',
  relative: 'bg-green-200 dark:bg-green-500/30 border-green-500 dark:border-green-400',
  adverbial: 'bg-orange-200 dark:bg-orange-500/30 border-orange-500 dark:border-orange-400'
}

/**
 * 从句显示名：名词性从句的子类自描述（如「宾语从句」），
 * 其余为「大类（子类）」如「定语从句（限制性）」「状语从句（时间）」。
 */
export function clauseLabel(clause: ClauseDescriptor | null | undefined): string {
  if (!clause) return ''
  if (clause.type === 'noun') {
    const sub = clause.subtype ? CLAUSE_SUBTYPE_LABELS[clause.subtype] : ''
    return sub || '名词性从句'
  }
  const type = (clause.type ? CLAUSE_TYPE_LABELS[clause.type] : '') || '从句'
  const sub = clause.subtype ? CLAUSE_SUBTYPE_LABELS[clause.subtype] : undefined
  return sub ? `${type}（${sub}）` : type
}
