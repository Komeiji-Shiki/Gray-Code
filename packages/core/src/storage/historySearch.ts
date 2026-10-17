/** 共享正文命中还原为当前会话中的位置；列表过滤和摘录必须使用相同的可见范围。 */
export function historyTextMatches(query: string): { sql: string; args: string[] } {
  const trigrams = Array.from(query).length >= 3 && !query.includes('\0');
  const source = trigrams ? 'history_search_fts f JOIN history_search s ON s.id=f.rowid' : 'history_search s';
  const condition = trigrams ? 'f.normalized LIKE ? AND instr(s.normalized,?)>0' : 'instr(s.normalized,?)>0';
  return {
    // 先按正文过滤一次；否则短查询可能先展开共享分支，重复读取和匹配同一份长正文。
    sql: `WITH matching_bodies AS MATERIALIZED (SELECT s.id,s.body_hash FROM ${source} WHERE ${condition})
      SELECT c.id AS conversation_id,span.history_id,span.start_index+e.ordinal-span.segment_offset AS position,
        e.message_id,s.id AS search_id
      FROM matching_bodies s
      JOIN segment_entries e ON e.body_hash=s.body_hash
      JOIN history_spans span ON span.segment_id=e.segment_id
        AND e.ordinal>=span.segment_offset AND e.ordinal<span.segment_offset+span.count
      JOIN histories h ON h.id=span.history_id AND span.start_index+e.ordinal-span.segment_offset<h.search_position
      JOIN conversations c ON c.history_id=h.id`,
    args: trigrams ? [`%${query}%`, query] : [query],
  };
}
