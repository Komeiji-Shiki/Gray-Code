import { beforeEach } from 'vitest'
import { setDetectedLanguage, setLanguage } from './i18n'

beforeEach(() => {
  // 测试文案断言不应依赖运行机器的 navigator.language。
  // 生产环境仍由 i18n 模块按浏览器/VS Code 语言自动探测。
  setDetectedLanguage('zh-CN')
  setLanguage('auto')
})
