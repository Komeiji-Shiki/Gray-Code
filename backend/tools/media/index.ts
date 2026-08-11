/**
 * 多媒体工具模块
 *
 * 导出所有多媒体相关的工具
 */

// 导出各个工具的创建函数
export { registerGenerateImage, createGenerateImageTool } from './generate_image';
export { registerRemoveBackground, createRemoveBackgroundTool } from './remove_background';
export { registerCropImage, createCropImageTool } from './crop_image';
export { registerResizeImage, createResizeImageTool } from './resize_image';
export { registerRotateImage, createRotateImageTool } from './rotate_image';

// 静态导入注册函数（与上方 re-export 共用同一模块实例，替代原函数内 require）
import { registerGenerateImage } from './generate_image';
import { registerRemoveBackground } from './remove_background';
import { registerCropImage } from './crop_image';
import { registerResizeImage } from './resize_image';
import { registerRotateImage } from './rotate_image';

// 导出图像生成管理函数（类似终端管理）
export {
    cancelImageGeneration,
    onImageGenOutput,
    generateToolId,
    getActiveImageTasks
} from './generate_image';
export type { ImageGenOutputEvent } from './generate_image';

// 导出抠图管理函数
export {
    cancelRemoveBackground,
    onRemoveBgOutput
} from './remove_background';
export type { RemoveBgOutputEvent } from './remove_background';

// 导出裁切管理函数
export {
    cancelCropImage,
    onCropImageOutput
} from './crop_image';
export type { CropImageOutputEvent } from './crop_image';

// 导出缩放管理函数
export {
    cancelResizeImage,
    onResizeImageOutput
} from './resize_image';
export type { ResizeImageOutputEvent } from './resize_image';

// 导出旋转管理函数
export {
    cancelRotateImage,
    onRotateImageOutput
} from './rotate_image';
export type { RotateImageOutputEvent } from './rotate_image';

/**
 * 获取所有多媒体工具的注册函数
 * @returns 注册函数数组
 */
export function getMediaToolRegistrations() {
    return [
        registerGenerateImage,
        registerRemoveBackground,
        registerCropImage,
        registerResizeImage,
        registerRotateImage
    ];
}