const loading = new Map<string, Promise<void>>();
/** 仅加载当前文件需要的语言服务；工作区 LSP 继续负责补全、诊断和重构。 */
export function ensureEditorLanguage(language: string): Promise<void> {
  const key = ['typescript', 'javascript'].includes(language) ? 'typescript' : ['css', 'scss', 'less'].includes(language) ? 'css'
    : ['html', 'handlebars', 'razor'].includes(language) ? 'html' : language === 'json' ? 'json' : '';
  if (!key) return Promise.resolve();
  const existing = loading.get(key); if (existing) return existing;
  const pending = (async () => {
    if (key === 'typescript') {
      const module = await import('monaco-editor/languages/features/typescript/register.js');
      for (const defaults of [module.typescriptDefaults, module.javascriptDefaults]) {
        defaults.setModeConfiguration({ ...defaults.modeConfiguration, completionItems: false, hovers: false, definitions: false,
          references: false, documentSymbols: false, rename: false, documentRangeFormattingEdits: false, diagnostics: false, signatureHelp: false, codeActions: false });
        defaults.setDiagnosticsOptions({ ...defaults.getDiagnosticsOptions(), noSyntaxValidation: true, noSemanticValidation: true, noSuggestionDiagnostics: true });
      }
    } else {
      const defaults = key === 'css' ? await import('monaco-editor/languages/features/css/register.js').then(module => [module.cssDefaults, module.scssDefaults, module.lessDefaults])
        : key === 'html' ? await import('monaco-editor/languages/features/html/register.js').then(module => [module.htmlDefaults])
        : await import('monaco-editor/languages/features/json/register.js').then(module => [module.jsonDefaults]);
      for (const value of defaults) value.setModeConfiguration({ ...value.modeConfiguration, completionItems: false, hovers: false, documentSymbols: false,
        documentFormattingEdits: false, documentRangeFormattingEdits: false, diagnostics: false,
        ...('definitions' in value.modeConfiguration ? { definitions: false, references: false, rename: false } : {}) });
    }
  })().catch(error => { loading.delete(key); throw error; });
  loading.set(key, pending); return pending;
}
