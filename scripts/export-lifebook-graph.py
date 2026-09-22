"""从 LifeBook 的 Kuzu 工作副本导出完整图谱，不打开或改写原数据库。"""
import argparse
import base64
import datetime
import hashlib
import json
import shutil
import tempfile
from pathlib import Path


def digest(file):
    result = hashlib.sha256()
    with file.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def json_value(value):
    if isinstance(value, (datetime.datetime, datetime.date)):
        return {'$type': type(value).__name__, 'value': value.isoformat()}
    if isinstance(value, bytes):
        return {'$type': 'bytes', 'base64': base64.b64encode(value).decode('ascii')}
    raise TypeError('不支持的图谱值类型：' + type(value).__name__)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('database', type=Path)
    parser.add_argument('output', type=Path)
    args = parser.parse_args()
    source = args.database.resolve(strict=True)
    output = args.output.resolve()
    if output.is_relative_to(source.parent):
        parser.error('输出目录必须与原记忆目录分开。')
    if output.exists():
        parser.error('输出文件已存在，请选择新文件名。')
    import kuzu
    output.parent.mkdir(parents=True, exist_ok=True)
    files = [source] + ([Path(str(source) + '.wal')] if Path(str(source) + '.wal').exists() else [])
    originals = [{'name': file.name, 'sha256': digest(file)} for file in files]
    with tempfile.TemporaryDirectory(prefix='graycode-graph-', dir=output.parent) as directory:
        for file in files:
            shutil.copy2(file, Path(directory) / file.name)
        copied = [Path(directory) / file.name for file in files]
        if any(digest(file) != info['sha256'] or digest(copy) != info['sha256'] for file, copy, info in zip(files, copied, originals)):
            raise RuntimeError('复制期间原数据库发生变化，请停止来源写入后重试。')
        if Path(str(source) + '.wal').exists() != (len(files) == 2):
            raise RuntimeError('复制期间出现或移除了 WAL，请在来源稳定后重试。')
        db = kuzu.Database(str(Path(directory) / source.name), buffer_pool_size=64 * 1024 * 1024, max_num_threads=2)
        connection = kuzu.Connection(db)
        try:
            result = connection.execute('CALL SHOW_TABLES() RETURN *')
            tables = [dict(zip(result.get_column_names(), row)) for row in result.get_all()]
            exports = []
            for table in sorted(tables, key=lambda row: row['name']):
                name = table['name'].replace('`', '``')
                pattern = f'(n:`{name}`)' if table['type'] == 'NODE' else f'()-[n:`{name}`]->()'
                rows = [row[0] for row in connection.execute(f'MATCH {pattern} RETURN n').get_all()]
                rows.sort(key=lambda row: json.dumps(row.get('_id'), sort_keys=True))
                exports.append({'name': table['name'], 'type': table['type'], 'rows': rows})
            payload = {'format': 'lifebook-kuzu-export', 'version': 1, 'sourceFiles': originals, 'tables': exports}
            with output.open('x', encoding='utf-8') as stream:
                json.dump(payload, stream, ensure_ascii=False, default=json_value, allow_nan=False)
        finally:
            connection.close()
            db.close()
    print(json.dumps({'output': str(output), 'tables': len(exports), 'rows': sum(len(table['rows']) for table in exports), 'sha256': digest(output)}))


if __name__ == '__main__':
    main()
