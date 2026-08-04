/**
 * highlight.js 常用语言子集。
 *
 * 修改原因：全量 `import hljs from 'highlight.js'` 会把 190+ 种语言（约 900KB 未压缩）
 *          打进主 bundle，是 index.js 2.7MB 的主要来源，拖慢 webview 首屏解析与执行。
 * 修改方式：改用 highlight.js/lib/core + 常用语言注册子集，代码块高亮行为不变
 *          （getLanguage 未注册的语言走原有 auto/纯文本回退路径）。
 * 修改目的：显著减小首屏 JS 体积，加快插件面板加载速度。
 */

import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import go from 'highlight.js/lib/languages/go'
import rust from 'highlight.js/lib/languages/rust'
import php from 'highlight.js/lib/languages/php'
import ruby from 'highlight.js/lib/languages/ruby'
import swift from 'highlight.js/lib/languages/swift'
import kotlin from 'highlight.js/lib/languages/kotlin'
import scala from 'highlight.js/lib/languages/scala'
import dart from 'highlight.js/lib/languages/dart'
import bash from 'highlight.js/lib/languages/bash'
import shell from 'highlight.js/lib/languages/shell'
import powershell from 'highlight.js/lib/languages/powershell'
import json from 'highlight.js/lib/languages/json'
import xml from 'highlight.js/lib/languages/xml'
import html from 'highlight.js/lib/languages/xml'
import css from 'highlight.js/lib/languages/css'
import scss from 'highlight.js/lib/languages/scss'
import less from 'highlight.js/lib/languages/less'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'
import ini from 'highlight.js/lib/languages/ini'
import toml from 'highlight.js/lib/languages/ini'
import dockerfile from 'highlight.js/lib/languages/dockerfile'
import makefile from 'highlight.js/lib/languages/makefile'
import plaintext from 'highlight.js/lib/languages/plaintext'
import vbnet from 'highlight.js/lib/languages/vbnet'
import r from 'highlight.js/lib/languages/r'
import perl from 'highlight.js/lib/languages/perl'
import lua from 'highlight.js/lib/languages/lua'
import elixir from 'highlight.js/lib/languages/elixir'
import erlang from 'highlight.js/lib/languages/erlang'
import haskell from 'highlight.js/lib/languages/haskell'
import julia from 'highlight.js/lib/languages/julia'
import matlab from 'highlight.js/lib/languages/matlab'
import groovy from 'highlight.js/lib/languages/groovy'
import objectivec from 'highlight.js/lib/languages/objectivec'
import protobuf from 'highlight.js/lib/languages/protobuf'
import cmake from 'highlight.js/lib/languages/cmake'
import nginx from 'highlight.js/lib/languages/nginx'
import properties from 'highlight.js/lib/languages/properties'
import graphql from 'highlight.js/lib/languages/graphql'
import clojure from 'highlight.js/lib/languages/clojure'
import coffeescript from 'highlight.js/lib/languages/coffeescript'
import crystal from 'highlight.js/lib/languages/crystal'
import d from 'highlight.js/lib/languages/d'
import fsharp from 'highlight.js/lib/languages/fsharp'
import gherkin from 'highlight.js/lib/languages/gherkin'
import apache from 'highlight.js/lib/languages/apache'
import handlebars from 'highlight.js/lib/languages/handlebars'
import stylus from 'highlight.js/lib/languages/stylus'
import vbscript from 'highlight.js/lib/languages/vbscript'
import x86asm from 'highlight.js/lib/languages/x86asm'
import mipsasm from 'highlight.js/lib/languages/mipsasm'
import armasm from 'highlight.js/lib/languages/armasm'
import tcl from 'highlight.js/lib/languages/tcl'
import vim from 'highlight.js/lib/languages/vim'
import glsl from 'highlight.js/lib/languages/glsl'
import gradle from 'highlight.js/lib/languages/gradle'
import latex from 'highlight.js/lib/languages/latex'
import nix from 'highlight.js/lib/languages/nix'
import nim from 'highlight.js/lib/languages/nim'
import verilog from 'highlight.js/lib/languages/verilog'
import vhdl from 'highlight.js/lib/languages/vhdl'
import wasm from 'highlight.js/lib/languages/wasm'

type LanguageModule = (hljs: any) => any

const COMMON_LANGUAGES: Array<[string, LanguageModule]> = [
  ['javascript', javascript],
  ['js', javascript],
  ['typescript', typescript],
  ['ts', typescript],
  ['python', python],
  ['py', python],
  ['java', java],
  ['c', c],
  ['cpp', cpp],
  ['c++', cpp],
  ['csharp', csharp],
  ['cs', csharp],
  ['go', go],
  ['golang', go],
  ['rust', rust],
  ['rs', rust],
  ['php', php],
  ['ruby', ruby],
  ['rb', ruby],
  ['swift', swift],
  ['kotlin', kotlin],
  ['kt', kotlin],
  ['scala', scala],
  ['dart', dart],
  ['bash', bash],
  ['sh', bash],
  ['shell', shell],
  ['zsh', bash],
  ['powershell', powershell],
  ['ps1', powershell],
  ['json', json],
  ['xml', xml],
  ['html', html],
  ['htm', html],
  ['css', css],
  ['scss', scss],
  ['less', less],
  ['sql', sql],
  ['yaml', yaml],
  ['yml', yaml],
  ['markdown', markdown],
  ['md', markdown],
  ['diff', diff],
  ['patch', diff],
  ['ini', ini],
  ['toml', toml],
  ['dockerfile', dockerfile],
  ['makefile', makefile],
  ['make', makefile],
  ['plaintext', plaintext],
  ['text', plaintext],
  ['vbnet', vbnet],
  ['vb', vbnet],
  ['r', r],
  ['perl', perl],
  ['lua', lua],
  ['elixir', elixir],
  ['erlang', erlang],
  ['haskell', haskell],
  ['hs', haskell],
  ['julia', julia],
  ['matlab', matlab],
  ['groovy', groovy],
  ['objectivec', objectivec],
  ['objc', objectivec],
  ['protobuf', protobuf],
  ['proto', protobuf],
  ['cmake', cmake],
  ['nginx', nginx],
  ['properties', properties],
  ['graphql', graphql],
  ['gql', graphql],
  ['clojure', clojure],
  ['coffeescript', coffeescript],
  ['coffee', coffeescript],
  ['crystal', crystal],
  ['d', d],
  ['fsharp', fsharp],
  ['fs', fsharp],
  ['gherkin', gherkin],
  ['feature', gherkin],
  ['apache', apache],
  ['handlebars', handlebars],
  ['hbs', handlebars],
  ['stylus', stylus],
  ['vbscript', vbscript],
  ['x86asm', x86asm],
  ['mipsasm', mipsasm],
  ['armasm', armasm],
  ['tcl', tcl],
  ['vim', vim],
  ['glsl', glsl],
  ['gradle', gradle],
  ['latex', latex],
  ['tex', latex],
  ['nix', nix],
  ['nim', nim],
  ['verilog', verilog],
  ['vhdl', vhdl],
  ['wasm', wasm]
]

for (const [name, definition] of COMMON_LANGUAGES) {
  try {
    hljs.registerLanguage(name, definition as Parameters<typeof hljs.registerLanguage>[1])
  } catch {
    // 个别语言注册失败不影响其余语言
  }
}

export { hljs }
