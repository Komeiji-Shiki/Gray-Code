import { crc32, inflateSync } from 'node:zlib';
import type { CharacterDefinition, CharacterResourceKind, RegexRule, WorldbookDefinition, WorldEntry } from '@graycode/contracts';

const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};
const text = (value: unknown) => typeof value === 'string' ? value : '';
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const number = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** Decode metadata without executing scripts, loading linked assets, or modifying the original file. */
export function readCharacterFile(bytes: Uint8Array): { raw: Record<string, unknown> | unknown[]; mimeType: string } {
  const data = Buffer.from(bytes);
  if (data.length > 32 * 1024 * 1024) throw new Error('角色资源文件不能超过 32 MiB。');
  if (!data.subarray(0, 8).equals(pngSignature)) return { raw: parseJson(data.toString('utf8')), mimeType: 'application/json' };
  const chunks = new Map<string, string>();
  let offset = 8;
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    if (offset + 12 + length > data.length) throw new Error('PNG 数据块不完整。');
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (crc32(data.subarray(offset + 4, offset + 8 + length)) !== data.readUInt32BE(offset + 8 + length)) throw new Error('PNG 数据块校验失败。');
    const end = body.indexOf(0);
    if (end > 0 && ['tEXt', 'zTXt', 'iTXt'].includes(type)) {
      const key = body.toString('latin1', 0, end);
      if (key === 'ccv3' || key === 'chara') {
        let content = body.subarray(end + 1);
        if (type === 'zTXt') {
          if (content[0] !== 0) throw new Error('PNG 文本压缩方式不支持。');
          content = inflateSync(content.subarray(1), { maxOutputLength: 16 * 1024 * 1024 });
        } else if (type === 'iTXt') {
          const compressed = content[0];
          if (content.length < 4 || content[1] !== 0 || compressed > 1) throw new Error('PNG 国际文本块无效。');
          const languageEnd = content.indexOf(0, 2), translatedEnd = content.indexOf(0, languageEnd + 1);
          if (languageEnd < 0 || translatedEnd < 0) throw new Error('PNG 国际文本块不完整。');
          content = content.subarray(translatedEnd + 1);
          if (compressed) content = inflateSync(content, { maxOutputLength: 16 * 1024 * 1024 });
        }
        if (chunks.has(key)) throw new Error(`PNG 包含重复的 ${key} 角色定义。`);
        chunks.set(key, content.toString('utf8'));
      }
    }
    offset += length + 12;
    if (type === 'IEND') break;
  }
  const encoded = chunks.get('ccv3') ?? chunks.get('chara');
  if (!encoded) throw new Error('PNG 中没有 chara / ccv3 角色定义。');
  if (!/^[A-Za-z0-9+/=\s]+$/.test(encoded)) throw new Error('PNG 角色定义不是有效的 Base64。');
  return { raw: parseJson(Buffer.from(encoded, 'base64').toString('utf8')), mimeType: 'image/png' };
}
function parseJson(value: string): Record<string, unknown> | unknown[] {
  const parsed = JSON.parse(value.replace(/^\uFEFF/, ''));
  if (!parsed || typeof parsed !== 'object') throw new Error('资源必须包含 JSON 对象或数组。');
  return parsed;
}

export function identifyCharacterResource(raw: unknown): CharacterResourceKind {
  const value = object(raw);
  if (value.spec === 'chara_card_v2' || value.spec === 'chara_card_v3' || typeof value.first_mes === 'string' || typeof value.description === 'string' && typeof value.name === 'string' && !value.entries) return 'character';
  if (value.entries && typeof value.entries === 'object' || Array.isArray(raw) && raw.length > 0 && raw.every(item => typeof object(item).content === 'string')) return 'worldbook';
  if (Array.isArray(raw) || typeof value.findRegex === 'string' || Array.isArray(value.regex_scripts)) return 'regex';
  throw new Error('未识别的资源格式，请导入角色卡、世界书或正则规则文件。');
}

export function readCharacterDefinition(raw: unknown): CharacterDefinition {
  const root = object(raw);
  if (root.spec && !['chara_card_v2', 'chara_card_v3'].includes(root.spec)) throw new Error(`不支持的角色格式：${root.spec}`);
  const version = root.spec === 'chara_card_v3' ? 3 : root.spec === 'chara_card_v2' ? 2 : 1;
  const data = version === 1 ? root : object(root.data);
  if (!text(data.name).trim()) throw new Error('角色卡缺少角色名称。');
  const extensions = object(data.extensions);
  const book = Object.keys(object(data.character_book)).length ? object(data.character_book) : undefined;
  const references = [text(extensions.world), ...strings(extensions.extra_books)];
  return { version, name: data.name, description: text(data.description), personality: text(data.personality), scenario: text(data.scenario),
    greetings: [text(data.first_mes), ...strings(data.alternate_greetings)], examples: text(data.mes_example), systemPrompt: text(data.system_prompt),
    postHistory: text(data.post_history_instructions), creatorNotes: text(data.creator_notes), book,
    regexScripts: Array.isArray(extensions.regex_scripts) ? extensions.regex_scripts : [],
    missingReferences: [...new Set(references.filter(name => name && name !== book?.name))],
  };
}

export function readRegexRules(raw: unknown): RegexRule[] {
  const value = object(raw);
  const scripts = Array.isArray(raw) ? raw : Array.isArray(value.regex_scripts) ? value.regex_scripts : [raw];
  if (scripts.length > 1000) throw new Error('单个资源最多包含 1000 条正则规则。');
  return scripts.map((script, index) => {
    const item = object(script);
    if (typeof item.findRegex !== 'string' || typeof (item.replaceString ?? item.replaceRegex) !== 'string') throw new Error(`第 ${index + 1} 条正则缺少匹配式或替换文本。`);
    return { id: text(item.id) || String(index), name: text(item.scriptName) || `规则 ${index + 1}`, pattern: item.findRegex, replacement: item.replaceString ?? item.replaceRegex,
      enabled: item.disabled !== true && item.enabled !== false, placements: Array.isArray(item.placement) ? item.placement.filter((x: unknown) => typeof x === 'number') : strings(item.targets).map(target => (({ userInput: 1, aiOutput: 2, slashCommands: 3, worldBook: 5, reasoning: 6 } as Record<string, number>)[target])).filter((value): value is number => value !== undefined),
      trim: strings(item.trimStrings ?? item.trimRegex), markdownOnly: item.markdownOnly === true || strings(item.view).includes('user'), promptOnly: item.promptOnly === true || strings(item.view).includes('model'), runOnEdit: item.runOnEdit === true,
      minDepth: typeof item.minDepth === 'number' ? item.minDepth : undefined, maxDepth: typeof item.maxDepth === 'number' ? item.maxDepth : undefined,
      substituteRegex: number(item.substituteRegex, item.macroMode === 'raw' ? 1 : item.macroMode === 'escaped' ? 2 : 0) };
  });
}

export function readWorldbook(raw: unknown, id: string): WorldbookDefinition {
  const value = object(raw);
  const entries = Array.isArray(raw) ? raw : Array.isArray(value.entries) ? value.entries : Object.values(object(value.entries));
  if (entries.length > 10000) throw new Error('单个世界书最多包含 10000 条条目。');
  return { id, name: text(value.name), scanDepth: typeof value.scan_depth === 'number' ? value.scan_depth : undefined,
    tokenBudget: typeof value.token_budget === 'number' ? value.token_budget : undefined, recursive: value.recursive_scanning === true,
    entries: entries.map((entry, index): WorldEntry => {
      const item = object(entry), ext = { ...object(object(item.other).extensions), ...object(item.extensions) };
      const field = (...keys: string[]) => {
        for (const key of keys) if (item[key] !== undefined && item[key] !== null) return item[key];
        for (const key of keys) if (ext[key] !== undefined && ext[key] !== null) return ext[key];
        return undefined;
      };
      const position = field('position');
      const positions = ['before_char', 'after_char', 'authors_note_before', 'authors_note_after', 'at_depth', 'examples_before', 'examples_after', 'outlet'];
      const aliases: Record<string, string> = { beforeChar: 'before_char', afterChar: 'after_char', beforeAn: 'authors_note_before', afterAn: 'authors_note_after',
        before_an: 'authors_note_before', after_an: 'authors_note_after', beforeEm: 'examples_before', afterEm: 'examples_after', before_em: 'examples_before', after_em: 'examples_after', fixed: 'at_depth' };
      const role = field('role');
      const logic = field('selectiveLogic', 'selective_logic');
      const logicNames: Record<string, number> = { andAny: 0, notAll: 1, notAny: 2, andAll: 3 };
      const delayRecursion = field('delayUntilRecursion', 'delay_until_recursion');
      return { id: String(item.id ?? item.uid ?? item.index ?? index), name: text(item.comment ?? item.name), content: text(item.content), keys: strings(item.keys ?? item.key), secondaryKeys: strings(item.secondary_keys ?? item.keysecondary ?? item.secondaryKey),
        enabled: value.enabled !== false && item.enabled !== false && item.disable !== true,
        constant: field('constant') === true || item.activationMode === 'always',
        selective: item.selective === true || typeof item.selectiveLogic === 'string',
        selectiveLogic: typeof logic === 'string' ? logicNames[logic] ?? 0 : number(logic, 0),
        caseSensitive: field('case_sensitive', 'caseSensitive') === true,
        wholeWords: field('matchWholeWords', 'match_whole_words') === true, useRegex: item.use_regex === true,
        order: number(item.insertion_order ?? item.order, index), priority: number(item.priority, 0),
        position: typeof position === 'number' ? positions[position] ?? 'unsupported' : typeof position === 'string' ? aliases[position] ?? position : 'before_char',
        depth: number(field('depth'), 0), role: role === 1 || role === 'user' ? 'user' : role === 2 || role === 'assistant' || role === 'model' ? 'assistant' : 'system',
        probability: field('useProbability') === false ? 100 : Math.max(0, Math.min(100, number(field('probability'), 100))),
        scanDepth: typeof field('scanDepth', 'scan_depth') === 'number' ? field('scanDepth', 'scan_depth') : undefined,
        preventRecursion: field('preventRecursion', 'prevent_recursion') === true, excludeRecursion: field('excludeRecursion', 'exclude_recursion') === true,
        group: text(field('group')).split(',').map(item => item.trim()).filter(Boolean),
        groupOverride: field('groupOverride') === true, groupWeight: Math.max(0, number(field('groupWeight'), 100)), useGroupScoring: field('useGroupScoring') === true,
        sticky: Math.max(0, number(field('sticky'), 0)), cooldown: Math.max(0, number(field('cooldown'), 0)), delay: Math.max(0, number(field('delay'), 0)),
        delayUntilRecursion: delayRecursion === true ? 1 : Math.max(0, number(delayRecursion, 0)),
        ignoreBudget: field('ignoreBudget') === true, vectorized: field('vectorized') === true || item.activationMode === 'vector', outletName: text(field('outletName')),
        additionalSources: ['matchPersonaDescription', 'matchCharacterDescription', 'matchCharacterPersonality', 'matchCharacterDepthPrompt', 'matchScenario', 'matchCreatorNotes']
          .filter(key => field(key) === true),
      };
    }) };
}