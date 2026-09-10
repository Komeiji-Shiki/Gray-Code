/** 保存的资源引用在桌面与 Web 间保持一致，仅在显示时转换地址。 */
export function resourceUrl(value: string): string {
  return /^https?:$/.test(window.location.protocol) && value.startsWith('graycode://app/assets/background/')
    ? value.slice('graycode://app'.length) : value;
}
