#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取指定版本与其后一个小节（共两个版本小节）作为 release notes。
 *
 * 用法: node scripts/extract-release-notes.mjs <tag>
 * 例:   node scripts/extract-release-notes.mjs v1.4.5
 * 输出: 从 `## [1.4.5]` 到 `## [1.4.3]` 之前的内容（含 1.4.5 与 1.4.4 两个小节），
 *       供 GitHub Releases 的 body 使用。
 *
 * 说明: 版本号从 tag 名解析（去掉前导 v）；CHANGELOG 中找不到该版本时以非零码退出，
 *       让 CI 显式失败（说明发布流程漏了 CHANGELOG 版本化）。
 */
import { readFileSync } from 'node:fs'

const tag = process.argv[2]
if (!tag) {
  console.error('Usage: node scripts/extract-release-notes.mjs <tag>')
  process.exit(1)
}
const version = tag.replace(/^v/, '')

const changelog = readFileSync(new URL('../CHANGELOG.md', import.meta.url), 'utf8')
const lines = changelog.split('\n')

// 收集所有版本小节起始行（## [Unreleased] 与 ## [x.y.z]）
const headerRe = /^## \[(.+?)\]/
const sections = []
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(headerRe)
  if (m) sections.push({ line: i, version: m[1] })
}

const idx = sections.findIndex(s => s.version === version)
if (idx === -1) {
  console.error(`[extract-release-notes] Version "${version}" not found in CHANGELOG.md`)
  process.exit(1)
}

// 提取当前版本起连续两个小节（例如 1.4.5 + 1.4.4），遇第三个版本小节或文件尾停止
const endLine = idx + 2 < sections.length ? sections[idx + 2].line : lines.length
const body = lines.slice(sections[idx].line, endLine).join('\n').trimEnd() + '\n'
process.stdout.write(body)
