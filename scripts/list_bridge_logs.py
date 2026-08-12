# -*- coding: utf-8 -*-
"""列出指定日志目录下所有请求记录的元数据时间线。"""
import json
import sys
import glob
import os


def main():
    folder = sys.argv[1]
    rows = []
    for path in glob.glob(os.path.join(folder, '*.json')):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                d = json.load(f)
        except Exception as e:
            rows.append({'file': os.path.basename(path), 'parse_error': str(e)})
            continue
        if not isinstance(d, dict):
            rows.append({'file': os.path.basename(path), 'type': 'non-dict'})
            continue
        rows.append({
            'file': os.path.basename(path),
            'type': d.get('type'),
            'ts': d.get('timestamp'),
            'end_ts': d.get('end_timestamp'),
            'model': d.get('model'),
            'status': d.get('status'),
            'error': (d.get('error') or {}).get('message') if isinstance(d.get('error'), dict) else d.get('error'),
            'msg_cnt': d.get('messages_count'),
            'in_tok': d.get('input_tokens'),
            'out_tok': d.get('output_tokens'),
            'resp_head': (d.get('response_content') or '')[:90].replace('\n', ' '),
        })
    rows.sort(key=lambda r: (r.get('ts') or 0, r.get('file', '')))
    for r in rows:
        ts = r.get('ts')
        end = r.get('end_ts')
        tstr = __import__('time').strftime('%H:%M:%S', __import__('time').localtime(ts)) if isinstance(ts, (int, float)) else ''
        estr = __import__('time').strftime('%H:%M:%S', __import__('time').localtime(end)) if isinstance(end, (int, float)) else ''
        def s(v):
            return '' if v is None else str(v)
        print(f"{s(r.get('file')):48} {s(r.get('type')):14} start={tstr:8} end={estr:8} "
              f"msgs={s(r.get('msg_cnt')):5} in={s(r.get('in_tok')):8} out={s(r.get('out_tok')):7} "
              f"status={s(r.get('status'))} err={s(r.get('error'))}")
        if r.get('resp_head'):
            print(f"{'':48} resp: {r['resp_head']}")


if __name__ == '__main__':
    main()
