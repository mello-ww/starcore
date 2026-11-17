import type {SatelliteSummary} from './types';
import {tokens} from '../theme';

import {ICONS} from './ui/contract';

/** The icon name for a satellite, for a `Glyph` given its `icons`: its own icon (UI contract
 * 1.2, from its icons/ folder), else the shared icon it declares in its satellite.toml
 * (icon_name), else a neutral circle. */
export function satelliteIcon(satellite: Pick<SatelliteSummary, 'icon' | 'icon_name' | 'icons'>): string {
  const own = satellite.icon;
  if (own && satellite.icons && Object.prototype.hasOwnProperty.call(satellite.icons, own)) {
    return own;
  }
  return satellite.icon_name && ICONS.has(satellite.icon_name) ? satellite.icon_name : 'circle';
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
