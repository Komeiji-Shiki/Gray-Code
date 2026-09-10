import type { PlatformApplication } from '../application';
import { BoundBotService } from './service';
import { DiscordJsGateway, type DiscordGateway } from './discordGateway';
import type { BotInteraction } from './gateway';
import { DiscordControls } from './discordControls';
export type { BotStatus as DiscordStatus } from './service';
export class DiscordBotService extends BoundBotService {
  private readonly controls: DiscordControls;
  constructor(app: PlatformApplication, factory: () => DiscordGateway = () => new DiscordJsGateway()) {
    super(app, 'discord', factory);
    this.controls = new DiscordControls(app, this.sessions, input => this.context(input));
  }
  protected async interaction(input: BotInteraction) { await this.controls.handle(input); }
  protected clearInteractions() { this.controls?.clear(); }
}
