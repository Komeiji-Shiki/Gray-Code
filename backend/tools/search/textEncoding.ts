export * from './textEncodingRuntime';
import { createTextReader } from './textEncodingRuntime';
import { vscodeFileHost } from './vscodeFileHost';
export const { tryGetFileSizeBytes,readHeaderBytes } = createTextReader(vscodeFileHost);
