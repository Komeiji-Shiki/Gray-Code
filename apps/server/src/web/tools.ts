import type { RuntimeTool } from '@graycode/core';
import { webFetchDeclaration, webSearchDeclaration } from '../../../../backend/tools/web/declarations';
import { executeWebFetch } from '../../../../backend/tools/web/fetchRuntime';
import { executeWebSearch } from '../../../../backend/tools/web/searchRuntime';
import type { PlatformApplication } from '../application';

/** 搜索与抓取都是只读公共信息接口；配置与模型渠道分开保存。 */
export function webTools(app: PlatformApplication): RuntimeTool[] {
  const settingsConfig = () => {
    const settings = app.product.runtimeSettings();
    return { config: settings.getWebSearchConfig(), proxyUrl: settings.getEffectiveProxyUrl() };
  };
  const search = webSearchDeclaration();
  const fetch = webFetchDeclaration();
  return [
    {
      declaration: { name: search.name, description: search.description, parameters: search.parameters },
      effects: () => ['public_read'],
      execute: (args, context) => {
        const { config, proxyUrl } = settingsConfig();
        return executeWebSearch(args, {
          endpoint: config.endpoint,
          apiKey: config.apiKey,
          count: config.count,
          needContent: config.needContent,
          proxyUrl
        }, context.signal);
      }
    },
    {
      declaration: { name: fetch.name, description: fetch.description, parameters: fetch.parameters },
      effects: () => ['public_read'],
      execute: (args, context) => {
        const { config, proxyUrl } = settingsConfig();
        return executeWebFetch(args, {
          endpoint: config.fetchEndpoint,
          apiKey: config.apiKey,
          proxyUrl
        }, context.signal);
      }
    }
  ];
}
