import React, {useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Image, StyleSheet, Text, View} from 'react-native';
import MapView, {Marker} from 'react-native-maps';
import {colors, radius, spacing, typography} from '../theme';
import type {Photo} from './types';
import {usePhotoApi} from './usePhotoApi';

interface Props {
  onOpenPhoto: (photos: Photo[], index: number) => void;
}

function hasLocation(photo: Photo): boolean {
  return photo.metadata.gps_latitude != null && photo.metadata.gps_longitude != null;
}

/**
 * The mobile Photo Map - the same GPS-only, tap-to-open map the web panel's
 * own "Map" tab shows (see mission_control/page.js's renderMap()), built on
 * react-native-maps rather than trying to embed the web panel's Leaflet map
 * in a WebView. Only ever plots photos that already carry GPS metadata (see
 * hasLocation()) - there is no location request or "show me on the map" of
 * the phone's own current position anywhere here, exactly like the web
 * panel's own map never asks for the browser's location either.
 */
export function PhotoMapTab({onOpenPhoto}: Props) {
  const {api, imageSource} = usePhotoApi();
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        setPhotos(await api.list());
        setError(null);
      } catch (err: any) {
        setError(err?.message || 'Could not load your photos.');
      }
    })();
  }, [api]);

  const located = useMemo(() => (photos ?? []).filter(hasLocation), [photos]);

  if (error && !photos) {
    return (
      <View style={styles.center}>
        <Text style={styles.error}>{error}</Text>
      </View>
    );
  }

  if (!photos) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.azure} />
      </View>
    );
  }

  if (located.length === 0) {
    return (
      <View style={styles.center}>
        <Text style={[typography.caption, styles.emptyText]}>
          No photos have location data yet. Photos with GPS metadata will appear here automatically.
        </Text>
      </View>
    );
  }

  const initialRegion = {
    latitude: located[0].metadata.gps_latitude as number,
    longitude: located[0].metadata.gps_longitude as number,
    latitudeDelta: 4,
    longitudeDelta: 4,
  };

  return (
    <MapView style={styles.map} initialRegion={initialRegion}>
      {located.map(photo => (
        <Marker
          key={photo.id}
          coordinate={{
            latitude: photo.metadata.gps_latitude as number,
            longitude: photo.metadata.gps_longitude as number,
          }}
          onPress={() => onOpenPhoto(located, located.indexOf(photo))}>
          <View style={styles.markerFrame}>
            <Image source={imageSource(photo.id, 'thumbnail')} style={styles.markerImage} />
          </View>
        </Marker>
      ))}
    </MapView>
  );
}

const styles = StyleSheet.create({
  map: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl, backgroundColor: colors.void},
  error: {color: colors.alert, fontSize: 13},
  emptyText: {textAlign: 'center'},
  markerFrame: {
    width: 40,
    height: 40,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.azure,
    overflow: 'hidden',
    backgroundColor: colors.raised,
  },
  markerImage: {width: '100%', height: '100%'},
});
