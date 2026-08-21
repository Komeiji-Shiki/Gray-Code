/**
 * DeepSeek Vision 前置判断的共享工具。
 *
 * 与后端 isDeepSeekVisionModel 同口径的轻量判断（前端无进程内共享函数），
 * 由 InputArea（输入区复选框）与 EditDialog（编辑消息复选框）共用，避免口径漂移。
 */
export function isDeepSeekVisionModelName(model?: string): boolean {
  const normalized = (model || '').trim().toLowerCase()
  return normalized.includes('deepseek') && normalized.includes('vision')
}
