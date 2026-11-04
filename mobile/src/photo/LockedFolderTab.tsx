import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import Video from 'react-native-video';
import {PrimaryButton} from '../components/PrimaryButton';
import {StarSwitch} from '../components/StarSwitch';
import type {LockedFolderStatus, SecurityProblem, VaultItem} from '../lockedFolder/api';
import {disable, enroll, isEnrolled} from '../lockedFolder/biometricUnlock';
import {LockedFolderUnlock, formatWait} from '../lockedFolder/LockedFolderUnlock';
import {PrivateImage} from '../lockedFolder/PrivateImage';
import {useLockedFolder} from '../lockedFolder/useLockedFolder';
import {durationLabel} from './duration';
import {deviceInfo} from '../platform/device';
import {privacy} from '../platform/privacy';
import {colors, spacing, tokens, typography, useAccentStyles, useTopInset} from '../theme';
import {FloatingPlayerSpacer} from '../components/FloatingPlayerInset';

const COLUMNS = 3;
const MAX_TIMER = 2 ** 31 - 1;
const GAP = 3;

/**
 * The Locked Folder, as the "Locked" section of Photos. Its contents come
 * only from the Locked Folder satellite's own routes, which check this
 * session's unlock on the server; nothing private is cached on the phone.
 *
 * Relocks when this section closes (switching section, leaving Photos,
 * switching server), when the app goes to the background, and when the
 * server's unlock time runs out. While it's on screen the window is
 * FLAG_SECURE: no screenshots, and a blank card in recent apps.
 */
export function LockedFolderTab({onPhotosChanged}: {onPhotosChanged?: () => void}) {
  const {api, baseUrl, token, biometricDeps} = useLockedFolder();
  const [status, setStatus] = useState<LockedFolderStatus | null | undefined>(undefined);
  const [items, setItems] = useState<VaultItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [viewing, setViewing] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const unlocked = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const next = await api.status();
      unlocked.current = Boolean(next?.unlocked);
      setStatus(next);
      setItems(next?.unlocked ? await api.media() : []);
      if (!next?.unlocked) {
        setViewing(null);
      }
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not reach the Locked Folder.');
    }
  }, [api]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    privacy.setSecure(true);
    return () => privacy.setSecure(false);
  }, []);

  const relock = useCallback(() => {
    if (unlocked.current) {
      unlocked.current = false;
      api.lock().catch(() => undefined);
    }
    setItems([]);
    setViewing(null);
    setSettingsOpen(false);
    setStatus(current => (current ? {...current, unlocked: false, expires_at: null} : current));
  }, [api]);

  // leaving the section (unmount) or the app (background) locks it again
  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') {
        relock();
      }
    });
    return () => {
      subscription.remove();
      if (unlocked.current) {
        api.lock().catch(() => undefined);
      }
    };
  }, [api, relock]);

  // and so does the server's own time limit
  useEffect(() => {
    if (!status?.unlocked || !status.expires_at) {
      return;
    }
    const wait = new Date(status.expires_at).getTime() - Date.now();
    // capped: setTimeout treats anything past ~24.8 days as "now"
    const timer = setTimeout(refresh, Math.min(Math.max(wait + 500, 1000), MAX_TIMER));
    return () => clearTimeout(timer);
  }, [status, refresh]);

  const fileUrl = (item: VaultItem) => `${baseUrl}${api.filePath(item.path)}`;
  const media = items.filter(item => item.media_type !== 'file');
  const files = items.filter(item => item.media_type === 'file');

  const moveOut = async (item: VaultItem) => {
    try {
      await api.moveOut([item.path]);
      onPhotosChanged?.();
      setViewing(null);
      await refresh();
    } catch (err: any) {
      if (err?.status === 403) {
        relock();
      }
      Alert.alert('Could not move this', err?.message || 'Please try again.');
    }
  };

  if (status === undefined) {
    return <ActivityIndicator style={styles.loading} color={colors.textFaint} />;
  }

  let body: React.ReactNode;
  if (status === null) {
    body = <StateCard icon="lock" title="No Locked Folder" text="This StarCore server doesn’t have a Locked Folder." />;
  } else if (!status.configured) {
    body = (
      <StateCard
        icon="lock"
        title="Set up your Locked Folder"
        text="Choose where it lives on the server from Mission Control: Photos → Locked Folder. Then come back here."
      />
    );
  } else if (status.security?.problem || status.pin_unreadable) {
    const [title, text] = problemText(status.security?.problem ?? 'pin_unreadable', Boolean(status.encryption?.recovery_key));
    body = <StateCard icon="alert-triangle" title={title} text={text} danger />;
  } else if (!status.pin_set) {
    body = <CreatePin api={api} onCreated={refresh} />;
  } else if (!status.unlocked) {
    body = (
      <LockedFolderUnlock
        api={api}
        biometricDeps={biometricDeps}
        onUnlocked={refresh}
        intro={unlockIntro(status)}
        forgotHelp={status.encryption?.recovery_key ? undefined : forgottenPinHelp(status)}
      />
    );
  } else {
    body = (
      <>
        <View style={styles.bar}>
          <View style={styles.barState}>
            <Icon name="unlock" size={16} color={colors.textDim} />
            <Text style={typography.body}>Unlocked</Text>
            {status.expires_at && <Text style={typography.caption}>· locks at {formatTime(status.expires_at)}</Text>}
            {status.encryption?.state === 'on' && <Text style={typography.caption}>· encrypted</Text>}
          </View>
          <View style={styles.barActions}>
            <Pressable
              onPress={() => setSettingsOpen(open => !open)}
              accessibilityRole="button"
              accessibilityLabel="Locked Folder settings"
              hitSlop={8}
              style={styles.iconButton}>
              <Icon name="settings" size={20} color={colors.textDim} />
            </Pressable>
            <Pressable
              onPress={relock}
              accessibilityRole="button"
              accessibilityLabel="Lock now"
              hitSlop={8}
              style={styles.iconButton}>
              <Icon name="lock" size={20} color={colors.textDim} />
            </Pressable>
          </View>
        </View>
        {settingsOpen && <BiometricSettings biometricDeps={biometricDeps} />}
        {items.length === 0 && (
          <StateCard icon="lock" title="Nothing here yet" text="Move photos here from a photo’s viewer: Lock." />
        )}
      </>
    );
  }

  const unlockedView = Boolean(status?.unlocked);
  return (
    <View style={styles.screen}>
      {error && <Text style={styles.error}>{error}</Text>}
      {unlockedView && media.length > 0 ? (
        <FlatList
          data={media}
          keyExtractor={item => item.path}
          numColumns={COLUMNS}
          ListHeaderComponent={<View style={styles.headerSpace}>{body}</View>}
          ListFooterComponent={<>{files.length ? <FileList files={files} /> : null}<FloatingPlayerSpacer /></>}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.gridContent}
          renderItem={({item, index}) => (
            <Pressable
              onPress={() => setViewing(index)}
              style={styles.tile}
              accessibilityRole="imagebutton"
              accessibilityLabel={item.name}>
              {item.media_type === 'video' ? (
                <VideoTile
                  thumbnailUrl={`${baseUrl}${api.thumbnailPath(item.path)}`}
                  durationUrl={`${baseUrl}${api.durationPath(item.path)}`}
                  token={token}
                />
              ) : (
                <PrivateImage url={fileUrl(item)} token={token} style={styles.tileFill} />
              )}
            </Pressable>
          )}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {body}
          {unlockedView && files.length > 0 && <FileList files={files} />}
          <FloatingPlayerSpacer />
        </ScrollView>
      )}
      {viewing !== null && media[viewing] && (
        <PrivateViewer
          item={media[viewing]}
          url={fileUrl(media[viewing])}
          token={token}
          position={`${viewing + 1} / ${media.length}`}
          onClose={() => setViewing(null)}
          onStep={offset => setViewing(index => (index === null ? null : (index + offset + media.length) % media.length))}
          onMoveOut={() => moveOut(media[viewing])}
        />
      )}
    </View>
  );
}

/** What to say when the server can't check the PIN. Recovery is done from Mission Control. */
export function problemText(problem: SecurityProblem, hasRecoveryKey: boolean): [string, string] {
  const recover = hasRecoveryKey
    ? ' Reset the PIN with your recovery key in Mission Control: Photos → Locked Folder.'
    : '';
  switch (problem) {
    case 'pin_tampered':
      return ['The PIN was changed outside StarCore', `The PIN record on the server doesn’t match this Locked Folder, so it stays locked.${recover}`];
    case 'key_unavailable':
      return [
        'This server can’t open the Locked Folder',
        hasRecoveryKey
          ? `The encryption key for these files isn’t on this server.${recover}`
          : 'The encryption key for these files isn’t on this server, and no recovery key was set up.',
      ];
    case 'keyring_damaged':
      return ['The Locked Folder’s keyring is missing', 'Its encryption keyring is missing or damaged on the server, so the files can’t be decrypted.'];
    case 'encryption_unavailable':
      return ['Encryption support is missing', 'The Locked Folder is encrypted, but the server doesn’t have StarCore’s encryption support installed.'];
    default:
      return ['The PIN can’t be read', `The stored PIN on the server is damaged, so the Locked Folder stays locked.${recover}`];
  }
}

function StateCard({icon, title, text, danger}: {icon: string; title: string; text: string; danger?: boolean}) {
  const accentStyle = useAccentStyles();
  return (
    <View style={styles.card}>
      <Icon name={icon} size={34} color={danger ? colors.alert : accentStyle.color} />
      <Text style={typography.heading}>{title}</Text>
      <Text style={[typography.caption, styles.center]}>{text}</Text>
    </View>
  );
}

function CreatePin({api, onCreated}: {api: ReturnType<typeof useLockedFolder>['api']; onCreated: () => void}) {
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    if (pin.length < 4) {
      setMessage('Use 4 to 12 digits.');
      return;
    }
    if (pin !== confirm) {
      setMessage('The PINs don’t match.');
      return;
    }
    setBusy(true);
    try {
      await api.setPin(pin);
      await api.unlock(pin);
      onCreated();
    } catch (err: any) {
      setMessage(err?.message || 'Could not save the PIN.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      <Icon name="lock" size={34} color={colors.textDim} />
      <Text style={typography.heading}>Create a PIN</Text>
      <Text style={[typography.caption, styles.center]}>
        4 to 12 digits. It can’t be recovered, only changed while unlocked.
      </Text>
      <PinField value={pin} onChange={setPin} label="New PIN" />
      <PinField value={confirm} onChange={setConfirm} label="Confirm PIN" />
      {message && <Text style={styles.error}>{message}</Text>}
      <View style={styles.stretch}>
        <PrimaryButton title="Create PIN" onPress={create} loading={busy} disabled={!pin || !confirm} />
      </View>
    </View>
  );
}

function BiometricSettings({biometricDeps}: {biometricDeps: ReturnType<typeof useLockedFolder>['biometricDeps']}) {
  const [enabled, setEnabled] = useState(false);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [asking, setAsking] = useState(false);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    isEnrolled(biometricDeps).then(setEnabled);
    biometricDeps.signer.isAvailable().then(result => setAvailable(result.available));
  }, [biometricDeps]);

  const toggle = async (value: boolean) => {
    setMessage(null);
    if (value) {
      setAsking(true);
      return;
    }
    await disable(biometricDeps);
    setEnabled(false);
  };

  const confirm = async () => {
    setBusy(true);
    try {
      const done = await enroll(biometricDeps, pin, deviceInfo.displayName());
      setEnabled(done);
      setAsking(false);
      if (!done) {
        setMessage('Biometrics aren’t available on this phone.');
      }
    } catch (err: any) {
      setMessage(
        err?.retryAfter
          ? `Too many incorrect attempts. Try again in ${formatWait(err.retryAfter)}.`
          : err?.status === 401
          ? 'Incorrect PIN.'
          : err?.message || 'Could not turn on biometric unlock.',
      );
    } finally {
      setPin('');
      setBusy(false);
    }
  };

  return (
    <View style={styles.settings}>
      <View style={styles.settingRow}>
        <View style={styles.settingText}>
          <Text style={typography.body}>Biometric unlock</Text>
          <Text style={typography.caption}>
            {available === false
              ? 'No fingerprint or face is set up on this phone.'
              : 'Unlock with your fingerprint or face. Your PIN always works too.'}
          </Text>
        </View>
        <StarSwitch
          value={enabled || asking}
          onValueChange={toggle}
          disabled={available === false || busy}
          accessibilityLabel="Biometric unlock"
        />
      </View>
      {asking && (
        <View style={styles.settingAsk}>
          <Text style={typography.caption}>Enter your PIN to turn on biometric unlock.</Text>
          <PinField value={pin} onChange={setPin} label="PIN" />
          <View style={styles.askActions}>
            <PrimaryButton title="Turn on" onPress={confirm} loading={busy} disabled={!pin} />
            <PrimaryButton title="Cancel" variant="secondary" onPress={() => setAsking(false)} disabled={busy} />
          </View>
        </View>
      )}
      {message && <Text style={styles.error}>{message}</Text>}
      <Text style={typography.caption}>
        Changing the PIN or your phone’s fingerprints turns biometric unlock off until you turn it on again. The
        PIN itself is changed from Mission Control.
      </Text>
    </View>
  );
}

function PinField({value, onChange, label}: {value: string; onChange: (value: string) => void; label: string}) {
  return (
    <TextInput
      value={value}
      onChangeText={text => onChange(text.replace(/\D/g, ''))}
      placeholder={label}
      placeholderTextColor={colors.textFaint}
      keyboardType="number-pad"
      secureTextEntry
      maxLength={12}
      style={styles.input}
      accessibilityLabel={label}
      autoComplete="off"
      importantForAutofill="no"
    />
  );
}

function FileList({files}: {files: VaultItem[]}) {
  return (
    <View style={styles.files}>
      <Text style={styles.eyebrow}>OTHER FILES · {files.length}</Text>
      {files.map(item => (
        <View key={item.path} style={styles.fileRow}>
          <Icon name="file" size={18} color={colors.textDim} />
          <Text style={[typography.body, styles.fileName]} numberOfLines={1}>
            {item.name}
          </Text>
        </View>
      ))}
      <Text style={typography.caption}>Open other files from Mission Control.</Text>
    </View>
  );
}

function PrivateViewer({
  item,
  url,
  token,
  position,
  onClose,
  onStep,
  onMoveOut,
}: {
  item: VaultItem;
  url: string;
  token: string | null;
  position: string;
  onClose: () => void;
  onStep: (offset: number) => void;
  onMoveOut: () => void;
}) {
  // a translucent-status-bar Modal is its own window: fall back to the status
  // bar height when the safe-area context doesn't reach it
  const top = Math.max(useTopInset(), StatusBar.currentHeight ?? 0);
  return (
    <Modal visible animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View style={styles.viewer}>
        {item.media_type === 'video' ? (
          <Video
            source={{uri: url, headers: token ? {Authorization: `Bearer ${token}`} : undefined}}
            style={styles.viewerMedia}
            resizeMode="contain"
            controls
          />
        ) : (
          <PrivateImage url={url} token={token} style={styles.viewerMedia} resizeMode="contain" />
        )}
        <View style={[styles.viewerTop, {paddingTop: top + spacing.sm}]}>
          <Pressable onPress={onClose} style={styles.viewerButton} accessibilityRole="button" accessibilityLabel="Close">
            <Icon name="x" size={20} color={colors.text} />
          </Pressable>
          <View style={styles.viewerTitle}>
            <Text style={typography.body} numberOfLines={1}>
              {item.name}
            </Text>
            <Text style={typography.caption}>{position}</Text>
          </View>
        </View>
        <View style={styles.viewerBottom}>
          <Pressable onPress={() => onStep(-1)} style={styles.viewerButton} accessibilityLabel="Previous">
            <Icon name="chevron-left" size={22} color={colors.text} />
          </Pressable>
          <PrimaryButton title="Move to Photos" onPress={onMoveOut} />
          <Pressable onPress={() => onStep(1)} style={styles.viewerButton} accessibilityLabel="Next">
            <Icon name="chevron-right" size={22} color={colors.text} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** A video's poster frame with a play badge and, once the server has rendered
 * it, the length. Both come from the vault's in-memory render. */
export function VideoTile({thumbnailUrl, durationUrl, token}: {thumbnailUrl: string; durationUrl: string; token: string | null}) {
  const [length, setLength] = useState('');
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const loadLength = () => {
    fetch(durationUrl, {headers: token ? {Authorization: `Bearer ${token}`} : undefined})
      .then(response => (response.ok ? response.json() : null))
      .then(body => alive.current && setLength(durationLabel(body?.duration)))
      .catch(() => {});
  };
  return (
    <View style={styles.tileFill}>
      <PrivateImage
        url={thumbnailUrl}
        token={token}
        style={styles.tileFill}
        onLoaded={loadLength}
        fallback={<View style={[styles.tileFill, styles.videoTile]} />}
      />
      <View style={styles.playBadge} pointerEvents="none">
        <Icon name="play" size={16} color="#fff" style={styles.playIcon} />
      </View>
      {length !== '' && (
        <View style={styles.durationBadge} pointerEvents="none">
          <Text style={styles.durationLabel}>{length}</Text>
        </View>
      )}
    </View>
  );
}

const TILE = (Dimensions.get('window').width - spacing.lg * 2 - GAP * (COLUMNS - 1)) / COLUMNS;

const styles = StyleSheet.create({
  screen: {flex: 1},
  loading: {marginTop: spacing.xl},
  content: {padding: spacing.lg, paddingTop: spacing.sm, gap: spacing.md, paddingBottom: 140},
  gridContent: {paddingHorizontal: spacing.lg, paddingBottom: 140},
  headerSpace: {gap: spacing.md, paddingTop: spacing.sm, paddingBottom: spacing.md},
  row: {gap: GAP, marginBottom: GAP},
  tile: {width: TILE, height: TILE, borderRadius: 6, overflow: 'hidden'},
  tileFill: {width: '100%', height: '100%'},
  videoTile: {backgroundColor: colors.raised},
  durationBadge: {
    position: 'absolute',
    right: 6,
    bottom: 6,
    paddingHorizontal: 5,
    paddingVertical: 1,
    borderRadius: 4,
    backgroundColor: 'rgba(4,6,13,0.72)',
  },
  durationLabel: {color: colors.text, fontSize: 10, fontVariant: ['tabular-nums']},
  playBadge: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -16,
    marginLeft: -16,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(4,6,13,0.55)',
  },
  playIcon: {marginLeft: 2},
  card: {
    alignItems: 'center',
    gap: spacing.sm,
    padding: spacing.lg,
    borderRadius: tokens.radii.card,
    backgroundColor: colors.surface,
  },
  center: {textAlign: 'center'},
  stretch: {alignSelf: 'stretch'},
  error: {color: colors.alert, fontSize: 13, textAlign: 'center'},
  input: {
    alignSelf: 'stretch',
    minHeight: 48,
    paddingHorizontal: spacing.md,
    borderRadius: tokens.radii.control,
    borderWidth: 1,
    borderColor: tokens.palette.controlStrong,
    backgroundColor: tokens.palette.field,
    color: colors.text,
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center',
  },
  bar: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  barState: {flexDirection: 'row', alignItems: 'center', gap: spacing.xs},
  barActions: {flexDirection: 'row', gap: spacing.xs},
  iconButton: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  settings: {gap: spacing.md, padding: spacing.md, borderRadius: tokens.radii.card, backgroundColor: colors.surface},
  settingRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.md},
  settingText: {flex: 1, gap: 2},
  settingAsk: {gap: spacing.sm},
  askActions: {gap: spacing.sm},
  files: {gap: spacing.sm, paddingTop: spacing.md},
  eyebrow: {...typography.label, letterSpacing: 1.2},
  fileRow: {flexDirection: 'row', alignItems: 'center', gap: spacing.sm, minHeight: 36},
  fileName: {flex: 1},
  viewer: {flex: 1, backgroundColor: '#000', justifyContent: 'center'},
  viewerMedia: {width: '100%', height: '100%'},
  viewerTop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingBottom: spacing.sm,
    backgroundColor: 'rgba(4,6,13,0.6)',
  },
  viewerTitle: {flex: 1},
  viewerButton: {width: 44, height: 44, alignItems: 'center', justifyContent: 'center'},
  viewerBottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: 'rgba(4,6,13,0.6)',
  },
});

/** Says when the PIN was set: "Incorrect PIN" on a vault someone thinks is new is otherwise baffling. */
export function unlockIntro(status: LockedFolderStatus): string {
  const date = status.pin_set_at ? new Date(status.pin_set_at) : null;
  if (!date || Number.isNaN(date.getTime())) {
    return 'Enter your PIN to see what’s inside.';
  }
  const day = date.toLocaleDateString(undefined, {day: 'numeric', month: 'long', year: 'numeric'});
  return `Enter the PIN set for this Locked Folder on ${day}.`;
}

/** The supported way out of a forgotten PIN when there is no recovery key. */
export function forgottenPinHelp(status: LockedFolderStatus): string {
  const encrypted = status.encryption?.state && status.encryption.state !== 'off';
  if (encrypted) {
    return 'No recovery key was created for this Locked Folder, so a forgotten PIN can’t be reset.';
  }
  return (
    'This Locked Folder isn’t encrypted and has no recovery key, so its PIN can’t be reset from here. ' +
    'Whoever runs the StarCore server can delete pin.json from StarCore’s data folder ' +
    '(satellites/LockedFolder) and restart StarCore, then create a new PIN. The files in the folder are not touched.'
  );
}
