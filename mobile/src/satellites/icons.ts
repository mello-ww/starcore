import type {SatelliteSummary} from './types';
import {tokens} from '../theme';

// Satellites only ship SVG icons, which this app can't draw yet
const SATELLITE_ICONS: Record<string, string> = {
  FileExplorer: 'folder',
  LockedFolder: 'lock',
  Music: 'music',
  Photo: 'camera',
  Status: 'activity',
  docker: 'box',
};

/** A Feather icon name for a satellite, with a neutral fallback. */
export function satelliteIcon(name: string): string {
  return SATELLITE_ICONS[name] ?? 'circle';
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
