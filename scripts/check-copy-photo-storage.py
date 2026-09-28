"""Run with python3; synthetic credentials and a stub rclone, no network access."""
from pathlib import Path
import subprocess
import tempfile


with tempfile.TemporaryDirectory() as directory:
    root = Path(directory)
    stub = root / "rclone"
    stub.write_text('''#!/usr/bin/env bash
set -eu
test "$RCLONE_CONFIG_SOURCE_FORCE_PATH_STYLE" = true
test "$RCLONE_CONFIG_DESTINATION_FORCE_PATH_STYLE" = false
test "$RCLONE_CONFIG_SOURCE_ACCESS_KEY_ID" = source-key
test "$RCLONE_CONFIG_DESTINATION_ACCESS_KEY_ID" = destination-key
printf '%s\\n' "$*" >> "$CALLS"
test "${FAIL_COMMAND:-}" != "$1"
''')
    stub.chmod(0o700)
    calls = root / "calls"
    env = {"PATH": f"{root}:/usr/bin:/bin", "TMPDIR": directory, "CALLS": str(calls)}
    for prefix, name in [("SUPABASE_S3", "source"), ("S3", "destination")]:
        env.update({f"{prefix}_ENDPOINT": f"https://{name}.example.com",
                    f"{prefix}_REGION": "auto",
                    f"{prefix}_ACCESS_KEY_ID": f"{name}-key",
                    f"{prefix}_SECRET_ACCESS_KEY": f"{name}-secret"})
    env.update(SUPABASE_STORAGE_BUCKET="old-photos", S3_BUCKET="new-photos")
    script = Path(__file__).with_name("copy-photo-storage.sh")
    for overrides, expected in [({}, ["size", "copy", "check", "size"]),
                                ({"FAIL_COMMAND": "copy"}, ["size", "copy"]),
                                ({"S3_FORCE_PATH_STYLE": "yes"}, [])]:
        calls.write_text("")
        result = subprocess.run(["bash", str(script)], env=env | overrides,
                                capture_output=True, text=True)
        commands = calls.read_text().splitlines()
        assert [line.split()[0] for line in commands] == expected
        assert (result.returncode == 0) == (not overrides)
        assert all(secret not in result.stdout + result.stderr
                   for secret in ["source-secret", "destination-secret"])
        if not overrides:
            assert "--immutable --metadata" in commands[1]
            assert "--download" in commands[2]
            assert all("--config /dev/null" in line for line in commands)
            assert commands[1].endswith("source:old-photos destination:new-photos")
print("Storage copy checks passed (synthetic, no network).")
