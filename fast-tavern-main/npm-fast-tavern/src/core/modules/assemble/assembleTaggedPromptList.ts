import type { PromptInfo, Role, TaggedContent, WorldBookEntry } from '../../types';

function normalizeRole(raw: string | null | undefined, fallback: Role = 'system'): Role {
  const r = String(raw ?? '').toLowerCase();
  if (r === 'system') return 'system';
  if (r === 'user') return 'user';
  if (r === 'model' || r === 'assistant') return 'model';
  return fallback;
}

function isFixedPrompt(p: PromptInfo): boolean {
  return p.position === 'fixed';
}

function isFixedWorldBookEntry(e: WorldBookEntry): boolean {
  return String(e.position) === 'fixed';
}

export function assembleTaggedPromptList(params: {
  presetPrompts: PromptInfo[];
  activeEntries: WorldBookEntry[];
  /** 线性聊天历史（允许包含 system/assistant；由调用方先转成 Role + text） */
  chatHistory: Array<{ role: Role; text: string; historyDepth?: number }>;
  /** 世界书 position 到 prompt.identifier 的映射（插槽条目） */
  positionMap?: Partial<Record<string, string>>;
  /** chatHistory 占位块 identifier；默认 'chatHistory' */
  chatHistoryIdentifier?: string;
}): TaggedContent[] {
  const {
    presetPrompts,
    activeEntries,
    chatHistory,
    positionMap = { beforeChar: 'charBefore', afterChar: 'charAfter' },
    chatHistoryIdentifier = 'chatHistory',
  } = params;

  const result: TaggedContent[] = [];

  const enabledPrompts = (presetPrompts || []).filter((p) => p && p.enabled !== false);

  // 1) relative prompts：作为“骨架块”输出（包含 chatHistory、charBefore、charAfter 等占位块）
  const relativePrompts = enabledPrompts.filter((p) => p.position === 'relative');

  for (const prompt of relativePrompts) {
    // 1) 世界书：插槽条目（position != fixed）
    const slotEntries = (activeEntries || [])
      .filter((e) => {
        if (!e) return false;
        if (isFixedWorldBookEntry(e)) return false;
        const mapped = positionMap[String(e.position)] || String(e.position);
        return mapped === prompt.identifier;
      })
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

    for (const entry of slotEntries) {
      result.push({
        tag: `Worldbook: ${entry.name}`,
        target: 'worldBook',
        role: normalizeRole(entry.role ?? 'system', 'system'),
        text: entry.content ?? '',
      });
    }

    // 2) 主内容
    if (prompt.identifier === chatHistoryIdentifier) {
      // dialogueList：仅包含真实聊天历史项（depth 规则只对这些生效）
      let dialogueList: TaggedContent[] = (chatHistory || []).map((node) => ({
        tag: `History: ${node.role}`,
        target: node.role === 'user' ? 'userInput' : node.role === 'model' ? 'aiOutput' : 'slashCommands',
        role: node.role,
        text: node.text,
        historyDepth: node.historyDepth,
      }));

      // 仅 fixed 才会注入到 chatHistory，此时才使用 depth/order
      const presetInjections = enabledPrompts.filter(
        (p) =>
          isFixedPrompt(p) &&
          typeof p.depth === 'number' &&
          Number.isFinite(p.depth) &&
          typeof p.order === 'number' &&
          Number.isFinite(p.order)
      );

      const worldBookInjections = (activeEntries || []).filter(
        (e) =>
          isFixedWorldBookEntry(e) &&
          typeof e.depth === 'number' &&
          Number.isFinite(e.depth) &&
          typeof e.order === 'number' &&
          Number.isFinite(e.order)
      );

      const allInjections = [
        ...presetInjections.map((p, idx) => ({
          tag: `Preset: ${p.name}`,
          target: 'slashCommands' as const,
          role: normalizeRole(p.role, 'system'),
          text: p.content || '',
          depth: p.depth,
          order: p.order,
          idx,
        })),
        ...worldBookInjections.map((e, idx) => ({
          tag: `Worldbook: ${e.name}`,
          target: 'worldBook' as const,
          role: normalizeRole(e.role ?? 'system', 'system'),
          text: e.content,
          depth: e.depth,
          order: e.order,
          idx: 10_000 + idx,
        })),
      ].sort((a, b) => {
        if (a.depth !== b.depth) return a.depth - b.depth;
        // 同 depth 条目 insert 到同一位置时，后插入的排在前面，
        // 因此需反转 order/idx 排序，保证最终输出中 order 小的在前
        if (a.order !== b.order) return b.order - a.order;
        return b.idx - a.idx;
      });

      const originalCount = dialogueList.length;
      for (const item of allInjections) {
        const targetIndex = Math.max(0, originalCount - item.depth);
        dialogueList.splice(targetIndex, 0, {
          tag: item.tag,
          target: item.target,
          role: item.role,
          text: item.text,
          // 注意：注入项不是“真实聊天历史”，所以不带 historyDepth
        });
      }

      result.push(...dialogueList);
      continue;
    }

    if (prompt.content) {
      result.push({
        tag: `Preset: ${prompt.name}`,
        target: 'slashCommands',
        role: normalizeRole(prompt.role, 'system'),
        text: prompt.content,
      });
    }
  }

  return result;
}

