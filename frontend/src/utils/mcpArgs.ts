/**
 * Format MCP stdio arguments for the settings input.
 *
 * JSON is used because joining with spaces cannot distinguish two arguments
 * from one argument that itself contains a space. An empty list remains an
 * empty input to keep the existing form appearance.
 */
export function formatMcpArgsInput(args?: readonly string[]): string {
  return args?.length ? JSON.stringify(args) : ''
}

/**
 * Parse MCP stdio arguments entered in settings.
 *
 * Syntactically valid JSON string arrays use the lossless format; parsed JSON
 * of any other shape is rejected. Ordinary whitespace-separated input and
 * non-JSON bracket/glob arguments keep the legacy semantics. An input that
 * begins with a JSON string token is treated as attempted JSON so a malformed
 * array is reported instead of silently changing argv.
 */
export function parseMcpArgsInput(value: string): string[] {
  const trimmed = value.trim()
  if (!trimmed) return []

  if (trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      // Preserve legacy bracket/glob arguments such as `[pattern] --flag`.
      // A leading JSON string token (`["`) is treated as an attempted JSON
      // array so malformed lossless input still produces a useful error.
      if (/^\[\s*"/.test(trimmed)) throw error
      return trimmed.split(/\s+/)
    }
    if (!Array.isArray(parsed) || !parsed.every((argument): argument is string => typeof argument === 'string')) {
      throw new TypeError('MCP arguments must be a JSON array of strings')
    }
    return parsed
  }

  return trimmed.split(/\s+/)
}
