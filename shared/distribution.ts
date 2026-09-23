/** 由平台和桌面构建注入；源码测试不伪造当前部署的提交身份。 */
export interface DistributionInfo {
  version?: string
  license: string
  buildCommit?: string
  buildDirty: boolean
  repositoryUrl?: string
  sourceUrl?: string
  licenseUrl?: string
}
declare const __GRAYCODE_DISTRIBUTION__: DistributionInfo | undefined

export function getDistributionInfo(): DistributionInfo {
  return typeof __GRAYCODE_DISTRIBUTION__ !== 'undefined' ? __GRAYCODE_DISTRIBUTION__
    : { license: 'AGPL-3.0-only with GrayCode Cubism exception 1.0', buildDirty: true }
}

export function distributionSourceNotice(info = getDistributionInfo()): string {
  return [`GrayCode${info.version ? ` ${info.version}` : ''} · ${info.license}`,
    info.sourceUrl ? `对应版本源码：${info.sourceUrl}` : '本地开发构建，请向部署者索取对应源码。',
    ...(info.licenseUrl ? [`许可说明：${info.licenseUrl}`] : [])].join('\n')
}
