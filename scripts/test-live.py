#!/usr/bin/env python3
"""Run the live contract test with a supplied SkilJ demo binary and disposable Postgres."""
import argparse
import json
import os
from pathlib import Path
import re
import signal
import shutil
import socket
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--server", required=True, type=Path, help="SkilJ v0.3.0 skilj-demo server binary")
    parser.add_argument("--deno", type=Path, default=Path.home() / ".swamp/deno/deno")
    parser.add_argument("--postgres-image", default="postgres:17-alpine", help="Pre-pulled Docker image")
    parser.add_argument("--prefix", default="ledger", help="Exercise federation-prefixed operations; empty for default names")
    args = parser.parse_args()
    server_binary = args.server.resolve(strict=True)
    deno = args.deno.resolve(strict=True)
    root = Path(__file__).resolve().parent.parent
    with tempfile.TemporaryDirectory(prefix="skilj-contract-") as directory:
        name = Path(directory).name
        process = None
        created = False
        try:
            subprocess.run(["docker", "run", "--detach", "--rm", "--pull=never", "--name", name,
                "--publish", "127.0.0.1::5432", "--env", "POSTGRES_USER=skilj_contract",
                "--env", "POSTGRES_PASSWORD=skilj_contract", "--env", "POSTGRES_DB=skilj_contract",
                "--tmpfs", "/var/lib/postgresql/data", args.postgres_image], check=True, capture_output=True)
            created = True
            port = subprocess.check_output(["docker", "port", name, "5432"], text=True).strip().rsplit(":", 1)[1]
            for _ in range(100):
                ready = subprocess.run(["docker", "exec", name, "pg_isready", "-h", "127.0.0.1", "-U", "skilj_contract", "-d", "skilj_contract"], capture_output=True)
                if ready.returncode == 0:
                    break
                time.sleep(0.1)
            else:
                raise RuntimeError("Disposable Postgres did not become ready")
            with socket.socket() as listener:
                listener.bind(("127.0.0.1", 0))
                server_port = listener.getsockname()[1]
            env = {key: value for key, value in os.environ.items() if not key.startswith(("SKILJ_LOCAL_", "OTEL_"))}
            env.pop("SKILJ_LOCAL_MODE", None)
            env.update(DATABASE_URL=f"postgres://skilj_contract:skilj_contract@127.0.0.1:{port}/skilj_contract",
                       PORT=str(server_port), RUST_LOG="warn", SKILJ_FEDERATION_PREFIX=args.prefix)
            log = Path(directory) / "server.log"
            with log.open("w") as output:
                log.chmod(0o600)
                process = subprocess.Popen([str(server_binary)], env=env, stdout=output, stderr=subprocess.STDOUT)
            for _ in range(300):
                contents = log.read_text()
                if "skilj-demo listening" in contents:
                    break
                if process.poll() is not None:
                    # The demo log includes generated credentials; don't echo it.
                    sanitized = re.sub(r"[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]{16,}", "<test credential>", contents[-3000:])
                    raise RuntimeError("Demo server exited before readiness: " + sanitized)
                time.sleep(0.1)
            else:
                raise RuntimeError("Demo server readiness timed out")
            match = re.search(r"^\s+(eyJ[A-Za-z0-9_.-]+)\s*$", contents, re.MULTILINE)
            if match is None:
                raise RuntimeError("Could not locate the demo's generated Role JWT")
            test_env = {**os.environ, "SKILJ_TEST_URL": f"http://127.0.0.1:{server_port}",
                        "SKILJ_TEST_JWT": match.group(1), "SKILJ_TEST_PREFIX": args.prefix}
            completed = subprocess.run([str(deno), "test", "--allow-net=127.0.0.1",
                "--allow-env=NODE_ENV,SKILJ_TEST_URL,SKILJ_TEST_JWT,SKILJ_TEST_PREFIX", "tests/skilj_live_test.ts"], cwd=root, env=test_env)
            if completed.returncode:
                return completed.returncode
            # Exercise Swamp's bundled runtime, vaults and declarative workflow
            # against the same isolated server, rather than only direct calls.
            swamp_env = {**os.environ, "SWAMP_REPO_DIR": str(Path(directory) / "swamp"), "SWAMP_NO_TELEMETRY": "1"}
            def swamp(*arguments, stdin=None, expect_failure=False):
                result = subprocess.run(["swamp", *arguments, "--no-telemetry", "--json"], input=stdin, text=True, capture_output=True, env=swamp_env)
                if result.returncode:
                    if arguments[:2] == ("workflow", "run"):
                        report = subprocess.run(["swamp", "report", "get", "@swamp/workflow-summary", "--workflow", arguments[2], "--json"], text=True, capture_output=True, env=swamp_env)
                        try:
                            summary = json.loads(report.stdout).get("json", {})
                            if not expect_failure:
                                print(json.dumps(summary.get("failures", summary), indent=2))
                        except json.JSONDecodeError:
                            print(report.stderr)
                    try:
                        failure = json.loads(result.stdout)
                        detail = failure.get("error", failure.get("status", "command failed"))
                    except json.JSONDecodeError:
                        detail = result.stdout[-2000:]
                    if not expect_failure:
                        raise RuntimeError(result.stderr or str(detail))
                parsed = json.loads(result.stdout)
                if expect_failure and parsed.get("status") != "failed":
                    raise RuntimeError("Expected verification failure, got " + str(parsed.get("status")))
                return parsed
            swamp("repo", "init", swamp_env["SWAMP_REPO_DIR"], "--tool", "none")
            swamp("extension", "source", "add", str(root), "--only", "models,reports,workflows")
            swamp("vault", "put", "default", "role-jwt", stdin=match.group(1))
            swamp("model", "create", "@gklijs/skilj-graphql", "native-admin", "--global-arg", f"endpoint=http://127.0.0.1:{server_port}/graphql",
                  "--global-arg", "namingPrefix=" + args.prefix,
                  "--global-arg", 'token=${{ vault.get("default", "role-jwt") }}')
            swamp("model", "method", "run", "native-admin", "introspect")
            swamp("model", "method", "run", "native-admin", "validateOperation", "--input",
                  json.dumps({"document": "{ __typename }"}))
            swamp("model", "method", "run", "native-admin", "exportSchemaSdl")
            swamp("model", "method", "run", "native-admin", "compareSchema")
            swamp("model", "method", "run", "native-admin", "listCommandProposals", "--input", json.dumps({"boundedContext": "banking", "status": "ALL", "includePayloads": True, "maxPages": 2}))
            inspected = swamp("data", "query", 'modelName == "native-admin" && name.startsWith("proposal-")', "--select", "content")
            encoded = json.dumps(inspected)
            assert "contract-a" not in encoded and "contract check" not in encoded, "Private proposal data leaked into persisted records"
            assert "vault.get" in encoded, "Expected protected proposal payloads"

            def find_credential(value, expected_kind, expected_type):
                if isinstance(value, str) and value.startswith(("{", "[")):
                    try:
                        return find_credential(json.loads(value), expected_kind, expected_type)
                    except json.JSONDecodeError:
                        pass
                if isinstance(value, dict):
                    if "credential" in value and value.get("kind") == expected_kind and value.get("typeName") == expected_type:
                        return value["credential"]
                    for child in value.values():
                        found = find_credential(child, expected_kind, expected_type)
                        if found:
                            return found
                if isinstance(value, list):
                    for child in value:
                        found = find_credential(child, expected_kind, expected_type)
                        if found:
                            return found
                return None
            credential_refs = set()
            for model_name, kind, type_name in [("native-command", "command", "WithdrawMoney"), ("native-events", "eventRead", "MoneyWithdrawn"), ("native-wrong-events", "eventRead", "MoneyDeposited")]:
                swamp("model", "method", "run", "native-admin", "createAccessToken", "--input", json.dumps({"kind": kind, "boundedContext": "banking", "typeName": type_name}))
                output = swamp("data", "query", 'modelName == "native-admin" && name.startsWith("token-")', "--select", "content")
                credential = find_credential(output, kind, type_name)
                assert isinstance(credential, str) and "vault.get" in credential, "Capability credential was not vaulted"
                assert credential not in credential_refs, "Distinct capabilities reused one vault slot"
                credential_refs.add(credential)
                swamp("model", "create", "@gklijs/skilj", model_name, "--global-arg", f"baseUrl=http://127.0.0.1:{server_port}", "--global-arg", "token=" + credential)
            # A pulled extension installs workflow YAML locally; source-added
            # model types alone do not materialize workflow definitions.
            shutil.copyfile(root / "workflows/workflow-skilj-command-and-verify.yaml",
                            Path(swamp_env["SWAMP_REPO_DIR"]) / "workflows/workflow-skilj-command-and-verify.yaml")
            workflow = "@gklijs/skilj-command-and-verify"
            swamp("workflow", "validate", workflow)
            workflow_inputs = {
                "commandModel": "native-command", "eventsModel": "native-events", "payload": {"account_id": "contract-a", "amount": 5}, "idempotencyKey": "native-withdraw-1",
            }
            for _ in range(2):
                result = swamp("workflow", "run", workflow, "--stdin", stdin=json.dumps(workflow_inputs))
                if result.get("status") != "succeeded":
                    raise RuntimeError("Native workflow reported failure")
            print("PASS: Swamp bundled runtime, independent vault-backed capabilities, schema tooling, workflow and idempotent replay")
            wrong = swamp("workflow", "run", workflow, "--stdin", stdin=json.dumps({
                **workflow_inputs, "eventsModel": "native-wrong-events", "idempotencyKey": "native-wrong-reader",
            }), expect_failure=True)
            failures = [step for job in wrong["jobs"] for step in job["steps"] if step["status"] == "failed"]
            assert len(failures) == 1 and failures[0]["name"] == "assert-stored-event", "Wrong reader did not fail the event verification assertion"
            print("PASS: wrong event reader fails verification, rather than reporting success")
            return 0
        finally:
            if process is not None and process.poll() is None:
                process.send_signal(signal.SIGINT)
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            if created:
                subprocess.run(["docker", "stop", "--timeout", "5", name], capture_output=True)


if __name__ == "__main__":
    raise SystemExit(main())
