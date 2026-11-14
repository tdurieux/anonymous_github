#!/usr/bin/env python3
"""Isolated local Docker integration test. Never reads production logs or .env.
Requires Docker Compose, Python 3 and PyYAML. Removes only its own project.
"""
import json
import base64
import os
from pathlib import Path
import secrets
import sys
import subprocess
import tempfile
import time
import urllib.parse
import urllib.request
import uuid
import yaml

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'deploy/logging'
PROJECT = 'logging-test-' + secrets.token_hex(4)

def run(args, **kw):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kw).stdout.strip()

def wait_for(fn, timeout=60):
    end = time.monotonic() + timeout
    last = None
    while time.monotonic() < end:
        try:
            result = fn()
            if result:
                return result
        except Exception as e:
            last = e
        time.sleep(1)
    raise AssertionError('Timed out: ' + str(last))

with tempfile.TemporaryDirectory(prefix=PROJECT) as temp:
    temp = Path(temp)
    docker = temp / 'docker'
    nginx = temp / 'nginx'
    docker.mkdir(); nginx.mkdir()
    (docker / 'fixture').mkdir()
    log = docker / 'fixture/fixture-json.log'
    log.touch()
    edge = nginx / 'anonymous.access.json'
    edge.touch()
    password = temp / 'password'
    password.write_text(secrets.token_urlsafe(32))
    password.chmod(0o644)  # temp directory is 0700; Grafana uid must read the bind mount
    env = {**os.environ, 'GRAFANA_ADMIN_USER': 'local-test', 'GRAFANA_PASSWORD_FILE': str(password),
           'DOCKER_LOG_DIR': str(docker), 'NGINX_LOG_DIR': str(nginx), 'GRAFANA_PORT': '0'}
    override = temp / 'override.yml'
    override.write_text(yaml.safe_dump({'services': {
        'victorialogs': {'ports': ['127.0.0.1::9428']},
        'prometheus': {'ports': ['127.0.0.1::9090']},
        'vector': {'ports': ['127.0.0.1::9598']},
        'vmalert': {'ports': ['127.0.0.1::8880']},
    }, 'networks': {'private': {'internal': False}}}))
    cmd = ['docker', 'compose', '-p', PROJECT, '-f', str(CONFIG / 'compose.yml'), '-f', str(override)]
    def compose(*args):
        return run(cmd + list(args), env=env)
    def url(service, port):
        return 'http://' + compose('port', service, str(port))
    def get(base, path, params=None):
        address = base + path + ('?' + urllib.parse.urlencode(params) if params else '')
        return urllib.request.urlopen(address, timeout=10).read().decode()
    def query(expression):
        return [json.loads(line) for line in get(vl, '/select/logsql/query', {'query': expression, 'limit': 50000}).splitlines() if line]
    def append(service, record):
        with log.open('a') as out:
            out.write(json.dumps({'log': json.dumps(record) + '\n', 'attrs': {'tag': service}, 'stream': 'stdout'}) + '\n')
    def count():
        return int(query('* | stats count() as n')[0]['n'])
    try:
        compose('up', '-d')
        vl = url('victorialogs', 9428)
        prom = url('prometheus', 9090)
        vector = url('vector', 9598)
        alerts = url('vmalert', 8880)
        grafana = url('grafana', 3000)
        wait_for(lambda: get(vl, '/health') is not None)
        wait_for(lambda: get(vector, '/metrics'))
        wait_for(lambda: get(grafana, '/api/health'))
        wait_for(lambda: 'application-logs' in get(alerts, '/api/v1/rules'))
        time.sleep(2)  # file watcher must discover empty files before append
        request_id, job_id = str(uuid.uuid4()), str(uuid.uuid4())
        sentinel = 'PRIVATE_SENTINEL_owner_repository_cookie_oauth_state'
        for service in ['api', 'streamer']:
            append(service, {'event': 'request_completed', 'severity': 'info', 'requestId': request_id,
                'route': '/api/repo/:repoId/file/:path', 'status': 200, 'outcome': 'completed',
                'firstByteMs': 40, 'responseMs': 600, 'ms': 640, 'stage_upstream_ms': 20,
                'message': sentinel, 'url': 'https://example.invalid/' + sentinel, 'cookie': sentinel,
                'authorization': sentinel, 'requestBody': {'secret': sentinel}, 'release': 'abcdef1'})
        append('api', {'service': 'worker', 'event': 'job_failed', 'severity': 'error', 'requestId': request_id,
                       'jobId': job_id, 'attempt': 2, 'queue': 'download', 'errorCode': 'ETIMEDOUT', 'raw': sentinel})
        append('mongodb', {'id': 51803, 's': 'E', 'msg': sentinel, 'attr': {'command': sentinel}})
        append('redis', {'message': sentinel})
        append('mongodb-backup', {'message': sentinel})
        append('unrelated-container', {'message': sentinel})
        # Malformed and malicious field values are represented without their raw content.
        append('api', {'event': sentinel, 'route': '/' + sentinel, 'requestId': sentinel, 'severity': sentinel, 'module': sentinel})
        with log.open('a') as out:
            out.write(json.dumps({'log': sentinel, 'attrs': {'tag': 'api'}}) + '\n')
        with edge.open('a') as out:
            out.write(json.dumps({'status': 429, 'request_time': 0.1, 'upstream_header_time': '0.05',
                'app_request_id': request_id, 'edge_request_id': 'f' * 32, 'route': '/api/repo/:id',
                'limit_req_status': 'REJECTED', 'client_ip': '192.0.2.1', 'user_agent': sentinel,
                'host': sentinel, 'request': sentinel}) + '\n')
        wait_for(lambda: count() >= 9)
        rows = query('*')
        stored = json.dumps(rows)
        assert sentinel not in stored and '192.0.2.1' not in stored
        correlated = query('requestId:="' + request_id + '"')
        assert {r['service'] for r in correlated} == {'api', 'streamer', 'worker', 'nginx'}
        assert len(query('jobId:="' + job_id + '"')) == 1
        assert all('requestId' not in r['_stream'] and 'instance' not in r['_stream'] for r in rows)
        print('PASS ingestion, privacy allowlist, malformed input, API/streamer/job/edge correlation')
        # Query every shipped dashboard and alert expression against the real server.
        dashboard = json.loads((CONFIG / 'grafana/dashboards/operations.json').read_text())
        for panel in dashboard['panels']:
            for target in panel['targets']:
                expr = target['expr'].replace('$request_id', request_id).replace('$job_id', job_id).replace('$edge_id', 'f' * 32)
                if panel['datasource']['uid'] == 'anonymous-logs':
                    query(expr)
                else:
                    get(prom, '/api/v1/query', {'query': expr})
        for group in yaml.safe_load((CONFIG / 'log-alerts.yml').read_text())['groups']:
            for rule in group['rules']:
                get(vl, '/select/logsql/stats_query', {'query': rule['expr']})
        auth = base64.b64encode(('local-test:' + password.read_text()).encode()).decode()
        def grafana_request(path, payload=None):
            request = urllib.request.Request(grafana + path,
                data=json.dumps(payload).encode() if payload is not None else None,
                headers={'Authorization': 'Basic ' + auth, 'Content-Type': 'application/json'})
            return json.loads(urllib.request.urlopen(request, timeout=20).read())
        assert grafana_request('/api/dashboards/uid/anonymous-operations')['dashboard']['uid'] == 'anonymous-operations'
        assert grafana_request('/api/datasources/uid/anonymous-logs/health')['status'] == 'OK'
        result = grafana_request('/api/ds/query', {'from': str(int((time.time() - 3600) * 1000)),
            'to': str(int(time.time() * 1000)), 'queries': [{'refId': 'A',
            'datasource': {'type': 'victoriametrics-logs-datasource', 'uid': 'anonymous-logs'},
            'expr': 'requestId:="' + request_id + '"', 'queryType': 'instant', 'maxLines': 100}]})
        assert not result['results']['A'].get('error'), result['results']['A'].get('error')
        assert result['results']['A']['frames']
        print('PASS dashboard and alert queries, provisioned Grafana datasource query')
        # Rename rotation, then collector restart, preserving the spool/checkpoint volume.
        before = count()
        log.rename(log.with_suffix('.log.1'))
        log.touch()
        append('api', {'event': 'process_started', 'severity': 'info'})
        wait_for(lambda: count() > before)
        compose('restart', 'vector')
        vector = url('vector', 9598)
        wait_for(lambda: get(vector, '/metrics'))
        before = count()
        append('api', {'event': 'process_heartbeat', 'severity': 'info'})
        wait_for(lambda: count() > before)
        print('PASS rename rotation and collector checkpoint restart')
        # Backend failure: sanitized disk spool remains bounded; source writer stays independent.
        before = count()
        compose('stop', 'victorialogs')
        started = time.monotonic()
        for _ in range(2000):
            append('api', {'event': 'request_completed', 'severity': 'info', 'requestId': str(uuid.uuid4()), 'status': 200})
        assert time.monotonic() - started < 10
        wait_for(lambda: 'vector_buffer_size_events' in get(vector, '/metrics'))
        time.sleep(3)
        compose('restart', 'vector')
        compose('start', 'victorialogs')
        vl = url('victorialogs', 9428)
        wait_for(lambda: count() >= before + 2000, 120)
        print('PASS unavailable backend, spool persistence, recovery of 2000 records')
        # Reject data older than retention rather than resurrecting it.
        old = json.dumps({'timestamp': '2000-01-01T00:00:00Z', 'event': 'expired_fixture'}).encode()
        req = urllib.request.Request(vl + '/insert/jsonline?_time_field=timestamp', data=old, headers={'Content-Type': 'application/stream+json'})
        urllib.request.urlopen(req, timeout=10).read()
        time.sleep(2)
        assert not query('event:expired_fixture')
        assert 'reason="too_small_timestamp"' in get(vl, '/metrics')
        print('PASS retention rejection')
        # Compression observation, synthetic workload only, including random trace IDs.
        raw_bytes = 0
        for _ in range(10000):
            record = {'event': 'request_completed', 'severity': 'info', 'requestId': str(uuid.uuid4()),
                      'status': 200, 'ms': 50, 'firstByteMs': 20, 'responseMs': 30, 'route': '/api/repo/:repoId/file/:path'}
            raw_bytes += len(json.dumps(record).encode()) + 1
            append('api', record)
        wait_for(lambda: count() >= before + 12000, 120)
        compose('restart', 'victorialogs')
        vl = url('victorialogs', 9428)
        wait_for(lambda: get(vl, '/health') is not None)
        metrics_text = get(vl, '/metrics')
        size = sum(float(line.split()[-1]) for line in metrics_text.splitlines() if line.startswith('vl_data_size_bytes{'))
        print(f'MEASURED fixture JSON bytes={raw_bytes}; total store data+index bytes={int(size)}; store also contains earlier fixtures; no production ratio claimed')
        # Check fixed limits and no accidental public ingress.
        config = json.loads(compose('config', '--format', 'json'))
        for service, spec in config['services'].items():
            assert int(spec['mem_limit']) > 0, service
            for port in spec.get('ports', []):
                assert port['host_ip'] == '127.0.0.1', service
        print('PASS configured memory/rotation/disk bounds and loopback-only test ports')
        if '--stress' in sys.argv:
            compose('stop', 'victorialogs')
            vector = url('vector', 9598)
            numeric_fields = ['status', 'httpStatus', 'ms', 'firstByteMs', 'responseMs', 'bytes', 'bytesPerSecond',
                'attempt', 'rss', 'memoryLimitBytes', 'memoryRatio', 'uptime', 'activeRequests', 'waiting',
                'active', 'delayed', 'failed', 'oldestWaitingMs', 'droppedLogs', 'loopP95Ms', 'upstreamStatus',
                'stage_repository_ms', 'stage_credential_resolution_ms', 'stage_upstream_ms', 'stage_cache_lookup_ms',
                'stage_cache_fill_ms', 'stage_worker_wait_ms', 'stage_anonymize_ms', 'stage_streamer_headers_ms']
            stress = {field: 123456789 for field in numeric_fields}
            stress.update(event='request_completed', severity='info', requestId=request_id)
            line = json.dumps({'log': json.dumps(stress), 'attrs': {'tag': 'api'}}) + '\n'
            with log.open('a') as output:
                for _ in range(500):
                    output.write(line * 1000)
            def metric_value(name):
                lines = get(vector, '/metrics').splitlines()
                return sum(float(line.split()[1]) for line in lines if line.startswith(name + '{') and ('buffer_id="logs"' in line if name.startswith('vector_buffer_') else 'component_id="logs"' in line))
            wait_for(lambda: metric_value('vector_buffer_discarded_events_total') > 0 or metric_value('vector_component_discarded_events_total') > 0, 240)
            buffered = metric_value('vector_buffer_size_bytes')
            assert buffered <= 268435488 + 1048576, buffered
            inspection = json.loads(run(['docker', 'inspect', compose('ps', '-q', 'vector')]))[0]
            assert inspection['RestartCount'] == 0 and not inspection['State']['OOMKilled']
            print(f'PASS full-spool drop-newest stress: 500000 events; buffered={int(buffered)} bytes; collector stayed alive')
            # Wait through the production two-minute 'for', rather than merely
            # checking PromQL syntax or that a counter exists.
            wait_for(lambda: json.loads(get(prom, '/api/v1/query', {'query':
                'ALERTS{alertname="CollectorDrops",alertstate="firing"}'}))['data']['result'], 210)
            print('PASS sustained CollectorDrops alert fires on full-spool loss')
    except Exception:
        # Only synthetic fixture logs exist in this project. No production reads.
        print(compose('logs', '--tail', '30', 'vector', 'victorialogs', 'vmalert', 'grafana'))
        raise
    finally:
        compose('down', '-v', '--remove-orphans')
