"""The File Explorer satellite: browsing, download, upload, mkdir, rename,
delete, and - most importantly - that none of it can ever reach outside the
configured root, however a request tries to get there.
"""

from http.client import HTTPConnection
from pathlib import Path
import json
import os
import shutil
import tempfile
import unittest

from tests.support import start_engine, stop_engine


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
        # the satellite is pointed at a fresh, disposable root for every test,
        # so the real satellite data/ directory (and other tests) are never touched
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-fe-"))
        self.satellite.config.data["root"] = str(self.directory)

    def tearDown(self):
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

    # ---------- browsing ----------

    def test_an_empty_root_lists_no_entries(self):
        status, payload = self.json_request(self.base("entries"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["entries"], [])
        self.assertIsNone(payload["parent"])
        self.assertEqual(payload["path"], "")

    def test_files_and_directories_are_listed_with_metadata(self):
        (self.directory / "notes.txt").write_text("hello", encoding="utf-8")
        (self.directory / "sub").mkdir()

        status, payload = self.json_request(self.base("entries"))
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

        status, payload = self.json_request(self.base("entries"))
        self.assertEqual(status, 200)
        self.assertEqual(payload["entries"][0]["name"], "a_dir")

    def test_nested_directories_can_be_browsed(self):
        nested = self.directory / "a" / "b"
        nested.mkdir(parents=True)
        (nested / "deep.txt").write_text("x", encoding="utf-8")

        status, payload = self.json_request(self.base("entries") + "?path=a/b")
        self.assertEqual(status, 200)
        self.assertEqual(payload["path"], "a/b")
        self.assertEqual(payload["parent"], "a")
        self.assertEqual([entry["name"] for entry in payload["entries"]], ["deep.txt"])

    def test_a_nonexistent_directory_is_404(self):
        status, payload = self.json_request(self.base("entries") + "?path=does/not/exist")
        self.assertEqual(status, 404)
        self.assertIn("error", payload)

    def test_listing_a_file_as_a_directory_is_rejected(self):
        (self.directory / "file.txt").write_text("x", encoding="utf-8")
        status, payload = self.json_request(self.base("entries") + "?path=file.txt")
        self.assertEqual(status, 400)

    # ---------- path safety ----------

    def test_a_literal_dotdot_is_refused(self):
        status, payload = self.json_request(self.base("entries") + "?path=../")
        self.assertEqual(status, 400)
        self.assertIn("error", payload)

    def test_a_dotdot_buried_in_a_deeper_path_is_refused(self):
        status, payload = self.json_request(self.base("entries") + "?path=a/../../etc")
        self.assertEqual(status, 400)

    def test_a_url_encoded_dotdot_is_refused(self):
        # the server decodes %2e%2e before this satellite ever sees the
        # segment, so it is caught by exactly the same check as a literal ..
        status, payload = self.json_request(self.base("entries") + "?path=%2e%2e%2fetc")
        self.assertEqual(status, 400)

    def test_an_absolute_looking_path_stays_confined_to_root(self):
        (self.directory / "etc").mkdir()
        (self.directory / "etc" / "passwd").write_text("safe", encoding="utf-8")

        # a leading slash in the query value is just another path component
        # once decoded - not a jump to the real filesystem root
        status, payload = self.json_request(self.base("entries") + "?path=/etc")
        self.assertEqual(status, 200)
        self.assertEqual(payload["path"], "etc")

    def test_a_symlink_escaping_the_root_is_refused(self):
        outside = Path(tempfile.mkdtemp(prefix="starcore-fe-outside-"))
        (outside / "secret.txt").write_text("do not read this", encoding="utf-8")
        try:
            link = self.directory / "escape"
            try:
                os.symlink(outside, link, target_is_directory=True)
            except OSError as error:
                # Creating a symlink needs a privilege this process may not
                # have - notably on Windows, where it requires either
                # SeCreateSymbolicLinkPrivilege or Developer Mode. That is an
                # environmental limitation, not something the security check
                # itself can be blamed for, so skip rather than weaken the
                # assertion below. Any other OSError is a real failure and is
                # left to fail the test.
                if os.name == "nt" and getattr(error, "winerror", None) == 1314:
                    raise unittest.SkipTest(
                        "creating symlinks requires elevated privileges or "
                        "Developer Mode on this Windows host"
                    )
                raise
            except NotImplementedError:
                raise unittest.SkipTest("this platform does not support symlinks")

            status, payload = self.json_request(self.base("entries") + "?path=escape")
            self.assertEqual(status, 400)
            self.assertIn("error", payload)
        finally:
            shutil.rmtree(outside, ignore_errors=True)

    def test_the_configured_root_itself_cannot_be_deleted(self):
        status, payload = self.json_request(self.base("delete"), method="POST", payload={"path": ""})
        self.assertEqual(status, 400)

    def test_the_configured_root_itself_cannot_be_renamed(self):
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": "", "name": "elsewhere"})
        self.assertEqual(status, 400)

    # ---------- download ----------

    def test_a_file_can_be_downloaded(self):
        (self.directory / "report.txt").write_text("the contents", encoding="utf-8")
        status, headers, body = self.request(self.base("content") + "?path=report.txt")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"the contents")

    def test_download_with_the_download_flag_sets_content_disposition(self):
        (self.directory / "report.txt").write_text("x", encoding="utf-8")
        status, headers, body = self.request(self.base("content") + "?path=report.txt&download=1")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))
        self.assertIn("report.txt", headers.get("Content-Disposition", ""))

    def test_an_unrecognized_extension_downloads_as_an_attachment_by_default(self):
        (self.directory / "data.bin").write_bytes(b"\x00\x01\x02")
        status, headers, body = self.request(self.base("content") + "?path=data.bin")
        self.assertEqual(status, 200)
        self.assertIn("attachment", headers.get("Content-Disposition", ""))

    def test_a_known_type_can_be_viewed_inline(self):
        (self.directory / "notes.txt").write_text("hi", encoding="utf-8")
        status, headers, body = self.request(self.base("content") + "?path=notes.txt")
        self.assertEqual(status, 200)
        self.assertNotIn("Content-Disposition", headers)
        self.assertIn("text/plain", headers.get("Content-Type", ""))

    def test_downloading_a_nonexistent_file_is_404(self):
        status, payload = self.json_request(self.base("content") + "?path=nope.txt")
        self.assertEqual(status, 404)

    def test_a_large_file_can_be_downloaded_with_a_range_request(self):
        content = os.urandom(3 * 1024 * 1024)  # large enough to exercise chunked streaming
        (self.directory / "big.bin").write_bytes(content)

        connection = HTTPConnection("127.0.0.1", self.engine.api.port, timeout=10)
        try:
            connection.request("GET", self.base("content") + "?path=big.bin",
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
        status, headers, body = self.request(self.base("content") + "?path=big.bin")
        self.assertEqual(status, 200)
        self.assertEqual(body, content)

    # ---------- upload ----------

    def test_a_file_can_be_uploaded(self):
        status, headers, body = self.request(
            self.base("upload") + "?path=&name=new.txt", method="POST", raw=b"uploaded content")
        self.assertEqual(status, 200)
        self.assertEqual((self.directory / "new.txt").read_bytes(), b"uploaded content")

    def test_uploading_into_a_nested_directory(self):
        (self.directory / "sub").mkdir()
        status, headers, body = self.request(
            self.base("upload") + "?path=sub&name=new.txt", method="POST", raw=b"data")
        self.assertEqual(status, 200)
        self.assertEqual((self.directory / "sub" / "new.txt").read_bytes(), b"data")

    def test_uploading_over_an_existing_file_without_overwrite_is_a_conflict(self):
        (self.directory / "existing.txt").write_text("old", encoding="utf-8")
        status, headers, body = self.request(
            self.base("upload") + "?path=&name=existing.txt", method="POST", raw=b"new")
        self.assertEqual(status, 409)
        self.assertEqual((self.directory / "existing.txt").read_text(encoding="utf-8"), "old")

    def test_uploading_over_an_existing_file_with_overwrite_replaces_it(self):
        (self.directory / "existing.txt").write_text("old", encoding="utf-8")
        status, headers, body = self.request(
            self.base("upload") + "?path=&name=existing.txt&overwrite=1", method="POST", raw=b"new")
        self.assertEqual(status, 200)
        self.assertEqual((self.directory / "existing.txt").read_bytes(), b"new")

    def test_uploading_to_a_nonexistent_directory_is_404(self):
        status, headers, body = self.request(
            self.base("upload") + "?path=does-not-exist&name=x.txt", method="POST", raw=b"data")
        self.assertEqual(status, 404)

    def test_an_empty_upload_is_refused(self):
        status, headers, body = self.request(
            self.base("upload") + "?path=&name=empty.txt", method="POST", raw=b"")
        self.assertEqual(status, 400)

    def test_uploading_with_a_traversal_name_is_refused(self):
        status, headers, body = self.request(
            self.base("upload") + "?path=&name=..%2f..%2fescaped.txt", method="POST", raw=b"data")
        self.assertEqual(status, 400)

    def test_a_partial_upload_never_leaves_a_stray_dot_part_file(self):
        status, headers, body = self.request(
            self.base("upload") + "?path=&name=new.txt", method="POST", raw=b"content")
        self.assertEqual(status, 200)
        leftovers = [item.name for item in self.directory.iterdir() if item.name.startswith(".")]
        self.assertEqual(leftovers, [])

    def test_a_large_upload_round_trips_correctly(self):
        content = os.urandom(3 * 1024 * 1024)
        status, headers, body = self.request(
            self.base("upload") + "?path=&name=big.bin", method="POST", raw=content)
        self.assertEqual(status, 200)
        self.assertEqual((self.directory / "big.bin").read_bytes(), content)

    def test_a_json_body_on_upload_is_rejected(self):
        status, payload = self.json_request(
            self.base("upload") + "?path=&name=x.txt", method="POST", payload={"not": "a file"})
        self.assertEqual(status, 400)

    # ---------- mkdir ----------

    def test_a_directory_can_be_created(self):
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": "", "name": "new_dir"})
        self.assertEqual(status, 200)
        self.assertTrue((self.directory / "new_dir").is_dir())

    def test_creating_a_directory_that_already_exists_is_a_conflict(self):
        (self.directory / "existing").mkdir()
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": "", "name": "existing"})
        self.assertEqual(status, 409)

    def test_creating_a_directory_with_a_traversal_name_is_refused(self):
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": "", "name": "../escape"})
        self.assertEqual(status, 400)

    def test_creating_a_directory_under_a_missing_parent_is_404(self):
        status, payload = self.json_request(self.base("mkdir"), method="POST",
                                              payload={"path": "missing", "name": "new_dir"})
        self.assertEqual(status, 404)

    # ---------- rename ----------

    def test_a_file_can_be_renamed(self):
        (self.directory / "old.txt").write_text("x", encoding="utf-8")
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": "old.txt", "name": "new.txt"})
        self.assertEqual(status, 200)
        self.assertFalse((self.directory / "old.txt").exists())
        self.assertTrue((self.directory / "new.txt").exists())

    def test_renaming_over_an_existing_name_is_a_conflict(self):
        (self.directory / "a.txt").write_text("a", encoding="utf-8")
        (self.directory / "b.txt").write_text("b", encoding="utf-8")
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": "a.txt", "name": "b.txt"})
        self.assertEqual(status, 409)

    def test_renaming_a_nonexistent_file_is_404(self):
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": "nope.txt", "name": "new.txt"})
        self.assertEqual(status, 404)

    def test_renaming_with_a_traversal_name_is_refused(self):
        (self.directory / "a.txt").write_text("a", encoding="utf-8")
        status, payload = self.json_request(self.base("rename"), method="POST",
                                              payload={"path": "a.txt", "name": "../escaped.txt"})
        self.assertEqual(status, 400)

    # ---------- delete ----------

    def test_a_file_can_be_deleted(self):
        (self.directory / "gone.txt").write_text("x", encoding="utf-8")
        status, payload = self.json_request(self.base("delete"), method="POST", payload={"path": "gone.txt"})
        self.assertEqual(status, 200)
        self.assertFalse((self.directory / "gone.txt").exists())

    def test_a_nonempty_directory_can_be_deleted(self):
        nested = self.directory / "sub"
        nested.mkdir()
        (nested / "inside.txt").write_text("x", encoding="utf-8")
        status, payload = self.json_request(self.base("delete"), method="POST", payload={"path": "sub"})
        self.assertEqual(status, 200)
        self.assertFalse(nested.exists())

    def test_deleting_a_nonexistent_path_is_404(self):
        status, payload = self.json_request(self.base("delete"), method="POST", payload={"path": "nope.txt"})
        self.assertEqual(status, 404)

    def test_deleting_with_a_traversal_path_is_refused(self):
        status, payload = self.json_request(self.base("delete"), method="POST", payload={"path": "../escape"})
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

    def test_configuration_reports_the_current_root(self):
        status, payload = self.json_request(self.base("configuration"))
        self.assertEqual(status, 200)
        root_setting = next(setting for setting in payload["settings"] if setting["key"] == "root")
        self.assertEqual(root_setting["live_value"], str(self.directory))

    def test_configuration_never_appears_in_generic_satellite_listing_specially(self):
        # the generic mechanism (docs/satellites.md) is just "a route named
        # 'configuration' exists" - nothing FileExplorer-specific in the Core
        status, payload = self.json_request("/api/satellites/FileExplorer")
        self.assertEqual(status, 200)
        self.assertTrue(payload["configurable"])
        self.assertEqual(payload["type"], "native")


class FileExplorerSecurityBoundaryTest(unittest.TestCase):
    """paths.resolve() on its own, independent of the HTTP layer above."""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp(prefix="starcore-fe-paths-"))
        from importlib import import_module
        self.paths = import_module("satellites.native.file_explorer.paths")

    def tearDown(self):
        shutil.rmtree(self.directory, ignore_errors=True)

    def test_resolving_the_empty_path_returns_the_root(self):
        self.assertEqual(self.paths.resolve(self.directory, ""), self.directory)

    def test_resolving_a_plain_relative_path_stays_inside_root(self):
        (self.directory / "sub").mkdir()
        resolved = self.paths.resolve(self.directory, "sub")
        self.assertEqual(resolved, self.directory / "sub")

    def test_a_single_dotdot_is_refused(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.resolve(self.directory, "..")

    def test_a_dotdot_after_a_real_subdirectory_is_refused(self):
        (self.directory / "sub").mkdir()
        with self.assertRaises(self.paths.PathError):
            self.paths.resolve(self.directory, "sub/../../")

    def test_a_name_with_a_separator_is_refused_by_safe_name(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.safe_name("a/b")

    def test_a_name_with_backslash_is_refused_by_safe_name(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.safe_name("a\\b")

    def test_an_empty_name_is_refused_by_safe_name(self):
        with self.assertRaises(self.paths.PathError):
            self.paths.safe_name("   ")


if __name__ == "__main__":
    unittest.main()
