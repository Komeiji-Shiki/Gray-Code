/** Monitor-only invocation card; real user text that merely mentions the heading is not a card. */
export function isSubagentInvocationContent(content: { role: string; parts: readonly { text?: unknown }[] }): boolean {
  return content.role === 'user' && content.parts.length === 1 && typeof content.parts[0].text === 'string'
    && /^# SubAgent Invocation\n+## Agent System Prompt\n/.test(content.parts[0].text);
}
