/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // 宽松组件类型：纯 tsc 无法解析 .vue 内部结构，只能靠此 shim。
  // 用 Record<string, any> 而非 object，避免 mount/setProps 字面量 props 触发 excess property check；
  // vue-tsc（项目标准 typecheck）会解析真实 .vue 类型，不受此 shim 影响。
  const component: DefineComponent<Record<string, any>, Record<string, any>, any>
  export default component
}

interface Window {
  __GRAYCODE_VIEW_MODE?: 'subagentMonitor'
  __GRAYCODE_STARTUP_SPLASH_ENABLED?: boolean
  __GRAYCODE_WEBVIEW_CLIENT_ID?: string
  __GRAYCODE_INITIAL_RUN_ID?: string | null
  __GRAYCODE_BUILTIN_SOUND_ASSETS?: unknown
  __GRAYCODE_FRONTEND_STYLES_READY?: Promise<void>
}

// VSCode Webview API 类型声明
interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi