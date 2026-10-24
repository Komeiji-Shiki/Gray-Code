import { ref } from 'vue'

/** 32 字节随机数的十六进制形式，满足远程入口与控制接口至少 32 个字符的要求。 */
export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(value => value.toString(16).padStart(2, '0')).join('')
}

/**
 * 设置页里的密钥输入框。凭据与设置分开加密保存，设置里只放引用：
 * 只有用户改过才随设置提交，避免把读到的旧值覆盖成其他窗口刚保存的新值；清空表示删除已保存的凭据。
 */
export function useCredentialDraft(credentialId: () => string) {
  const token = ref('')
  let edited = false
  return {
    token,
    /** 填入已保存的值，不算修改。 */
    load(value: string) { token.value = value; edited = false },
    change(value: string) { token.value = value; edited = true },
    /** platform.settings.update 的凭据字段，未修改时为空对象。 */
    updates(): { credentials?: Record<string, string>; clearCredentialChanges?: string[] } {
      if (!edited) return {}
      const value = token.value.trim()
      return value ? { credentials: { [credentialId()]: value }, clearCredentialChanges: [] }
        : { credentials: {}, clearCredentialChanges: [credentialId()] }
    },
    saved() { edited = false },
  }
}
