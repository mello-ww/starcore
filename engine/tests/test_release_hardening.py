"""v0.1.0-alpha.1 hardening for an Engine behind a reverse proxy: a fresh
install is not claimable (or browsable) from outside without the one-time
setup code, sign-in throttling is per real client rather than shared by
everyone behind the proxy, and the build metadata every client shows.
"""

from http.client import HTTPConnection
from pathlib import Path
import json
import re
import tomllib
import unittest

from starcore import build_info
from starcore.api.server import RequestHandler
from starcore.core import SETUP_CODE_ALPHABET, new_setup_code
from tests.support import start_engine, stop_engine

REPO = Path(__file__).resolve().parents[2]
PASSWORD = "a very good password"
# what nginx adds in deploy/nginx/starcore-panel.conf
PROXY = {"X-Real-IP": "203.0.113.7", "X-Forwarded-For": "203.0.113.7"}


def request(engine, path, method="GET", payload=None, headers=None, bearer=None):
    connection = HTTPConnection("127.0.0.1", engine.api.port, timeout=5)
    sent = dict(headers or {})
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        sent["Content-Type"] = "application/json"
    if bearer:
        sent["Authorization"] = f"Bearer {bearer}"
    try:
        connection.request(method, path, body=body, headers=sent)
        response = connection.getresponse()
        raw = response.read().decode("utf-8")
        return response.status, (json.loads(raw) if raw else {})
    finally:
        connection.close()


class FirstRunBehindProxyTest(unittest.TestCase):
    def setUp(self):
        self.engine = start_engine(mission_control=True)

    def tearDown(self):
        stop_engine(self.engine)

    def test_a_setup_code_is_issued_while_no_administrator_exists(self):
        self.assertRegex(self.engine.setup_code, r"^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$")

    def test_the_api_stays_closed_to_a_proxied_client_before_setup(self):
        for path in ("/api/status", "/api/satellites", "/api/configuration"):
            status, payload = request(self.engine, path, headers=PROXY)
            self.assertEqual(status, 401, path)
            self.assertTrue(payload["setup_required"])
        status, _ = request(self.engine, "/api/commands/execute", method="POST",
                            payload={"command": "status"}, headers=PROXY)
        self.assertEqual(status, 401)

    def test_a_direct_local_client_still_reaches_the_api_before_setup(self):
        status, payload = request(self.engine, "/api/status")
        self.assertEqual(status, 200)
        self.assertTrue(payload["running"])

    def test_auth_status_says_when_the_code_is_needed(self):
        _, payload = request(self.engine, "/api/auth/status", headers=PROXY)
        self.assertTrue(payload["setup_code_required"])
        _, payload = request(self.engine, "/api/auth/status")
        self.assertFalse(payload["setup_code_required"])

    def test_proxied_setup_without_or_with_a_wrong_code_is_refused(self):
        for code in (None, "", "AAAA-AAAA-AAAA"):
            body = {"username": "admin", "password": PASSWORD}
            if code is not None:
                body["setup_code"] = code
            status, payload = request(self.engine, "/api/auth/setup", method="POST",
                                      payload=body, headers=PROXY)
            self.assertEqual(status, 403, code)
            self.assertTrue(payload["setup_code_required"])
        self.assertFalse(self.engine.auth.is_bootstrapped)

    def test_proxied_setup_with_the_code_creates_the_administrator(self):
        # typed loosely - lower case, no dashes - it is still the same code
        code = self.engine.setup_code.replace("-", "").lower()
        status, _ = request(self.engine, "/api/auth/setup", method="POST",
                            payload={"username": "admin", "password": PASSWORD, "setup_code": code},
                            headers=PROXY)
        self.assertEqual(status, 200)
        self.assertTrue(self.engine.auth.is_bootstrapped)
        self.assertIsNone(self.engine.setup_code)
        # and from then on it's simply signed in or not
        status, _ = request(self.engine, "/api/status", headers=PROXY)
        self.assertEqual(status, 401)

    def test_setup_code_guesses_are_throttled(self):
        body = {"username": "admin", "password": PASSWORD, "setup_code": "AAAA-AAAA-AAAA"}
        statuses = [request(self.engine, "/api/auth/setup", method="POST", payload=body, headers=PROXY)[0]
                    for _ in range(6)]
        self.assertEqual(statuses[-1], 429)
        # even the right code waits out the lockout
        body["setup_code"] = self.engine.setup_code
        status, _ = request(self.engine, "/api/auth/setup", method="POST", payload=body, headers=PROXY)
        self.assertEqual(status, 429)

    def test_the_cli_bridge_refuses_anything_a_proxy_forwarded(self):
        status, _ = request(self.engine, "/api/cli/run", method="POST", payload={"argv": ["status"]},
                            headers=PROXY)
        self.assertEqual(status, 403)


class ThrottlePerClientBehindProxyTest(unittest.TestCase):
    def test_one_clients_failed_sign_ins_do_not_lock_out_another(self):
        engine = start_engine(mission_control=True)
        try:
            request(engine, "/api/auth/setup", method="POST", payload={"username": "admin", "password": PASSWORD})
            attacker = {"X-Real-IP": "198.51.100.9", "X-Forwarded-For": "198.51.100.9"}
            wrong = {"username": "admin", "password": "not the password"}
            statuses = [request(engine, "/api/auth/login", method="POST", payload=wrong, headers=attacker)[0]
                        for _ in range(6)]
            self.assertEqual(statuses[-1], 429)

            status, _ = request(engine, "/api/auth/login", method="POST",
                                payload={"username": "admin", "password": PASSWORD}, headers=PROXY)
            self.assertEqual(status, 200)
        finally:
            stop_engine(engine)


class ClientAddressTest(unittest.TestCase):
    def handler(self, peer, headers):
        handler = RequestHandler.__new__(RequestHandler)
        handler.client_address = (peer, 50000)
        handler.headers = headers
        return handler

    def test_forwarding_headers_are_only_believed_from_this_machine(self):
        self.assertEqual(self.handler("127.0.0.1", {"X-Real-IP": "203.0.113.7"})._client_address(), "203.0.113.7")
        self.assertEqual(self.handler("::1", {"X-Forwarded-For": "10.0.0.1, 203.0.113.8"})._client_address(),
                         "203.0.113.8")
        self.assertEqual(self.handler("192.168.1.50", {"X-Real-IP": "203.0.113.7"})._client_address(),
                         "192.168.1.50")
        self.assertEqual(self.handler("127.0.0.1", {})._client_address(), "127.0.0.1")

    def test_direct_local_means_loopback_without_a_proxy(self):
        self.assertTrue(self.handler("127.0.0.1", {})._direct_local())
        self.assertTrue(self.handler("::ffff:127.0.0.1", {})._direct_local())
        self.assertFalse(self.handler("127.0.0.1", {"X-Real-IP": "203.0.113.7"})._direct_local())
        self.assertFalse(self.handler("127.0.0.1", {"Forwarded": "for=203.0.113.7"})._direct_local())
        self.assertFalse(self.handler("192.168.1.50", {})._direct_local())


class SetupCodeTest(unittest.TestCase):
    def test_codes_are_unambiguous_and_differ(self):
        codes = {new_setup_code() for _ in range(50)}
        self.assertEqual(len(codes), 50)
        for code in codes:
            self.assertTrue(set(code.replace("-", "")) <= set(SETUP_CODE_ALPHABET))
            self.assertNotRegex(code, r"[01OIL]")


class BuildInfoTest(unittest.TestCase):
    def test_version_file_is_the_one_source_every_manifest_agrees_with(self):
        version = build_info.read_version()
        package = json.loads((REPO / "mobile" / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["version"], version)
        pyproject = tomllib.loads((REPO / "engine" / "pyproject.toml").read_text(encoding="utf-8"))
        # PEP 440 spelling of the same version: 0.1.0-alpha.1 -> 0.1.0a1
        pep440 = re.sub(r"-alpha\.?", "a", re.sub(r"-beta\.?", "b", re.sub(r"-rc\.?", "rc", version)))
        self.assertEqual(pyproject["project"]["version"], pep440)

    def test_channel_comes_from_the_pre_release_label(self):
        self.assertEqual(build_info.channel_of("0.1.0-alpha.1"), "alpha")
        self.assertEqual(build_info.channel_of("1.0.0-rc.2"), "rc")
        self.assertEqual(build_info.channel_of("1.0.0"), "stable")

    def test_a_malformed_version_file_is_refused(self):
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "VERSION"
            for bad in ("", "v0.1.0", "0.1", "0.1.0-alpha.1 extra"):
                path.write_text(bad, encoding="utf-8")
                with self.assertRaises(ValueError):
                    build_info.read_version(path)

    def test_info_is_real_git_metadata_or_nothing(self):
        info = build_info.info()
        self.assertEqual(info["version"], build_info.read_version())
        if info["commit"] is not None:
            self.assertRegex(info["commit"], r"^[0-9a-f]{7,}$")
            self.assertGreater(info["build"], 0)
            self.assertRegex(info["date"], r"^\d{4}-\d{2}-\d{2}T")
        else:
            self.assertIsNone(info["build"])
            self.assertIsNone(info["date"])

    def test_describe_is_one_readable_line(self):
        line = build_info.describe({"version": "0.1.0-alpha.1", "channel": "alpha", "build": 66,
                                    "commit": "fdfa361", "dirty": False, "date": None})
        self.assertEqual(line, "StarCore 0.1.0-alpha.1 (alpha, build 66, fdfa361)")
        line = build_info.describe({"version": "0.1.0", "channel": "stable", "build": None,
                                    "commit": None, "dirty": None, "date": None})
        self.assertEqual(line, "StarCore 0.1.0 (stable)")

    def test_status_carries_the_build(self):
        engine = start_engine(mission_control=True)
        try:
            status, payload = request(engine, "/api/status")
            self.assertEqual(status, 200)
            self.assertEqual(payload["build"]["version"], build_info.read_version())
        finally:
            stop_engine(engine)


if __name__ == "__main__":
    unittest.main()
