#!/usr/bin/env python3
"""Ejecuta SQL contra el proyecto Supabase via Management API.
Uso: python sbq.py <archivo.sql>   o   echo "SQL" | python sbq.py -
"""
import os, sys, json, urllib.request

PAT = os.environ.get("SB_PAT", "")  # export SB_PAT=sbp_... (nunca hardcodear)
REF = "kqwuvhfgykhjosglsznd"
URL = f"https://api.supabase.com/v1/projects/{REF}/database/query"

def run(sql):
    body = json.dumps({"query": sql}).encode()
    req = urllib.request.Request(URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {PAT}",
        "Content-Type": "application/json",
        "User-Agent": "curl/8.0.1",
    })
    try:
        with urllib.request.urlopen(req) as r:
            print(r.read().decode())
    except urllib.error.HTTPError as e:
        print(f"HTTP {e.code}: {e.read().decode()}", file=sys.stderr)
        sys.exit(1)

if __name__ == "__main__":
    if not PAT:
        sys.exit("Falta SB_PAT en el entorno (export SB_PAT=sbp_...)")
    src = sys.argv[1] if len(sys.argv) > 1 else "-"
    sql = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()
    run(sql)
