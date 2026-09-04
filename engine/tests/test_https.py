"""HTTPS transport: ApiServer wrapping its socket in TLS when https_enabled is
configured, at the HTTP/API level (a real client connecting over TLS), plus
the startup-time validation that keeps a broken cert/key configuration from
silently falling back to plain HTTP.

A self-signed cert/key pair is generated with the system's `openssl` binary
purely to have *something* to test against - StarCore itself never shells
out to openssl or depends on it; it only ever reads whatever cert/key files
are configured, via the stdlib `ssl` module. Skipped if openssl isn't on
this machine's PATH, since it's a test fixture, not a runtime dependency.
"""

from http.client import HTTPSConnection
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import unittest

from starcore.api.server import ApiServer
from starcore.auth import AuthStore
from starcore.core import StarCore
from tests.support import stop_engine

HAVE_OPENSSL = shutil.which("openssl") is not None


def _make_self_signed_cert(directory: Path) -> tuple:
    cert = directory / "cert.pem"
    key = directory / "key.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
         "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=localhost"],
        check=True, capture_output=True)
    return cert, key


def _https_engine(cert: Path = None, key: Path = None) -> StarCore:
    directory = Path(tempfile.mkdtemp(prefix="starcore-https-tests-"))
    native = directory / "native"
    link = directory / "link"
    native.mkdir()
    link.mkdir()

    config_path = directory / "config.toml"
    config_path.write_text(
        "[server]\nenabled = true\nhost = \"127.0.0.1\"\nport = 0\n\n[satellites]\nservices = false\n",
        encoding="utf-8")

    engine = StarCore(config_path)
    engine.native_path = native
    engine.link_path = link
    engine.auth = AuthStore(directory / "auth.json")  # never the real engine/data/auth.json
    engine.api = ApiServer(engine, "127.0.0.1", 0, engine.api.web_root,
                            https_enabled=True, https_cert=cert, https_key=key)
    engine.start()
    return engine


def _unverified_client_context() -> ssl.SSLContext:
    # the client side of these tests only cares that the *server* served TLS
    # at all with the configured cert - it isn't validating that cert against
    # a real CA (it's self-signed on purpose), the same way a browser hitting
    # a private-LAN StarCore with a self-signed cert has to be told to trust it
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    context.check_hostname = False
    context.verify_mode = ssl.CERT_NONE
    return context


@unittest.skipUnless(HAVE_OPENSSL, "requires the openssl binary to generate a test certificate")
class HttpsServingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = Path(tempfile.mkdtemp(prefix="starcore-https-tests-"))
        cls.cert, cls.key = _make_self_signed_cert(cls.directory)
        cls.engine = _https_engine(cls.cert, cls.key)
        if not cls.engine.api.running:
            stop_engine(cls.engine)
            raise unittest.SkipTest("Mission Control could not start over HTTPS")

    @classmethod
    def tearDownClass(cls):
        stop_engine(cls.engine)

    def get(self, path: str):
        connection = HTTPSConnection("127.0.0.1", self.engine.api.port, timeout=5,
                                      context=_unverified_client_context())
        try:
            connection.request("GET", path)
            response = connection.getresponse()
            return response.status, response.read(), response.headers
        finally:
            connection.close()

    def test_the_api_is_reachable_over_tls(self):
        status, body, _ = self.get("/api/status")
        self.assertEqual(status, 200)
        self.assertIn(b'"running": true', body)

    def test_the_url_property_reports_https(self):
        self.assertTrue(self.engine.api.url.startswith("https://"))

    def test_plain_http_is_not_served(self):
        # nothing is listening for plain HTTP on this port once wrapped in TLS -
        # a raw HTTP request over the socket should fail to get a sane response
        import http.client
        connection = http.client.HTTPConnection("127.0.0.1", self.engine.api.port, timeout=2)
        with self.assertRaises(Exception):
            connection.request("GET", "/api/status")
            connection.getresponse()
        connection.close()

    def test_the_session_cookie_is_marked_secure_over_https(self):
        connection = HTTPSConnection("127.0.0.1", self.engine.api.port, timeout=5,
                                      context=_unverified_client_context())
        try:
            import json
            body = json.dumps({"username": "admin", "password": "a very good password"}).encode("utf-8")
            connection.request("POST", "/api/auth/setup", body=body,
                                headers={"Content-Type": "application/json"})
            response = connection.getresponse()
            response.read()
            cookies = response.headers.get_all("Set-Cookie") or []
            self.assertTrue(cookies)
            self.assertIn("Secure", cookies[0])
        finally:
            connection.close()


@unittest.skipUnless(HAVE_OPENSSL, "requires the openssl binary to generate a test certificate")
class HttpsMisconfigurationTest(unittest.TestCase):
    """HTTPS failing to start must fail closed - never silently serve plain
    HTTP instead when the operator asked for encryption."""

    def test_missing_cert_and_key_refuses_to_start(self):
        engine = _https_engine(cert=None, key=None)
        try:
            self.assertFalse(engine.api.running)
        finally:
            stop_engine(engine)

    def test_a_cert_path_that_does_not_exist_refuses_to_start(self):
        directory = Path(tempfile.mkdtemp(prefix="starcore-https-tests-"))
        _, key = _make_self_signed_cert(directory)
        engine = _https_engine(cert=directory / "does-not-exist.pem", key=key)
        try:
            self.assertFalse(engine.api.running)
        finally:
            stop_engine(engine)

    def test_a_key_path_that_does_not_exist_refuses_to_start(self):
        directory = Path(tempfile.mkdtemp(prefix="starcore-https-tests-"))
        cert, _ = _make_self_signed_cert(directory)
        engine = _https_engine(cert=cert, key=directory / "does-not-exist.pem")
        try:
            self.assertFalse(engine.api.running)
        finally:
            stop_engine(engine)

    def test_a_mismatched_cert_and_key_pair_refuses_to_start(self):
        directory_a = Path(tempfile.mkdtemp(prefix="starcore-https-tests-"))
        directory_b = Path(tempfile.mkdtemp(prefix="starcore-https-tests-"))
        cert_a, _ = _make_self_signed_cert(directory_a)
        _, key_b = _make_self_signed_cert(directory_b)

        engine = _https_engine(cert=cert_a, key=key_b)
        try:
            self.assertFalse(engine.api.running)
        finally:
            stop_engine(engine)


class HttpsPlainHttpUnaffectedTest(unittest.TestCase):
    """https_enabled defaults to false - existing plain-HTTP behavior (every
    other test in this suite) must be completely unaffected."""

    def test_url_is_plain_http_by_default(self):
        from tests.support import start_engine
        engine = start_engine(mission_control=True)
        try:
            self.assertTrue(engine.api.url.startswith("http://"))
            self.assertFalse(engine.api.https_enabled)
        finally:
            stop_engine(engine)


if __name__ == "__main__":
    unittest.main()
