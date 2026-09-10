import type { PlatformApplication } from '../application';
import type { BotGateway } from './gateway';
import { OneBotGateway } from './onebotGateway';
import { BoundBotService } from './service';
import { createOneBotProtocol } from './onebotProtocol';
export class OneBotService extends BoundBotService {
  constructor(app: PlatformApplication, factory?: () => BotGateway) {
    super(app, 'onebot', factory ?? (() => {
      const config = app.settings.snapshot().settings.onebot;
      if (!config) throw new Error('请先配置 OneBot。');
      return new OneBotGateway(config.endpoint, createOneBotProtocol(config));
    }));
  }
}
