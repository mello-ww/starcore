"""Authentication: starcore.auth.AuthStore on its own, and the /api/auth/*
endpoints plus the generic session-required gate every other /api/ endpoint
now goes through.
"""

from http.client import HTTPConnection
from pathlib import Path
import json
import tempfile
import time
import unittest

from starcore.auth import AuthError, AuthStore
from tests.support import start_engine, stop_engine


class AuthStoreTest(unittest.TestCase):
    def store(self) -> AuthStore:
        directory = Path(tempfile.mkdtemp(prefix="starcore-auth-tests-"))
        return AuthStore(directory / "auth.json")

    def test_a_fresh_store_is_not_bootstrapped(self):
        self.assertFalse(self.store().is_bootstrapped)

    def test_bootstrap_creates_a_user_and_returns_a_working_session(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")

        self.assertTrue(auth.is_bootstrapped)
        self.assertTrue(auth.validate_session(token))

    def test_bootstrap_twice_is_refused(self):
        auth = self.store()
        auth.bootstrap("admin", "a very good password")

        with self.assertRaises(AuthError):
            auth.bootstrap("someone-else", "another good password")

    def test_bootstrap_rejects_a_short_password(self):
        auth = self.store()
        with self.assertRaises(AuthError):
            auth.bootstrap("admin", "short")

    def test_bootstrap_rejects_an_empty_username(self):
        auth = self.store()
        with self.assertRaises(AuthError):
            auth.bootstrap("  ", "a very good password")

    def test_the_password_is_never_stored_in_plain_text(self):
        directory = Path(tempfile.mkdtemp(prefix="starcore-auth-tests-"))
        path = directory / "auth.json"
        auth = AuthStore(path)
        auth.bootstrap("admin", "a very good password")

        raw = path.read_text(encoding="utf-8")
        self.assertNotIn("a very good password", raw)

    def test_login_with_the_right_password_succeeds(self):
        auth = self.store()
        auth.bootstrap("admin", "a very good password")

        token = auth.login("admin", "a very good password")
        self.assertTrue(auth.validate_session(token))

    def test_login_with_the_wrong_password_fails(self):
        auth = self.store()
        auth.bootstrap("admin", "a very good password")

        with self.assertRaises(AuthError):
            auth.login("admin", "wrong password")

    def test_login_with_an_unknown_username_fails(self):
        auth = self.store()
        auth.bootstrap("admin", "a very good password")

        with self.assertRaises(AuthError):
            auth.login("nobody", "a very good password")

    def test_an_unknown_token_does_not_validate(self):
        auth = self.store()
        self.assertFalse(auth.validate_session("not-a-real-token"))

    def test_an_empty_token_does_not_validate(self):
        auth = self.store()
        self.assertFalse(auth.validate_session(""))

    def test_an_expired_session_no_longer_validates(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")
        auth._data["sessions"][token]["expires"] = time.time() - 1  # simulate the passage of time

        self.assertFalse(auth.validate_session(token))

    def test_logout_invalidates_the_session(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")

        auth.logout(token)
        self.assertFalse(auth.validate_session(token))

    def test_a_new_store_reads_back_credentials_persisted_by_an_earlier_one(self):
        directory = Path(tempfile.mkdtemp(prefix="starcore-auth-tests-"))
        path = directory / "auth.json"
        AuthStore(path).bootstrap("admin", "a very good password")

        reloaded = AuthStore(path)
        self.assertTrue(reloaded.is_bootstrapped)
        self.assertTrue(reloaded.login("admin", "a very good password"))

    def test_token_from_request_prefers_a_bearer_header_over_a_cookie(self):
        token = AuthStore.token_from_request("starcore_session=cookie-token", "Bearer header-token")
        self.assertEqual(token, "header-token")

    def test_token_from_request_falls_back_to_the_cookie(self):
        token = AuthStore.token_from_request("other=1; starcore_session=cookie-token; more=2", "")
        self.assertEqual(token, "cookie-token")

    def test_token_from_request_with_neither_is_empty(self):
        self.assertEqual(AuthStore.token_from_request("", ""), "")

    # ---------- sessions: kind/device_name, listing, revocation ----------
    # (see the module docstring at the top of auth.py - this is the
    # foundation a future StarCore mobile app authenticates through: an
    # ordinary login, labeled "mobile" purely so it can be shown and
    # individually revoked here, never a second auth mechanism)

    def test_a_session_defaults_to_kind_web_with_no_device_name(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")

        sessions = auth.list_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]["kind"], "web")
        self.assertIsNone(sessions[0]["device_name"])

    def test_login_can_label_a_session_as_mobile_with_a_device_name(self):
        auth = self.store()
        auth.bootstrap("admin", "a very good password")

        auth.login("admin", "a very good password", kind="mobile", device_name="Nathan's iPhone")

        sessions = auth.list_sessions()
        mobile = next(session for session in sessions if session["kind"] == "mobile")
        self.assertEqual(mobile["device_name"], "Nathan's iPhone")

    def test_an_unrecognized_kind_falls_back_to_web(self):
        auth = self.store()
        auth.bootstrap("admin", "a very good password")

        auth.login("admin", "a very good password", kind="not-a-real-kind")

        sessions = auth.list_sessions()
        self.assertTrue(all(session["kind"] in ("web", "mobile") for session in sessions))

    def test_session_kind_reports_the_kind_of_a_valid_token(self):
        auth = self.store()
        auth.bootstrap("admin", "a very good password")
        mobile_token = auth.login("admin", "a very good password", kind="mobile")

        self.assertEqual(auth.session_kind(mobile_token), "mobile")

    def test_session_kind_is_empty_for_an_invalid_token(self):
        auth = self.store()
        self.assertEqual(auth.session_kind("not-a-real-token"), "")

    def test_list_sessions_marks_the_given_token_as_current(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")
        other = auth.create_session("admin")

        sessions = {session["session_id"]: session for session in auth.list_sessions(current_token=token)}
        current_flags = [session["current"] for session in sessions.values()]
        self.assertEqual(current_flags.count(True), 1)

    def test_list_sessions_never_includes_the_raw_token(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")

        for session in auth.list_sessions():
            self.assertNotIn(token, session.values())

    def test_list_sessions_excludes_expired_sessions(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")
        auth._data["sessions"][token]["expires"] = time.time() - 1

        self.assertEqual(auth.list_sessions(), [])

    def test_revoke_session_by_id_invalidates_that_token(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")
        session_id = auth.list_sessions()[0]["session_id"]

        revoked = auth.revoke_session(session_id)
        self.assertTrue(revoked)
        self.assertFalse(auth.validate_session(token))

    def test_revoking_one_session_does_not_touch_another(self):
        auth = self.store()
        token = auth.bootstrap("admin", "a very good password")
        other_token = auth.create_session("admin")

        # list_sessions() deliberately never exposes which token a session_id
        # belongs to (see its docstring) - revoke the first one found and
        # confirm exactly one of the two tokens survives, whichever it was
        first_id = auth.list_sessions()[0]["session_id"]
        auth.revoke_session(first_id)

        survivors = [auth.validate_session(token), auth.validate_session(other_token)]
        self.assertEqual(survivors.count(True), 1)

    def test_revoke_unknown_session_id_returns_false(self):
        auth = self.store()
        auth.bootstrap("admin", "a very good password")

        self.assertFalse(auth.revoke_session("not-a-real-session-id"))


class AuthApiTest(unittest.TestCase):
    """Each test starts its own engine - a bootstrapped admin account changes
    every other endpoint's behavior, so state can never carry over."""

    def request(self, engine, path, method="GET", payload=None, cookie=None, bearer=None):
        connection = HTTPConnection("127.0.0.1", engine.api.port, timeout=5)
        headers = {}
        body = None
        if payload is not None:
            body = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = f"starcore_session={cookie}"
        if bearer:
            headers["Authorization"] = f"Bearer {bearer}"

        try:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read().decode("utf-8")
            cookies = response.headers.get_all("Set-Cookie") or []
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {}  # a non-JSON response (e.g. the frontend's HTML)
            return response.status, parsed, cookies
        finally:
            connection.close()

    def token_from_set_cookie(self, cookies) -> str:
        for value in cookies:
            if value.startswith("starcore_session="):
                return value.split(";", 1)[0].split("=", 1)[1]
        return ""

    def test_before_setup_the_api_is_open(self):
        engine = start_engine(mission_control=True)
        try:
            status, payload, _ = self.request(engine, "/api/status")
            self.assertEqual(status, 200)
            self.assertTrue(payload["running"])
        finally:
            stop_engine(engine)

    def test_auth_status_reports_not_bootstrapped_before_setup(self):
        engine = start_engine(mission_control=True)
        try:
            status, payload, _ = self.request(engine, "/api/auth/status")
            self.assertEqual(status, 200)
            self.assertFalse(payload["bootstrapped"])
            self.assertFalse(payload["authenticated"])
        finally:
            stop_engine(engine)

    def test_auth_status_names_only_the_signed_in_caller(self):
        engine = start_engine(mission_control=True)
        try:
            _, _, cookies = self.request(engine, "/api/auth/setup", method="POST",
                                         payload={"username": "Ada", "password": "a very good password"})
            token = self.token_from_set_cookie(cookies)

            _, payload, _ = self.request(engine, "/api/auth/status", bearer=token)
            self.assertTrue(payload["authenticated"])
            self.assertEqual(payload["username"], "Ada")

            _, payload, _ = self.request(engine, "/api/auth/status")
            self.assertFalse(payload["authenticated"])
            self.assertNotIn("username", payload)
        finally:
            stop_engine(engine)

    def test_setup_creates_an_account_and_returns_a_session_cookie(self):
        engine = start_engine(mission_control=True)
        try:
            status, payload, cookies = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "admin", "password": "a very good password"})

            self.assertEqual(status, 200)
            token = self.token_from_set_cookie(cookies)
            self.assertTrue(token)
            self.assertIn("HttpOnly", cookies[0])
            self.assertIn("SameSite=Lax", cookies[0])
        finally:
            stop_engine(engine)

    def test_setup_twice_is_refused(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})
            status, payload, _ = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "someone-else", "password": "another good password"})

            self.assertEqual(status, 409)
            self.assertIn("error", payload)
        finally:
            stop_engine(engine)

    def test_after_setup_the_api_requires_a_session(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, payload, _ = self.request(engine, "/api/status")
            self.assertEqual(status, 401)
            self.assertIn("error", payload)
        finally:
            stop_engine(engine)

    def test_after_setup_the_session_cookie_grants_access(self):
        engine = start_engine(mission_control=True)
        try:
            _, _, cookies = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            token = self.token_from_set_cookie(cookies)

            status, payload, _ = self.request(engine, "/api/status", cookie=token)
            self.assertEqual(status, 200)
            self.assertTrue(payload["running"])
        finally:
            stop_engine(engine)

    def test_a_bearer_token_also_grants_access(self):
        engine = start_engine(mission_control=True)
        try:
            _, _, cookies = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            token = self.token_from_set_cookie(cookies)

            status, payload, _ = self.request(engine, "/api/status", bearer=token)
            self.assertEqual(status, 200)
            self.assertTrue(payload["running"])
        finally:
            stop_engine(engine)

    def test_an_unknown_session_is_rejected(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, payload, _ = self.request(engine, "/api/status", cookie="not-a-real-token")
            self.assertEqual(status, 401)
        finally:
            stop_engine(engine)

    def test_login_with_the_right_credentials_grants_a_session(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, payload, cookies = self.request(
                engine, "/api/auth/login", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            self.assertEqual(status, 200)
            token = self.token_from_set_cookie(cookies)

            status, _, _ = self.request(engine, "/api/status", cookie=token)
            self.assertEqual(status, 200)
        finally:
            stop_engine(engine)

    def test_login_with_the_wrong_password_is_rejected(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, payload, _ = self.request(
                engine, "/api/auth/login", method="POST",
                payload={"username": "admin", "password": "wrong password"})
            self.assertEqual(status, 401)
            self.assertIn("error", payload)
        finally:
            stop_engine(engine)

    def test_logout_invalidates_the_session(self):
        engine = start_engine(mission_control=True)
        try:
            _, _, cookies = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            token = self.token_from_set_cookie(cookies)

            status, _, _ = self.request(engine, "/api/auth/logout", method="POST", cookie=token)
            self.assertEqual(status, 200)

            status, _, _ = self.request(engine, "/api/status", cookie=token)
            self.assertEqual(status, 401)
        finally:
            stop_engine(engine)

    def test_protection_covers_satellite_management_and_shutdown_generically(self):
        # no per-endpoint special-casing - this is the same gate every /api/
        # path goes through, exercised here against a representative sample
        # rather than because these specific paths needed their own logic
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            for path, method in (
                ("/api/satellites", "GET"),
                ("/api/configuration", "GET"),
                ("/api/commands", "GET"),
                ("/api/restart", "POST"),
                ("/api/shutdown", "POST"),
            ):
                status, _, _ = self.request(engine, path, method=method)
                self.assertEqual(status, 401, f"{method} {path} should require authentication")
        finally:
            stop_engine(engine)

    def test_the_auth_endpoints_never_require_a_session_themselves(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            # /api/auth/status and /api/auth/login must stay reachable with no
            # session at all, or a logged-out client could never log back in
            status, _, _ = self.request(engine, "/api/auth/status")
            self.assertEqual(status, 200)

            status, _, _ = self.request(
                engine, "/api/auth/login", method="POST",
                payload={"username": "admin", "password": "wrong"})
            self.assertEqual(status, 401)  # rejected on credentials, not on missing auth
        finally:
            stop_engine(engine)

    def test_login_accepts_an_optional_kind_and_device_name(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, payload, cookies = self.request(
                engine, "/api/auth/login", method="POST",
                payload={"username": "admin", "password": "a very good password",
                         "kind": "mobile", "device_name": "Nathan's iPhone"})
            self.assertEqual(status, 200)
            token = self.token_from_set_cookie(cookies)

            status, payload = self.get_json(engine, "/api/auth/sessions", token)
            self.assertEqual(status, 200)
            mobile = next(session for session in payload["sessions"] if session["kind"] == "mobile")
            self.assertEqual(mobile["device_name"], "Nathan's iPhone")
        finally:
            stop_engine(engine)

    def test_a_mobile_login_also_returns_the_token_in_the_response_body(self):
        # a native HTTP client (Android/iOS) does not expose Set-Cookie to
        # application code the way a browser's fetch() does, so it has no
        # other reliable way to learn the token it was just issued - see
        # docs/api.md, "Authentication", and mobile/src/api/auth.ts
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, payload, cookies = self.request(
                engine, "/api/auth/login", method="POST",
                payload={"username": "admin", "password": "a very good password", "kind": "mobile"})
            self.assertEqual(status, 200)
            self.assertIn("token", payload)

            # the returned token is a real, usable bearer token - not just
            # some opaque or truncated value
            status, _, _ = self.request(engine, "/api/status", bearer=payload["token"])
            self.assertEqual(status, 200)

            # and it's exactly the same token the cookie carries, not a
            # second, independent session
            self.assertEqual(payload["token"], self.token_from_set_cookie(cookies))
        finally:
            stop_engine(engine)

    def test_a_web_login_does_not_return_a_token_in_the_body(self):
        # the browser flow is completely unchanged by the mobile addition
        # above - the token stays only in the HttpOnly cookie, never handed
        # to page script that a stored XSS payload could read
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, payload, _ = self.request(
                engine, "/api/auth/login", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            self.assertEqual(status, 200)
            self.assertNotIn("token", payload)
        finally:
            stop_engine(engine)

    def get_json(self, engine, path, token):
        status, payload, _ = self.request(engine, path, bearer=token)
        return status, payload

    def test_sessions_endpoint_lists_every_active_session(self):
        engine = start_engine(mission_control=True)
        try:
            _, _, cookies = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            token = self.token_from_set_cookie(cookies)
            self.request(engine, "/api/auth/login", method="POST",
                         payload={"username": "admin", "password": "a very good password", "kind": "mobile"})

            status, payload = self.get_json(engine, "/api/auth/sessions", token)
            self.assertEqual(status, 200)
            self.assertEqual(len(payload["sessions"]), 2)
        finally:
            stop_engine(engine)

    def test_sessions_endpoint_marks_the_callers_own_session_current(self):
        engine = start_engine(mission_control=True)
        try:
            _, _, cookies = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            token = self.token_from_set_cookie(cookies)

            status, payload = self.get_json(engine, "/api/auth/sessions", token)
            self.assertEqual(status, 200)
            self.assertEqual(len(payload["sessions"]), 1)
            self.assertTrue(payload["sessions"][0]["current"])
        finally:
            stop_engine(engine)

    def test_sessions_endpoint_requires_a_session_itself(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, _, _ = self.request(engine, "/api/auth/sessions")
            self.assertEqual(status, 401)
        finally:
            stop_engine(engine)

    def test_revoking_a_session_by_id_invalidates_it(self):
        engine = start_engine(mission_control=True)
        try:
            _, _, cookies = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            token = self.token_from_set_cookie(cookies)
            _, _, other_cookies = self.request(
                engine, "/api/auth/login", method="POST",
                payload={"username": "admin", "password": "a very good password", "kind": "mobile"})
            other_token = self.token_from_set_cookie(other_cookies)

            _, payload = self.get_json(engine, "/api/auth/sessions", token)
            mobile_id = next(s["session_id"] for s in payload["sessions"] if s["kind"] == "mobile")

            status, revoke_payload, _ = self.request(
                engine, "/api/auth/sessions/revoke", method="POST",
                payload={"session_id": mobile_id}, cookie=token)
            self.assertEqual(status, 200)

            status, _, _ = self.request(engine, "/api/status", bearer=other_token)
            self.assertEqual(status, 401)
            # the caller's own session is untouched
            status, _, _ = self.request(engine, "/api/status", bearer=token)
            self.assertEqual(status, 200)
        finally:
            stop_engine(engine)

    def test_revoking_an_unknown_session_id_is_a_clean_404(self):
        engine = start_engine(mission_control=True)
        try:
            _, _, cookies = self.request(
                engine, "/api/auth/setup", method="POST",
                payload={"username": "admin", "password": "a very good password"})
            token = self.token_from_set_cookie(cookies)

            status, payload, _ = self.request(
                engine, "/api/auth/sessions/revoke", method="POST",
                payload={"session_id": "not-a-real-id"}, cookie=token)
            self.assertEqual(status, 404)
        finally:
            stop_engine(engine)

    def test_revoke_session_endpoint_requires_a_session_itself(self):
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, _, _ = self.request(
                engine, "/api/auth/sessions/revoke", method="POST", payload={"session_id": "anything"})
            self.assertEqual(status, 401)
        finally:
            stop_engine(engine)

    def test_the_frontend_itself_stays_reachable_without_a_session(self):
        # never relying on frontend route hiding cuts both ways: the login
        # page has to be servable with no session, since that's what lets a
        # browser reach the login screen in the first place
        engine = start_engine(mission_control=True)
        try:
            self.request(engine, "/api/auth/setup", method="POST",
                         payload={"username": "admin", "password": "a very good password"})

            status, _, _ = self.request(engine, "/")
            self.assertEqual(status, 200)
        finally:
            stop_engine(engine)


if __name__ == "__main__":
    unittest.main()
