/**
 * i18n Composable（统一实现）
 *
 * 历史：本项目曾有两套并行 i18n 实现（本文件与 i18n/index.ts），参数占位符替换语义不一致
 * （本文件对缺失参数输出字面 "undefined"，i18n 版保留占位符）。
 *
 * 统一方案：以 i18n/index.ts 为唯一实现，本文件仅做 re-export，保持既有导入路径兼容
 * （组件/Store 从 '@/composables/useI18n' 或 '@/composables' 导入 useI18n / translate 均继续可用）。
 * currentLanguage 由 i18n/index.ts 以 readonly 暴露，不可直写；语言切换统一走 setLanguage()。
 */

export {
    useI18n,
    t,
    translate,
    hasMessage,
    setLanguage,
    getLanguage,
    setDetectedLanguage,
    actualLanguage,
    SUPPORTED_LANGUAGES,
    messages
} from '@/i18n';
