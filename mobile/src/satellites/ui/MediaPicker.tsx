import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {ActivityIndicator, Modal, Pressable, StatusBar, StyleSheet, Text, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {tokens, useAccent} from '../../theme';
import {isSafeRoute, type CapabilityProvider} from './contract';
import {mediaKind, VirtualMediaGrid} from './MediaGrid';
import type {BlockContext} from './UiBlocks';

const {palette, space, type, radii} = tokens;

/**
 * The media picker (client capability media.picker, UI contract 1.2's pick action): a
 * full-screen sheet listing what a media.gallery provider offers, in the shared media-grid,
 * that resolves with what the person chose - references, never paths - or null on cancel.
 * It knows the capability, never which Satellite provides it.
 */

export interface MediaReference {
  provider: string;
  capability: string;
  id: string;
  kind: 'image' | 'video';
}

export interface PickRequest {
  provider: CapabilityProvider;
  capability: string;
  kinds?: string[];
  multiple: boolean;
  title: string;
  resolve: (picked: MediaReference[] | null) => void;
}

/** The references a pick returns for the items chosen from `provider`. */
export function references(provider: CapabilityProvider, capability: string, items: any[]): MediaReference[] {
  return items.map(item => ({provider: provider.satellite, capability, id: String(item.id), kind: mediaKind(item.kind)}));
}

/** What the picker asks a provider for at a time (media.gallery's optional paging). */
export const PICK_PAGE = 200;

/** The provider's `list` route for these kinds, or null when it isn't a safe route. With
 * `paged`, it asks for PICK_PAGE at a time; a provider without paging answers everything. */
export function listRoute(provider: CapabilityProvider, kinds?: string[], paged = false): string | null {
  const route = provider.operations?.list;
  if (!route || !isSafeRoute(route)) {
    return null;
  }
  const wanted = (kinds && kinds.length ? kinds : ['image', 'video']).filter(kind => kind === 'image' || kind === 'video');
  // the comma is encoded: a route stays within the contract's URL-safe characters
  const listed = `${route}${route.includes('?') ? '&' : '?'}kinds=${wanted.join('%2C')}`;
  return paged ? `${listed}&limit=${PICK_PAGE}` : listed;
}

export function MediaPicker({
  request, read, mediaSource,
}: {
  request: PickRequest;
  /** Reads a route of another Satellite (the provider) with this session. */
  read: (satellite: string, route: string) => Promise<any>;
  /** An image from one of the provider's routes, with this session. */
  mediaSource: (satellite: string, route: string) => {uri: string; headers?: Record<string, string>};
}) {
  const {color: accent, onColor} = useAccent();
  const {provider, capability, kinds, multiple, title, resolve} = request;
  const [data, setData] = useState<{items: any[]; next?: unknown} | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<any[]>([]);
  const thumbnail = provider.operations?.thumbnail;
  const route = listRoute(provider, kinds, true);

  useEffect(() => {
    if (!route || !thumbnail || !isSafeRoute(thumbnail)) {
      setError(`${provider.satellite} doesn't offer anything to choose from.`);
      return;
    }
    let cancelled = false;
    const accepted = new Set(kinds && kinds.length ? kinds : ['image', 'video']);
    read(provider.satellite, route)
      .then(payload => {
        if (!cancelled) {
          // a provider answers for the kinds asked; the picker never offers another kind
          const listed = Array.isArray(payload?.items) ? payload.items : [];
          setData({...payload, items: listed.filter((item: any) => item && item.id !== undefined && accepted.has(mediaKind(item.kind)))});
        }
      })
      .catch((err: any) => !cancelled && setError(err?.message || 'Could not load what there is to choose from.'));
    return () => {
      cancelled = true;
    };
  }, [provider, kinds, thumbnail, read, route]);

  const block = useMemo(
    () => ({
      type: 'media-grid',
      items: '$.items',
      size: 'medium',
      empty: 'There is nothing to choose from yet.',
      item: {image: `${thumbnail}/{$.id}`, key: '$.id', kind: '$.kind', duration: '$.duration', group: '$.group'},
      // the provider's next page as the list nears its end (media.gallery's paging)
      more: {route: `${route}&cursor={$value}`, cursor: '$.next'},
    }),
    [thumbnail, route],
  );
  const scope = useMemo(() => ({data: data ?? {}, page: data ?? {}, params: {}}), [data]);
  const providerSource = useCallback((itemRoute: string) => mediaSource(provider.satellite, itemRoute), [mediaSource, provider.satellite]);
  const load = useCallback((pageRoute: string) => read(provider.satellite, pageRoute), [read, provider.satellite]);
  const picking = useMemo(() => ({multiple, onChange: setChosen}), [multiple]);
  const context: BlockContext = useMemo(
    () => ({
      developer: false,
      providers: {},
      runAction: async () => false,
      readCapability: read,
      forms: {},
      setEditing: () => {},
      mediaSource: providerSource,
      load,
      picking,
    }),
    [read, providerSource, load, picking],
  );

  const cancel = () => resolve(null);
  const confirm = () => chosen.length && resolve(references(provider, capability, chosen));
  const label = title || (multiple ? 'Choose media' : 'Choose an item');

  return (
    <Modal visible animationType="slide" onRequestClose={cancel} statusBarTranslucent>
      <View style={styles.sheet} testID="media-picker">
        <View style={styles.head}>
          <View style={styles.heading}>
            <Text style={type.title} numberOfLines={1}>
              {label}
            </Text>
            <Text style={type.caption} accessibilityLiveRegion="polite">
              {chosen.length ? `${chosen.length} selected` : multiple ? 'Nothing selected' : 'Choose one'}
            </Text>
          </View>
          <Pressable onPress={cancel} accessibilityRole="button" accessibilityLabel="Cancel" hitSlop={8} style={styles.close}>
            <Icon name="x" size={20} color={palette.text} />
          </Pressable>
        </View>
        <View style={styles.list}>
          {error ? (
            <Text style={[styles.error, styles.body]}>{error}</Text>
          ) : data === null ? (
            <ActivityIndicator color={accent} style={styles.loading} />
          ) : (
            <VirtualMediaGrid block={block as any} scope={scope} context={context} contentContainerStyle={styles.body} testID="media-picker-list" />
          )}
        </View>
        <View style={styles.foot}>
          <Pressable onPress={cancel} accessibilityRole="button" style={({pressed}) => [styles.pill, pressed && styles.pressed]}>
            <Text style={styles.pillLabel}>Cancel</Text>
          </Pressable>
          <Pressable
            onPress={confirm}
            disabled={!chosen.length}
            accessibilityRole="button"
            accessibilityState={{disabled: !chosen.length}}
            testID="media-picker-confirm"
            style={({pressed}) => [styles.pill, {backgroundColor: accent}, !chosen.length && styles.disabled, pressed && styles.pressed]}>
            <Text style={[styles.pillLabel, {color: onColor}]}>
              {multiple ? (chosen.length ? `Add ${chosen.length}` : 'Add') : 'Choose'}
            </Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  sheet: {flex: 1, backgroundColor: palette.bg, paddingTop: StatusBar.currentHeight ?? 0},
  head: {flexDirection: 'row', alignItems: 'center', gap: space.md, padding: space.lg},
  heading: {flex: 1, minWidth: 0, gap: 2},
  close: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: palette.control,
  },
  body: {paddingHorizontal: space.lg, paddingBottom: space.xl},
  list: {flex: 1},
  loading: {marginTop: space.xxl},
  error: {...type.body, color: palette.danger},
  foot: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space.sm,
    padding: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: palette.line,
    backgroundColor: palette.card,
    borderTopLeftRadius: radii.card,
    borderTopRightRadius: radii.card,
  },
  pill: {minHeight: 44, justifyContent: 'center', paddingHorizontal: space.xl, borderRadius: 999, backgroundColor: palette.control},
  pillLabel: {...type.caption, color: palette.text, fontWeight: '700'},
  disabled: {opacity: 0.5},
  pressed: {opacity: 0.8},
});
