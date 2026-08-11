import { describe, expect } from 'vitest'
import { formatMcpArgsInput, parseMcpArgsInput } from '../mcpArgs'

describe('MCP stdio argument input', () => {
  test('round-trips arguments without losing spaces, quotes, backslashes, or empty values', () => {
    const args = [
      '-m',
      'C:\\Program Files\\MCP server',
      '--label=a b',
      '',
      'a "quoted" value'
    ]

    expect(parseMcpArgsInput(formatMcpArgsInput(args))).toEqual(args)
  })

  test('continues to accept the legacy whitespace-separated syntax', () => {
    expect(parseMcpArgsInput('  -m   mcp_server  --verbose ')).toEqual([
      '-m',
      'mcp_server',
      '--verbose'
    ])
  })

  test('keeps legacy bracket and glob arguments that are not valid JSON arrays', () => {
    expect(parseMcpArgsInput('[pattern]  [A-Z]*')).toEqual(['[pattern]', '[A-Z]*'])
  })

  test.each([
    '["valid", 123]',
    '["unterminated"'
  ])('rejects an invalid JSON argument array: %s', (input) => {
    expect(() => parseMcpArgsInput(input)).toThrow()
  })
})
