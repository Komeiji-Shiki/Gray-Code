import type { RuntimeTool } from '@graycode/core';
import { webSearchDeclaration } from '../../../../backend/tools/web/declarations';
import { executeWebSearch } from '../../../../backend/tools/web/searchRuntime';
import type { PlatformApplication } from '../application';

/** 搜索服务是只读公共信息接口；配置与模型渠道分开保存。 */
export function webTools(app: PlatformApplication): RuntimeTool[] {
  const declaration = webSearchDeclaration();
  return [{
    declaration: { name: declaration.name, description: declaration.description, parameters: declaration.parameters },
    effects: () => ['public_read'],
    execute: (args, context) => {
      const settings = app.product.runtimeSettings();
      const config = settings.getWebSearchConfig();
      return executeWebSearch(args, {
        endpoint: config.endpoint,
        apiKey: config.apiKey,
        count: config.count,
        needContent: config.needContent,
        proxyUrl: settings.getEffectiveProxyUrl()
      }, context.signal);
    }
  }];
}
