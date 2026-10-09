import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("schola_backup", Path(__file__).resolve().parents[1] / "operations" / "backup.py")
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)
TEST_ROOT = Path(__file__).resolve().parents[1] / "test-results" / "backup-safety"
TEST_ROOT.mkdir(parents=True, exist_ok=True)


def temporary_directory():
    directory = tempfile.TemporaryDirectory(dir=TEST_ROOT)
    Path(directory.name).resolve().relative_to(TEST_ROOT.resolve())
    return directory


class BackupSafety(unittest.TestCase):
    def test_restore_sql_stream_reaches_final_consumer(self):
        with temporary_directory() as directory:
            output = Path(directory) / "output"
            with output.open("wb") as result:
                backup.pipeline([sys.executable, "-c", "import sys; sys.stdout.buffer.write(b'BEGIN; fixture; COMMIT;')"],
                    [sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"],
                    final=[sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"],
                    env=backup.os.environ.copy(), output=result)
            self.assertEqual(output.read_bytes(), b"BEGIN; fixture; COMMIT;")

    def test_pipeline_reports_producer_failure_even_when_consumers_succeed(self):
        with self.assertRaisesRegex(RuntimeError, "exit codes 7, 0, 0"):
            backup.pipeline([sys.executable, "-c", "raise SystemExit(7)"],
                [sys.executable, "-c", "import sys; sys.stdout.buffer.write(sys.stdin.buffer.read())"],
                final=[sys.executable, "-c", "import sys; sys.stdin.buffer.read()"], env=backup.os.environ.copy())

    def test_restore_executes_sql_with_private_connection_before_marking_verified(self):
        with temporary_directory() as directory:
            source = Path(directory) / "backup.dump.age"
            source.write_bytes(b"encrypted fixture")
            manifest_path = source.with_suffix(".age.json")
            manifest_path.write_text(json.dumps({"version": 1, "sha256": backup.digest(source), "restore_verified": False}))
            identity = Path(directory) / "identity"
            identity.write_text("test identity")
            connection = "postgresql://private:secret@localhost/disposable"
            def restore_pipeline(first, second, *, final, env):
                self.assertEqual(second[0], "pg_restore")
                self.assertIn("--single-transaction", second)
                self.assertEqual(final, ["psql", "--no-psqlrc", "--set=ON_ERROR_STOP=1"])
                self.assertEqual(env["PGDATABASE"], connection)
                self.assertNotIn(connection, " ".join(first + second + final))
                self.assertFalse(json.loads(manifest_path.read_text())["restore_verified"])
            with patch.dict(backup.os.environ, {"SCHOLA_RESTORE_DATABASE_URL": connection}), patch.object(backup, "pipeline", side_effect=restore_pipeline) as pipeline, patch.object(backup.subprocess, "run", side_effect=[SimpleNamespace(returncode=0, stdout=b"0"), SimpleNamespace(returncode=0), SimpleNamespace(returncode=0, stdout=b"4")]):
                backup.restore(SimpleNamespace(file=str(source), identity=str(identity), disposable=True))
                pipeline.assert_called_once()
            self.assertTrue(json.loads(manifest_path.read_text())["restore_verified"])

    def test_live_restore_is_refused_before_running_commands(self):
        with patch.dict(backup.os.environ, {"SCHOLA_RESTORE_DATABASE_URL": "postgresql://postgres:private@db.bqhzqsyfzbwprhummugp.supabase.co/postgres"}), patch.object(backup.subprocess, "run") as run:
            with self.assertRaisesRegex(RuntimeError, "live project"):
                backup.restore(SimpleNamespace(file="missing", identity="missing", disposable=True))
            run.assert_not_called()

    def test_checksum_mismatch_prevents_decryption(self):
        with temporary_directory() as directory:
            source = Path(directory) / "backup.dump.age"
            source.write_bytes(b"tampered encrypted data")
            source.with_suffix(".age.json").write_text(json.dumps({"version": 1, "sha256": "wrong"}))
            with patch.dict(backup.os.environ, {"SCHOLA_RESTORE_DATABASE_URL": "postgresql://test/disposable"}), patch.object(backup.subprocess, "Popen") as popen:
                with self.assertRaisesRegex(RuntimeError, "checksum"):
                    backup.restore(SimpleNamespace(file=str(source), identity="missing", disposable=True))
                popen.assert_not_called()

    def test_failed_backup_removes_partial_file(self):
        with temporary_directory() as directory:
            with patch.dict(backup.os.environ, {"SCHOLA_DATABASE_URL": "postgresql://private/test", "SCHOLA_BACKUP_RECIPIENT": "age1test"}), patch.object(backup, "pipeline", side_effect=RuntimeError("failed")):
                with self.assertRaisesRegex(RuntimeError, "failed"):
                    backup.backup(SimpleNamespace(directory=directory))
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_credentials_are_in_environment_and_backup_is_unverified(self):
        with temporary_directory() as directory:
            connection = "postgresql://private:secret@db/test"
            def encrypted_pipeline(first, second, *, env, output):
                self.assertEqual(env["PGDATABASE"], connection)
                self.assertNotIn(connection, " ".join(first + second))
                self.assertIn("age", second)
                output.write(b"encrypted fixture")
            with patch.dict(backup.os.environ, {"SCHOLA_DATABASE_URL": connection, "SCHOLA_BACKUP_RECIPIENT": "age1test"}), patch.object(backup, "pipeline", side_effect=encrypted_pipeline):
                backup.backup(SimpleNamespace(directory=directory))
            manifest = json.loads(next(Path(directory).glob("*.json")).read_text())
            self.assertFalse(manifest["restore_verified"])
            self.assertNotIn(connection, json.dumps(manifest))


if __name__ == "__main__":
    unittest.main()
