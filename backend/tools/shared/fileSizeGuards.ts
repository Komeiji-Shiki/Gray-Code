/**
 * 单文件操作大小护栏常量（发现 10）。
 *
 * 同一语义的「单文件操作大小护栏」此前以不同名字在多个文件重复声明
 * （read_file 的 MAX_READ_FILE_BYTES、delete_code/insert_code/apply_diff 的
 * MAX_EDIT_FILE_BYTES、fileStats 的 MAX_LINE_COUNT_FILE_SIZE_BYTES），
 * 任何一处调整都需要手工同步 4-5 个文件。集中导出，数值保持不变。
 */

/** 写/编辑类工具（write_file 全量重写、delete_code/insert_code/apply_diff 等）的文件大小上限（5MB）：
 * 超大文件全量 readFileSync 会阻塞 extension host 并全量读入内存。 */
export const MAX_EDIT_FILE_BYTES = 5 * 1024 * 1024;

/** 读取类工具（read_file 与 search_in_files 的 5MB 默认上限）的文件大小上限（5MB）：
 * 超大文件全量读入并全量塞进模型上下文会导致内存与 token 爆炸。 */
export const MAX_READ_FILE_BYTES = 5 * 1024 * 1024;

/** 行数统计（list_files / find_files fileDetails.lineCount）的文件大小上限（4MB）：
 * 超过后 lineCount 的参考价值很低，不值得付出读取成本。 */
export const MAX_LINE_COUNT_FILE_BYTES = 4 * 1024 * 1024;
