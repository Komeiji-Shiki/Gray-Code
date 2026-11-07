/**
 * 模型接口失败的处理办法分类。输入是运行失败时记录的错误文本（`HTTP 410: …` 或格式器包装的流式错误），
 * 只识别能给出明确办法的三类：模型下线或不可用、密钥失效、额度或频率上限；其余返回 undefined，照常显示原文。
 */
export type UpstreamErrorKind = 'model_unavailable' | 'credential' | 'quota';

export interface UpstreamErrorAdvice {
  kind: UpstreamErrorKind;
  /** 供应方在下线说明里点名的替代模型，如 “Use deepseek-v4.1-flash instead”。 */
  replacementModel?: string;
}

const MODEL_UNAVAILABLE = /\bmodel\b.{0,80}?\b(?:deprecated|decommissioned|retired|no longer (?:available|supported)|not found|does not exist|not available)\b/i;
const REPLACEMENT = /\b(?:use|switch to|migrate to)\s+[`'"]?([A-Za-z0-9][\w.:/-]{0,63}?)[`'"]?\s+instead\b/i;
const CREDENTIAL = /\b(?:api[ _-]?key|access token|credential)s?\b.{0,40}?\b(?:expired|invalid|incorrect|revoked|disabled)\b|\binvalid_api_key\b|\bauthentication_error\b/i;
const QUOTA = /\b(?:usage|rate|quota|spending|credit|billing)\b.{0,30}?\b(?:limit|exceeded|exhausted|insufficient)\b|\binsufficient_quota\b|\b(?:insufficient balance|balance is too low)\b/i;

export function classifyUpstreamError(message: string): UpstreamErrorAdvice | undefined {
  const status = Number(/^HTTP (\d{3})\b/.exec(message)?.[1]);
  if (status === 410 || MODEL_UNAVAILABLE.test(message)) {
    const replacementModel = REPLACEMENT.exec(message)?.[1];
    return { kind: 'model_unavailable', ...(replacementModel ? { replacementModel } : {}) };
  }
  if (status === 401 || CREDENTIAL.test(message)) return { kind: 'credential' };
  if (status === 402 || status === 429 || QUOTA.test(message)) return { kind: 'quota' };
  return undefined;
}
