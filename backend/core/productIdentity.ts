/** Shared protocol identity, independent of the extension registry or application host. */
export const PRODUCT_USER_AGENT = 'GrayCode';

let versionResolver: () => string = () => '0.0.0';
/** Hosts supply their installed application version, independently of the user's workspace. */
export function setProductVersionResolver(resolve: () => string): void { versionResolver = resolve; }
export function createGrayCodeMcpClientInfo(): { name: string; version: string } {
    return { name: 'GrayCode', version: versionResolver() };
}
