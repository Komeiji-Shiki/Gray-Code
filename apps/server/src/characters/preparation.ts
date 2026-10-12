import { createHash } from 'node:crypto';
import type { CharacterResource, RegexRule, WorldActivation, WorldbookDefinition } from '@graycode/contracts';
import { CharacterEngine, expandCharacterMacros, readWorldbook } from '@graycode/core';
import { MessageTokenEstimator } from '../../../../backend/modules/api/chat/services/MessageTokenEstimator';

export interface PreparedWorldbooks {
  texts: Record<string, string>;
  tokenCosts: Record<string, number>;
  regexErrors: NonNullable<WorldActivation['regexErrors']>;
}

/** 缓存只含资源和宏决定的文字，概率与时效条件仍在每个新回合重新求值。 */
export class WorldbookPreparation {
  private readonly books = new Map<string, WorldbookDefinition>();
  private readonly rendered = new Map<string, { value: PreparedWorldbooks; bytes: number }>();
  private cachedBytes = 0;
  private readonly estimator = new MessageTokenEstimator();

  read(resource: Pick<CharacterResource, 'id' | 'raw'> & { source: { sha256: string } }, revision: number | null): WorldbookDefinition {
    const key = JSON.stringify([resource.id, revision, resource.source.sha256]);
    const cached = this.books.get(key);
    if (cached) {
      this.books.delete(key);
      this.books.set(key, cached);
      return cached;
    }
    const book = readWorldbook(resource.raw, resource.id);
    if (this.books.size >= 16) this.books.delete(this.books.keys().next().value!);
    this.books.set(key, book);
    return book;
  }

  async prepare(engine: CharacterEngine, books: WorldbookDefinition[], versions: unknown, rules: RegexRule[],
    macros: Record<string, string>, signal?: AbortSignal): Promise<PreparedWorldbooks> {
    const worldRules = rules.filter(rule => rule.placements.includes(5));
    const key = createHash('sha256').update(JSON.stringify([versions, worldRules, Object.entries(macros).sort()])).digest('hex');
    const cached = this.rendered.get(key);
    if (cached) {
      signal?.throwIfAborted();
      this.rendered.delete(key);
      this.rendered.set(key, cached);
      return cached.value;
    }
    const entries = books.flatMap(book => book.entries.map(entry => ({ key: `${book.id}/${entry.id}`, entry })));
    const source = await engine.transformBatch(entries.map(({ entry }) => ({ text: expandCharacterMacros(entry.content, macros),
      context: { placement: 5, phase: 'source' as const, macros } })), worldRules, signal);
    const prompt = await engine.transformBatch(source.map(item => ({ text: item.text,
      context: { placement: 5, phase: 'prompt' as const, macros } })), worldRules, signal);
    const value: PreparedWorldbooks = { texts: {}, tokenCosts: {}, regexErrors: [] };
    let bytes = 0;
    entries.forEach(({ key }, index) => {
      const text = prompt[index].text;
      value.texts[key] = text;
      value.tokenCosts[key] = this.estimator.estimateMessageTokens({ role: 'user', parts: [{ text }] });
      bytes += (key.length + text.length) * 2 + 64;
    });
    value.regexErrors = [...new Map([...source, ...prompt].flatMap(result => result.errors)
      .map(error => [JSON.stringify([error.id, error.message]), error])).values()];
    // 宏组合随对话而变，按字节和组合数淘汰，避免长期陪伴保留全部历史版本。
    if (bytes <= 16 * 1024 * 1024) {
      while (this.rendered.size >= 16 || this.cachedBytes + bytes > 16 * 1024 * 1024) {
        const oldest = this.rendered.keys().next().value!;
        this.cachedBytes -= this.rendered.get(oldest)!.bytes;
        this.rendered.delete(oldest);
      }
      this.rendered.set(key, { value, bytes });
      this.cachedBytes += bytes;
    }
    return value;
  }

  clear(): void {
    this.books.clear();
    this.rendered.clear();
    this.cachedBytes = 0;
  }
}
