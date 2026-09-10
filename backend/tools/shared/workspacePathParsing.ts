/** 只处理目录名称前缀，宿主负责绝对路径、真实路径与访问权限。 */
export function parseNamedWorkspacePath<T extends { name: string }>(pathStr: string, workspaces: readonly T[]): {
    workspace: T | undefined;
    relativePath: string;
    isExplicit: boolean;
    error?: string;
} {
    if (!workspaces.length) return { workspace: undefined, relativePath: pathStr, isExplicit: false, error: 'No workspace folder open' };
    if (workspaces.length === 1) return { workspace: workspaces[0], relativePath: pathStr, isExplicit: false };
    if (pathStr.startsWith('@')) {
        const separator = pathStr.indexOf('/');
        const name = separator > 1 ? pathStr.slice(1, separator) : pathStr.slice(1);
        const workspace = workspaces.find(item => item.name.toLowerCase() === name.toLowerCase());
        if (workspace) return { workspace, relativePath: separator > 1 ? pathStr.slice(separator + 1) : '.', isExplicit: true };
        return { workspace: undefined, relativePath: pathStr, isExplicit: false,
            error: `Unknown workspace: ${name}. Available workspaces: ${workspaces.map(item => item.name).join(', ')}` };
    }
    const workspace = workspaces.find(item => pathStr.startsWith(item.name + '/')) ?? workspaces.find(item => pathStr === item.name);
    if (workspace) return { workspace, relativePath: pathStr === workspace.name ? '.' : pathStr.slice(workspace.name.length + 1), isExplicit: true };
    return { workspace: undefined, relativePath: pathStr, isExplicit: false,
        error: `Multi-root workspace requires workspace prefix. Use "workspace_name/path" format. Available workspaces: ${workspaces.map(item => item.name).join(', ')}` };
}
