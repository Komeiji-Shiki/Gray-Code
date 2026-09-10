import { createFindFilesRuntime } from './findFilesRuntime';
import { vscodeFileHost } from './vscodeFileHost';
export const { createFindFilesTool, registerFindFiles } = createFindFilesRuntime(vscodeFileHost);

