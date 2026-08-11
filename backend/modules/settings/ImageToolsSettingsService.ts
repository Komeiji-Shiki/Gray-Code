/**
 * GrayCode - 图像工具（Image Tools）设置服务
 *
 * 从 SettingsManager.ts 拆分而来：负责图像生成/抠图/裁切/缩放/旋转
 * 工具配置段。SettingsManager 聚合委托本服务。
 */

import type {
    GenerateImageToolConfig,
    RemoveBackgroundToolConfig,
    CropImageToolConfig,
    ResizeImageToolConfig,
    RotateImageToolConfig
} from './types';
import {
    DEFAULT_GENERATE_IMAGE_CONFIG,
    DEFAULT_REMOVE_BACKGROUND_CONFIG,
    DEFAULT_CROP_IMAGE_CONFIG,
    DEFAULT_RESIZE_IMAGE_CONFIG,
    DEFAULT_ROTATE_IMAGE_CONFIG
} from './types';
import { SettingsCore } from './SettingsCore';

/**
 * 图像工具配置服务
 *
 * 对应原 SettingsManager 的「图像生成配置管理 / 抠图工具配置管理 /
 * 裁切图片工具配置管理 / 缩放图片工具配置管理 / 旋转图片工具配置管理」段。
 */
export class ImageToolsSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    /**
     * 获取图像生成工具配置
     */
    getGenerateImageConfig(): Readonly<GenerateImageToolConfig> {
        return this.core.getToolsConfigEntry('generate_image', DEFAULT_GENERATE_IMAGE_CONFIG);
    }

    /**
     * 更新图像生成工具配置
     */
    async updateGenerateImageConfig(config: Partial<GenerateImageToolConfig>): Promise<void> {
        // 读-改-写整体入队串行：oldConfig 读取与 newConfig 构造必须在 mutator 内，
        // 否则并发 update 基于队列外旧快照构造的 newConfig 会覆盖前一个变更（静默丢更新）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getGenerateImageConfig();
            await this.core.saveToolsConfigEntry('generate_image', oldConfig, { ...oldConfig, ...config });
        });
    }

    /**
     * 获取抠图工具配置
     */
    getRemoveBackgroundConfig(): Readonly<RemoveBackgroundToolConfig> {
        return this.core.getToolsConfigEntry('remove_background', DEFAULT_REMOVE_BACKGROUND_CONFIG);
    }

    /**
     * 更新抠图工具配置
     */
    async updateRemoveBackgroundConfig(config: Partial<RemoveBackgroundToolConfig>): Promise<void> {
        // 读-改-写整体入队串行（同 updateGenerateImageConfig）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getRemoveBackgroundConfig();
            await this.core.saveToolsConfigEntry('remove_background', oldConfig, { ...oldConfig, ...config });
        });
    }

    /**
     * 获取裁切图片工具配置
     */
    getCropImageConfig(): Readonly<CropImageToolConfig> {
        return this.core.getToolsConfigEntry('crop_image', DEFAULT_CROP_IMAGE_CONFIG);
    }

    /**
     * 更新裁切图片工具配置
     */
    async updateCropImageConfig(config: Partial<CropImageToolConfig>): Promise<void> {
        // 读-改-写整体入队串行（同 updateGenerateImageConfig）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getCropImageConfig();
            await this.core.saveToolsConfigEntry('crop_image', oldConfig, { ...oldConfig, ...config });
        });
    }

    /**
     * 获取缩放图片工具配置
     */
    getResizeImageConfig(): Readonly<ResizeImageToolConfig> {
        return this.core.getToolsConfigEntry('resize_image', DEFAULT_RESIZE_IMAGE_CONFIG);
    }

    /**
     * 更新缩放图片工具配置
     */
    async updateResizeImageConfig(config: Partial<ResizeImageToolConfig>): Promise<void> {
        // 读-改-写整体入队串行（同 updateGenerateImageConfig）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getResizeImageConfig();
            await this.core.saveToolsConfigEntry('resize_image', oldConfig, { ...oldConfig, ...config });
        });
    }

    /**
     * 获取旋转图片工具配置
     */
    getRotateImageConfig(): Readonly<RotateImageToolConfig> {
        return this.core.getToolsConfigEntry('rotate_image', DEFAULT_ROTATE_IMAGE_CONFIG);
    }

    /**
     * 更新旋转图片工具配置
     */
    async updateRotateImageConfig(config: Partial<RotateImageToolConfig>): Promise<void> {
        // 读-改-写整体入队串行（同 updateGenerateImageConfig）
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getRotateImageConfig();
            await this.core.saveToolsConfigEntry('rotate_image', oldConfig, { ...oldConfig, ...config });
        });
    }
}
