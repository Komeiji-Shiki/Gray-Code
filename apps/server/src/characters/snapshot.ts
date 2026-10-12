import type { PlatformMessage, WorldActivation, WorldEntry } from '@graycode/contracts';
import type { CharacterTurn } from './pipeline';

export const WORLD_SLOTS: Record<string, string> = {
  before_char: 'WORLDBOOK_BEFORE_CHARACTER',
  after_char: 'WORLDBOOK_AFTER_CHARACTER',
  examples_before: 'WORLDBOOK_BEFORE_EXAMPLES',
  examples_after: 'WORLDBOOK_AFTER_EXAMPLES',
  authors_note_before: 'WORLDBOOK_BEFORE_NOTE',
  authors_note_after: 'WORLDBOOK_AFTER_NOTE',
};

type StoredActivationEntry = Omit<WorldActivation['entries'][number], 'entry' | 'text'> & {
  entry: Omit<WorldEntry, 'content'> & { content: number };
  text: number;
};

export interface StoredCharacterTurn extends Omit<CharacterTurn, 'modules' | 'injections' | 'outlets' | 'activation'> {
  version: 2;
  texts: string[];
  modules: Record<string, number[]>;
  injections: Array<{ role: PlatformMessage['role']; promptAnchor?: PlatformMessage['promptAnchor']; text: number }>;
  outlets: Record<string, number[]>;
  activation: Omit<WorldActivation, 'entries'> & { entries: StoredActivationEntry[] };
}

/** 同一正文只保存一次，模块与深度插入保存引用；随机结果和时效仍随回合完整保留。 */
export function storeCharacterTurn(turn: CharacterTurn): StoredCharacterTurn {
  const texts: string[] = [];
  const indices = new Map<string, number>();
  const reference = (text: string) => {
    const existing = indices.get(text);
    if (existing !== undefined) return existing;
    const index = texts.length;
    texts.push(text);
    indices.set(text, index);
    return index;
  };
  const worldModules = new Map<string, number[]>();
  const worldOutlets = new Map<string, number[]>();
  const append = (values: Map<string, number[]>, key: string, index: number) => {
    const indices = values.get(key);
    if (indices) indices.push(index);
    else values.set(key, [index]);
  };
  const entries = turn.activation.entries.map(item => {
    const text = reference(item.text);
    const slot = WORLD_SLOTS[item.entry.position];
    if (slot && item.text) append(worldModules, slot, text);
    else if (item.entry.position === 'outlet' && item.entry.outletName && item.text) {
      const name = item.entry.outletName;
      append(worldOutlets, name, text);
    }
    return { ...item, text, entry: { ...item.entry, content: reference(item.entry.content) } };
  });
  const layout = (values: Record<string, string>, worldValues: Map<string, number[]>) => Object.fromEntries(
    Object.entries(values).map(([key, text]) => [key, worldValues.get(key) ?? [reference(text)]])
  );
  return {
    ...turn,
    version: 2,
    texts,
    modules: layout(turn.modules, worldModules),
    outlets: layout(turn.outlets, worldOutlets),
    injections: turn.injections.map(message => ({ role: message.role, promptAnchor: message.promptAnchor,
      text: reference(message.parts.map(part => part.text ?? '').join('\n')) })),
    activation: { ...turn.activation, entries },
  };
}

/** 旧记录保留原结构，新记录只在组装请求和预览时恢复正文。 */
export function restoreCharacterTurn(value: unknown): CharacterTurn | undefined {
  if (!value) return undefined;
  const stored = value as CharacterTurn | StoredCharacterTurn;
  if (!('version' in stored) || stored.version !== 2) return stored as CharacterTurn;
  const render = (values: Record<string, number[]>) => Object.fromEntries(
    Object.entries(values).map(([key, indices]) => [key, indices.map(index => stored.texts[index]).join('\n\n')])
  );
  const { version, texts, ...turn } = stored;
  return {
    ...turn,
    modules: render(stored.modules),
    outlets: render(stored.outlets),
    injections: stored.injections.map(message => ({ role: message.role, promptAnchor: message.promptAnchor,
      parts: [{ text: texts[message.text] }] })),
    activation: { ...stored.activation, entries: stored.activation.entries.map(item => ({ ...item, text: texts[item.text],
      entry: { ...item.entry, content: texts[item.entry.content] } })) },
  };
}
