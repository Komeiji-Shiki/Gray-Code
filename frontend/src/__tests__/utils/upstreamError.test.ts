import { expect, test } from 'vitest'
import { classifyUpstreamError } from '@shared/upstreamError'

test('按真实失败文本归类，下线说明中点名的替代模型一并取出', () => {
  expect(classifyUpstreamError('HTTP 410: Model deepseek-flash has been deprecated. Use deepseek-v4.1-flash instead.'))
    .toEqual({ kind: 'model_unavailable', replacementModel: 'deepseek-v4.1-flash' })
  expect(classifyUpstreamError("HTTP 404: The model `gpt-4-32k` does not exist or you do not have access to it."))
    .toEqual({ kind: 'model_unavailable' })
  expect(classifyUpstreamError('Anthropic 在流式响应中返回错误: This API key has expired. Create a new API key in OpenCode Console.'))
    .toEqual({ kind: 'credential' })
  expect(classifyUpstreamError('HTTP 401: Unauthorized')).toEqual({ kind: 'credential' })
  expect(classifyUpstreamError('HTTP 429: Go usage limit exceeded')).toEqual({ kind: 'quota' })
  expect(classifyUpstreamError('OpenAI Responses 在流式响应中返回错误: The ChatGPT user has reached their Subscription Sharing usage limit.'))
    .toEqual({ kind: 'quota' })
  expect(classifyUpstreamError('HTTP 402: Insufficient Balance')).toEqual({ kind: 'quota' })
})

test('超时、网关中断和参数错误没有对应的渠道动作，不归类', () => {
  for (const message of ['HTTP 502: Request timed out while waiting for API response', 'HTTP 502: 上游流在终态事件之前中断', 'fetch failed',
    'HTTP 400: Request is missing x-opencode-session and cannot be routed efficiently.',
    "HTTP 400: The 'max_tokens' parameter is deprecated, use 'max_completion_tokens'.", 'The model stream ended before a completion event.'])
    expect(classifyUpstreamError(message)).toBeUndefined()
})
