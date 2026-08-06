/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  // 宽松组件类型：纯 tsc 无法解析 .vue 内部结构，只能靠此 shim。
  // 用 Record<string, any> 而非 object，避免 mount/setProps 字面量 props 触发 excess property check；
  // vue-tsc（项目标准 typecheck）会解析真实 .vue 类型，不受此 shim 影响。
  const component: DefineComponent<Record<string, any>, Record<string, any>, any>
  export default component
}

// VSCode Webview API 类型声明
interface VsCodeApi {
  postMessage(message: unknown): void
  getState(): unknown
  setState(state: unknown): void
}

declare function acquireVsCodeApi(): VsCodeApi