# Production edge logging

Load `anonymous-logging.conf` in Nginx's **http** context, normally by installing it as `/etc/nginx/conf.d/anonymous-logging.conf`. Add this directive inside each application **server** block, including HTTP redirects and alternate hostnames:

```nginx
access_log /var/log/nginx/anonymous-access.log anonymous_json buffer=64k flush=1s;
```

Back up the existing configuration, run `sudo nginx -t`, then gracefully reload Nginx. On validation failure restore the backup before reloading. The server-level directive replaces the inherited combined access log for that virtual host; do not add a second combined log containing raw queries.

The JSON log separates visitor and Cloudflare edge addresses. Cloudflare headers are accepted only for peers in its published IP ranges. Direct requests cannot spoof the visitor IP or Ray ID through these headers. Refresh the ranges from the two URLs in the config when Cloudflare changes them. This configuration deliberately leaves `real_ip`, `X-Forwarded-For`, and application rate-limit identity unchanged.

Use `app_request_id` to correlate with API/streamer request logs and `cf_ray` with Cloudflare security events. `edge_request_id` exists even when the upstream never responds. Upstream statuses and connect/header/response timings separate origin failures from proxy failures. Status 499 and an empty `completion` identify incomplete requests; connection fields expose keep-alive reuse. Use the separate Nginx error log to distinguish connection-slot exhaustion from timeouts. An access event is emitted when its request finishes, so per-second counts are completion counts, not exact arrival rates.

Route labels omit queries, repository IDs and file paths. Cookies, authorization headers, bodies and referrers are not collected. User-agent text is JSON escaped. Treat IPs and Ray IDs as private operational data: keep logs readable only by operators. On Ubuntu, the existing `/var/log/nginx/*.log` logrotate rule covers this file; verify it creates mode 0640, compresses old logs and retains no more than 14 daily rotations. Watch disk usage during floods; daily rotation is not a hard size cap.

This is observability, not flood prevention. Cloudflare rate limiting/challenges and origin connection limits need a separate measured rollout. Do not block the Cloudflare edge IPs reported in `peer_ip` as if they were visitors.

Validate with the installed Nginx binary before rollout:

```sh
python3 scripts/test-nginx-logging.py deploy/nginx/anonymous-logging.conf
```

The test starts an isolated loopback listener and checks trusted IPv4/IPv6 peers, spoofed headers, missing-header fallback, JSON escaping and omitted sensitive data. It never changes production listeners.
