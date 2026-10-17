/**
 * GrayCode - 网页搜索工具设置服务
 *
 * 管理 DeepSeek Search API 的接口地址、凭据与默认结果参数。
 * 与模型渠道分开保存：渠道可能指向第三方中转，不保证提供 Search 接口。
 */

import type { WebSearchToolConfig } from './types';
import { DEFAULT_WEB_SEARCH_CONFIG } from './types';
import { SettingsCore } from './SettingsCore';

export class WebSearchSettingsService {
    private core: SettingsCore;

    constructor(core: SettingsCore) {
        this.core = core;
    }

    getWebSearchConfig(): Readonly<WebSearchToolConfig> {
        return this.core.getToolsConfigEntry('web_search', DEFAULT_WEB_SEARCH_CONFIG);
    }

    async updateWebSearchConfig(config: Partial<WebSearchToolConfig>): Promise<void> {
        // 读-改-写整体入队串行，避免并发保存基于同一份旧配置互相覆盖。
        await this.core.serializeMutation(async () => {
            const oldConfig = this.getWebSearchConfig();
            await this.core.saveToolsConfigEntry('web_search', oldConfig, { ...oldConfig, ...config });
        });
    }
}
