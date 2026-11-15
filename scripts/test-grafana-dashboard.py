#!/usr/bin/env python3
"""Check dashboard query frames against an isolated, running pinned logging stack.

Use only synthetic data. GRAFANA_TEST_URL, GRAFANA_TEST_PASSWORD_FILE and
GRAFANA_TEST_USER identify that local stack. Never point this at production.
See deploy/logging/dashboard-validation.md for the reproducible setup.
"""
import base64
import json
import os
from pathlib import Path
import time
import urllib.request
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
base = os.environ.get('GRAFANA_TEST_URL', 'http://localhost:13301')
assert urlparse(base).hostname in ('localhost', '127.0.0.1'), 'Local fixture stack only'
password = Path(os.environ['GRAFANA_TEST_PASSWORD_FILE']).read_text().strip()
auth = base64.b64encode((os.environ.get('GRAFANA_TEST_USER', 'local-test') + ':' + password).encode()).decode()

def request(path, payload=None):
    req = urllib.request.Request(base + path, data=json.dumps(payload).encode() if payload else None,
                                 headers={'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json'})
    return json.loads(urllib.request.urlopen(req, timeout=30).read())

def panels(items):
    for panel in items:
        yield panel
        yield from panels(panel.get('panels', []))

def query(panel, target, start=None, end=None):
    target = {**target, 'datasource': panel['datasource'], 'intervalMs': 60000, 'maxDataPoints': 100}
    for name in ['request_id', 'job_id', 'edge_id']:
        target['expr'] = target['expr'].replace('${' + name + ':json}', '"fixture-not-present"').replace('$' + name, 'fixture-not-present')
    for name in ['service', 'release', 'event']:
        target['expr'] = target['expr'].replace('${' + name + ':json}', '".*"').replace('$' + name, '.*')
    result = request('/api/ds/query', {'from': str(start or int((time.time()-3600)*1000)),
                                     'to': str(end or int(time.time()*1000)), 'queries': [target]})['results'][target['refId']]
    assert not result.get('error'), (panel['title'], result.get('error'))
    return result.get('frames', [])

for path in sorted((ROOT / 'deploy/logging/grafana/dashboards').glob('*.json')):
    dashboard = json.loads(path.read_text())
    assert request('/api/dashboards/uid/' + dashboard['uid'])['dashboard']['uid'] == dashboard['uid']
    for panel in panels(dashboard['panels']):
        for target in panel.get('targets', []):
            frames = query(panel, target)
            if panel['type'] in ('stat', 'timeseries') and panel['datasource']['uid'] == 'anonymous-logs':
                assert target['queryType'] in ('stats', 'statsRange')
                assert all(any(f['type'] == 'number' for f in frame['schema']['fields']) for frame in frames), panel['title']
            if panel['type'] == 'table' and panel['datasource']['uid'] == 'anonymous-logs':
                assert panel['transformations'][0]['id'] == 'extractFields'
                # Aggregate results must carry parseable fields, not a timestamp to display.
                for frame in frames:
                    fields = frame['schema']['fields']; values = frame['data']['values']
                    labels_index = next((i for i, f in enumerate(fields) if f['name'] == 'labels'), None)
                    if labels_index is not None:
                        for value in values[labels_index]:
                            row = json.loads(value) if isinstance(value, str) else value
                            assert row, panel['title']
            print('PASS', dashboard['uid'], panel['title'], target['refId'])
print('PASS all provisioned dashboard datasource queries')

# A reserved synthetic release contains one normal completion, one slow 503,
# and one interrupted 503. This proves we count each terminal event once and
# never classify the interrupted status as a completed server error.
operations = json.loads((ROOT / 'deploy/logging/grafana/dashboards/operations.json').read_text())
by_id = {p['id']: p for p in panels(operations['panels'])}
def numeric(frames):
    return [v for frame in frames for field, values in zip(frame['schema']['fields'], frame['data']['values'])
            if field['type'] == 'number' for v in values]
for panel_id, expected in [(101, 2), (102, 1), (104, 1), (103, 1200)]:
    panel = by_id[panel_id]
    target = {**panel['targets'][0]}
    target['expr'] = 'release:=\"fff0001\" ' + target['expr']
    assert numeric(query(panel, target)) == [expected], (panel['title'], numeric(query(panel, target)))
print('PASS exact completed/slow/interrupted counts and measured p95')
for panel_id in (10, 11, 12):
    panel = by_id[panel_id]
    target = {**panel['targets'][0]}
    for name in ['request_id', 'job_id', 'edge_id']:
        target['expr'] = target['expr'].replace('${' + name + ':json}', '\"\"')
    frames = query(panel, target)
    assert not any(values for frame in frames for values in frame['data']['values']), panel['title']
print('PASS blank correlation IDs never match unrelated logs')
# No measured latency must remain absent/NaN, never a fabricated healthy zero.
panel = by_id[103]; target = {**panel['targets'][0]}
target['expr'] = 'release:=\"0000000\" ' + target['expr']
values = numeric(query(panel, target))
assert not values or all(v is None or str(v).lower() == 'nan' for v in values), values
print('PASS absent latency is not zero')

fixture_dir = Path(os.environ['GRAFANA_TEST_PASSWORD_FILE']).parent
ids = json.loads((fixture_dir / 'ids.json').read_text())
fixture_end = int((fixture_dir / 'docker/fixture/fixture-json.log').stat().st_mtime * 1000) + 2000
for panel_id in (10, 11):
    panel = by_id[panel_id]; target = {**panel['targets'][0]}
    name = 'request_id' if panel_id == 10 else 'job_id'
    target['expr'] = target['expr'].replace('${' + name + ':json}', json.dumps(ids[name]))
    frames = query(panel, target, fixture_end-3600000, fixture_end)
    assert any(values for frame in frames for values in frame['data']['values']), panel['title']
for panel_id in (110, 130):
    panel = by_id[panel_id]
    fresh = query(panel, panel['targets'][0], fixture_end-3600000, fixture_end)
    stale = query(panel, panel['targets'][0], fixture_end-3600000, fixture_end+240000)
    assert any(values for frame in fresh for values in frame['data']['values']), panel['title']
    assert not any(values for frame in stale for values in frame['data']['values']), panel['title']
print('PASS real correlation matches and range-end freshness/staleness')

panel = by_id[122]
target = {**panel['targets'][0], 'expr': 'release:="fff0002" ' + panel['targets'][0]['expr']}
frames = query(panel, target, fixture_end-3600000, fixture_end)
rows = []
for frame in frames:
    for field, values in zip(frame['schema']['fields'], frame['data']['values']):
        if field['name'] == 'labels':
            rows.extend(json.loads(value) if isinstance(value, str) else value for value in values)
groups = {(row['route'], row['method']): row for row in rows}
assert len(groups) == 3, groups
get_repo = groups[('/api/repo/:repoId', 'GET')]
assert [float(get_repo[k]) for k in ['requests','header_samples','header_p95','response_samples','response_p95']] == [2,2,1200,2,3000], get_repo
post_repo = groups[('/api/repo/:repoId', 'POST')]
assert [float(post_repo[k]) for k in ['requests','header_p95','response_p95']] == [1,70,90], post_repo
missing = groups[('/api/repo/:repoId/file/:path', 'GET')]
assert [int(missing[k]) for k in ['requests','header_samples','response_samples']] == [1,0,0], missing
assert all((k not in missing or missing[k] is None or str(missing[k]).lower() == 'nan') for k in ['header_p95','response_p95']), missing
print('PASS endpoint/method separation, slow completion, excluded interruption/streamer, absent timing coverage')
