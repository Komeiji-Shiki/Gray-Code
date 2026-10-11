/** 工程日志的旧名称同时用于读取旧清单和继承逐操作的执行设置。 */
export const ENGINEERING_LOG_LEGACY_NAMES = {
    wake: 'memory_wake',
    note: 'memory_note',
    recall: 'memory_recall',
    compress: 'memory_compress',
    zoom: 'memory_zoom',
    forget: 'memory_forget',
    config: 'memory_config'
} as const;

/** 只在读取旧工具清单时升级名称，旧历史中的调用与结果仍保留原名。 */
const TOOL_NAME_UPGRADES: Readonly<Record<string, readonly string[]>> = {
    workspace_files: ['read_file', 'list_files', 'write_file', 'apply_diff', 'delete_file'],
    search_files: ['search_in_files'],
    run_command: ['execute_command'],
    process_session: ['terminal_task'],
    ...Object.fromEntries(Object.values(ENGINEERING_LOG_LEGACY_NAMES).map(name => [name, ['engineering_log']]))
};

export function upgradeToolNames(names: readonly string[]): string[] {
    return [...new Set(names.flatMap(name => TOOL_NAME_UPGRADES[name] ?? [name]))];
}
