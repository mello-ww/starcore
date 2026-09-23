/**
 * Build-time constants only - never a real server address, credential or
 * token. The StarCore server this app talks to is *this installation's*
 * own address (e.g. `https://192.168.1.20:8090`, or a DuckDNS name the
 * owner set up) - something only the person running the app knows, never
 * something to hardcode or commit. It's entered once on the "Connect to
 * StarCore" screen and persisted locally via `src/platform/secureStorage`
 * (see docs in that file for why the URL itself, unlike the session token,
 * doesn't need to be *secret*, just remembered) - see src/auth/session.ts.
 */
export const APP_NAME = 'StarCore';

/** How this client identifies itself in StarCore's "Active sessions" list
 * (`AuthStore.create_session`'s `kind`/`device_name` - see
 * docs/api.md, "Authentication"). Every mobile login uses this `kind`;
 * `device_name` is filled in at runtime from `platform/device.ts`. */
export const SESSION_KIND = 'mobile' as const;

/** Timeout for a single StarCore API call. Generous - some of these (a
 * large File Explorer listing, a Photo Library scan trigger) can
 * legitimately take a while on a modest home server. */
export const REQUEST_TIMEOUT_MS = 20_000;
