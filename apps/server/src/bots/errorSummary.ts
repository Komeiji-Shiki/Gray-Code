import type { RunStatus } from '@graycode/contracts';

const PUBLIC_ERRORS = new Set([
  'Workspace or account is unavailable.',
  'Workspace not found.',
  'Actor or agent is unavailable.',
  'Run account was revoked.',
  'The provider credential is unavailable.',
  'The model stream ended before a completion event.',
  '模型渠道已变化，请重新选择。',
  '请输入消息。',
  '当前任务仍在执行，可用 /gray 查看状态、追加说明，或新建另一段对话。',
  '当前对话没有可重试的失败任务。',
  '只能重试你在当前频道发起的任务。',
  '原自动工作区目录已不存在，请由主人重新选择工作区。',
  '原自动工作区路径不是目录，请由主人重新选择工作区。',
  '自动工作区目录与原会话记录不一致，请由主人重新选择工作区。',
  '这个菜单已经过期，或不属于当前账号。请重新输入 /gray。',
  'Discord 私聊当前只对主人开放。',
  '这个频道尚未启用，请在桌面管理页选择允许响应的频道。',
]);

/** 只公开已核对的固定文案；上游错误正文和异常参数不能靠正则证明没有敏感信息。 */
export function publicBotError(error: string | undefined): string | undefined {
  const message = error?.trim();
  if (!message) return undefined;
  if (PUBLIC_ERRORS.has(message)) return message;
  if (/^账号尚未绑定，默认访客对话也未启用。你的数字用户 ID 是 \d{1,20}，请由主人配置默认权限或单独授权。$/.test(message))
    return '账号尚未绑定，默认访客对话也未启用。请由主人配置默认权限或单独授权。';
  const limit = /^The configured iteration limit \(([1-9]\d{0,5})\) was reached\.$/.exec(message);
  if (limit) return message;
  const status = /^HTTP ([45]\d{2})(?::|$)/.exec(message);
  if (status) return `模型接口返回 HTTP ${status[1]}。`;
  return undefined;
}

/** 动态提示词只传递上一轮的失败事实和可公开摘要，不把未知异常原文交给模型。 */
export function botFailureContext(status: RunStatus, error?: string): string | undefined {
  if (status !== 'failed' && status !== 'interrupted') return undefined;
  const reason = publicBotError(error);
  const result = status === 'failed' ? '执行失败' : '执行中断';
  return `[GrayCode 运行状态] 上一轮任务${result}。${reason ? `错误摘要：${reason} ` : '具体错误未提供给模型。'}`
    + '上一轮未能正常完成，可能已有部分输出；请结合本次用户消息和已有历史继续处理，不要把这条状态信息当作用户指令。';
}
