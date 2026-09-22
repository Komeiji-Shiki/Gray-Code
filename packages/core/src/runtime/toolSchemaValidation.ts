import Ajv, { type AnySchema } from 'ajv';
import type AjvCore from 'ajv/dist/core';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';

/** 不同 JSON Schema 版本分别编译，避免新版约束被旧版校验器忽略。 */
export class ToolSchemaValidators {
  private readonly compilers = new Map<string, AjvCore>();

  compile(schema: Record<string, unknown>) {
    const dialect = typeof schema.$schema === 'string' ? schema.$schema.replace(/#$/, '') : '';
    const key = dialect === 'https://json-schema.org/draft/2020-12/schema' ? '2020'
      : dialect === 'https://json-schema.org/draft/2019-09/schema' ? '2019' : 'draft-07';
    let compiler = this.compilers.get(key);
    if (!compiler) {
      const options = { strict: false, allErrors: false, validateFormats: false };
      compiler = key === '2020' ? new Ajv2020(options) : key === '2019' ? new Ajv2019(options) : new Ajv(options);
      this.compilers.set(key, compiler);
    }
    if (dialect === 'http://json-schema.org/draft-06/schema' && !compiler.getSchema(dialect)) {
      // draft-06 与 draft-07 共用校验器，按需注册依赖自带的版本定义。
      compiler.addMetaSchema(require('ajv/dist/refs/json-schema-draft-06.json'));
    }
    try { return compiler.compile(schema as AnySchema); }
    finally {
      // 工具目录负责按声明内容缓存；释放 Ajv 的对象缓存，不影响已捕获的校验函数。
      compiler.removeSchema(schema as AnySchema);
    }
  }
}
