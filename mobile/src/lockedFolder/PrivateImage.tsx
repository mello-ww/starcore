import React, {useEffect, useState} from 'react';
import {ActivityIndicator, Image, ImageResizeMode, ImageStyle, StyleProp, StyleSheet, Text, View} from 'react-native';
import {colors} from '../theme';

/**
 * An image from the Locked Folder. It's fetched with the session's token
 * and shown from memory as a data URI - never handed to the image loader as
 * a URL, which would keep a copy in its disk cache. The server marks every
 * vault file `no-store`, so the HTTP layer doesn't cache it either. Nothing
 * outlives the component.
 */
export function PrivateImage({
  url,
  token,
  style,
  resizeMode = 'cover',
  fallback,
  onLoaded,
}: {
  url: string;
  token: string | null;
  style?: StyleProp<ImageStyle>;
  resizeMode?: ImageResizeMode;
  /** Shown instead of the "unavailable" label when the image can't load. */
  fallback?: React.ReactNode;
  /** Called once the image has been fetched. */
  onLoaded?: () => void;
}) {
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUri(null);
    setFailed(false);
    loadDataUri(url, token)
      .then(data => {
        if (alive) {
          setUri(data);
          onLoaded?.();
        }
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [url, token]);

  if (uri) {
    return <Image source={{uri}} style={style} resizeMode={resizeMode} />;
  }
  if (failed && fallback !== undefined) {
    return <>{fallback}</>;
  }
  return (
    <View style={[styles.placeholder, style as any]}>
      {failed ? <Text style={styles.failed}>unavailable</Text> : <ActivityIndicator color={colors.textFaint} />}
    </View>
  );
}

export async function loadDataUri(url: string, token: string | null): Promise<string> {
  const response = await fetch(url, {headers: token ? {Authorization: `Bearer ${token}`} : undefined});
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => (typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('empty')));
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(blob);
  });
}

const styles = StyleSheet.create({
  placeholder: {alignItems: 'center', justifyContent: 'center', backgroundColor: colors.raised},
  failed: {color: colors.textFaint, fontSize: 11},
});
