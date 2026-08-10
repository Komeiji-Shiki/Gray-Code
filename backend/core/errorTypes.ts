/**
 * 渠道错误类型（下沉自 modules/channel/types.ts）。
 *
 * 修改原因（模块化第七批「依赖方向清零」遗留）：core/errors.ts 以值导入方式引用
 * modules/channel/types 的 ErrorType enum——enum 是运行时值，core → modules 反向依赖
 * 破坏「core 不依赖 modules」方向纪律（09 批 M1）。
 * 修改方式：ErrorType 词汇下沉到 core（独立文件，零依赖），modules/channel/types.ts
 * 改为从本文件 re-export，导出面与消费方（channel/index.ts、webview/stream 等）零变化。
 */
export enum ErrorType {
    /** 配置错误 */
    CONFIG_ERROR = 'CONFIG_ERROR',

    /** 网络错误 */
    NETWORK_ERROR = 'NETWORK_ERROR',

    /** API 错误 */
    API_ERROR = 'API_ERROR',

    /** 解析错误 */
    PARSE_ERROR = 'PARSE_ERROR',

    /** 验证错误 */
    VALIDATION_ERROR = 'VALIDATION_ERROR',

    /** 超时错误 */
    TIMEOUT_ERROR = 'TIMEOUT_ERROR',

    /** 用户取消错误（不应重试） */
    CANCELLED_ERROR = 'CANCELLED_ERROR',

    /** 空响应错误（HTTP 成功但模型返回空内容；应重试） */
    EMPTY_RESPONSE_ERROR = 'EMPTY_RESPONSE_ERROR'
}
