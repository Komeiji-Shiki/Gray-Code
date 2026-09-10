import { createSearchPass } from './searchPassRuntime';
import { vscodeFileHost } from './vscodeFileHost';
export const { getSearchInFilesConfig, getExcludePattern, splitWhitespaceFallbackKeywords, createFallbackKeywordRegex, clampNonNegativeNumber, truncateWithEllipsis, searchInDirectory, getSearchRootAndPattern } = createSearchPass(vscodeFileHost);
export type { SearchMatch, SearchBudget, SearchPassResult, SkippedFileInfo, SearchQueryFallbackInfo, SearchPathWarningInfo } from './searchPassRuntime';
