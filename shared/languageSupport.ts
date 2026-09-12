import type { ServerCapabilities } from 'vscode-languageserver-protocol';

/** 编辑器与宿主按服务实际声明的能力发请求，避免未实现的方法反复报错。 */
export function languageMethodSupported(capabilities: ServerCapabilities, method: string): boolean {
  switch (method) {
    case 'textDocument/completion': return !!capabilities.completionProvider;
    case 'completionItem/resolve': return capabilities.completionProvider?.resolveProvider === true;
    case 'textDocument/signatureHelp': return !!capabilities.signatureHelpProvider;
    case 'textDocument/hover': return !!capabilities.hoverProvider;
    case 'textDocument/definition': return !!capabilities.definitionProvider;
    case 'textDocument/references': return !!capabilities.referencesProvider;
    case 'textDocument/documentSymbol': return !!capabilities.documentSymbolProvider;
    case 'textDocument/formatting': return !!capabilities.documentFormattingProvider;
    case 'textDocument/rename': return !!capabilities.renameProvider;
    case 'textDocument/prepareRename': return typeof capabilities.renameProvider === 'object' && capabilities.renameProvider.prepareProvider === true;
    case 'textDocument/codeAction': return !!capabilities.codeActionProvider;
    case 'codeAction/resolve': return typeof capabilities.codeActionProvider === 'object' && capabilities.codeActionProvider.resolveProvider === true;
    default: return false;
  }
}
