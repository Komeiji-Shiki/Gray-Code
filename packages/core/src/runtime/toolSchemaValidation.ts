import Ajv, { type AnySchema, type ValidateFunction } from 'ajv';
import type AjvCore from 'ajv/dist/core';
import Ajv2019 from 'ajv/dist/2019';
import Ajv2020 from 'ajv/dist/2020';
import { normalizeToolArguments } from './toolArguments';

export interface CompiledToolSchema {
  validate: ValidateFunction;
  normalizeArguments: (value: Record<string, unknown>) => Record<string, unknown>;
}

/** 不同 JSON Schema 版本分别编译，避免新版约束被旧版校验器忽略。 */
export class ToolSchemaValidators {
  private readonly compilers = new Map<string, AjvCore>();
  private nextSchemaId = 0;

  compile(schema: Record<string, unknown>): CompiledToolSchema {
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
    let validate: ValidateFunction;
    try {
      validate = compiler.compile(schema as AnySchema);
      if ('$async' in validate && validate.$async) throw new Error('工具参数不支持异步 Schema 校验。');
    }
    finally {
      // 工具目录负责按声明内容缓存；释放 Ajv 的对象缓存，不影响已捕获的校验函数。
      compiler.removeSchema(schema as AnySchema);
    }
    const capturedCompiler = compiler;
    const schemaKey = `urn:graycode:tool-arguments:${++this.nextSchemaId}`;
    const nullablePaths = new Map<string, boolean>();
    return { validate, normalizeArguments: value => {
      const references: string[] = [];
      let registered = false;
      try {
        return normalizeToolArguments(value, schema, pointer => {
          const cached = nullablePaths.get(pointer);
          if (cached !== undefined) return cached;
          // 保留整份 Schema 的引用作用域，仅在首次遇到这一可选空值时编译子路径。
          if (!registered) { capturedCompiler.addSchema(schema as AnySchema, schemaKey); registered = true; }
          const reference = `${schemaKey}#${pointer.split('/').map(encodeURIComponent).join('/')}`;
          references.push(reference);
          const validateNull = capturedCompiler.getSchema(reference);
          if (!validateNull) throw new Error(`无法读取工具参数 Schema 子路径：${pointer}`);
          const accepted = validateNull(null) === true;
          nullablePaths.set(pointer, accepted);
          return accepted;
        });
      } finally {
        // 目录只保留空值判断结果；临时引用与 Schema 不占用 Ajv 的长期缓存。
        for (const reference of references) capturedCompiler.removeSchema(reference);
        if (registered) { capturedCompiler.removeSchema(schemaKey); capturedCompiler.removeSchema(schema as AnySchema); }
      }
    } };
  }
}
