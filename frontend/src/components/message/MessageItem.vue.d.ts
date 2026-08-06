/**
 * MessageItem.vue 的 tsc 旁路类型声明。
 *
 * 背景：vue-tsc（package.json 的 typecheck 标准）能直接解析 .vue 文件，
 * 包括普通 <script> 块的具名导出；但纯 tsc 只能靠全局 `*.vue` shim
 * （vite-env.d.ts），shim 仅声明默认导出，导致测试文件
 * `import { backgroundTaskViewModeByMessageId, ... } from '../MessageItem.vue'`
 * 报 TS2614。
 *
 * 此文件让纯 tsc 解析 `../MessageItem.vue` 时命中本声明（模块解析优先
 * 匹配 `.vue.d.ts`），补齐 script 块的具名导出；vue-tsc 解析真实 .vue
 * 文件不受影响。若 script 块导出发生变化，请同步更新本声明。
 */
import type { DefineComponent } from 'vue'

declare const MessageItem: DefineComponent<Record<string, any>, Record<string, any>, any>
export default MessageItem

export type BackgroundTaskViewMode = 'collapsed' | 'medium' | 'expanded'

/** reactive(Map) 运行时类型即 Map（reactive 不 unwrap Map） */
export declare const backgroundTaskViewModeByMessageId: Map<string, BackgroundTaskViewMode>
export declare const BACKGROUND_TASK_VIEW_MODE_CAP: number
export declare function pruneBackgroundTaskViewModes(activeIds: Set<string>): void

export type ThoughtViewMode = 'collapsed' | 'medium' | 'expanded'
export declare const thoughtViewModeByMessageId: Map<string, ThoughtViewMode>
export declare const THOUGHT_VIEW_MODE_CAP: number
