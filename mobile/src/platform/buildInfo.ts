import {NativeModules} from 'react-native';

/** This app's own build, as Gradle stamped it (android/app/build.gradle,
 * read through android/.../buildinfo/BuildInfoModule.kt). The version comes
 * from the repository's VERSION file - the same one the Engine reads - and
 * the rest from Git at build time. A value the build couldn't determine is
 * null and shown as "unknown"; nothing here is ever a placeholder hash. */
export interface AppBuildInfo {
  version: string;
  versionCode: number | null;
  channel: string;
  buildNumber: number | null;
  commit: string | null;
  dirty: boolean;
  buildDate: string | null;
  buildType: string;
}

/** The connected Engine's build, from its `/api/status` "build" (see
 * engine/starcore/build_info.py). Older Engines don't report one. */
export interface EngineBuildInfo {
  version: string;
  channel: string;
  build: number | null;
  commit: string | null;
  dirty: boolean | null;
  date: string | null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function count(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function appBuildInfo(): AppBuildInfo {
  const raw = NativeModules.StarCoreBuildInfo ?? {};
  return {
    version: text(raw.version) ?? 'unknown',
    versionCode: count(raw.versionCode),
    channel: text(raw.channel) ?? 'unknown',
    buildNumber: count(raw.buildNumber),
    commit: text(raw.commit),
    dirty: raw.dirty === true,
    buildDate: text(raw.buildDate),
    buildType: text(raw.buildType) ?? 'unknown',
  };
}

/** Accepts `/api/status`'s "build" as-is, or null when it's missing or
 * malformed (an Engine older than 0.1.0-alpha.1). */
export function parseEngineBuild(value: unknown): EngineBuildInfo | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const raw = value as Record<string, unknown>;
  const version = text(raw.version);
  if (!version) {
    return null;
  }
  return {
    version,
    channel: text(raw.channel) ?? 'unknown',
    build: count(raw.build),
    commit: text(raw.commit),
    dirty: typeof raw.dirty === 'boolean' ? raw.dirty : null,
    date: text(raw.date),
  };
}

export function commitLabel(commit: string | null, dirty: boolean | null): string {
  if (!commit) {
    return 'unknown';
  }
  return dirty ? `${commit} + local changes` : commit;
}

/** What "Copy build info" puts on the clipboard for a bug report: versions,
 * builds and commits only - no server address, account, device name or
 * token, so it is safe to paste anywhere. */
export function buildInfoReport(app: AppBuildInfo, engine: EngineBuildInfo | null, engineError?: string): string {
  const lines = [
    'StarCore build info',
    `App: ${app.version} (${app.channel}, ${app.buildType})`,
    `App build: ${app.buildNumber ?? 'unknown'} / versionCode ${app.versionCode ?? 'unknown'}`,
    `App commit: ${commitLabel(app.commit, app.dirty)}`,
    `App build date: ${app.buildDate ?? 'unknown'}`,
  ];
  if (engine) {
    lines.push(
      `Engine: ${engine.version} (${engine.channel})`,
      `Engine build: ${engine.build ?? 'unknown'}`,
      `Engine commit: ${commitLabel(engine.commit, engine.dirty)}`,
      `Engine date: ${engine.date ? engine.date.slice(0, 10) : 'unknown'}`,
    );
  } else {
    lines.push(`Engine: ${engineError ?? 'not reported'}`);
  }
  lines.push('Client: Android');
  return lines.join('\n');
}
