/** 只在读取旧工具清单时升级名称，旧历史中的调用与结果仍保留原名。 */
const TOOL_NAME_UPGRADES: Readonly<Record<string, readonly string[]>> = {
    workspace_files: ['read_file', 'list_files', 'write_file', 'apply_diff', 'delete_file'],
    search_files: ['search_in_files'],
    run_command: ['execute_command'],
    process_session: ['terminal_task'],
    memory_remember: [],
    memory_revise: [],
    memory_remove: [],
    memory_summarize: [],
    engineering_log: [],
    memory_wake: [],
    memory_note: [],
    memory_recall: [],
    memory_compress: [],
    memory_zoom: [],
    memory_forget: [],
    memory_config: []
};

export function upgradeToolNames(names: readonly string[]): string[] {
    return [...new Set(names.flatMap(name => TOOL_NAME_UPGRADES[name] ?? [name]))];
}
