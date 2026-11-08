#!/usr/bin/env python3
"""Smoke-test the root Go Compose model with disposable data and random ports.

Build first: docker build -t anonymous-github-go:deployment-test .
Run: python3 backend/scripts/test-deployment.py [image]
"""
import base64
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
IMAGE = sys.argv[1] if len(sys.argv) > 1 else 'anonymous-github-go:deployment-test'
PROJECT = 'go-deployment-test-' + secrets.token_hex(6)
ENV = {key: os.environ[key] for key in ('PATH', 'HOME', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG') if key in os.environ}
ENV.update(DB_USERNAME='smoke', DB_PASSWORD=secrets.token_hex(20), EXPOSED_PORT='5000')


def run(*args, capture=True):
    return subprocess.run(args, cwd=ROOT, env=ENV, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout


with tempfile.TemporaryDirectory(prefix=PROJECT) as directory:
    envfile = Path(directory) / 'app.env'
    envfile.write_text('\n'.join([
        'SESSION_SECRET=' + secrets.token_hex(32),
        'CREDENTIAL_KEYS=' + json.dumps({'smoke': base64.b64encode(secrets.token_bytes(32)).decode()}),
        'CREDENTIAL_ACTIVE_KEY_ID=smoke', 'GITHUB_OAUTH_ENABLED=false',
        'GITHUB_APP_ENABLED=false', 'COOKIE_SECURE=false',
        'SHARED_CACHE_ENABLED=true', 'SHARED_CACHE_FREE_BYTES=0',
        'DB_USERNAME=' + ENV['DB_USERNAME'], 'DB_PASSWORD=' + ENV['DB_PASSWORD'],
    ]) + '\n')
    envfile.chmod(0o600)
    ENV['APP_ENV_FILE'] = str(envfile)
    base = ['docker', 'compose', '--env-file', '/dev/null']
    model = json.loads(run(*base, '-f', 'docker-compose.yml', 'config', '--format', 'json'))
    assert set(model['services']) == {'anonymous_github', 'mongodb', 'redis', 'mongodb-backup'}
    for files, expected in [(['docker-compose.yml', 'docker-compose.github-app.yml'], 4),
                            (['docker-compose.node.yml', 'docker-compose.node.github-app.yml'], 5)]:
        flags = [arg for file in files for arg in ('-f', file)]
        other = json.loads(run(*base, *flags, 'config', '--no-env-resolution', '--format', 'json'))
        assert len(other['services']) == expected
    app = model['services']['anonymous_github']
    assert app['read_only'] and app['init']
    assert app['healthcheck']['test'] == ['CMD', '/usr/local/bin/anonymous-server', 'healthcheck']
    assert app['pids_limit'] == 128 and app['cap_drop'] == ['ALL']
    assert 'streamer' not in app['depends_on']
    # Replace all persisted data and host bindings before starting any container.
    del model['services']['mongodb-backup']
    app.pop('build', None)
    app['image'] = IMAGE
    app['ports'] = [{'target': 5000, 'published': '0', 'host_ip': '127.0.0.1', 'protocol': 'tcp'}]
    app['volumes'] = [{'type': 'volume', 'source': 'test_repositories', 'target': '/app/repositories'}]
    mongo = model['services']['mongodb']
    mongo['image'] = 'mongo:7'
    mongo.pop('ports', None)
    mongo['volumes'] = [{'type': 'volume', 'source': 'test_mongo', 'target': '/data/db'}]
    model['services']['redis'].pop('ports', None)
    model['volumes'] = {'test_repositories': {}, 'test_mongo': {}}
    model['networks'] = {'default': {}}
    model['name'] = PROJECT
    for service in model['services'].values():
        service['restart'] = 'no'
        assert all(v['type'] == 'volume' for v in service.get('volumes', []))
    config = Path(directory) / 'compose.json'
    config.write_text(json.dumps(model))
    config.chmod(0o600)
    compose = base + ['-p', PROJECT, '-f', str(config)]
    try:
        run(*compose, 'up', '-d', '--no-build', '--wait', '--wait-timeout', '120', capture=False)
        cid = run(*compose, 'ps', '-q', 'anonymous_github').strip()
        info = json.loads(run('docker', 'inspect', cid))[0]
        assert info['Config']['User'] == '10001:10001'
        assert info['HostConfig']['ReadonlyRootfs']
        run(*compose, 'exec', '-T', 'anonymous_github', 'sh', '-ec',
            'test "$(id -u)" = 10001; touch /tmp/smoke /app/repositories/smoke; '
            'test ! -w /app/public; test ! -e /usr/local/bin/node; '
            'rm /tmp/smoke /app/repositories/smoke')
        address = run(*compose, 'port', 'anonymous_github', '5000').strip()
        for path in ('/healthcheck', '/', '/llms.txt', '/maintenance-openapi.json'):
            with urllib.request.urlopen('http://' + address + path, timeout=10) as response:
                assert response.status == 200
                assert response.read(), path
        run(*compose, 'stop', 'anonymous_github', capture=False)
        state = json.loads(run('docker', 'inspect', cid))[0]['State']
        assert state['ExitCode'] == 0 and not state['OOMKilled'], state
        print('PASS: Go default, Node rollback models, isolated startup, non-root writes, static routes, graceful shutdown')
    finally:
        # Only this randomly named test project owns these disposable volumes.
        run(*compose, 'down', '--volumes', '--timeout', '45', capture=False)
