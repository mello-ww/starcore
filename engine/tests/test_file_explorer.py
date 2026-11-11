"""The File Explorer satellite: browsing, download, upload, mkdir, rename,
delete - across the whole filesystem the StarCore process can reach, not a
sandboxed root. There is no boundary to escape any more (see paths.py), so
what matters here is that malformed requests are rejected cleanly, that a
filesystem root itself can never be renamed or deleted, and that whatever
the operating system's own permissions refuse comes back as a clean, useful
error instead of a crash.
"""

from http.client import HTTPConnection
from pathlib import Path
from urllib.parse import urlencode
import json
import os
import shutil
import tempfile
import unittest

from tests.support import start_engine, stop_engine

# root privileges (common inside a container) bypass POSIX permission bits
# entirely, and POSIX permission bits themselves don't apply on Windows the
# same way - both make a real "permission denied" impossible to provoke
_CAN_TEST_PERMISSION_DENIAL = (
    os.name != "nt" and not (hasattr(os, "geteuid") and os.geteuid() == 0)
)


class FileExplorerApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = start_engine(mission_control=True)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not be started")

        cls.satellite = cls.engine.registry.get("FileExplorer")
        if cls.satellite is None:
            stop_engine(cls.engine)
            raise unittest.SkipTest("FileExplorer satellite did not load")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def setUp(self):
        # a fresh, disposable directory for every test - real, ordinary
        # storage completely outside the StarCore checkout, exactly like
        # anywhere else on the machine File Explorer can now reach
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-fe-")).resolve()

    def tearDown(self):
        if os.name != "nt":
            os.chmod(self.directory, 0o755)
        shutil.rmtree(self.directory, ignore_errors=True)

    def request(self, path, method="GET", payload=None, raw=None, content_type=None):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        body = None
        headers = {}
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif raw is not None:
            body = raw
            headers["Content-Type"] = content_type or "application/octet-stream"

        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            return response.status, response.headers, response.read()
        finally:
            connection.close()

    def json_request(self, path, method="GET", payload=None):
        status, headers, body = self.request(path, method, payload)
        self.assertIn("application/json", headers.get("Content-Type", ""))
        return status, json.loads(body.decode("utf-8"))

    def base(self, route: str) -> str:
        return f"/api/satellites/FileExplorer/{route}"

    def with_path(self, route: str, path, **extra) -> str:
        query = {"path": str(path), **extra}
        return f"{self.base(route)}?{urlencode(query)}"

    # ---------- browsing ----------

    def test_the_roots_listing_has_no_parent_and_is_not_empty(self):
        status, payload = self.json_request(self.base("entries"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["path"], "")
        self.assertIsNone(payload["parent"])
        self.assertTrue(payload["entries"])
        self.assertTrue(all(entry["type"] == "dir" for entry in payload["entries"]))

    def test_the_roots_listing_matches_the_current_platform(self):
        status, payload = self.json_request(self.base("entries"))
        self.assertEqual(status, 200)
        names = [entry["name"] for entry in payload["entries"]]
        if os.name == "nt":
            for name in names:
                self.assertRegex(name, r"^[A-Za-z]:\\$")
        else:
            self.assertEqual(names, ["/"])

    # ---------- storage dashboard (Part 4/7 of the "Home Storage
    # Visualization" block) - per-root/per-directory disk usage, and the
    # deduplicated machine-wide total the roots listing carries alongside it ----------

    def test_the_roots_listing_has_no_top_level_storage_figure_but_a_machine_total(self):
        # the roots list isn't itself one filesystem - "storage" stays None
        # there; "machine" is the deduplicated total across every root
        # (see _machine_storage() in api.py)
        status, payload = self.json_request(self.base("entries"))
        self.assertEqual(status, 200)
        self.assertIsNone(payload["storage"])
        self._assert_storage_shape_or_none(payload["machine"], extra_keys={"volumes"})

    def test_each_root_reports_its_own_storage_or_none(self):
        status, payload = self.json_request(self.base("entries"))
        self.assertEqual(status, 200)
        for entry in payload["entries"]:
            self.assertIn("storage", entry)
            self._assert_storage_shape_or_none(entry["storage"])

    def test_a_real_directory_listing_includes_storage_totals(self):
        status, payload = self.json_request(self.with_path("entries", self.directory))
        self.assertEqual(status, 200)
        self.assertIn("storage", payload)
        self._assert_storage_shape_or_none(payload["storage"])

    def test_storage_totals_are_internally_consistent_when_available(self):
        status, payload = self.json_request(self.with_path("entries", self.directory))
        self.assertEqual(status, 200)
        info = payload["storage"]
        if info is None:
            self.skipTest("this platform/mount could not report disk usage")
        self.assertGreaterEqual(info["total"], 0)
        self.assertGreaterEqual(info["used"], 0)
        self.assertGreaterEqual(info["free"], 0)
        # shutil.disk_usage doesn't promise used+free == total to the byte
        # (reserved blocks, concurrent writes elsewhere on the same
        # filesystem), just that neither figure can exceed the whole
        self.assertLessEqual(info["used"], info["total"])
        self.assertLessEqual(info["free"], info["total"])

    def test_the_machine_total_is_at_least_as_large_as_any_single_root(self):
        status, payload = self.json_request(self.base("entries"))
        self.assertEqual(status, 200)
        machine = payload["machine"]
        if machine is None:
            self.skipTest("no root on this platform could report disk usage")
        for entry in payload["entries"]:
            if entry["storage"] is not None:
                self.assertGreaterEqual(machine["total"], entry["storage"]["total"])

    def test_a_volume_reachable_from_two_roots_is_only_counted_once_in_the_machine_total(self):
        from importlib import import_module
        from unittest.mock import patch

        fe_api = import_module("satellites.native.file_explorer.api")
        fe_paths = import_module("satellites.native.file_explorer.paths")

        # two distinct roots that happen to sit on the very same volume (the
        # realistic case being, e.g., a Windows drive also reachable through
        # a mounted junction) - _machine_storage() must count that volume's
        # capacity exactly once, not twice
        duplicate_roots = [self.directory, self.directory.parent]
        with patch.object(fe_paths, "list_roots", return_value=duplicate_roots):
            status, payload = self.json_request(self.base("entries"))
        self.assertEqual(status, 200)
        machine = payload["machine"]
        self.assertIsNotNone(machine)
        self.assertEqual(machine["volumes"], 1)

        import shutil as shutil_module
        real_usage = shutil_module.disk_usage(self.directory)
        self.assertEqual(machine["total"], real_usage.total)

    def test_missing_disk_usage_is_reported_as_a_null_storage_field_not_a_failure(self):
        from importlib import import_module
        from unittest.mock import patch

        fe_api = import_module("satellites.native.file_explorer.api")
        with patch.object(fe_api.shutil, "disk_usage", side_effect=OSError("no such device")):
            status, payload = self.json_request(self.with_path("entries", self.directory))
            status_roots, payload_roots = self.json_request(self.base("entries"))
        # File Explorer otherwise keeps listing and browsing just fine even
        # when disk-usage reporting itself fails everywhere
        self.assertEqual(status, 200)
        self.assertIsNone(payload["storage"])
        self.assertEqual(status_roots, 200)
        self.assertIsNone(payload_roots["machine"])
        for entry in payload_roots["entries"]:
            self.assertIsNone(entry["storage"])

    def _assert_storage_shape_or_none(self, info, extra_keys=frozenset()):
        if info is None:
            return
        self.assertEqual(set(info.keys()), {"total", "used", "free"} | set(extra_keys))
        for key in ("total", "used", "free"):
            self.assertIsInstance(info[key], int)
            self.assertGreaterEqual(info[key], 0)

    def test_files_and_directories_are_listed_with_metadata(self):
        (self.directory / "notes.txt").write_text("hello", encoding="utf-8")
        (self.directory / "sub").mkdir()

        status, payload = self.json_request(self.with_path("entries", self.directory))
        self.assertEqual(status, 200)
        names = {entry["name"]: entry for entry in payload["entries"]}
        self.assertEqual(names["notes.txt"]["type"], "file")
        self.assertEqual(names["notes.txt"]["size"], 5)
        self.assertIsNotNone(names["notes.txt"]["modified"])
        self.assertEqual(names["sub"]["type"], "dir")
        self.assertIsNone(names["sub"]["size"])

    def test_directories_sort_before_files(self):
        (self.directory / "z_file.txt").write_text("x", encoding="utf-8")
        (self.directory / "a_dir").mkdir()

        status, payload = self.json_request(self.with_path("entries", self.directory))
        self.assertEqual(status, 200)
        self.assertEqual(payload["entries"][0]["name"], "a_dir")

    def test_nested_directories_can_be_browsed_and_report_their_real_parent(self):
        nested = self.directory / "a" / "b"
        nested.mkdir(parents=True)
        (nested / "deep.txt").write_text("x", encoding="utf-8")

        status, payload = self.json_request(self.with_path("entries", nested))
        self.assertEqual(status, 200)
        self.assertEqual(payload["path"], str(nested))
        self.assertEqual(payload["parent"], str(self.directory / "a"))
        self.assertEqual([entry["name"] for entry in payload["entries"]], ["deep.txt"])

    def test_a_directory_with_spaces_and_special_characters_can_be_browsed(self):
        odd = self.directory / "My Files (2024) #1 & Co"
        odd.mkdir()
        (odd / "a file, with commas.txt").write_text("x", encoding="utf-8")

        status, payload = self.json_request(self.with_path("entries", self.directory))
        self.assertEqual(status, 200)
        self.assertIn(odd.name, [entry["name"] for entry in payload["entries"]])

        status, payload = self.json_request(self.with_path("entries", odd))
        self.assertEqual(status, 200)
        self.assertEqual(payload["path"], str(odd))
        self.assertEqual([entry["name"] for entry in payload["entries"]], ["a file, with commas.txt"])

    def test_going_up_from_a_real_filesystem_root_returns_to_the_roots_listing(self):
        for root in self._roots():
            status, payload = self.json_request(self.with_path("entries", root))
            self.assertEqual(status, 200)
            self.assertEqual(payload["parent"], "")

    def test_a_nonexistent_directory_is_404(self):
        status, payload = self.json_request(self.with_path("entries", self.directory / "does-not-exist"))
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_listing_a_file_as_a_directory_is_rejected(self):
        (self.directory / "file.txt").write_text("x", encoding="utf-8")
        status, payload = self.json_request(self.with_path("entries", self.directory / "file.txt"))
        self.assertEqual(status, 400)

    def test_listing_a_location_outside_any_satellite_storage_works(self):
        # the whole point of this milestone: nothing confines File Explorer to
        # its own satellite directory, or to the StarCore checkout at all. The
        # test's own folder is outside both; it doesn't list the system's temp
        # folder itself, which other programs fill (thousands of entries) and
        # which could take longer to list than the request may wait
        (self.directory / "elsewhere").mkdir()
        status, payload = self.json_request(self.with_path("entries", self.directory))
        self.assertEqual(status, 200)
        self.assertIn("elsewhere", [entry["name"] for entry in payload["entries"]])
        self.assertNotIn(str(Path(__file__).resolve().parents[2]), payload["path"])

    # ---------- path safety ----------

    def test_a_relative_path_is_rejected(self):
        status, payload = self.json_request(self.base("entries") + "?path=relative/path")
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_a_bare_dotdot_is_rejected_as_not_absolute(self):
        status, payload = self.json_request(self.base("entries") + "?path=..")
        self.assertEqual(status, 400)

    def test_a_path_with_a_null_byte_is_rejected(self):
        status, payload = self.json_request(self.with_path("entries", str(self.directory) + "\x00etc"))
        self.assertEqual(status, 400)

    def test_dotdot_inside_an_absolute_path_is_resolved_normally(self):
        # there is no boundary left to escape, so '..' is just ordinary
        # filesystem navigation now, not a security bypass to catch
        nested = self.directory / "sub"
        nested.mkdir()
        status, payload = self.json_request(self.with_path("entries", f"{nested}/../"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["path"], str(self.directory))

    @unittest.skipIf(os.name == "nt", "creating symlinks needs elevated privileges on Windows")
    def test_a_symlink_is_followed_to_its_real_target(self):
        target = self.directory / "target"
        target.mkdir()
        (target / "inside.txt").write_text("x", encoding="utf-8")
        link = self.directory / "link"
        os.symlink(target, link, target_is_directory=True)

        status, payload = self.json_request(self.with_path("entries", link))
        self.assertEqual(status, 200)
        self.assertEqual(payload["path"], str(target))

    def test_a_filesystem_root_cannot_be_deleted(self):
        for root in self._roots():
            status, payload = self.json_request(self.base("delete"), method="POST", payload={"path": str(root)})
            self.assertEqual(status, 400)

    def test_a_filesystem_root_cannot_be_renamed(self):
        for root in self._roots():
            status, payload = self.json_request(self.base("rename"), method="POST",
                                                  payload={"path": str(root), "name": "elsewhere"})
            self.assertEqual(status, 400)

    @unittest.skipUnless(_CAN_TEST_PERMISSION_DENIAL, "cannot provoke a real permission error here")
    def test_a_permission_denied_directory_returns_a_clean_error_not_a_crash(self):
        blocked = self.directory / "blocked"
        blocked.mkdir()
        (blocked / "secret.txt").write_text("do not read this", encoding="utf-8")
        os.chmod(blocked, 0o000)
        try:
            status, payload = self.json_request(self.with_path("entries", blocked))
            self.assertEqual(status, 403)
            self.assertIn("error", payload)
        finally:
            os.chmod(blocked, 0o755)

    @unittest.skipUnless(_CAN_TEST_PERMISSION_DENIAL, "cannot provoke a real permission error here")
    def test_uploading_into_a_permission_denied_directory_is_a_clean_error(self):
        blocked = self.directory / "blocked"
        blocked.mkdir()
        os.chmod(blocked, 0o555)  # read + execute, no write
        try:
            status, headers, body = self.request(
                self.with_path("upload", blocked, name="x.txt"), method="POST", raw=b"data")
            self.assertEqual(status, 403)
        finally:
            os.chmod(blocked, 0o755)

    def _roots(self):
        from importlib import import_module
        return import_module("satellites.native.file_explorer.paths").list_roots()

    # ---------- download ----------

    def test_a_file_can_be_downloaded(self):
        (self.directory / "report.txt").write_text("the contents", encoding="utf-8")
        status, headers, body = self.request(self.with_path("content", self.directory / "report.txt"))
        self.assertEqual(status, 200)
        self.assertEqual(body, b"the contents")

    def test_download_with_the_download_flag_sets_content_disposition(self):
        (self.directory / "report.txt").write_text("x", encoding="utf-8")
        status, headers, body = self.request(self.with_path("content", self.directory / "report.txt", download="1"))
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        self.assertIn("report.txt", headers.get("Content-Disposition", ""))

    def test_an_unrecognized_extension_downloads_as_an_attachment_by_default(self):
        (self.directory / "data.bin").write_bytes(b"\x00\x01\x02")
        status, headers, body = self.request(self.with_path("content", self.directory / "data.bin"))
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))

    def test_a_known_type_can_be_viewed_inline(self):
        (self.directory / "notes.txt").write_text("hi", encoding="utf-8")
        status, headers, body = self.request(self.with_path("content", self.directory / "notes.txt"))
        self.assertEqual(status, 200)
        self.assertNotIn("Content-Disposition", headers)
        self.assertIn("text/plain", headers.get("Content-Type", ""))

    def test_downloading_a_nonexistent_file_is_404(self):
        status, payload = self.json_request(self.with_path("content", self.directory / "nope.txt"))
        self.assertEqual(status, 404)

    def test_downloading_a_directory_is_rejected_not_crashed(self):
        status, payload = self.json_request(self.with_path("content", self.directory))
        self.assertEqual(status, 400)

    def test_a_large_file_can_be_downloaded_with_a_range_request(self):
        content = os.urandom(3 * 1024 * 1024)  # large enough to exercise chunked streaming
        (self.directory / "big.bin").write_bytes(content)

        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
        try:
            connection.request("GET", self.with_path("content", self.directory / "big.bin"),
                                headers={"Range": "bytes=1000-1999"})
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, 206)
            self.assertEqual(len(body), 1000)
            self.assertEqual(body, content[1000:2000])
        finally:
            connection.close()

    def test_a_full_large_file_download_matches_byte_for_byte(self):
        content = os.urandom(2 * 1024 * 1024)
        (self.directory / "big.bin").write_bytes(content)
        status, headers, body = self.request(self.with_path("content", self.directory / "big.bin"))
        self.assertEqual(status, 200)
        self.assertEqual(body, content)

    # ---------- upload ----------

    def test_a_file_can_be_uploaded(self):
        status, headers, body = self.request(
            self.with_path("upload", self.directory, name="new.txt"), method="POST", raw=b"uploaded content")
        self.assertEqual(status, 200)
        self.assertEqual((self.directory / "new.txt").read_bytes(), b"uploaded content")

    def test_uploading_into_a_nested_directory(self):
        sub = self.directory / "sub"
        sub.mkdir()
        status, headers, body = self.request(
            self.with_path("upload", sub, name="new.txt"), method="POST", raw=b"data")
        self.assertEqual(status, 200)
        self.assertEqual((sub / "new.txt").read_bytes(), b"data")

    def test_uploading_a_file_with_spaces_in_its_name(self):
        status, headers, body = self.request(
            self.with_path("upload", self.directory, name="my report (final).txt"),
            method="POST", raw=b"data")
        self.assertEqual(status, 200)
        self.assertEqual((self.directory / "my report (final).txt").read_bytes(), b"data")

    def test_uploading_over_an_existing_file_without_overwrite_is_a_conflict(self):
        (self.directory / "existing.txt").write_text("old", encoding="utf-8")
        status, headers, body = self.request(
            self.with_path("upload", self.directory, name="existing.txt"), method="POST", raw=b"new")
        self.assertEqual(status, 409)
        self.assertEqual((self.directory / "existing.txt").read_text(encoding="utf-8"), "old")

    def test_uploading_over_an_existing_file_with_overwrite_replaces_it(self):
        (self.directory / "existing.txt").write_text("old", encoding="utf-8")
        status, headers, body = self.request(
            self.with_path("upload", self.directory, name="existing.txt", overwrite="1"),
            method="POST", raw=b"new")
        self.assertEqual(status, 200)
        self.assertEqual((self.directory / "existing.txt").read_bytes(), b"new")

    def test_uploading_to_a_nonexistent_directory_is_404(self):
        status, headers, body = self.request(
            self.with_path("upload", self.directory / "does-not-exist", name="x.txt"), method="POST", raw=b"data")
        self.assertEqual(status, 404)

    def test_uploading_to_a_relative_path_is_rejected(self):
        status, headers, body = self.request(
            self.base("upload") + "?path=relative&name=x.txt", method="POST", raw=b"data")
        self.assertEqual(status, 400)

    def test_an_empty_upload_is_refused(self):
        status, headers, body = self.request(
            self.with_path("upload", self.directory, name="empty.txt"), method="POST", raw=b"")
        self.assertEqual(status, 400)

    def test_uploading_with_a_traversal_name_is_refused(self):
        status, headers, body = self.request(
            self.with_path("upload", self.directory, name="../escaped.txt"), method="POST", raw=b"data")
        self.assertEqual(status, 400)

    def test_a_partial_upload_never_leaves_a_stray_dot_part_file(self):
        status, headers, body = self.request(
            self.with_path("upload", self.directory, name="new.txt"), method="POST", raw=b"content")
        self.assertEqual(status, 200)
        leftovers = [item.name for item in self.directory.iterdir() if item.name.startswith(".")]
        self.assertEqual(leftovers, [])

    def test_a_large_upload_round_trips_correctly(self):
        content = os.urandom(3 * 1024 * 1024)
        status, headers, body = self.request(
            self.with_path("upload", self.directory, name="big.bin"), method="POST", raw=content)
        self.assertEqual(status, 200)
        self.assertEqual((self.directory / "big.bin").read_bytes(), content)

    def test_a_json_body_on_upload_is_rejected(self):
        status, payload = self.json_request(
            self.with_path("upload", self.directory, name="x.txt"), method="POST", payload={"not": "a file"})
        self.assertEqual(status, 400)

    # ---------- mkdir ----------

    def test_a_directory_can_be_created(self):
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": str(self.directory), "name": "new_dir"})
        self.assertEqual(status, 200)
        self.assertTrue((self.directory / "new_dir").is_dir())

    def test_a_directory_with_spaces_and_special_characters_can_be_created(self):
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": str(self.directory), "name": "New Folder (1) #2"})
        self.assertEqual(status, 200)
        self.assertTrue((self.directory / "New Folder (1) #2").is_dir())

    def test_creating_a_directory_that_already_exists_is_a_conflict(self):
        (self.directory / "existing").mkdir()
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": str(self.directory), "name": "existing"})
        self.assertEqual(status, 409)

    def test_creating_a_directory_with_a_traversal_name_is_refused(self):
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": str(self.directory), "name": "../escape"})
        self.assertEqual(status, 400)

    def test_creating_a_directory_under_a_missing_parent_is_404(self):
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": str(self.directory / "missing"), "name": "new_dir"})
        self.assertEqual(status, 404)

    def test_creating_a_directory_with_a_relative_parent_is_rejected(self):
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": "relative", "name": "new_dir"})
        self.assertEqual(status, 400)

    # ---------- rename ----------

    def test_a_file_can_be_renamed(self):
        (self.directory / "old.txt").write_text("x", encoding="utf-8")
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": str(self.directory / "old.txt"), "name": "new.txt"})
        self.assertEqual(status, 200)
        self.assertFalse((self.directory / "old.txt").exists())
        self.assertTrue((self.directory / "new.txt").exists())

    def test_renaming_over_an_existing_name_is_a_conflict(self):
        (self.directory / "a.txt").write_text("a", encoding="utf-8")
        (self.directory / "b.txt").write_text("b", encoding="utf-8")
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": str(self.directory / "a.txt"), "name": "b.txt"})
        self.assertEqual(status, 409)

    def test_renaming_a_nonexistent_file_is_404(self):
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": str(self.directory / "nope.txt"), "name": "new.txt"})
        self.assertEqual(status, 404)

    def test_renaming_with_a_traversal_name_is_refused(self):
        (self.directory / "a.txt").write_text("a", encoding="utf-8")
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": str(self.directory / "a.txt"), "name": "../escaped.txt"})
        self.assertEqual(status, 400)

    # ---------- delete ----------

    def test_a_file_can_be_deleted(self):
        (self.directory / "gone.txt").write_text("x", encoding="utf-8")
        status, payload = self.json_request(self.base("delete"), method="POST",
                                              payload={"path": str(self.directory / "gone.txt")})
        self.assertEqual(status, 200)
        self.assertFalse((self.directory / "gone.txt").exists())

    def test_a_nonempty_directory_can_be_deleted(self):
        nested = self.directory / "sub"
        nested.mkdir()
        (nested / "inside.txt").write_text("x", encoding="utf-8")
        status, payload = self.json_request(self.base("delete"), method="POST",
                                              payload={"path": str(nested)})
        self.assertEqual(status, 200)
        self.assertFalse(nested.exists())

    def test_deleting_a_nonexistent_path_is_404(self):
        status, payload = self.json_request(self.base("delete"), method="POST",
                                              payload={"path": str(self.directory / "nope.txt")})
        self.assertEqual(status, 404)

    def test_deleting_with_a_relative_path_is_refused(self):
        status, payload = self.json_request(self.base("delete"), method="POST", payload={"path": "relative"})
        self.assertEqual(status, 400)

    # ---------- malformed requests ----------

    def test_malformed_json_is_rejected(self):
        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=5)
        try:
            connection.request("POST", self.base("mkdir"), body=b"{not json",
                                headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            self.assertEqual(response.status, 400)
        finally:
            connection.close()

    def test_wrong_http_method_is_rejected(self):
        status, payload = self.json_request(self.base("mkdir"), method="GET")
        self.assertEqual(status, 405)

    # ---------- configuration ----------

    def test_file_explorer_has_no_configurable_settings(self):
        # there is no longer a boundary (or anything else) to configure - the
        # generic mechanism (docs/satellites.md) is just "a route named
        # 'configuration' exists", and File Explorer no longer names one
        status, payload = self.json_request("/api/satellites/FileExplorer")
        self.assertEqual(status, 200)
        self.assertFalse(payload["configurable"])
        self.assertEqual(payload["type"], "native")


class FileExplorerPathSafetyTest(unittest.TestCase):
    """paths.py on its own, independent of the HTTP layer above."""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-fe-paths-")).resolve()
        from importlib import import_module
        self.paths = import_module("satellites.native.file_explorer.paths")

    def tearDown(self):
        if os.name != "nt":
            os.chmod(self.directory, 0o755)
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_list_roots_matches_the_current_platform(self):
        roots = self.paths.list_roots()
        self.assertTrue(roots)
        if os.name == "nt":
            for root in roots:
                self.assertRegex(str(root), r"^[A-Za-z]:\\$")
                self.assertTrue(root.exists())
        else:
            self.assertEqual(roots, [Path("/")])

    def test_resolve_path_rejects_an_empty_string(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.resolve_path("")

    def test_resolve_path_rejects_a_relative_path(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.resolve_path("relative/path")

    def test_resolve_path_rejects_a_null_byte(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.resolve_path(f"{self.directory}\x00/etc")

    def test_resolve_path_accepts_a_real_absolute_path(self):
        self.assertEqual(self.paths.resolve_path(str(self.directory)), self.directory)

    def test_resolve_path_collapses_dotdot_within_an_absolute_path(self):
        sub = self.directory / "sub"
        sub.mkdir()
        self.assertEqual(self.paths.resolve_path(f"{sub}/../"), self.directory)

    def test_is_filesystem_root_true_for_a_real_root(self):
        for root in self.paths.list_roots():
            self.assertTrue(self.paths.is_filesystem_root(root))

    def test_is_filesystem_root_false_for_an_ordinary_directory(self):
        self.assertFalse(self.paths.is_filesystem_root(self.directory))

    def test_parent_of_a_root_is_the_empty_string(self):
        for root in self.paths.list_roots():
            self.assertEqual(self.paths.parent_of(root), "")

    def test_parent_of_an_ordinary_path_is_its_real_parent(self):
        sub = self.directory / "sub"
        self.assertEqual(self.paths.parent_of(sub), str(self.directory))

    def test_a_name_with_a_separator_is_refused_by_safe_name(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.safe_name("a/b")

    def test_a_name_with_backslash_is_refused_by_safe_name(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.safe_name("a\\b")

    def test_an_empty_name_is_refused_by_safe_name(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.safe_name("   ")

    def test_a_dotdot_name_is_refused_by_safe_name(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.safe_name("..")


if __name__ == "__main__":
    unittest.main()
