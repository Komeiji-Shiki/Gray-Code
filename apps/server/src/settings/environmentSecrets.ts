import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { SecretCodec } from './service';

/** 无系统密钥服务的独立进程使用部署者提供的加密密钥，密钥本身不写入数据库。 */
export function environmentSecretCodec(variable?: string): SecretCodec | undefined {
  if (!variable) return undefined;
  const value = process.env[variable];
  if (!value || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('--key-env 指定的环境变量须包含 32 字节密钥的十六进制表示（64 个字符）。');
  return keySecretCodec(Buffer.from(value, 'hex'));
}

/** 便携配置和部署密钥共用加密格式，系统密钥服务仍负责本机数据库。 */
export function keySecretCodec(value: Uint8Array): SecretCodec {
  if (value.byteLength !== 32) throw new Error('配置加密密钥必须为 32 字节。');
  const key = Buffer.from(value);
  const scope = Buffer.from('graycode-platform-secrets:v1');
  return {
    encrypt: async text => {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(scope);
      const ciphertext = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return Buffer.concat([Buffer.from([1]), nonce, cipher.getAuthTag(), ciphertext]);
    },
    decrypt: async bytes => {
      if (bytes.length < 29 || bytes[0] !== 1) throw new Error('此密钥记录无法使用当前部署密钥读取。');
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(1, 13));
      decipher.setAAD(scope); decipher.setAuthTag(bytes.subarray(13, 29));
      return Buffer.concat([decipher.update(bytes.subarray(29)), decipher.final()]).toString('utf8');
    },
  };
}
