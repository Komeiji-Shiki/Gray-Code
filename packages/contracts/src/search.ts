import type { SourceRange } from './development';

export interface ProjectSearchQuery {
  query: string;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  include?: string;
  exclude?: string;
}
export interface ProjectSearchMatch { range: SourceRange; text: string; preview: string }
export interface ProjectSearchFile {
  path: string;
  hash: string;
  draft: boolean;
  matches: ProjectSearchMatch[];
}
export interface ProjectSearchResult {
  files: ProjectSearchFile[];
  count: number;
  truncated: boolean;
  skipped: Array<{ path: string; reason: string }>;
}
export interface ProjectReplacement { path: string; before: string; after: string }
