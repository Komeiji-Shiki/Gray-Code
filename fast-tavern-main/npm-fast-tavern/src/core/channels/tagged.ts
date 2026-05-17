import type { ChatMessage, TaggedContent } from '../types';

export function isTaggedContents(v: unknown): v is TaggedContent[] {
  return (
    Array.isArray(v) &&
    v.every(
      (x) =>
        typeof x === 'object' &&
        x !== null &&
        'tag' in x &&
        'target' in x &&
        'text' in x
    )
  );
}

export function toInternalFromTagged(input: TaggedContent[]): ChatMessage[] {
  return (input || []).map((m) => ({
    role: m.role,
    parts: [{ text: m.text ?? '' }]
  }));
}

/**
 * 注意：tagged 的“反向转换”没有足够信息恢复 tag/target。
 * 所以 fromInternal 只能退化成 simple 或文本。
 * buildPrompt() 会在 outputFormat='tagged' 时直接返回 taggedStages，而不是走 convertMessagesOut。
 */
export function fromInternalToTagged(_internal: ChatMessage[]): TaggedContent[] {
  throw new Error(
    "fromInternalToTagged is not supported: tagged output should be produced by prompt assembly stage."
  );
}
