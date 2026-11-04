import React, {useEffect, useMemo, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {TOUCH_TARGET, tokens, useAccent} from '../../theme';
import type {SatelliteSummary} from '../types';
import {UiApi} from './api';
import {ICONS, resolve, resolveTemplate, type Scope, type UiWidget} from './contract';
import {BlockContext, UiWidgetBlocks} from './UiBlocks';

const {palette, radii, space, type} = tokens;

interface LoadedWidget {
  satellite: SatelliteSummary;
  widget: UiWidget;
}

/**
 * Home's widgets: the `widgets` every Satellite declares in its ui.json
 * (UI contract 1.1), drawn with the shared blocks. Home knows the
 * contract, never a Satellite - any Satellite can put a summary here.
 *
 * A widget without a source binds to the state the Satellite already
 * publishes with GET /api/satellites, the list Home just loaded, so it
 * costs no request of its own; documents come from the per-revision cache.
 */
export function SatelliteWidgets({
  satellites, api, developer, onOpen,
}: {
  satellites: SatelliteSummary[];
  api: UiApi;
  developer: boolean;
  onOpen: (satellite: SatelliteSummary, page?: string, params?: Record<string, any>) => void;
}) {
  const [loaded, setLoaded] = useState<LoadedWidget[]>([]);
  const signature = satellites
    .filter(satellite => satellite.enabled && satellite.ui?.revision)
    .map(satellite => `${satellite.name}:${satellite.ui?.revision}`)
    .join('|');

  useEffect(() => {
    let cancelled = false;
    const candidates = satellites.filter(satellite => satellite.enabled && satellite.ui?.revision);
    Promise.all(
      candidates.map(satellite =>
        api
          .document(satellite.name, satellite.ui?.revision)
          .then(({document}) => (document.widgets ?? []).map(widget => ({satellite, widget})))
          .catch(() => [] as LoadedWidget[]),
      ),
    ).then(found => {
      if (!cancelled) {
        setLoaded(found.flat());
      }
    });
    return () => {
      cancelled = true;
    };
    // the documents change only with their revisions
  }, [api, signature]);

  // the latest published state, without refetching any document
  const byName = useMemo(() => new Map(satellites.map(satellite => [satellite.name, satellite])), [satellites]);
  return (
    <>
      {loaded.map(({satellite, widget}) => {
        const current = byName.get(satellite.name);
        if (!current || !current.enabled) {
          return null;
        }
        return (
          <WidgetCard
            key={`${satellite.name}:${widget.id}`}
            satellite={current}
            widget={widget}
            api={api}
            developer={developer}
            onOpen={onOpen}
          />
        );
      })}
    </>
  );
}

function WidgetCard({
  satellite, widget, api, developer, onOpen,
}: {
  satellite: SatelliteSummary;
  widget: UiWidget;
  api: UiApi;
  developer: boolean;
  onOpen: (satellite: SatelliteSummary, page?: string, params?: Record<string, any>) => void;
}) {
  const {color: accent} = useAccent();
  const [own, setOwn] = useState<any>(null);
  const source = widget.source;

  useEffect(() => {
    if (!source) {
      return;
    }
    let cancelled = false;
    const load = () =>
      api
        .read(satellite.name, resolveTemplate(source.route, {}))
        .then(body => !cancelled && setOwn(body))
        .catch(() => {});
    load();
    const timer = source.refresh ? setInterval(load, Math.max(2, source.refresh) * 1000) : null;
    return () => {
      cancelled = true;
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [api, satellite.name, source]);

  const data = source ? own : satellite.state;
  if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
    return null; // nothing published yet (a disabled Satellite publishes nothing)
  }
  const scope: Scope = {data, page: data, params: {}};
  const title = widget.title !== undefined ? String(resolve(widget.title, scope) ?? '') : satellite.name;
  const context: BlockContext = {
    developer,
    providers: {},
    runAction: async action => {
      if (action?.navigate) {
        onOpen(satellite, action.navigate, resolve(action.params ?? {}, scope));
        return true;
      }
      return false; // a widget only opens pages
    },
    readCapability: () => Promise.reject(new Error('not available in a widget')),
    forms: {},
    setEditing: () => {},
  };
  const open = () => onOpen(satellite, widget.action?.navigate, resolve(widget.action?.params ?? {}, scope));
  return (
    <Pressable
      onPress={open}
      accessibilityRole="button"
      accessibilityLabel={`${title}. Open ${satellite.name}`}
      style={({pressed}) => [styles.card, pressed && styles.pressed]}
      testID={`home-widget-${widget.id}`}>
      <View style={styles.head}>
        {widget.icon && ICONS.has(widget.icon) && <Icon name={widget.icon} size={18} color={accent} />}
        <Text style={[type.eyebrow, styles.title]} numberOfLines={1}>
          {title.toUpperCase()}
        </Text>
        <Icon name="chevron-right" size={20} color={palette.text3} />
      </View>
      <UiWidgetBlocks blocks={widget.blocks} scope={scope} context={context} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    minHeight: TOUCH_TARGET,
    padding: space.lg,
    borderRadius: radii.card,
    backgroundColor: palette.card,
    gap: space.md,
  },
  pressed: {opacity: 0.85},
  head: {flexDirection: 'row', alignItems: 'center', gap: space.sm},
  title: {flex: 1},
});
