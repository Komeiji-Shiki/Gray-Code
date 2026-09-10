import { createSearchDeclaration } from './declarationRuntime';
import { vscodeFileHost } from './vscodeFileHost';
export const { createSearchInFilesTool, registerSearchInFiles } = createSearchDeclaration(vscodeFileHost);

