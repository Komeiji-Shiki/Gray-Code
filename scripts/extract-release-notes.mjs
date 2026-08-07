#!/usr/bin/env node
/**
 * 从 CHANGELOG.md 提取 release notes。
 *
 * 用法: node scripts/extract-release-notes.mjs <tag>
 * 例:   node scripts/extract-release-notes.mjs v1.4.6
 *
 * 输出策略（默认单版本，版本跳过时自动补带）：
 * - 默认只带当前版本小节（如 v1.4.6 -> 只带 1.4.6）；
 * - 设置了 GITHUB_TOKEN 时查询 GitHub 最新已发布 release：若 CHANGELOG 中
 *   当前版本与最新 release 之间存在未发布小节（版本被跳过，如最新 release
 *   为 1.4.4 时发 1.4.6，中间 1.4.5 从未发布），则把这些跳过版本的小节一并
 *   带上（1.4.6 + 1.4.5），避免用户错过未发布版本的内容；
 * - 查询失败 / 无 token 时回退为只带当前版本（fail-safe，不阻塞发布）。
 *
 * 说明: 版本号从 tag 名解析（去掉前导 v）；CHANGELOG 中找不到该版本时以非零码
 *       退出，让 CI 显式失败（说明发布流程漏了 CHANGELOG 版本化）。
 */
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

/** 解析版本号为数字数组（忽略预发布后缀，如 1.3.1-1 -> [1,3,1]） */
export function parseVersion(v) {
  return v.split('-')[0].split('.').map(Number)
}

/** 版本比较：a > b 返回正数，a < b 返回负数，相等返回 0 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da !== db) return da - db
  }
  return 0
}

/**
 * 选定要携带的版本小节区间。
 *
 * @param sections 所有版本小节（含 [Unreleased]，按出现顺序）
 * @param version  当前发布版本
 * @param latest   最新已发布 release 版本（undefined = 未知/查询失败）
 * @returns 要提取的小节起始下标与结束下标（不含）；版本不存在时返回 null
 */
export function selectSections(sections, version, latest) {
  const idx = sections.findIndex(s => s.version === version)
  if (idx === -1) return null

  let end = idx + 1 // 默认只带当前版本
  if (latest) {
    // 向后扩展：带上所有「版本号大于 latest」的未发布小节（跳过版本补带）
    let i = idx + 1
    while (i < sections.length && compareVersions(sections[i].version, latest) > 0) {
      end = i + 1
      i++
    }
  }
  return { start: idx, end }
}

/** 查询 GitHub 最新已发布 release 版本号（无 token / 失败返回 undefined） */
export async function fetchLatestRelease() {
  const token = process.env.GITHUB_TOKEN
  const repo = process.env.GITHUB_REPOSITORY
  if (!token || !repo) return undefined
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'extract-release-notes'
      }
    })
    if (!res.ok) return undefined
    const data = await res.json()
    return typeof data.tag_name === 'string' ? data.tag_name.replace(/^v/, '') : undefined
  } catch {
    return undefined
  }
}

/** 从 CHANGELOG.md 提取当前版本（及必要时跳过的未发布版本）小节文本 */
export async function extractReleaseNotes(tag, changelogPath, latestOverride) {
  const version = tag.replace(/^v/, '')
  const changelog = readFileSync(changelogPath, 'utf8')
  const lines = changelog.split('\n')

  // 收集所有版本小节起始行（## [Unreleased] 与 ## [x.y.z]）
  const headerRe = /^## \[(.+?)\]/
  const sections = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(headerRe)
    if (m) sections.push({ line: i, version: m[1] })
  }

  const latest = latestOverride !== undefined ? latestOverride : await fetchLatestRelease()
  const selection = selectSections(sections, version, latest)
  if (!selection) {
    throw new Error(`[extract-release-notes] Version "${version}" not found in CHANGELOG.md`)
  }

  const endLine = selection.end < sections.length ? sections[selection.end].line : lines.length
  return lines.slice(sections[selection.start].line, endLine).join('\n').trimEnd() + '\n'
}

// CLI 入口：仅直接运行时执行（import 测试时不触发）
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  const tag = process.argv[2]
  if (!tag) {
    console.error('Usage: node scripts/extract-release-notes.mjs <tag>')
    process.exit(1)
  }
  try {
    const body = await extractReleaseNotes(tag, new URL('../CHANGELOG.md', import.meta.url))
    process.stdout.write(body)
  } catch (error) {
    console.error(error.message)
    process.exit(1)
  }
}
