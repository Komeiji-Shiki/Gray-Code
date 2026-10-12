import type { CompanionTurn, ModelInput, PetCommandInput, PlatformMessage } from '@graycode/contracts';
import type { PlatformApplication } from '../application';
import { InlineDirectiveStream } from './inlineDirectives';

/** 行内桌宠指令在显示与保存之前剔除，模型供应方仍保留自己的完整流状态。 */
export class CompanionOutput {
  private readonly speechRuns = new Map<string, { actorId: string; resourceId: string; text: string }>();

  constructor(private readonly app: PlatformApplication) {}

  async generate(input: ModelInput, generate: (input: ModelInput) => Promise<PlatformMessage>): Promise<PlatformMessage> {
    if (input.purpose) return generate(input);
    const turn = input.turnContext?.companionTurn as CompanionTurn | undefined;
    const pet = input.runId && turn && turn.actorId === input.taskContext?.actor.id && this.app.pets.hasHost
      && input.turnContext?.companionPetAllowed === true ? turn.pet : undefined;
    const source = input.messages.findLast(message => message.isUserInput === true);
    const silent = source?.screenSenseAllowSilent === true;
    if (!pet && !silent) return generate(input);
    let sent = 0;
    let actions = Promise.resolve();
    const schedule = (command: PetCommandInput) => {
      sent++;
      actions = actions.then(async () => {
        if (!pet || input.signal.aborted) return;
        const catalog = await this.app.pets.modelCatalog();
        if (catalog.resource?.id !== pet.id) return;
        await this.app.pets.command(command, { source: 'model', actorId: turn!.actorId, runId: input.runId }, input.signal);
      }).catch(error => {
        if (!input.signal.aborted) this.app.publish({ type: 'notification', severity: 'warning', message: String(error) });
      });
    };
    let stream = new InlineDirectiveStream({ pet: !!pet, silent, onPet: schedule });
    const output = await generate({
      ...input,
      onDelta: parts => {
        const visible: Record<string, unknown>[] = [];
        for (const part of parts) {
          if (typeof part.text !== 'string' || part.thought) {
            visible.push(part);
            continue;
          }
          const text = stream.push(part.text);
          if (text) visible.push({ ...part, text });
        }
        if (visible.length) input.onDelta?.(visible);
      },
      onRetry: status => {
        stream = new InlineDirectiveStream({ pet: !!pet, silent, onPet: schedule });
        sent = 0;
        input.onRetry?.(status);
      },
    });
    const tail = stream.push('', true);
    if (tail) input.onDelta?.([{ text: tail }]);
    let ordinal = 0;
    const final = new InlineDirectiveStream({
      pet: !!pet,
      silent,
      onPet: command => { if (++ordinal > sent) schedule(command); },
    });
    const parts: Record<string, unknown>[] = [];
    for (const part of output.parts) {
      if (typeof part.text !== 'string' || part.thought) {
        parts.push(part);
        continue;
      }
      const text = final.push(part.text);
      if (text) parts.push({ ...part, text });
    }
    const finalTail = final.push('', true);
    if (finalTail) parts.push({ text: finalTail });
    await actions;
    if (pet && input.runId) {
      this.speechRuns.set(input.runId, {
        actorId: turn!.actorId,
        resourceId: pet.id,
        text: parts.filter(part => !part.thought && typeof part.text === 'string').map(part => part.text).join(''),
      });
    }
    return { ...output, parts };
  }

  async finishRun(runId: string): Promise<void> {
    const speech = this.speechRuns.get(runId);
    this.speechRuns.delete(runId);
    if (!speech?.text.trim() || !this.app.pets.hasHost) return;
    const run = await this.app.storage.getRun(runId);
    if (run?.status !== 'completed') return;
    const current = await this.app.pets.modelCatalog();
    if (current.resource?.id !== speech.resourceId || run.actorId !== speech.actorId) return;
    await this.app.pets.speak(speech.text, { actorId: run.actorId, runId });
  }
}
