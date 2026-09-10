export type ChatKind = 'code' | 'chat' | 'character';
export type CharacterResourceKind = 'character' | 'worldbook' | 'regex';
export interface CharacterResource {
  id: string; kind: CharacterResourceKind; name: string; createdAt: number; updatedAt: number;
  raw: Record<string, unknown> | unknown[];
  source: { name: string; sha256: string; inlineData: { mimeType: string; data: string } };
  warnings: string[];
  bindings: { worldbookIds: string[]; regexIds: string[]; missing: string[] };
}
export interface CharacterDefinition {
  version: 1 | 2 | 3; name: string; description: string; personality: string; scenario: string;
  greetings: string[]; examples: string; systemPrompt: string; postHistory: string; creatorNotes: string;
  book?: Record<string, unknown>; regexScripts: unknown[]; missingReferences: string[];
}
export interface CharacterChatConfig {
  kind: ChatKind; characterId?: string; greetingIndex?: number; userName: string; persona: string;
  worldbookIds: string[]; regexIds: string[];
  /** Explicit user configuration is used when a book omits these fields. */
  scanDepth: number; worldTokenBudget?: number; recursiveScan?: boolean; maxRecursionSteps?: number;
}
export interface RegexRule {
  id: string; name: string; pattern: string; replacement: string; enabled: boolean;
  placements: number[]; trim: string[]; markdownOnly: boolean; promptOnly: boolean; runOnEdit: boolean;
  minDepth?: number; maxDepth?: number; substituteRegex: number;
}
export interface RegexContext {
  placement: number; phase: 'source' | 'prompt' | 'display'; depth?: number; isEdit?: boolean;
  macros: Record<string, string>;
}
export interface RegexTransform { text: string; applied: string[]; errors: { id: string; message: string }[] }
export interface WorldEntry {
  name?: string;
  group?: string[]; groupOverride?: boolean; groupWeight?: number; useGroupScoring?: boolean;
  sticky?: number; cooldown?: number; delay?: number; delayUntilRecursion?: number;
  ignoreBudget?: boolean; vectorized?: boolean; outletName?: string;
  additionalSources?: string[];
  id: string; content: string; keys: string[]; secondaryKeys: string[]; enabled: boolean; constant: boolean;
  selective: boolean; selectiveLogic: number; caseSensitive: boolean; wholeWords: boolean; useRegex: boolean;
  order: number; priority: number; position: string; depth: number; role: 'system' | 'user' | 'assistant';
  probability: number; scanDepth?: number; preventRecursion: boolean; excludeRecursion: boolean;
}
export interface WorldbookDefinition {
  id: string; name: string; entries: WorldEntry[]; scanDepth?: number; tokenBudget?: number; recursive: boolean;
}
export interface WorldTimedEffect { activatedAt: number; stickyUntil: number; cooldownUntil: number }
export interface WorldActivation {
  regexErrors?: { id: string; message: string }[];
  timedEffects?: Record<string, WorldTimedEffect>;
  entries: { bookId: string; entry: WorldEntry; text: string; reason?: 'constant' | 'sticky' | 'keyword' | 'recursion' }[];
  skipped: { bookId: string; entryId: string; reason: string }[];
}
