#!/usr/bin/env python3
"""Create/stop an isolated dashboard fixture stack. Never reads production data.

python3 scripts/grafana-fixtures.py start
python3 scripts/grafana-fixtures.py stop
State and a generated password stay in /tmp/grafana-dashboard-fixtures (0700).
Only the grafana-dashboard-fixtures Compose project is managed by this script.
"""
import datetime
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import urllib.request
import uuid
import yaml

ROOT = Path(__file__).resolve().parents[1]
STATE = Path('/tmp/grafana-dashboard-fixtures')
PROJECT = 'grafana-dashboard-fixtures'
CMD = ['docker', 'compose', '-p', PROJECT, '-f', str(ROOT / 'deploy/logging/compose.yml'), '-f', str(STATE / 'override.yml')]

def compose(*args):
    env = {**os.environ, **json.loads((STATE / 'environment.json').read_text())}
    return subprocess.run(CMD + list(args), env=env, check=True, capture_output=True, text=True).stdout.strip()

if sys.argv[1:] == ['stop']:
    compose('down', '-v', '--remove-orphans')
    print('Removed fixture containers and volumes')
    sys.exit(0)
if sys.argv[1:] != ['start']:
    sys.exit('Use start or stop')
if STATE.exists():
    sys.exit('Fixture directory exists. Stop the fixture stack and remove ' + str(STATE) + ' before recreating it.')
STATE.mkdir(mode=0o700)
for directory in ['docker/fixture', 'nginx']:
    (STATE / directory).mkdir(parents=True)
log = STATE / 'docker/fixture/fixture-json.log'; log.touch()
edge = STATE / 'nginx/anonymous.access.json'; edge.touch(); edge.chmod(0o640)
password = STATE / 'password'; password.write_text(secrets.token_urlsafe(32)); password.chmod(0o644)
(STATE / 'environment.json').write_text(json.dumps({'GRAFANA_ADMIN_USER':'local-test', 'GRAFANA_PASSWORD_FILE':str(password),
    'NGINX_LOG_GID':str(os.getgid()), 'DOCKER_LOG_DIR':str(STATE / 'docker'), 'NGINX_LOG_DIR':str(STATE / 'nginx'), 'GRAFANA_PORT':'0'}))
# Published ports on an internal Docker bridge are not reachable on all hosts.
# This override is local-test-only; production compose and auth stay unchanged.
(STATE / 'override.yml').write_text(yaml.safe_dump({'networks':{'private':{'internal':False}}}))
try:
    compose('up', '-d')
    url = 'http://' + compose('port', 'grafana', '3000')
    (STATE / 'url').write_text(url)
    deadline = time.monotonic() + 180
    while True:
        try:
            with urllib.request.urlopen(url + '/api/health', timeout=5) as response:
                if response.status == 200: break
        except Exception:
            if time.monotonic() > deadline: raise
            time.sleep(2)
    now = time.time(); rid = str(uuid.uuid4()); jid = str(uuid.uuid4())
    instances = [str(uuid.uuid4()) for _ in range(5)]
    def stamp(t): return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()
    with log.open('a') as out, edge.open('a') as nginx:
        def emit(service, event, t, **fields):
            record = dict(event=event, time=stamp(t), severity='info', **fields)
            out.write(json.dumps({'log':json.dumps(record)+'\n', 'attrs':{'tag':service}, 'stream':'stdout'})+'\n')
        for minute in range(60):
            t = now - minute * 60
            for i in range(15 + minute % 8):
                status = 503 if minute < 12 and i == 0 else 200
                emit('api', 'request_completed', t, requestId=rid, route='/api/repo/:repoId/file/:path', status=status,
                     outcome='completed', firstByteMs=40+minute*2+i*3, responseMs=500+minute*5,
                     release='abcdef1' if minute<30 else 'abcdef0')
                nginx.write(json.dumps({'time':stamp(t), 'status':status, 'request_time':.8,
                    'upstream_header_time':'0.06', 'app_request_id':rid, 'route':'/api/repo/:id'})+'\n')
            if minute < 6: emit('api','request_cancelled',t,requestId=rid,status=200,outcome='interrupted')
            for i, instance in enumerate(instances):
                emit('api' if i==0 else 'streamer','process_heartbeat',t,instance=instance,memoryRatio=.31+i*.09,rss=100000000,droppedLogs=0)
            for queue in ['download','cache','remove']:
                emit('api','queue_heartbeat',t,queue=queue,waiting=3 if queue=='download' else 0,active=1,oldestWaitingMs=45000 if queue=='download' else 0)
        for event,outcome,status,latency in [('request_completed','completed',200,40),('request_slow','completed',503,1200),('request_cancelled','interrupted',503,None)]:
            emit('api',event,now,requestId=rid,release='fff0001',outcome=outcome,status=status,firstByteMs=latency)
        emit('api','job_failed',now,jobId=jid,requestId=rid,errorCode='ETIMEDOUT',queue='download')
    (STATE / 'ids.json').write_text(json.dumps({'request_id':rid,'job_id':jid}))
    time.sleep(3)
    print('Fixture Grafana: ' + url)
    print('Username: local-test; password file: ' + str(password))
    print('Run GRAFANA_TEST_URL="$(cat ' + str(STATE / 'url') + ')" GRAFANA_TEST_PASSWORD_FILE=' + str(password) + ' python3 scripts/test-grafana-dashboard.py')
except Exception:
    compose('down','-v','--remove-orphans')
    raise
