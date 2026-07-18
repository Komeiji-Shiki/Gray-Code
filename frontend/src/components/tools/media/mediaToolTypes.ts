/**
 * 媒体工具面板共享类型
 *
 * MediaToolPanel 骨架组件与各媒体工具薄壳组件（crop/resize/rotate/remove_background/generate_image）
 * 之间传递数据所用的公共类型定义。
 */

/** 多模态图片数据（base64 编码） */
export interface MultimodalData {
  /** MIME 类型，例如 image/png */
  mimeType: string
  /** base64 编码的图片内容 */
  data: string
  /** 可选文件名 */
  name?: string
}

/** 工具运行状态（与 ToolMessage 传入的 status 一致） */
export type MediaToolStatus =
  | 'streaming'
  | 'queued'
  | 'awaiting_approval'
  | 'executing'
  | 'awaiting_apply'
  | 'success'
  | 'error'
  | 'warning'

/**
 * 媒体工具通用结果数据。
 *
 * 各工具的特有字段（如 rotate 的 rotatedDimensions）通过索引签名读取，
 * 薄壳组件内部可以扩展该接口获得强类型。
 */
export interface MediaToolResultData {
  message?: string
  toolId?: string
  totalTasks?: number
  successCount?: number
  failedCount?: number
  cancelledCount?: number
  paths?: string[]
  success?: boolean
  cancelled?: boolean
  error?: string
  [key: string]: unknown
}

/** 任务条目 meta 行中的一项（图标 + 文本，可选强调色） */
export interface MediaMetaItem {
  /** codicon 图标类名，例如 'codicon-sync' */
  icon: string
  text: string
  /** 强调色（CSS 颜色值）；提供时该条目高亮显示 */
  accentColor?: string
}

/**
 * 结果信息行（如尺寸变化 "原始 100×100 → 裁切后 50×50"）的一段。
 * 三种形态互斥：arrow 渲染箭头图标，label 渲染灰色标签，value 渲染等宽高亮值。
 */
export interface MediaInfoSegment {
  label?: string
  value?: string
  arrow?: boolean
}

/** 状态徽章覆盖（如 remove_background 的 needsSharp 警告态） */
export interface MediaStatusOverride {
  label: string
  badgeClass: string
}
