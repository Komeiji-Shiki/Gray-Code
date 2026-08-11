import { beforeEach } from 'vitest'
import { setDetectedLanguage, setLanguage } from './i18n'

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

beforeEach(() => {
  // 测试文案断言不应依赖运行机器的 navigator.language。
  // 生产环境仍由 i18n 模块按浏览器/VS Code 语言自动探测。
  setDetectedLanguage('zh-CN')
  setLanguage('auto')
})
