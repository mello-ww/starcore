# Platform abstractions

Everything in this directory is a seam between StarCore's own logic and
something only the operating system can do: secure credential storage and
biometric authentication today; device info, notifications and
filesystem access as later blocks need them (see the root `mobile/README.md`,
"Roadmap").

Each capability is one interface in `types.ts`, plus one `*.android.ts`
implementation. Metro (React Native's bundler) resolves a plain import like
`from './secureStorage'` to `./secureStorage.android.ts` automatically when
building for Android, so nothing that *uses* `secureStorage` or `biometrics`
ever imports the platform-specific file directly or branches on
`Platform.OS` itself.

Adding iOS later means writing `secureStorage.ios.ts` and `biometrics.ios.ts`
against these same two interfaces (react-native-keychain and
react-native-biometrics already support iOS, so this is mostly wiring, not
new logic) - no change to `src/auth/session.ts`, any screen, or any test in
`__tests__/`, all of which depend only on the interfaces in `types.ts`.
