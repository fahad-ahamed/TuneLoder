#!/usr/bin/env python3
"""SSH helper for BasicDeploy container w33qy6jj (or any by subdomain).
Usage: python3 bd_ssh.py [--sub SUB] [--put local remote] [--get remote local] "command"
"""
import sys, json, argparse, urllib.request

API = "https://basicdeploy.com/api/containers"
KEY_PATH = "/tmp/bd_key"

def get_key(sub):
    try:
        return open(KEY_PATH).read()
    except Exception:
        pass
    return None

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sub", default="w33qy6jj")
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--put", nargs=2, metavar=("LOCAL", "REMOTE"))
    ap.add_argument("--get", nargs=2, metavar=("REMOTE", "LOCAL"))
    ap.add_argument("cmd", nargs="?", default="")
    a = ap.parse_args()

    import paramiko
    # fetch container info (curl works even when urllib gets 403)
    import subprocess
    try:
        out = subprocess.run(
            ["curl", "-s", "-m", "30", API, "-H", "Authorization: Bearer bd_q4jm4nIorX19tOl3QsCsxT4VvFKY17oSOdvfLidf"],
            capture_output=True, text=True, timeout=40).stdout
        containers = json.loads(out)
        json.dump(containers, open("/home/z/my-project/data/bd-containers.json", "w"))
    except Exception:
        containers = json.load(open("/home/z/my-project/data/bd-containers.json"))
    c = next(x for x in containers if x["subdomain"] == a.sub)
    port = a.port or c["sshPort"]
    key_text = c["sshKey"].replace("[REDACTED:ssh_private_key]", "-----BEGIN PRIVATE KEY-----")
    open("/tmp/bd_key_raw", "w").write(key_text)

    # convert PKCS8 → PKCS1 so paramiko can load it
    from cryptography.hazmat.primitives import serialization
    pk = serialization.load_pem_private_key(key_text.encode(), password=None)
    pem = pk.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption())
    open("/tmp/bd_key", "wb").write(pem)

    cli = paramiko.SSHClient()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    k = paramiko.RSAKey.from_private_key_file("/tmp/bd_key")
    cli.connect("basicdeploy.com", port=port, username="root", pkey=k, timeout=25)

    if a.put:
        sftp = cli.open_sftp()
        sftp.put(a.put[0], a.put[1])
        print(f"put {a.put[0]} -> {a.put[1]}")
        sftp.close()
    elif a.get:
        sftp = cli.open_sftp()
        sftp.get(a.get[0], a.get[1])
        print(f"get {a.get[0]} -> {a.get[1]}")
        sftp.close()
    if a.cmd:
        stdin, stdout, stderr = cli.exec_command(a.cmd, timeout=300)
        out = stdout.read().decode("utf-8", "replace")
        err = stderr.read().decode("utf-8", "replace")
        if out: print(out)
        if err: print("STDERR:", err[-2000:], file=sys.stderr)
    cli.close()

if __name__ == "__main__":
    main()
