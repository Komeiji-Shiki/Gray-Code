import { createReplacePass } from './replacePassRuntime';
import { vscodeFileHost } from './vscodeFileHost';
export const { expandReplacementTemplate, MAX_REPLACE_MATCHES, searchAndReplaceInDirectory } = createReplacePass(vscodeFileHost);
export type { ReplaceResult } from './replacePassRuntime';
