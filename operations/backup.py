"""Encrypted logical backups. Requires PostgreSQL 17 clients and age.

Connection URLs and age identities are supplied through environment/private files.
No unencrypted dump is written to disk. Restore rejects the live project.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
from datetime import datetime, timezone

LIVE_REF = "bqhzqsyfzbwprhummugp"


def database_env(name):
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"Set {name} in a private environment.")
    env = os.environ.copy()
    env["PGDATABASE"] = value
    env["PGCONNECT_TIMEOUT"] = "15"
    return env


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def pipeline(first, second, *, env, output=None, final=None):
    # Error output can contain user/host information; only exit codes are reported.
    with tempfile.TemporaryFile() as errors:
        processes = []
        try:
            commands = [first, second] + ([final] if final else [])
            for index, command in enumerate(commands):
                previous = processes[-1].stdout if processes else None
                process = subprocess.Popen(command, stdin=previous,
                    stdout=subprocess.PIPE if index < len(commands) - 1 else output or subprocess.DEVNULL,
                    stderr=errors, env=env)
                processes.append(process)
                if previous is not None:
                    previous.close()
            codes = [process.wait() for process in reversed(processes)][::-1]
            if any(codes):
                raise RuntimeError(f"Backup pipeline failed (exit codes {', '.join(map(str, codes))}). No credentials or raw logs are displayed.")
        finally:
            for process in reversed(processes):
                if process.poll() is None:
                    process.kill()
                process.wait()
                if process.stdout and not process.stdout.closed:
                    process.stdout.close()


def backup(args):
    env = database_env("SCHOLA_DATABASE_URL")
    recipient = os.environ.get("SCHOLA_BACKUP_RECIPIENT")
    if not recipient or not recipient.startswith("age1"):
        raise RuntimeError("Set SCHOLA_BACKUP_RECIPIENT to your age public encryption key.")
    directory = Path(args.directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
    target = directory / f"schola-{timestamp}.dump.age"
    staging = directory / f"schola-{timestamp}.partial"
    try:
        with staging.open("xb") as encrypted:
            pipeline(["pg_dump", "--format=custom", "--no-owner", "--schema=public", "--schema=private", "--schema=auth", "--schema=supabase_migrations"],
                     ["age", "--recipient", recipient], env=env, output=encrypted)
        staging.replace(target)
    finally:
        if staging.exists():
            staging.unlink()
    manifest = {"version": 1, "created_at": timestamp, "file": target.name, "sha256": digest(target), "format": "PostgreSQL custom / age", "restore_verified": False}
    target.with_suffix(target.suffix + ".json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print(f"Encrypted backup created: {target.name}. Restore verification is still required.")


def restore(args):
    env = database_env("SCHOLA_RESTORE_DATABASE_URL")
    if LIVE_REF in env["PGDATABASE"]:
        raise RuntimeError("Refusing to restore over the live project. Use a disposable database.")
    if not args.disposable:
        raise RuntimeError("Restore requires --disposable and an empty disposable database.")
    source = Path(args.file).resolve()
    manifest_path = source.with_suffix(source.suffix + ".json")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("version") != 1 or manifest.get("sha256") != digest(source):
        raise RuntimeError("Backup checksum mismatch; restore stopped.")
    identity = Path(args.identity).resolve()
    if not identity.is_file():
        raise RuntimeError("A private age identity file is required.")
    # Fail rather than overwriting existing app/auth tables. No --clean is used.
    probe = subprocess.run(["psql", "--no-psqlrc", "--tuples-only", "--no-align", "--command", "select count(*) from information_schema.tables where table_schema in ('public','private','auth') and table_type='BASE TABLE';"], capture_output=True, env=env, check=False)
    if probe.returncode or probe.stdout.strip() != b"0":
        raise RuntimeError("Restore target must be empty and reachable. Existing tables will not be overwritten.")
    role_sql = "do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role','authenticator','supabase_auth_admin','supabase_storage_admin','supabase_admin','supabase_read_only_user','dashboard_user'] loop if not exists(select 1 from pg_roles where rolname=r) then execute format('create role %I nologin',r); end if; end loop; end $$;"
    roles = subprocess.run(["psql", "--no-psqlrc", "--set=ON_ERROR_STOP=1", "--command", role_sql], capture_output=True, env=env, check=False)
    if roles.returncode:
        raise RuntimeError("Could not prepare roles in the disposable restore target.")
    # pg_restore without --dbname emits SQL. Stream it into psql, which reads
    # the private PGDATABASE environment; no plaintext dump or secret argv.
    pipeline(["age", "--decrypt", "--identity", str(identity), str(source)],
             ["pg_restore", "--exit-on-error", "--single-transaction", "--no-owner"],
             final=["psql", "--no-psqlrc", "--set=ON_ERROR_STOP=1"], env=env)
    verify_sql = "select count(*) from information_schema.tables where table_schema='public' and table_name in ('chapters','classrooms','user_profiles','matches');"
    result = subprocess.run(["psql", "--no-psqlrc", "--tuples-only", "--no-align", "--command", verify_sql], capture_output=True, env=env, check=False)
    if result.returncode or result.stdout.strip() != b"4":
        raise RuntimeError("Restore completed but core schema verification failed.")
    manifest["restore_verified"] = True
    manifest["verified_at"] = datetime.now(timezone.utc).isoformat()
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("PASS encrypted backup restored into a disposable database; core schema verified. Check application access and record counts before using it for recovery.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="action", required=True)
    create = sub.add_parser("backup")
    create.add_argument("--directory", required=True)
    recover = sub.add_parser("verify-restore")
    recover.add_argument("--file", required=True)
    recover.add_argument("--identity", required=True)
    recover.add_argument("--disposable", action="store_true")
    args = parser.parse_args()
    try:
        backup(args) if args.action == "backup" else restore(args)
    except (RuntimeError, OSError, ValueError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
