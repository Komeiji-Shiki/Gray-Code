import type { RegexContext, RegexRule, RegexTransform, WorldActivation, WorldbookDefinition, WorldEntry } from '@graycode/contracts';

export function expandCharacterMacros(text: string, values: Record<string, string>, escape = false): string {
  return text.replace(/\{\{\s*([\w]+)\s*\}\}/g, (match, key: string) => {
    const value = values[key.toLowerCase()];
    return typeof value !== 'string' ? match : escape ? value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : value;
  });
}
function compile(pattern: string): RegExp {
  const end = pattern.startsWith('/') ? pattern.lastIndexOf('/') : -1;
  return end > 0 ? new RegExp(pattern.slice(1, end), pattern.slice(end + 1)) : new RegExp(pattern);
}

/** This module executes exclusively in the terminable character worker. */
export function transformCharacterText(text: string, rules: RegexRule[], context: RegexContext): RegexTransform {
  const result: RegexTransform = { text, applied: [], errors: [] };
  for (const rule of rules) {
    const phase = context.phase === 'display' ? rule.markdownOnly : context.phase === 'prompt' ? rule.promptOnly : !rule.markdownOnly && !rule.promptOnly;
    if (!rule.enabled || !phase || !rule.placements.includes(context.placement) || context.isEdit && !rule.runOnEdit) continue;
    if (context.depth !== undefined && (rule.minDepth !== undefined && rule.minDepth >= -1 && context.depth < rule.minDepth || rule.maxDepth !== undefined && rule.maxDepth >= 0 && context.depth > rule.maxDepth)) continue;
    try {
      const regex = compile(rule.substituteRegex ? expandCharacterMacros(rule.pattern, context.macros, rule.substituteRegex === 2) : rule.pattern);
      let matched = false;
      const updated = result.text.replace(regex, (...args: any[]) => {
        matched = true;
        const named = typeof args.at(-1) === 'object' ? args.at(-1) : {};
        const groups = args.slice(0, typeof args.at(-1) === 'object' ? -3 : -2);
        let whole = String(groups[0] ?? '');
        for (const trim of rule.trim) whole = whole.replaceAll(expandCharacterMacros(trim, context.macros), '');
        const replacement = rule.replacement.replace(/\{\{\s*match\s*\}\}|\$(\$|&|\d{1,2}|<[^>]+>)/gi, (token, capture: string | undefined) => {
          if (!capture || capture === '&' || capture === '0') return whole;
          if (capture === '$') return '$';
          if (capture.startsWith('<')) return String(named[capture.slice(1, -1)] ?? '');
          return String(groups[Number(capture)] ?? '');
        });
        return expandCharacterMacros(replacement, context.macros);
      });
      if (updated.length > 4 * 1024 * 1024) throw new Error('正则替换结果超过 4 MiB。');
      result.text = updated;
      if (matched) result.applied.push(rule.id);
    } catch (error) { result.errors.push({ id: rule.id, message: (error as Error).message }); }
  }
  return result;
}

export interface WorldEvaluation {
  books: WorldbookDefinition[]; history: string[]; scanDepth: number; tokenBudget: number;
  macros: Record<string, string>; tokenCosts: Record<string, number>; randomValues: Record<string, number>;
  messageCount?: number; timedEffects?: NonNullable<WorldActivation['timedEffects']>;
  recursive?: boolean; maxRecursionSteps?: number; additionalSources?: Record<string, string>;
}
export function evaluateWorldbooks(input: WorldEvaluation): WorldActivation {
  const output: WorldActivation = { entries: [], skipped: [], timedEffects: { ...input.timedEffects } };
  const selected = new Set<string>(), declined = new Set<string>(), activeGroups = new Set<string>();
  const usedByBook = new Map<string, number>();
  let used = 0;
  const count = input.messageCount ?? input.history.length;
  const candidates = input.books.flatMap(book => book.entries.map(entry => ({ book, entry, key: `${book.id}/${entry.id}` })))
    .sort((a, b) => Number(b.entry.constant) - Number(a.entry.constant) || b.entry.priority - a.entry.priority || b.entry.order - a.entry.order);
  let recursionText = '';
  const totalPasses = input.maxRecursionSteps && input.maxRecursionSteps > 0 ? input.maxRecursionSteps : candidates.length + 1;
  const skip = (bookId: string, entryId: string, reason: string) => output.skipped.push({ bookId, entryId, reason });
  for (let pass = 0; pass < totalPasses; pass++) {
    const activated: (typeof candidates[number] & { score: number; sticky: boolean; text: string })[] = [];
    for (const node of candidates) {
      const { book, entry, key } = node;
      if (selected.has(key) || declined.has(key) || !entry.enabled || !entry.content.trim()) continue;
      if (pass > 0 && (!(input.recursive ?? book.recursive) || entry.excludeRecursion)) continue;
      if (pass < (entry.delayUntilRecursion ?? 0)) continue;
      const timing = input.timedEffects?.[key];
      const sticky = !!timing && count > timing.activatedAt && count <= timing.stickyUntil;
      if (count < (entry.delay ?? 0)) { declined.add(key); skip(book.id, entry.id, 'delay'); continue; }
      if (!sticky && timing && count > timing.activatedAt && count <= timing.cooldownUntil) { declined.add(key); skip(book.id, entry.id, 'cooldown'); continue; }
      if (entry.vectorized && !entry.constant && !sticky) { declined.add(key); skip(book.id, entry.id, '未配置向量激活'); continue; }
      const depth = Math.max(0, Math.floor(entry.scanDepth ?? book.scanDepth ?? input.scanDepth));
      const history = depth === 0 ? '' : input.history.slice(-depth).join('\n');
      const extra = (entry.additionalSources ?? []).map(name => input.additionalSources?.[name] ?? '').join('\n');
      const haystack = expandCharacterMacros(`${history}\n${recursionText}\n${extra}`, input.macros);
      let active = entry.constant || sticky;
      let score = 0;
      try {
        const matches = (value: string) => {
          const keyword = expandCharacterMacros(value, input.macros);
          if (!keyword) return false;
          if (entry.useRegex || /^\/.+\/[dgimsuvy]*$/.test(keyword)) return compile(keyword).test(haystack);
          const source = entry.caseSensitive ? haystack : haystack.toLowerCase();
          const target = entry.caseSensitive ? keyword : keyword.toLowerCase();
          if (!entry.wholeWords) return source.includes(target);
          return new RegExp(`(?<![\\p{L}\\p{N}_])${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}_])`, 'u').test(source);
        };
        const primary = entry.keys.map(matches);
        score = primary.filter(Boolean).length;
        if (!active) active = primary.some(Boolean);
        if (active && !entry.constant && !sticky && entry.selective && entry.secondaryKeys.length) {
          const secondary = entry.secondaryKeys.map(matches);
          active = entry.selectiveLogic === 1 ? !secondary.every(Boolean) : entry.selectiveLogic === 2 ? !secondary.some(Boolean) : entry.selectiveLogic === 3 ? secondary.every(Boolean) : secondary.some(Boolean);
          if (entry.selectiveLogic === 0 || entry.selectiveLogic === 3) score += secondary.filter(Boolean).length;
        }
      } catch (error) { declined.add(key); skip(book.id, entry.id, `关键词正则无效：${(error as Error).message}`); continue; }
      if (!active) continue;
      if (!sticky && (input.randomValues[key] ?? 0) * 100 >= entry.probability) { declined.add(key); skip(book.id, entry.id, 'probability'); continue; }
      activated.push({ ...node, score, sticky, text: expandCharacterMacros(entry.content, input.macros) });
    }
    const eligible = new Set(activated.map(node => node.key));
    const groups = [...new Set(activated.flatMap(node => node.entry.group ?? []))];
    for (const group of groups) {
      const members = activated.filter(node => eligible.has(node.key) && node.entry.group?.includes(group));
      if (!members.length) continue;
      if (activeGroups.has(group)) { for (const member of members) eligible.delete(member.key); continue; }
      let choices = members;
      const stickyMembers = choices.filter(node => node.sticky);
      if (stickyMembers.length) choices = stickyMembers;
      else if (choices.some(node => node.entry.useGroupScoring)) {
        const best = Math.max(...choices.map(node => node.score));
        choices = choices.filter(node => node.score === best);
      }
      const overrides = choices.filter(node => node.entry.groupOverride);
      let winner: typeof members[number] | undefined;
      if (overrides.length) winner = overrides.sort((a, b) => b.entry.order - a.entry.order)[0];
      else {
        const total = choices.reduce((sum, node) => sum + (node.entry.groupWeight ?? 100), 0);
        let draw = (input.randomValues[`group:${group}:${pass}`] ?? input.randomValues[`group:${group}`] ?? 0) * total;
        winner = choices.find(node => { draw -= node.entry.groupWeight ?? 100; return draw < 0; });
      }
      for (const member of members) if (member !== winner) eligible.delete(member.key);
    }
    const newTexts: string[] = [];
    for (const node of activated) {
      const { book, entry, key } = node;
      if (!eligible.has(key) || entry.group?.some(group => activeGroups.has(group))) {
        declined.add(key); skip(book.id, entry.id, 'inclusion_group'); continue;
      }
      const cost = input.tokenCosts[key];
      if (cost === undefined) throw new Error(`世界书条目缺少 Token 估算：${key}`);
      if (used + cost > input.tokenBudget || (usedByBook.get(book.id) ?? 0) + cost > (book.tokenBudget ?? input.tokenBudget)) {
        declined.add(key); skip(book.id, entry.id, 'budget'); continue;
      }
      selected.add(key); entry.group?.forEach(group => activeGroups.add(group));
      used += cost; usedByBook.set(book.id, (usedByBook.get(book.id) ?? 0) + cost);
      output.entries.push({ bookId: book.id, entry, text: node.text, reason: node.sticky ? 'sticky' : entry.constant ? 'constant' : pass > 0 ? 'recursion' : 'keyword' });
      if (!node.sticky) {
        const stickyUntil = count + (entry.sticky ?? 0);
        output.timedEffects![key] = { activatedAt: count, stickyUntil, cooldownUntil: stickyUntil + (entry.cooldown ?? 0) };
      }
      if (!entry.preventRecursion) newTexts.push(node.text);
    }
    if (!newTexts.length) break;
    recursionText += '\n' + newTexts.join('\n');
  }
  output.entries.sort((a, b) => a.entry.order - b.entry.order);
  return output;
}