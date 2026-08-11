/**
 * VSCode 工具共享辅助函数
 *
 * 支持多工作区（Multi-root Workspaces）
 *
 * 本文件已按职责拆分到 shared/ 子目录，此处仅保留 re-export 以保持向后兼容。
 * 拆分目标：workspacePaths（多工作区路径解析）/ multimodal（多模态 MIME 与读权限）/
 * textUtils（文本与正则工具）/ fileStats（行数统计与文件大小）/ concurrency（并发控制）/
 * imageMath（图片尺寸计算）。
 */

export * from './shared/workspacePaths';
export * from './shared/multimodal';
export * from './shared/textUtils';
export * from './shared/fileStats';
export * from './shared/concurrency';
export * from './shared/imageMath';
export * from './shared/fetchSignal';
