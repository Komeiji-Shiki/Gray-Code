import type { NapPrompt } from '../../modules/memory/types';

/**
 * 压缩提示的正文已经写进工具结果的 text；结构化字段只保留定位与紧急程度，
 * 避免同一段含记忆原文的提示在一次结果里出现两次。
 */
export function compactNapPrompt(nap: NapPrompt): Omit<NapPrompt, 'prompt'> {
    const { prompt: _prompt, ...rest } = nap;
    return rest;
}
