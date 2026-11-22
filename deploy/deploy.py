#!/usr/bin/env python3
"""Deploy DNSi to a Debian/Ubuntu VPS over SSH.

Usage:  HOSTINGER_TOKEN=... python deploy/deploy.py [user@host]

Idempotent: safe to re-run for updates. Requires `pip install paramiko`
and a password in the HOSTINGER_TOKEN environment variable (never hardcode).
"""

import os
import sys

import paramiko

HOST = os.environ.get("DNSI_DEPLOY_HOST", "2.25.19.136")
USER = os.environ.get("DNSI_DEPLOY_USER", "root")
TARBALL = os.path.join(os.path.dirname(__file__), "..", ".tmp-deploy", "dnsi.tar.gz")
UNIT_PATH = os.path.join(os.path.dirname(__file__), "dnsi.service")

# One-shot remote setup. Node 22 via NodeSource, a dedicated system user,
# /opt/dnsi, the unit from deploy/dnsi.service, then smoke tests.
REMOTE = [
    "apt-get update -qq",
    "node --version 2>/dev/null || (curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs)",
    "id dnsi >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d /opt/dnsi dnsi",
    "mkdir -p /opt/dnsi",
    "command -v dig >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y dnsutils",
    "systemctl unmask dnsi 2>/dev/null; true",
    "systemctl daemon-reload && systemctl enable dnsi",
    "systemctl restart dnsi",
    "sleep 1 && systemctl is-active dnsi",
    "journalctl -u dnsi -n 3 --no-pager | tail -3",
    "dig +short TXT what-is-dnsi.ask.dnsi.dev @127.0.0.1 -p 53",
    "dig +short TXT tool.time.ask.dnsi.dev @127.0.0.1 -p 53",
]


def run(ssh, cmd, check=True, timeout=600):
    print(f"\n$ {cmd}")
    _, stdout, stderr = ssh.exec_command(cmd, timeout=timeout)
    out = stdout.read().decode(errors="replace").strip()
    err = stderr.read().decode(errors="replace").strip()
    code = stdout.channel.recv_exit_status()
    if out:
        print(out[:3000].encode("ascii", "replace").decode())
    if err:
        print(f"[stderr] {err[:2000].encode('ascii', 'replace').decode()}")
    if check and code != 0:
        print(f"!! exit {code}")
        sys.exit(1)
    return out


def main():
    global HOST, USER
    password = os.environ.get("HOSTINGER_TOKEN")
    if not password:
        print("set HOSTINGER_TOKEN (or your ssh password env var) first")
        sys.exit(2)
    if len(sys.argv) > 1:
        user, _, host = sys.argv[1].partition("@")
        if not host:
            HOST = user
        else:
            HOST = host
            USER = user

    ssh = paramiko.SSHClient()
    ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    print(f"connecting {USER}@{HOST} ...")
    ssh.connect(HOST, username=USER, password=password, timeout=30)

    with open(UNIT_PATH) as f:
        unit = f.read()

    sftp = ssh.open_sftp()
    print("uploading tarball + unit ...")
    sftp.put(os.path.abspath(TARBALL), "/tmp/dnsi.tar.gz")
    with sftp.open("/etc/systemd/system/dnsi.service", "w") as f:
        f.write(unit)
    sftp.close()
    run(ssh, "tar -xzf /tmp/dnsi.tar.gz -C /opt/dnsi && rm /tmp/dnsi.tar.gz", timeout=120)

    for cmd in REMOTE:
        check = "dig" not in cmd and "is-active" not in cmd
        run(ssh, cmd, check=check)

    ssh.close()
    print("\nDONE")


if __name__ == "__main__":
    main()
