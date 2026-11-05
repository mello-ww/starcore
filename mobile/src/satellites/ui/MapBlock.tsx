import React, {useCallback, useMemo, useState} from 'react';
import {Image, StyleSheet, Text, useWindowDimensions, View} from 'react-native';
import MapView, {Marker, type Region} from 'react-native-maps';
import Icon from 'react-native-vector-icons/Feather';
import {tokens, useAccent} from '../../theme';
import {isSafeRoute, resolve, resolveTemplate, type Scope, type UiBlock} from './contract';
import {mediaKind, MediaViewer} from './MediaGrid';
import type {BlockContext} from './UiBlocks';

const {palette, space, type, radii} = tokens;

/**
 * The map block (UI contract 1.2): items with a latitude and longitude on an interactive map,
 * grouped into clusters that separate as it zooms - the same screen-space grid Mission
 * Control's map uses. A marker opens the shared viewer on its items, or runs the block's action. It
 * draws with react-native-maps, the map the app already uses for Photo's own Map tab: no new
 * service or key. It never asks for the device's location.
 */

export interface MapPoint {
  lat: number;
  lon: number;
  item: any;
  key: string;
  scope: Scope;
}

/** A valid coordinate pair, or null. */
export function coordinates(lat: unknown, lon: unknown): [number, number] | null {
  if (lat === null || lon === null || lat === undefined || lon === undefined || lat === '' || lon === '') {
    return null;
  }
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }
  return [latitude, longitude];
}

/** The zoom level a region shows, as web maps count it (0 = the whole world). */
export function zoomFor(longitudeDelta: number): number {
  return Math.log2(360 / Math.max(longitudeDelta, 1e-6));
}

/** A cluster covers about this many pixels of the map, whatever the zoom (as on the web). */
export const CLUSTER_PIXELS = 64;

/** Points in the same cell of a grid about CLUSTER_PIXELS wide on screen share a cluster, so
 * the number of markers stays bounded however many points there are. */
export function clusterPoints<T extends {lat: number; lon: number}>(points: T[], zoom: number) {
  const cell = (360 / 2 ** Math.max(0, zoom)) * (CLUSTER_PIXELS / 256);
  const buckets = new Map<string, T[]>();
  for (const point of points) {
    const key = `${Math.floor(point.lat / cell)}:${Math.floor(point.lon / cell)}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(point);
    } else {
      buckets.set(key, [point]);
    }
  }
  const average = (values: number[]) => values.reduce((total, value) => total + value, 0) / values.length;
  return [...buckets.values()].map(group => ({
    lat: average(group.map(point => point.lat)),
    lon: average(group.map(point => point.lon)),
    points: group,
  }));
}

/** A region that shows every point, with a margin. */
export function regionFor(points: {lat: number; lon: number}[]): Region {
  const lats = points.map(point => point.lat);
  const lons = points.map(point => point.lon);
  const [minLat, maxLat, minLon, maxLon] = [Math.min(...lats), Math.max(...lats), Math.min(...lons), Math.max(...lons)];
  return {
    latitude: (minLat + maxLat) / 2,
    longitude: (minLon + maxLon) / 2,
    latitudeDelta: Math.min(180, Math.max(0.05, (maxLat - minLat) * 1.4)),
    longitudeDelta: Math.min(360, Math.max(0.05, (maxLon - minLon) * 1.4)),
  };
}

const present = (value: unknown) => value !== null && value !== undefined && value !== '';

export function MapBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const {height} = useWindowDimensions();
  const {color: accent} = useAccent();
  const item = (block.item ?? {}) as Record<string, any>;
  const {mediaSource, runAction} = context;

  const source = useCallback(
    (template: unknown, itemScope: Scope) => {
      if (typeof template !== 'string') {
        return null;
      }
      const route = resolveTemplate(template, itemScope);
      return route && isSafeRoute(route) ? mediaSource?.(route) ?? null : null;
    },
    [mediaSource],
  );

  const resolved = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
  const points: MapPoint[] = useMemo(() => {
    const out: MapPoint[] = [];
    (Array.isArray(resolved) ? resolved : []).forEach((value: any, index: number) => {
      const itemScope = {...scope, data: value};
      const pair = coordinates(resolve(item.lat, itemScope), resolve(item.lon, itemScope));
      if (pair) {
        const key = item.key !== undefined ? resolve(item.key, itemScope) : null;
        out.push({lat: pair[0], lon: pair[1], item: value, key: present(key) ? String(key) : `#${index}`, scope: itemScope});
      }
    });
    return out;
  }, [resolved, scope.page, scope.state]);

  const initial = useMemo(() => (points.length ? regionFor(points) : null), [points.length === 0]);
  const [zoom, setZoom] = useState(() => (initial ? zoomFor(initial.longitudeDelta) : 2));
  const clusters = useMemo(() => clusterPoints(points, zoom), [points, zoom]);
  // the viewer, open on one marker's items: their keys, so it follows the page's fresh data
  const [viewing, setViewing] = useState<{keys: string[]; start: string} | null>(null);

  if (!points.length || !initial) {
    const empty = block.empty !== undefined ? resolve(block.empty, scope) : null;
    return (
      <View style={styles.notice} testID="map-empty">
        <Text style={type.body}>{present(empty) ? String(empty) : 'Nothing here has a location yet.'}</Text>
      </View>
    );
  }

  const openCluster = (group: MapPoint[]) => {
    if (block.viewer) {
      setViewing({keys: group.map(point => point.key), start: group[0].key});
    } else if (block.action && group.length === 1) {
      runAction(block.action, group[0].scope);
    }
  };

  const viewed = viewing ? points.filter(point => viewing.keys.includes(point.key)) : [];
  const entries = viewed.map((point, index) => ({
    item: point.item,
    key: point.key,
    index,
    scope: point.scope,
    kind: mediaKind(item.kind !== undefined ? resolve(item.kind, point.scope) : 'image'),
    thumb: source(item.image, point.scope),
  }));

  return (
    <View testID="map">
      <MapView
        style={[styles.map, {height: Math.max(320, Math.round(height * 0.6))}]}
        initialRegion={initial}
        onRegionChangeComplete={region => setZoom(zoomFor(region.longitudeDelta))}
        toolbarEnabled={false}>
        {clusters.map(cluster => (
          <ClusterMarker
            key={cluster.points.map(point => point.key).join('|')}
            lat={cluster.lat}
            lon={cluster.lon}
            count={cluster.points.length}
            title={item.title !== undefined && cluster.points.length === 1 ? String(resolve(item.title, cluster.points[0].scope) ?? '') : ''}
            thumb={source(item.image, cluster.points[0].scope)}
            accent={accent}
            onPress={() => openCluster(cluster.points)}
          />
        ))}
      </MapView>
      {block.viewer && viewing && entries.length > 0 && (
        <MediaViewer
          block={block}
          entries={entries}
          startKey={viewing.start}
          context={context}
          source={source}
          reduced={false}
          onClose={() => setViewing(null)}
        />
      )}
    </View>
  );
}

function ClusterMarker({
  lat, lon, count, title, thumb, accent, onPress,
}: {
  lat: number; lon: number; count: number; title: string; thumb: {uri: string; headers?: Record<string, string>} | null;
  accent: string; onPress: () => void;
}) {
  // a marker's picture is drawn once it has loaded, then left alone (cheap with many markers)
  const [ready, setReady] = useState(!thumb);
  const label = count > 1 ? `${count} items here` : title || 'One item';
  return (
    <Marker
      coordinate={{latitude: lat, longitude: lon}}
      onPress={onPress}
      tracksViewChanges={!ready}
      accessibilityLabel={label}
      testID={`map-marker-${count}`}>
      <View style={[styles.marker, {borderColor: accent}]}>
        {thumb ? (
          <Image source={thumb} style={styles.markerImage} onLoad={() => setReady(true)} onError={() => setReady(true)} />
        ) : (
          <Icon name="map-pin" size={18} color={palette.text} />
        )}
      </View>
      {count > 1 && (
        <View style={styles.count}>
          <Text style={styles.countText}>{count}</Text>
        </View>
      )}
    </Marker>
  );
}

const styles = StyleSheet.create({
  map: {width: '100%', borderRadius: radii.card, overflow: 'hidden'},
  notice: {padding: space.xl, borderRadius: radii.card, backgroundColor: palette.card},
  marker: {
    width: 44,
    height: 44,
    borderRadius: 10,
    borderWidth: 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.controlStrong,
  },
  markerImage: {width: '100%', height: '100%'},
  count: {
    position: 'absolute',
    top: -6,
    right: -8,
    minWidth: 22,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 999,
    backgroundColor: palette.card,
    alignItems: 'center',
  },
  countText: {color: palette.text, fontSize: 11, fontWeight: '700'},
});
