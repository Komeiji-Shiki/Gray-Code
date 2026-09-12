/** 编辑器和语言服务共用文件识别，避免高亮名称与服务匹配使用不同规则。 */
const extensions: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact',
  py: 'python', pyi: 'python', pyw: 'python', vue: 'vue', svelte: 'svelte', html: 'html', htm: 'html', xhtml: 'html',
  css: 'css', scss: 'scss', sass: 'sass', less: 'less', json: 'json', jsonc: 'jsonc', yaml: 'yaml', yml: 'yaml',
  sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', ksh: 'shellscript',
  go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  m: 'objective-c', mm: 'objective-cpp', java: 'java', cs: 'csharp', lua: 'lua', php: 'php', phtml: 'php',
  rb: 'ruby', rake: 'ruby', gemspec: 'ruby', ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  md: 'markdown', markdown: 'markdown', mdx: 'mdx', sql: 'sql', xml: 'xml', svg: 'xml', toml: 'toml',
  kt: 'kotlin', kts: 'kotlin', swift: 'swift', dart: 'dart', ex: 'elixir', exs: 'elixir', erl: 'erlang',
  r: 'r', rmd: 'r', jl: 'julia', pl: 'perl', pm: 'perl', dockerfile: 'dockerfile', cmake: 'cmake',
};
const filenames: Record<string, string> = { dockerfile: 'dockerfile', containerfile: 'dockerfile', makefile: 'makefile', gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake', '.bashrc': 'shellscript', '.bash_profile': 'shellscript', '.zshrc': 'shellscript', '.profile': 'shellscript',
  '.babelrc': 'jsonc', '.eslintrc': 'jsonc', '.prettierrc': 'jsonc', gemfile: 'ruby', rakefile: 'ruby' };

export function documentLanguageId(file: string): string {
  const name = file.replaceAll('\\', '/').split('/').at(-1)?.toLowerCase() ?? '';
  return filenames[name] ?? extensions[name.split('.').at(-1) ?? ''] ?? 'plaintext';
}

export function editorLanguageId(language: string): string {
  return ({ typescriptreact: 'typescript', javascriptreact: 'javascript', jsonc: 'json', shellscript: 'shell',
    vue: 'html', svelte: 'html', sass: 'scss', 'objective-c': 'objective-c', 'objective-cpp': 'cpp', mdx: 'markdown' } as Record<string, string>)[language] ?? language;
}
