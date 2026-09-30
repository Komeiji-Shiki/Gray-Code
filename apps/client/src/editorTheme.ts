import { resolveAppearancePalette, resolveCodePalette } from '../../../shared/appearance';

export interface WorkbenchThemeData {
  base: 'vs' | 'vs-dark';
  inherit: true;
  rules: Array<{ token: string; foreground: string }>;
  colors: Record<string, string>;
}

/**
 * 按当前色板生成编辑器主题。Monaco 只接受十六进制颜色，用户自定义的其他写法逐项回落默认色板，
 * 不让一个不合法的颜色拖垮整套主题；需要叠加透明度的颜色也因此总是六位十六进制。
 */
export function workbenchThemeData(palette: Record<string, string>, light: boolean): WorkbenchThemeData {
  const defaults = resolveAppearancePalette(light ? 'light' : 'dark');
  const color = (key: string) => /^#[0-9a-f]{6}$/i.test(palette[key] ?? '') ? palette[key] : defaults[key];
  const { syntax } = resolveCodePalette(light ? 'light' : 'dark');
  const token = (name: string, value: string) => ({ token: name, foreground: value.slice(1) });
  return {
    base: light ? 'vs' : 'vs-dark', inherit: true,
    rules: [
      token('comment', syntax.comment),
      token('keyword', syntax.keyword), token('storage', syntax.keyword),
      token('string', syntax.string), token('regexp', syntax.regexp),
      token('number', syntax.number), token('constant', syntax.constant),
      token('type', syntax.type), token('type.identifier', syntax.type),
      token('identifier', syntax.variable), token('variable', syntax.variable),
      token('function', syntax.function), token('entity.name.function', syntax.function),
      token('tag', syntax.tag), token('attribute.name', syntax.attribute), token('attribute.value', syntax.string),
      token('delimiter', syntax.operator), token('operator', syntax.operator), token('key', syntax.property),
    ],
    colors: {
      'editor.background': color('background'), 'editor.foreground': color('text'), 'editorGutter.background': color('background'),
      'editorLineNumber.foreground': color('disabled'), 'editorLineNumber.activeForeground': color('muted'),
      'editor.lineHighlightBackground': color('hover') + '66', 'editor.selectionBackground': color('selection'),
      'editorCursor.foreground': color('accent'), 'editorIndentGuide.background1': color('border'),
      'editorWidget.background': color('panel'), 'editorWidget.border': color('border'),
      'diffEditor.insertedTextBackground': color('success') + '2a', 'diffEditor.insertedLineBackground': color('success') + '18',
      'diffEditor.removedTextBackground': color('danger') + '2d', 'diffEditor.removedLineBackground': color('danger') + '1b',
      'diffEditorGutter.insertedLineBackground': color('success') + '48', 'diffEditorGutter.removedLineBackground': color('danger') + '48',
      'diffEditor.diagonalFill': color('border'),
      'editorBracketHighlight.foreground1': syntax.type, 'editorBracketHighlight.foreground2': syntax.keyword,
      'editorBracketHighlight.foreground3': syntax.function, 'editorBracketHighlight.unexpectedBracket.foreground': color('danger'),
    },
  };
}

/** 终端：底色、文字、光标与选区取当前色板，16 色 ANSI 取品牌代码配色。 */
export function terminalThemeData(palette: Record<string, string>, light: boolean): Record<string, string> {
  return { background: palette.background, foreground: palette.text, cursor: palette.accent,
    selectionBackground: palette.selection, ...resolveCodePalette(light ? 'light' : 'dark').ansi };
}
