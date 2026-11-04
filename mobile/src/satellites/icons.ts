import type {SatelliteSummary} from './types';
import {tokens} from '../theme';

import {ICONS} from './ui/contract';

// The names below are only for servers older than UI contract 1.0, whose
// Satellites can't declare an icon_name yet - a Satellite's own SVG icon is
// something this app can't draw. Never add to this list: a new Satellite
// sets icon_name in its satellite.toml instead.
const LEGACY_SATELLITE_ICONS: Record<string, string> = {
  FileExplorer: 'folder',
  LockedFolder: 'lock',
  Music: 'music',
  Photo: 'camera',
  Status: 'activity',
  docker: 'box',
};

/** A Feather icon name for a satellite: the shared icon it declares
 * (icon_name), else the legacy fallback for an older server, else a
 * neutral circle. */
export function satelliteIcon(name: string, iconName?: string | null): string {
  if (iconName && ICONS.has(iconName)) {
    return iconName;
  }
  return LEGACY_SATELLITE_ICONS[name] ?? 'circle';
}

export const STATUS_LABELS: Record<SatelliteSummary['status'], string> = {
  running: 'Running',
  stopped: 'Stopped',
  disabled: 'Disabled',
  error: 'Error',
};

export function statusDotColor(status: SatelliteSummary['status'] | 'offline'): string {
  if (status === 'running') {
    return tokens.palette.textIcon;
  }
  if (status === 'stopped') {
    return tokens.palette.warn;
  }
  if (status === 'error' || status === 'offline') {
    return tokens.palette.danger;
  }
  return tokens.palette.text3;
}
