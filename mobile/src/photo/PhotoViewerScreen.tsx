import {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  Dimensions,
  FlatList,
  Image,
  Pressable,
  Share,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {useAnimatedStyle, useSharedValue, withTiming} from 'react-native-reanimated';
import Video from 'react-native-video';
import {colors, spacing, typography, useAccentStyles} from '../theme';
import type {SatellitesStackParamList} from '../navigation/MainTabs';
import {durationLabel} from './duration';
import type {Photo} from './types';
import {useFavorites} from './useFavorites';
import {usePhotoApi} from './usePhotoApi';

type Props = NativeStackScreenProps<SatellitesStackParamList, 'PhotoViewer'>;
type MediaItem = SatellitesStackParamList['PhotoViewer']['media'][number];

const {width: SCREEN_WIDTH} = Dimensions.get('window');

function formatBytes(size: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/**
 * The full-screen viewer: swipe between photos and videos alike (a paging
 * FlatList), pinch-to-zoom on a still image (see ZoomableImage below),
 * Favorite (the same heart every grid uses - see useFavorites.ts), Share,
 * Delete (moves to the recycle bin, with confirmation - never a direct
 * permanent delete) and a Details panel, which also shows the photo's
 * physical album path when it has one. Closing returns to exactly the grid
 * position it was opened from, since the caller never remounts the grid
 * underneath - this screen is simply popped off the stack.
 *
 * A video page (media_type === 'video') renders react-native-video instead
 * of Image, with its own tap-to-play/pause controls; only the page that's
 * actually on screen is ever mounted with a real player (see
 * `renderItem`/`viewableIndex` below) so swiping away always stops playback
 * rather than leaving audio running behind the next page.
 */
export function PhotoViewerScreen({route, navigation}: Props) {
  const accentStyle = useAccentStyles();
  const {media: initialMedia, startIndex} = route.params;
  const {api, imageSource} = usePhotoApi();
  const [media, setMedia] = useState<MediaItem[]>(initialMedia);
  const [details, setDetails] = useState(false);
  const [photoDetail, setPhotoDetail] = useState<Photo | null>(null);
  const [viewableIndex, setViewableIndex] = useState(startIndex);
  const listRef = useRef<FlatList<MediaItem>>(null);
  const currentIndexRef = useRef(startIndex);
  const {favoriteIds, toggle: toggleFavorite} = useFavorites();

  const getItemLayout = (_: unknown, index: number) => ({length: SCREEN_WIDTH, offset: SCREEN_WIDTH * index, index});

  const current = media[currentIndexRef.current] ?? media[0];

  const loadDetails = async (photoId: string) => {
    try {
      // the id is already known-good (it came from a list this app just
      // loaded), so this is only ever fetching the fuller record, never
      // discovering whether the photo exists
      const list = await api.list();
      setPhotoDetail(list.find(photo => photo.id === photoId) ?? null);
    } catch {
      setPhotoDetail(null);
    }
  };

  const onDelete = () => {
    Alert.alert('Delete?', 'It will move to the recycle bin and can be restored from there.', [
      {text: 'Cancel', style: 'cancel'},
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const deleting = current;
          try {
            await api.trash(deleting.id);
          } catch (err: any) {
            Alert.alert('Could not delete this', err?.message || 'Please try again.');
            return;
          }
          const remaining = media.filter(item => item.id !== deleting.id);
          if (remaining.length === 0) {
            navigation.goBack();
            return;
          }
          setMedia(remaining);
          const nextIndex = Math.min(currentIndexRef.current, remaining.length - 1);
          currentIndexRef.current = nextIndex;
          setViewableIndex(nextIndex);
        },
      },
    ]);
  };

  const onToggleFavorite = async (photoId: string) => {
    try {
      await toggleFavorite(photoId);
    } catch (err: any) {
      Alert.alert('Could not update Favorites', err?.message || 'Please try again.');
    }
  };

  const onShare = async (photoId: string) => {
    try {
      await Share.share({message: imageSource(photoId, 'original').uri});
    } catch {
      // the user cancelled the share sheet - nothing to report
    }
  };

  const toggleDetails = () => {
    if (!details) {
      loadDetails(current.id);
    }
    setDetails(!details);
  };

  return (
    <View style={styles.screen}>
      <FlatList
        ref={listRef}
        data={media}
        keyExtractor={item => item.id}
        horizontal
        pagingEnabled
        initialScrollIndex={startIndex}
        getItemLayout={getItemLayout}
        initialNumToRender={1}
        windowSize={3}
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={event => {
          const index = Math.round(event.nativeEvent.contentOffset.x / SCREEN_WIDTH);
          currentIndexRef.current = index;
          setViewableIndex(index);
          if (details) {
            loadDetails(media[index].id);
          }
        }}
        renderItem={({item, index}) => <ViewerPage item={item} active={index === viewableIndex} />}
      />

      <View style={styles.topBar} pointerEvents="box-none">
        <Pressable onPress={() => navigation.goBack()} style={styles.iconButton} hitSlop={12}>
          <Text style={styles.iconText}>✕</Text>
        </Pressable>
      </View>

      <View style={styles.bottomBar}>
        <ViewerAction
          label={favoriteIds.has(current.id) ? '♥ Favorited' : '♡ Favorite'}
          onPress={() => onToggleFavorite(current.id)}
        />
        <ViewerAction label="Share" onPress={() => onShare(current.id)} />
        <ViewerAction label="Details" onPress={toggleDetails} />
        <ViewerAction label="Delete" onPress={onDelete} destructive />
      </View>

      {details && (
        <View style={styles.detailsPanel}>
          {photoDetail ? (
            <>
              <Text style={typography.heading}>{photoDetail.filename}</Text>
              {photoDetail.media_type === 'video' ? (
                <DetailRow label="Duration" value={durationLabel(photoDetail.duration) || 'unknown'} />
              ) : (
                photoDetail.width && photoDetail.height && (
                  <DetailRow label="Dimensions" value={`${photoDetail.width} × ${photoDetail.height}`} />
                )
              )}
              <DetailRow label="Size" value={formatBytes(photoDetail.size)} />
              <DetailRow label="Format" value={photoDetail.format.toUpperCase()} />
              {photoDetail.captured_at && <DetailRow label="Taken" value={photoDetail.captured_at} />}
              {photoDetail.metadata.camera_model && (
                <DetailRow
                  label="Camera"
                  value={[photoDetail.metadata.camera_make, photoDetail.metadata.camera_model].filter(Boolean).join(' ')}
                />
              )}
              {photoDetail.metadata.lens_model && <DetailRow label="Lens" value={photoDetail.metadata.lens_model} />}
              {photoDetail.metadata.gps_coordinates && (
                <DetailRow label="Location" value={photoDetail.metadata.gps_coordinates} />
              )}
              {photoDetail.physical_path && <DetailRow label="Path" value={photoDetail.physical_path} />}
            </>
          ) : (
            <ActivityIndicator color={accentStyle.color} />
          )}
        </View>
      )}
    </View>
  );
}

function ViewerPage({item, active}: {item: MediaItem; active: boolean}) {
  const accentStyle = useAccentStyles();
  const {imageSource} = usePhotoApi();
  const [loading, setLoading] = useState(true);
  const [paused, setPaused] = useState(false);

  if (item.mediaType === 'video') {
    return (
      <Pressable style={styles.page} onPress={() => setPaused(current => !current)}>
        {/* only the active page actually mounts a player with a source, so
            swiping away stops playback/decoding rather than leaving it
            running off-screen behind whichever page is now showing */}
        {active ? (
          <Video
            source={imageSource(item.id, 'original')}
            style={styles.image}
            resizeMode="contain"
            controls
            paused={paused}
            onLoadStart={() => setLoading(true)}
            onLoad={() => setLoading(false)}
            onError={() => setLoading(false)}
          />
        ) : (
          <Image source={imageSource(item.id, 'thumbnail')} style={styles.image} resizeMode="contain" />
        )}
        {loading && active && <ActivityIndicator color={accentStyle.color} style={StyleSheet.absoluteFill} />}
      </Pressable>
    );
  }

  return (
    <ZoomableImage source={imageSource(item.id, 'original')} onLoadEnd={() => setLoading(false)} loading={loading} />
  );
}

/** The photo page's own pinch-to-zoom - "swipe is here but pinch-to-zoom
 * isn't wired up here yet" from this screen's old docstring, now that
 * react-native-gesture-handler + react-native-reanimated are both approved
 * dependencies (see PhotoLibraryTab's usePinchColumns for the other use of
 * that same pair). Pinching zooms in around the gesture's own focal point;
 * releasing below the original size springs back to it rather than leaving
 * the image stuck smaller than the frame. This never touches horizontal
 * swiping between photos - the pinch gesture and the FlatList's own paging
 * gesture are independent, since a two-finger pinch never triggers a
 * single-finger horizontal pan. */
function ZoomableImage({
  source,
  onLoadEnd,
  loading,
}: {
  source: {uri: string; headers?: Record<string, string>};
  onLoadEnd: () => void;
  loading: boolean;
}) {
  const accentStyle = useAccentStyles();
  const scale = useSharedValue(1);
  const savedScale = useSharedValue(1);
  const translateX = useSharedValue(0);
  const translateY = useSharedValue(0);
  const savedTranslateX = useSharedValue(0);
  const savedTranslateY = useSharedValue(0);

  const reset = () => {
    'worklet';
    scale.value = withTiming(1);
    translateX.value = withTiming(0);
    translateY.value = withTiming(0);
    savedScale.value = 1;
    savedTranslateX.value = 0;
    savedTranslateY.value = 0;
  };

  const pinch = Gesture.Pinch()
    .onUpdate(event => {
      scale.value = Math.max(1, savedScale.value * event.scale);
    })
    .onEnd(() => {
      savedScale.value = scale.value;
      if (scale.value <= 1) {
        reset();
      }
    });

  // two fingers only (matching the pinch above) - a single-finger drag is
  // deliberately left entirely to the FlatList's own native horizontal
  // paging (swipe between photos), so zooming in never steals that gesture
  const pan = Gesture.Pan()
    .minPointers(2)
    .onUpdate(event => {
      if (scale.value <= 1) {
        return;
      }
      translateX.value = savedTranslateX.value + event.translationX;
      translateY.value = savedTranslateY.value + event.translationY;
    })
    .onEnd(() => {
      savedTranslateX.value = translateX.value;
      savedTranslateY.value = translateY.value;
    });

  const gesture = Gesture.Simultaneous(pinch, pan);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      {translateX: translateX.value},
      {translateY: translateY.value},
      {scale: scale.value},
    ],
  }));

  return (
    <View style={styles.page}>
      <GestureDetector gesture={gesture}>
        <Animated.Image
          source={source}
          style={[styles.image, animatedStyle]}
          resizeMode="contain"
          onLoadEnd={onLoadEnd}
        />
      </GestureDetector>
      {loading && <ActivityIndicator color={accentStyle.color} style={StyleSheet.absoluteFill} />}
    </View>
  );
}

function ViewerAction({label, onPress, destructive}: {label: string; onPress: () => void; destructive?: boolean}) {
  return (
    <Pressable onPress={onPress} style={styles.action} hitSlop={8}>
      <Text style={[typography.body, destructive && styles.destructive]}>{label}</Text>
    </Pressable>
  );
}

function DetailRow({label, value}: {label: string; value: string}) {
  return (
    <View style={styles.detailRow}>
      <Text style={typography.label}>{label}</Text>
      <Text style={typography.body}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: '#000'},
  page: {width: SCREEN_WIDTH, alignItems: 'center', justifyContent: 'center'},
  image: {width: SCREEN_WIDTH, height: '100%'},
  topBar: {position: 'absolute', top: spacing.lg, left: spacing.lg},
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(4,6,13,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconText: {color: colors.text, fontSize: 18},
  bottomBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'space-evenly',
    paddingVertical: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: 'rgba(4,6,13,0.75)',
  },
  action: {paddingHorizontal: spacing.md, paddingVertical: spacing.xs},
  destructive: {color: colors.alert},
  detailsPanel: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    bottom: 96,
    backgroundColor: 'rgba(28,29,34,0.94)',
    borderRadius: 12,
    padding: spacing.md,
    gap: spacing.xs,
  },
  detailRow: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.md},
});
