/**
 * GrayCode - 更新检查模块（GitHub Releases 自动更新）
 */

export {
    UpdateChecker,
    UPDATE_REPO,
    UPDATE_CHECK_INTERVAL_MS,
    UPDATE_FETCH_TIMEOUT_MS,
    UPDATE_DOWNLOAD_TIMEOUT_MS,
    stripVersionPrefix,
    compareVersions,
    shouldCheck,
    parseReleaseResponse,
    resolveReleaseChannel,
    pickInstallerAsset,
} from './UpdateChecker';

export type {
    UpdateInfo,
    UpdateCheckStatus,
    UpdateCheckerOptions,
    ReleaseChannel,
    InstallerKind,
} from './UpdateChecker';
