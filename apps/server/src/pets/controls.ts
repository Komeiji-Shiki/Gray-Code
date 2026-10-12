import type { PetChannel, PetCommand, PetCommandInput, PetParameter, PetResource } from '@graycode/contracts';

export type PetIdentity = Pick<PetCommand, 'source' | 'actorId' | 'runId'>;
export type PetControlDraft = Partial<Record<PetChannel, PetCommandInput>>;
const priorities = { task: 0, model: 1, manual: 2 };

export function petControlBusy(command: PetCommand, identity: PetIdentity): boolean {
  return command.expiresAt > Date.now() && (
    priorities[command.source] > priorities[identity.source] ||
    command.source === 'model' && identity.source === 'model' && command.runId !== identity.runId
  );
}

/** 在统一入口检查组合指令，避免其中一个通道失败后留下半次操作。 */
export function petCommandChannels(input: PetCommandInput, resource: PetResource, parameters: PetParameter[]): PetControlDraft {
  if (!input || !['play', 'expression', 'look', 'parameters', 'set', 'cancel', 'resume'].includes(input.action)) {
    throw new Error('桌宠动作类型无效。');
  }
  const channels: PetControlDraft = {};
  if (input.action === 'play' || input.action === 'set' && input.motion !== undefined) {
    const id = input.action === 'play' ? input.id : input.motion;
    if (!resource.actions.some(action => action.id === id)) throw new Error('当前桌宠没有这个动作，请先查询实际动作列表。');
    channels.motion = { action: 'play', id };
  }
  if (input.action === 'expression' || input.action === 'set' && input.expression !== undefined) {
    const id = input.action === 'expression' ? input.id : input.expression;
    if (id !== null && !resource.expressions.some(expression => expression.id === id)) throw new Error('当前模型没有这个表情。');
    channels.expression = { action: 'expression', ...(id === null ? { expression: null } : { id }) };
  }
  if (input.action === 'look' || input.action === 'set' && input.angle !== undefined) {
    if (input.angle !== null && (!Number.isFinite(input.angle) || input.angle! < 0 || input.angle! >= 360)) {
      throw new Error('视线方向需要 0 至 360 度以内的角度，或 null 恢复正面。');
    }
    if (resource.sprite?.version === 1 && input.angle !== null) throw new Error('版本 1 图集没有观察方向。');
    channels.look = { action: 'look', angle: input.angle };
  }
  if (input.action === 'parameters' || input.action === 'set' && input.parameters !== undefined) {
    if (!input.parameters || typeof input.parameters !== 'object' || Array.isArray(input.parameters) || !Object.keys(input.parameters).length) {
      throw new Error('请提供模型参数。');
    }
    for (const [id, value] of Object.entries(input.parameters)) {
      const parameter = parameters.find(item => item.id === id);
      if (!parameter || !Number.isFinite(value) || value < parameter.min || value > parameter.max) {
        throw new Error(`参数 ${id} 不存在或超出模型范围。`);
      }
    }
    channels.parameters = { action: 'parameters', parameters: { ...input.parameters } };
  }
  if (input.action === 'set' && !Object.keys(channels).length) throw new Error('组合控制至少需要一个动作、表情、视线或参数。');
  return channels;
}
