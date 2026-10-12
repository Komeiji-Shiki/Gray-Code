import type { PetCommandInput } from '@graycode/contracts';

export interface InlineDirectiveOptions {
  pet: boolean;
  silent: boolean;
  onPet?: (command: PetCommandInput) => void;
}

function petCommand(tag: string): PetCommandInput | undefined {
  const match = /^<pet\s+([^<>]*?)\s*\/>$/i.exec(tag);
  if (!match) return undefined;
  const fields = new Map<string, string>();
  const attributes = /\s*([a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
  let cursor = 0;
  for (const attribute of match[1].matchAll(attributes)) {
    if (attribute.index !== cursor || fields.has(attribute[1]) || !['motion', 'expression'].includes(attribute[1])) return undefined;
    fields.set(attribute[1], (attribute[2] ?? attribute[3]).replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&'));
    cursor = attribute.index + attribute[0].length;
  }
  if (match[1].slice(cursor).trim() || !fields.size || fields.has('motion') && !fields.get('motion')) return undefined;
  return {
    action: 'set',
    ...(fields.has('motion') ? { motion: fields.get('motion') } : {}),
    ...(fields.has('expression') ? { expression: fields.get('expression') || null } : {}),
  };
}

/** 只保留可能跨增量分割的标签；代码中的示例保持原文，也不会执行动作。 */
export class InlineDirectiveStream {
  private pending = '';
  private codeTicks = 0;
  private escaped = false;

  constructor(private readonly options: InlineDirectiveOptions) {}

  push(text: string, final = false): string {
    this.pending += text;
    let output = '';
    let cursor = 0;
    const names = [
      ...(this.options.pet ? ['<pet'] : []),
      ...(this.options.silent ? ['<screen_sense_silent'] : []),
    ];
    while (cursor < this.pending.length) {
      const character = this.pending[cursor];
      if (character === '`' && !this.escaped) {
        let end = cursor + 1;
        while (this.pending[end] === '`') end++;
        if (end === this.pending.length && !final) break;
        const count = end - cursor;
        if (!this.codeTicks) this.codeTicks = count;
        else if (this.codeTicks === count) this.codeTicks = 0;
        output += this.pending.slice(cursor, end);
        cursor = end;
        continue;
      }
      if (character === '<' && !this.codeTicks && !this.escaped) {
        const rest = this.pending.slice(cursor);
        const lower = rest.toLowerCase();
        const name = names.find(value => lower.startsWith(value) || value.startsWith(lower));
        if (name && (lower.length <= name.length || /[\s/]/.test(lower[name.length]))) {
          const end = rest.indexOf('>');
          if (end < 0 && !final) break;
          if (end >= 0) {
            const tag = rest.slice(0, end + 1);
            const command = this.options.pet ? petCommand(tag) : undefined;
            if (command) {
              this.options.onPet?.(command);
              cursor += tag.length;
              continue;
            }
            if (this.options.silent && /^<screen_sense_silent\s*\/>$/i.test(tag)) {
              cursor += tag.length;
              continue;
            }
          }
        }
      }
      output += character;
      this.escaped = character === '\\' && !this.escaped;
      cursor++;
    }
    this.pending = this.pending.slice(cursor);
    return output;
  }
}
