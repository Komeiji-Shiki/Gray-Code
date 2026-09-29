export const appearanceTokens: Record<string,string[]> = {
    background:['--vscode-editor-background','--vscode-sideBar-background'], panel:['--vscode-editorWidget-background'], input:['--vscode-input-background'],
    text:['--vscode-foreground','--vscode-input-foreground'], muted:['--vscode-descriptionForeground'], disabled:['--vscode-disabledForeground'],
    accent:['--vscode-textLink-foreground','--vscode-focusBorder','--gc-accent','--vscode-charts-blue'],
    border:['--vscode-panel-border','--vscode-input-border','--vscode-widget-border','--vscode-editorWidget-border'],
    hover:['--vscode-list-hoverBackground','--vscode-toolbar-hoverBackground','--vscode-editor-inactiveSelectionBackground'],
    selection:['--vscode-list-activeSelectionBackground','--vscode-editor-selectionBackground','--vscode-toolbar-activeBackground'],
    selectionText:['--vscode-list-activeSelectionForeground'], button:['--vscode-button-background'], buttonHover:['--vscode-button-hoverBackground'],
    buttonText:['--vscode-button-foreground'], linkActive:['--vscode-textLink-activeForeground'],
    danger:['--vscode-errorForeground'], success:['--vscode-testing-iconPassed','--vscode-charts-green'], warning:['--vscode-editorWarning-foreground','--vscode-charts-yellow'],
    scrollbar:['--vscode-scrollbarSlider-background'], scrollbarHover:['--vscode-scrollbarSlider-hoverBackground','--vscode-scrollbarSlider-activeBackground'],
  };

/** 外壳、聊天和自定义主题共用颜色映射，既有变量名称继续有效。 */
export function appearanceCssVariables(palette: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(palette).flatMap(([name, value]) => [
    ['--' + name.replace(/[A-Z]/g, match => '-' + match.toLowerCase()), value],
    ...(appearanceTokens[name] ?? []).map(token => [token, value]),
  ]));
}
