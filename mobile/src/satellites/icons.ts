import type {SatelliteSummary} from './types';
import {tokens} from '../theme';

import {ICONS} from './ui/contract';

/** A Feather icon name for a satellite: the shared icon it declares in its
 * satellite.toml (icon_name), else a neutral circle. A Satellite's own SVG
 * icon is something this app can't draw yet (docs/remaining-work.md). */
export function satelliteIcon(_name: string, iconName?: string | null): string {
  return iconName && ICONS.has(iconName) ? iconName : 'circle';
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
