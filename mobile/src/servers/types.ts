/** A single StarCore server this device knows about - just enough to show
 * it in a list and connect to it. Never a secret: the session token for
 * this server lives separately, namespaced by `id` (see src/auth/session.ts
 * and AuthContext's use of it), never inside a ServerProfile itself. */
export interface ServerProfile {
  /** Locally generated, stable for the lifetime of this entry on this
   * device - never sent to any server, only used to namespace this
   * server's own local storage (session token, satellite cache). */
  id: string;
  /** A label the user picks, purely for telling servers apart in the UI -
   * "Home", "Nathan's StarCore", ... StarCore itself has no concept of
   * this and never sees it. */
  name: string;
  /** Same shape src/storage's old single-server value used: trimmed, no
   * trailing slash. */
  baseUrl: string;
}
