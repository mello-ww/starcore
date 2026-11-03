import React, {ReactNode} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {tokens} from '../theme';
import {HEALTH_LABELS, MISSING, healthColor} from './format';
import type {HealthState, StatusWarning} from './types';

const {palette, radii, space, type} = tokens;

/** A Status card: a spaced eyebrow, then its content. */
export function SectionCard({title, children, testID}: {title: string; children: ReactNode; testID?: string}) {
  return (
    <View style={styles.card} testID={testID}>
      <Text style={type.eyebrow}>{title.toUpperCase()}</Text>
      {children}
    </View>
  );
}

/** A usage bar. The fill carries severity - neutral, then warning, then danger - never the
 * accent, which with the default red would make a normal bar look critical. */
export function Meter({value, level, label}: {value: number | null | undefined; level?: HealthState | null; label: string}) {
  const known = typeof value === 'number' && Number.isFinite(value);
  const fill = level === 'critical' ? palette.danger : level === 'warning' ? palette.warn : palette.textIcon;
  return (
    <View
      style={styles.track}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={known ? {min: 0, max: 100, now: Math.round(value)} : {text: 'Unavailable'}}>
      {known && <View style={[styles.fill, {width: `${Math.max(0, Math.min(100, value))}%`, backgroundColor: fill}]} />}
    </View>
  );
}

/** A KPI: label, value, a line of context and optionally a meter. */
export function Tile({label, value, caption, children}: {label: string; value: string; caption?: string; children?: ReactNode}) {
  return (
    <View style={styles.tile} accessible accessibilityLabel={`${label}: ${value}${caption ? `, ${caption}` : ''}`}>
      <Text style={[type.eyebrow, styles.tileLabel]}>{label.toUpperCase()}</Text>
      <Text style={styles.tileValue} numberOfLines={1} adjustsFontSizeToFit>
        {value}
      </Text>
      {caption ? (
        <Text style={type.caption} numberOfLines={2}>
          {caption}
        </Text>
      ) : null}
      {children}
    </View>
  );
}

/** A label and its value on one line. */
export function Row({label, value, note}: {label: string; value: string; note?: string | null}) {
  return (
    <View style={styles.row}>
      <Text style={[type.caption, styles.rowLabel]}>{label}</Text>
      <View style={styles.rowValue}>
        <Text style={[type.label, styles.rowText]}>{value}</Text>
        {note ? <Text style={[type.caption, styles.rowNote]}>{note}</Text> : null}
      </View>
    </View>
  );
}

export function Dot({color, size = 8}: {color: string; size?: number}) {
  return <View style={{width: size, height: size, borderRadius: size / 2, backgroundColor: color}} />;
}

/** Overall health, always as a dot and a word - never colour alone. */
export function HealthPill({state}: {state: HealthState | null | undefined}) {
  const label = state ? HEALTH_LABELS[state] : 'Unknown';
  return (
    <View style={styles.pill} accessible accessibilityLabel={`Health: ${label}`}>
      <Dot color={healthColor(state)} />
      <Text style={type.label}>{label}</Text>
    </View>
  );
}

/** "—" plus why the server has no reading here. */
export function Unsupported({reason}: {reason?: string | null}) {
  return (
    <View style={styles.unsupported}>
      <Text style={type.label}>{MISSING}</Text>
      <Text style={[type.caption, styles.rowNote]}>{reason ? `Not available: ${reason}` : 'Not available on this server'}</Text>
    </View>
  );
}

export function WarningList({warnings}: {warnings: StatusWarning[]}) {
  if (!warnings.length) {
    return <Text style={type.body}>No warnings. Every reading is within its normal range.</Text>;
  }
  return (
    <View style={styles.warnings}>
      {warnings.map(warning => (
        <View key={warning.id} style={styles.warning} accessible accessibilityLabel={`${warning.level}: ${warning.title}. ${warning.detail}`}>
          <View style={styles.warningDot}>
            <Dot color={healthColor(warning.level)} />
          </View>
          <View style={styles.warningText}>
            <Text style={type.label}>{warning.title}</Text>
            {warning.detail ? <Text style={type.caption}>{warning.detail}</Text> : null}
          </View>
          <Text style={[type.caption, {color: healthColor(warning.level)}]}>
            {warning.level === 'critical' ? 'Critical' : 'Warning'}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {padding: space.lg, borderRadius: radii.card, backgroundColor: palette.card, gap: space.md},
  track: {height: 6, borderRadius: 3, backgroundColor: palette.controlStrong, overflow: 'hidden'},
  fill: {height: '100%', borderRadius: 3},
  tile: {
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: 140,
    padding: space.lg,
    borderRadius: radii.card,
    backgroundColor: palette.card,
    gap: space.xs,
  },
  tileLabel: {fontSize: 10, letterSpacing: 1.6},
  tileValue: {...type.title, fontSize: 24, lineHeight: 30},
  row: {flexDirection: 'row', alignItems: 'flex-start', gap: space.md},
  rowLabel: {width: 108, paddingTop: 1},
  rowValue: {flex: 1, gap: 2},
  rowText: {flexShrink: 1},
  rowNote: {color: palette.text3},
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.xs + 2,
    borderRadius: 999,
    backgroundColor: palette.control,
  },
  unsupported: {gap: 2},
  warnings: {gap: space.sm},
  warning: {flexDirection: 'row', alignItems: 'flex-start', gap: space.md},
  warningDot: {paddingTop: 6},
  warningText: {flex: 1, gap: 2},
});
