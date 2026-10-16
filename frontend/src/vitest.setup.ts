import { beforeEach } from 'vitest'
import { preloadLanguage, setDetectedLanguage, setLanguage } from './i18n'
import { preloadShellLanguage, setShellLanguage } from '../../apps/client/src/i18n'

// jsdom 不计算布局；需要模拟尺寸变化的用例提供自己的回调夹具，默认环境提供观察器接口。
globalThis.ResizeObserver = class implements ResizeObserver {
  constructor(_callback: ResizeObserverCallback) {}
  observe(_target: Element, _options?: ResizeObserverOptions): void {}
  unobserve(_target: Element): void {}
  disconnect(): void {}
}

// Node 26 exposes its own global localStorage accessor. Without
// --localstorage-file that accessor resolves to undefined, and its presence
// prevents Vitest from installing jsdom's implementation on globalThis.
// Vitest exposes the original JSDOM instance as globalThis.jsdom. Vitest's
// public `window` alias points back to globalThis, so read Storage from the
// original instance instead.
const jsdomEnvironment = (globalThis as typeof globalThis & {
  jsdom?: { window: { localStorage: Storage } }
}).jsdom

if (jsdomEnvironment) {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    writable: true,
    value: jsdomEnvironment.window.localStorage
  })
}

// 组件用例直接同步切换语言，测试夹具预载全部语言，不影响生产入口的按需加载。
await Promise.all(['zh-CN', 'en', 'ja'].flatMap(language => [
  preloadLanguage(language as 'zh-CN' | 'en' | 'ja'),
  preloadShellLanguage(language)
]))

beforeEach(() => {
  // 测试文案断言不应依赖运行机器的 navigator.language。
  // 生产环境仍由 i18n 模块按浏览器/VS Code 语言自动探测。
  setDetectedLanguage('zh-CN')
  setLanguage('auto')
  setShellLanguage('zh-CN')
})
