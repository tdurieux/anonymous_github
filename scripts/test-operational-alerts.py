#!/usr/bin/env python3
"""Pinned, isolated alert firing/recovery. No production access or notifications.
Log tests accelerate windows/for/interval only; expressions and numeric thresholds
are otherwise shipped rules. PromQL tests use promtool's simulated clock.
"""
import json, pathlib, re, subprocess, tempfile, time, urllib.request, urllib.parse, uuid
import yaml
ROOT = pathlib.Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'deploy/logging'
images = yaml.safe_load((CONFIG/'compose.yml').read_text())['services']
def run(*args):
    result=subprocess.run(args, capture_output=True, text=True)
    if result.returncode:raise RuntimeError(result.stdout+'\n'+result.stderr)
    return result.stdout.strip()
def request(url, data=None):
    return json.loads(urllib.request.urlopen(urllib.request.Request(url, data=data,
        headers={'Content-Type':'application/stream+json'} if data else {}), timeout=5).read())
def wait(fn, seconds=30):
    end=time.monotonic()+seconds; last=None
    while time.monotonic()<end:
        try:
            result=fn()
            if result:return result
        except Exception as error:last=error
        time.sleep(.25)
    raise AssertionError('condition did not become true: '+str(last))
with tempfile.TemporaryDirectory(prefix='operational-alerts-') as tmp:
    tmp=pathlib.Path(tmp); tmp.chmod(0o755); project='operational-alerts-'+uuid.uuid4().hex[:10]
    rules=yaml.safe_load((CONFIG/'log-alerts.yml').read_text())
    for group in rules['groups']:
        group['interval']='1s'
        for rule in group['rules']:
            rule['expr']=re.sub(r'_time:\d+m', '_time:5s', rule['expr']);rule['for']='2s'
    (tmp/'rules.yml').write_text(yaml.safe_dump(rules))
    compose={'services':{
        'logs':{'image':images['victorialogs']['image'],'mem_limit':'512m','command':['-storageDataPath=/storage','-storage.minFreeDiskSpaceBytes=1MB','-memory.allowedBytes=256MiB'], 'ports':['127.0.0.1::9428']},
        'alerts':{'image':images['vmalert']['image'],'command':['-rule=/rules.yml','-datasource.url=http://logs:9428','-notifier.blackhole','-rule.evalDelay=0s'], 'volumes':[str(tmp/'rules.yml')+':/rules.yml:ro'],'ports':['127.0.0.1::8880']},
    },'networks':{'default':{'internal':False}}}
    (tmp/'compose.yml').write_text(yaml.safe_dump(compose))
    cmd=['docker','compose','-p',project,'-f',str(tmp/'compose.yml')]
    try:
        run(*cmd,'up','-d')
        logs='http://'+run(*cmd,'port','logs','9428');alerts='http://'+run(*cmd,'port','alerts','8880')
        def states():
            groups=request(alerts+'/api/v1/rules')['data']['groups']
            return {r['name']:r['state'] for g in groups for r in g['rules']}
        wait(states)
        def emit(rows):
            data=('\n'.join(json.dumps({**r,"message":r.get("event", "fixture")}) for r in rows)+'\n').encode()
            urllib.request.urlopen(urllib.request.Request(logs+'/insert/jsonline?_msg_field=message',data=data,headers={'Content-Type':'application/stream+json'}),timeout=5).read()
        def healthy():
            rows=[{'service':'api','instance':'api','event':'process_heartbeat','memoryRatio':.2,'droppedLogsInterval':0}]
            rows += [{'service':'streamer','instance':str(i),'event':'process_heartbeat','memoryRatio':.2,'droppedLogsInterval':0} for i in range(4)]
            rows += [{'service':'api','queue':q,'event':'queue_heartbeat','oldestWaitingMs':0} for q in ['download','remove','cache']]
            return rows
        # Threshold violations, then missing telemetry, then healthy recovery.
        target={'SustainedServerErrors','ApplicationRestartBurst','ApplicationMemoryPressure','QueueStalled','QueueWaitingTooLong','WebhookFailures','ApplicationLogDrops'}
        def failures():
            rows=healthy()
            rows += [{'service':'api','event':'request_completed','outcome':'completed','status':503,'route':'/github/app/webhook'} for _ in range(12)]
            rows += [{'service':'api','event':'process_started'} for _ in range(5)]
            rows += [{'service':'api','event':'process_heartbeat','instance':'api','memoryRatio':.95,'droppedLogsInterval':2}]
            rows += [{'service':'api','event':'job_stalled','queue':'download'},{'service':'api','event':'queue_heartbeat','queue':'download','oldestWaitingMs':700000}]
            return rows
        seen=set()
        for _ in range(16):
            emit(failures());time.sleep(.5);seen.update(n for n,s in states().items() if s=='firing')
        assert target <= seen,(target-seen,states())
        print('PASS real vmalert firing for 5xx, restarts, memory, stalls, waiting age, webhook and interval drops',flush=True)
        missing={'ApiTelemetryMissing','StreamerTelemetryMissing','QueueTelemetryMissing'}
        wait(lambda: missing <= {n for n,s in states().items() if s=='firing'},20)
        print('PASS real missing-heartbeat alerts fire',flush=True)
        for _ in range(16):emit(healthy());time.sleep(.5)
        assert all(s=='inactive' for s in states().values()),states()
        print('PASS all log alerts recover; no external notifier configured',flush=True)
    except Exception:
        print(run(*cmd,'logs','--tail','25'),flush=True);raise
    finally:run(*cmd,'down','-v','--remove-orphans')
    metric_rules=yaml.safe_load((CONFIG/'metrics-alerts.yml').read_text())
    (tmp/'metrics.yml').write_text(yaml.safe_dump(metric_rules))
    series=[
        {'series':'up{job="collector",instance="vector:9598"}','values':'0+0x6 1+0x14'},
        {'series':'vector_buffer_discarded_events_total','values':'0+1x6 6+0x14'},
        {'series':'vector_component_discarded_events_total{intentional="false"}','values':'0+1x6 6+0x14'},
        {'series':'vector_component_errors_total','values':'0+1x6 6+0x14'},
        {'series':'vl_data_size_bytes','values':str(9*1024**3)+'+0x6 1000+0x14'},
        {'series':'vl_free_disk_space_bytes','values':str(10*1024**3)+'+0x21'},
        {'series':'vl_rows_dropped_total','values':'0+1x6 6+0x14'},
        {'series':'vmalert_execution_errors_total','values':'0+1x6 6+0x14'},
    ]
    checks=[]
    for group in metric_rules['groups']:
        for rule in group['rules']:
            labels=dict(rule['labels'])
            if rule['alert']=='LoggingTelemetryMissing':labels.update(job='collector',instance='vector:9598')
            checks += [{'eval_time':'6m','alertname':rule['alert'],'exp_alerts':[{'exp_labels':labels,'exp_annotations':rule['annotations']}]},
                       {'eval_time':'15m','alertname':rule['alert'],'exp_alerts':[]},
                       {'eval_time':'1m','alertname':rule['alert'],'exp_alerts':[]}]
    tests={'rule_files':['/fixtures/metrics.yml'],'evaluation_interval':'1m','tests':[{'interval':'1m','input_series':series,'alert_rule_test':checks}]}
    (tmp/'tests.yml').write_text(yaml.safe_dump(tests))
    print(run('docker','run','--rm','--network','none','--entrypoint','/bin/promtool','-v',str(tmp)+':/fixtures:ro',images['prometheus']['image'],'test','rules','/fixtures/tests.yml'),flush=True)
    print('PASS pinned Prometheus firing, sustained thresholds and recovery for every infrastructure alert',flush=True)
