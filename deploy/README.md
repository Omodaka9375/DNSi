# Deploying the public instance

The live public DNSi runs on a Hostinger VPS (Debian 13) answering
`*.ask.dnsi.dev` on port 53, delegated from Porkbun:

```text
ns.dnsi.dev.    A     <VPS IP>     (Porkbun, glue)
ask.dnsi.dev.   NS    ns.dnsi.dev. (Porkbun, delegation)
```

On the VPS the server runs as the `dnsi` system user via
`deploy/dnsi.service`, bound to port 53 with `CAP_NET_BIND_SERVICE`
(no root), serving the canned-answers backend (`DNSI_ANSWERS`) in the
`dnsi.dev` zone. Note the zone is `dnsi.dev`, not `ask.dnsi.dev`:
`<question>.ask.dnsi.dev` is the full question name, so the delegated
subtree is exactly what the protocol names.

Port 53 was occupied by `systemd-resolved` on a fresh Debian install;
it is disabled (`systemctl disable --now systemd-resolved`) and
`/etc/resolv.conf` points at 1.1.1.1 / 8.8.8.8 directly. A host whose
job is to be a nameserver should not run a local stub resolver.

## One-shot deploy

```bash
pip install paramiko
export HOSTINGER_TOKEN='...'      # ssh password; never commit it
pnpm build
tar -czf .tmp-deploy/dnsi.tar.gz --exclude='*.map' \
  dist examples docs/*.md package.json README.md LICENSE
python deploy/deploy.py root@<vps-ip>
```

The script is idempotent: re-run it after every `pnpm build` to update
the running server. Verify from anywhere:

```bash
dig +short TXT what-is-dnsi.ask.dnsi.dev   # through normal recursion
dig +short TXT tool.time.ask.dnsi.dev @<vps-ip>
```
