import type { RuntimeTool } from '@graycode/core';
import type { PetCommandInput } from '@graycode/contracts';
import type { PetService } from './service';

export function petTools(service: PetService): RuntimeTool[] {
  return [{
    declaration: {
      name: 'pet_control',
      description: '控制本设备当前显示的桌宠。query 返回动作、表情描述、参数范围和各通道状态；set 可同时指定 motion、expression、angle、parameters，各通道独立叠加和过期。cancel 撤销控制并恢复待机；resume 释放自己的控制并恢复任务动画，两者都不占用控制权。用户手动停止后只能由用户恢复。手动操作优先，其他运行占用同一通道时返回忙碌。回执区分已接受与已实际应用。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['query', 'play', 'expression', 'look', 'parameters', 'set', 'cancel', 'resume'] },
          id: { type: 'string' },
          motion: { type: 'string' },
          expression: { type: ['string', 'null'] },
          angle: { type: ['number', 'null'], minimum: 0, exclusiveMaximum: 360 },
          parameters: { type: 'object', additionalProperties: { type: 'number' } },
          durationMs: { type: 'integer', minimum: 100, maximum: 120000 },
        },
        required: ['action'],
        additionalProperties: false,
      },
    },
    effects: () => ['desktop_control'],
    execute: async (input, context) => {
      try {
        if (input.action === 'query') return await service.query(context.actorId, context.signal);
        return await service.command(input as unknown as PetCommandInput, {
          source: 'model', actorId: context.actorId, runId: context.runId,
        }, context.signal);
      } catch (error) {
        return { success: false, error: (error as Error).message };
      }
    },
  }];
}
