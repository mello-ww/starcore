import React, {useEffect, useState} from 'react';
import {Alert, Pressable, StyleSheet, Text, TextInput, View} from 'react-native';
import Icon from 'react-native-vector-icons/Feather';
import {PrimaryButton} from '../../components/PrimaryButton';
import {Slider} from '../../components/Slider';
import {StarSwitch} from '../../components/StarSwitch';
import {Surface} from '../../components/Surface';
import {tokens, useAccent} from '../../theme';
import {
  BLOCK_TYPES, findProvider, formatValue, ICONS, isSafeRoute, isVisible, resolve, toneOf,
  type Providers, type Scope, type UiAction, type UiBlock,
} from './contract';

const {palette, space, type, radii} = tokens;

/**
 * This app's components for UI contract 1.0 blocks (docs/ui-contract.md).
 * Each block is drawn with the app's own components and tokens; what it
 * shows comes from bindings into live data, and what it does is an action
 * the screen runs against the Satellite's own routes. No block knows which
 * Satellite it belongs to - shared ones such as the file browser are bound
 * to a capability instead.
 */
export interface BlockContext {
  developer: boolean;
  providers: Providers;
  /** Runs an action; resolves true once its request (if any) succeeded. */
  runAction: (action: UiAction | undefined, scope: Scope, value?: unknown) => Promise<boolean>;
  /** Reads one operation of a capability provider - another Satellite's route. */
  readCapability: (satellite: string, route: string) => Promise<any>;
  /** Form values survive a data refresh, keyed per form block. */
  forms: Record<string, Record<string, any>>;
  /** A slider or text field is being used - background refresh holds off. */
  setEditing: (editing: boolean) => void;
}

const asText = (value: unknown) => (value === null || value === undefined ? '' : String(value));

const TONE_COLORS: Record<string, string> = {neutral: palette.text, ok: palette.text, warn: palette.warn, danger: palette.danger};

export function UiBlocks({blocks, scope, context}: {blocks: UiBlock[] | undefined; scope: Scope; context: BlockContext}) {
  return (
    <>
      {(blocks ?? []).map((block, index) => (
        <UiBlockView key={block?.id ?? `${block?.type}-${index}`} block={block} scope={scope} context={context} />
      ))}
    </>
  );
}

function UiBlockView({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  if (!block || typeof block !== 'object') {
    return null;
  }
  if (block.developer && !context.developer) {
    return null;
  }
  if ('visible' in block && !isVisible(resolve(block.visible, scope))) {
    return null;
  }
  if (!BLOCK_TYPES.has(block.type)) {
    // a newer block this app doesn't know - skipped, unless the page needs it
    return block.required ? <Text style={styles.unsupported}>Part of this page needs a newer StarCore app.</Text> : null;
  }
  switch (block.type) {
    case 'heading':
      return <Text style={type.title}>{asText(resolve(block.text, scope))}</Text>;
    case 'text':
      return (
        <Text style={block.style === 'caption' ? type.caption : block.style === 'mono' ? styles.mono : styles.body}>
          {asText(resolve(block.text, scope))}
        </Text>
      );
    case 'field':
      return (
        <View style={styles.field}>
          <Text style={styles.label}>{asText(resolve(block.label, scope))}</Text>
          <Text style={[styles.value, {color: TONE_COLORS[toneOf(resolve(block.tone, scope))]}]} selectable>
            {formatValue(resolve(block.value, scope), block.format, block.unit)}
          </Text>
        </View>
      );
    case 'metric':
      return <MetricBlock block={block} scope={scope} />;
    case 'card':
      return (
        <Surface style={styles.card}>
          {block.title !== undefined && <Text style={type.eyebrow}>{asText(resolve(block.title, scope)).toUpperCase()}</Text>}
          <UiBlocks blocks={block.blocks} scope={scope} context={context} />
        </Surface>
      );
    case 'list':
      return <ListBlock block={block} scope={scope} context={context} />;
    case 'button':
      return <ButtonBlock block={block} scope={scope} context={context} />;
    case 'toggle':
      return <ToggleBlock block={block} scope={scope} context={context} />;
    case 'slider':
      return <SliderBlock block={block} scope={scope} context={context} />;
    case 'form':
      return <FormBlock block={block} scope={scope} context={context} />;
    case 'file-browser':
      return <FileBrowserBlock block={block} scope={scope} context={context} />;
    default:
      return null;
  }
}

function MetricBlock({block, scope}: {block: UiBlock; scope: Scope}) {
  const value = resolve(block.value, scope);
  const max = resolve(block.max, scope);
  const tone = toneOf(resolve(block.tone, scope));
  const {color: accent} = useAccent();
  const ratio = typeof max === 'number' && max > 0 && typeof value === 'number' ? Math.max(0, Math.min(1, value / max)) : null;
  return (
    <View style={styles.metric}>
      <View style={styles.field}>
        <Text style={styles.label}>{asText(resolve(block.label, scope))}</Text>
        <Text style={[styles.metricValue, {color: TONE_COLORS[tone]}]}>{formatValue(value, block.format, block.unit)}</Text>
      </View>
      {ratio !== null && (
        <View style={styles.bar}>
          <View
            style={[styles.barFill, {width: `${ratio * 100}%`, backgroundColor: tone === 'neutral' || tone === 'ok' ? accent : TONE_COLORS[tone]}]}
          />
        </View>
      )}
    </View>
  );
}

function ListBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const items = Array.isArray(block.items) ? block.items : resolve(block.items, scope);
  if (!Array.isArray(items) || items.length === 0) {
    return <Text style={type.caption}>{block.empty !== undefined ? asText(resolve(block.empty, scope)) : 'Nothing here.'}</Text>;
  }
  const formats = block.item?.format ?? {};
  return (
    <View style={styles.list}>
      {items.map((item: any, index: number) => {
        const itemScope = {...scope, data: item};
        const iconName = resolve(block.item?.icon, itemScope);
        const title = asText(resolve(block.item?.title, itemScope));
        return (
          <Row
            key={item?.id ?? index}
            icon={typeof iconName === 'string' && ICONS.has(iconName) ? iconName : undefined}
            title={title}
            subtitle={block.item?.subtitle !== undefined ? formatValue(resolve(block.item.subtitle, itemScope), formats.subtitle) : undefined}
            value={block.item?.value !== undefined ? formatValue(resolve(block.item.value, itemScope), formats.value) : undefined}
            onPress={block.action ? () => context.runAction(block.action, itemScope) : undefined}
          />
        );
      })}
    </View>
  );
}

function Row({icon, title, subtitle, value, onPress}: {icon?: string; title: string; subtitle?: string; value?: string; onPress?: () => void}) {
  const {color: accent} = useAccent();
  const content = (
    <>
      {icon && <Icon name={icon} size={18} color={accent} />}
      <View style={styles.rowMain}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {subtitle !== undefined && (
          <Text style={type.caption} numberOfLines={1}>
            {subtitle}
          </Text>
        )}
      </View>
      {value !== undefined && <Text style={type.caption}>{value}</Text>}
      {onPress && <Icon name="chevron-right" size={18} color={palette.text3} />}
    </>
  );
  if (!onPress) {
    return <View style={styles.row}>{content}</View>;
  }
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={title} onPress={onPress} style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      {content}
    </Pressable>
  );
}

function ButtonBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const [busy, setBusy] = useState(false);
  const label = asText(resolve(block.label, scope));
  const danger = block.style === 'danger';
  const press = async () => {
    setBusy(true);
    try {
      await context.runAction(block.action, scope);
    } finally {
      setBusy(false);
    }
  };
  if (danger) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{disabled: busy}}
        disabled={busy}
        onPress={press}
        style={({pressed}) => [styles.danger, (pressed || busy) && styles.pressed]}>
        <Text style={styles.dangerLabel}>{label}</Text>
      </Pressable>
    );
  }
  return <PrimaryButton title={label} variant={block.style === 'primary' ? 'primary' : 'secondary'} loading={busy} onPress={press} />;
}

function ToggleBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const bound = Boolean(resolve(block.value, scope));
  const [value, setValue] = useState(bound);
  useEffect(() => setValue(bound), [bound]);
  const label = asText(resolve(block.label, scope));
  return (
    <View style={styles.toggle}>
      <View style={styles.rowMain}>
        <Text style={styles.label}>{label}</Text>
        {block.description !== undefined && <Text style={type.caption}>{asText(resolve(block.description, scope))}</Text>}
      </View>
      <StarSwitch
        accessibilityLabel={label}
        value={value}
        onValueChange={async next => {
          setValue(next);
          if (!(await context.runAction(block.action, scope, next))) {
            setValue(bound); // the server said no - show what's actually true
          }
        }}
      />
    </View>
  );
}

function SliderBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const min = Number(resolve(block.min, scope));
  const max = Number(resolve(block.max, scope));
  const step = Number(resolve(block.step, scope)) || 1;
  const bound = Number(resolve(block.value, scope));
  const value = Number.isFinite(bound) ? bound : min;
  const [shown, setShown] = useState(value);
  useEffect(() => setShown(value), [value]);
  const label = asText(resolve(block.label, scope));
  return (
    <View>
      <View style={styles.field}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>{formatValue(shown, block.format, block.unit)}</Text>
      </View>
      <Slider
        accessibilityLabel={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={setShown}
        onDragStateChange={context.setEditing}
        onComplete={next => {
          setShown(next);
          context.runAction(block.action, scope, next);
        }}
      />
    </View>
  );
}

function FormBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const fields: any[] = Array.isArray(block.fields) ? block.fields : [];
  const key = block.id ?? `form-${fields.map(field => field.key).join(',')}`;
  const initial = () =>
    Object.fromEntries(
      fields.map(field => [field.key, field.value !== undefined ? resolve(field.value, scope) : field.kind === 'toggle' ? false : '']),
    );
  if (!context.forms[key]) {
    context.forms[key] = initial();
  }
  const [values, setValues] = useState<Record<string, any>>(context.forms[key]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const update = (name: string, next: any) => {
    const merged = {...values, [name]: next};
    context.forms[key] = merged;
    setValues(merged);
  };
  const submit = async () => {
    const missing = fields.filter(field => field.required && (values[field.key] === '' || values[field.key] === null || values[field.key] === undefined));
    if (missing.length) {
      setError(`${missing.map(field => field.label).join(', ')} ${missing.length === 1 ? 'is' : 'are'} required.`);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      if (await context.runAction(block.submit?.action, {...scope, form: {...values}})) {
        // a successful submit starts the form afresh - also when this page
        // stays mounted behind the one the action opened
        context.forms[key] = initial();
        setValues(context.forms[key]);
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.form}>
      {fields.map(field => (
        <FormField key={field.key} field={field} value={values[field.key]} onChange={next => update(field.key, next)} context={context} />
      ))}
      {error && <Text style={styles.error}>{error}</Text>}
      <PrimaryButton title={asText(resolve(block.submit?.label, scope)) || 'Submit'} loading={busy} onPress={submit} />
    </View>
  );
}

function FormField({field, value, onChange, context}: {field: any; value: any; onChange: (value: any) => void; context: BlockContext}) {
  const {color: accent} = useAccent();
  const label = `${asText(field.label)}${field.required ? ' *' : ''}`;
  if (field.kind === 'toggle') {
    return (
      <View style={styles.toggle}>
        <Text style={[styles.label, styles.rowMain]}>{label}</Text>
        <StarSwitch accessibilityLabel={asText(field.label)} value={Boolean(value)} onValueChange={onChange} />
      </View>
    );
  }
  if (field.kind === 'select') {
    return (
      <View style={styles.inputField}>
        <Text style={styles.label}>{label}</Text>
        <View style={styles.options}>
          {(field.options ?? []).map((option: any) => {
            const selected = option.value === value;
            return (
              <Pressable
                key={String(option.value)}
                accessibilityRole="radio"
                accessibilityState={{selected}}
                onPress={() => onChange(option.value)}
                style={[styles.option, selected && {backgroundColor: accent}]}>
                <Text style={[styles.optionLabel, selected && {color: palette.onAccent}]}>{asText(option.label)}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    );
  }
  const numeric = field.kind === 'number';
  return (
    <View style={styles.inputField}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        accessibilityLabel={asText(field.label)}
        style={styles.input}
        value={value === null || value === undefined ? '' : String(value)}
        placeholder={field.placeholder !== undefined ? asText(field.placeholder) : undefined}
        placeholderTextColor={palette.text3}
        keyboardType={numeric ? 'numeric' : 'default'}
        onFocus={() => context.setEditing(true)}
        onBlur={() => context.setEditing(false)}
        onChangeText={text => onChange(numeric ? (text.trim() === '' || Number.isNaN(Number(text)) ? text : Number(text)) : text)}
      />
    </View>
  );
}

/** A shared block bound to the files.browse capability - it browses through
 * whichever Satellite the catalog says provides it, never a named one. */
function FileBrowserBlock({block, scope, context}: {block: UiBlock; scope: Scope; context: BlockContext}) {
  const provider = findProvider(context.providers, block.capability);
  const route = provider?.operations?.list;
  const select = block.select ?? 'none';
  const [listing, setListing] = useState<{path: string; parent: string | null; entries: any[]} | null>(null);
  const [error, setError] = useState<string | null>(null);

  const open = async (path: string) => {
    if (!provider || !isSafeRoute(route)) {
      return;
    }
    setError(null);
    try {
      const body = await context.readCapability(provider.satellite, `${route}?path=${encodeURIComponent(path)}`);
      setListing({path: body?.path ?? '', parent: body?.parent ?? null, entries: Array.isArray(body?.entries) ? body.entries : []});
    } catch (err: any) {
      setError(err?.message || 'Could not open that folder.');
    }
  };

  useEffect(() => {
    open('');
    // only when the provider changes - `open` itself is recreated every render
  }, [provider?.satellite, route]);

  if (!provider || !isSafeRoute(route)) {
    return <Text style={styles.unsupported}>No enabled Satellite provides {String(block.capability)}, so there is nothing to browse yet.</Text>;
  }
  const join = (base: string, name: string) => {
    const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/';
    return base.endsWith(separator) ? `${base}${name}` : `${base}${separator}${name}`;
  };
  return (
    <View style={styles.form}>
      <View style={styles.toggle}>
        <Text style={[styles.mono, styles.rowMain]} numberOfLines={1}>
          {listing?.path || 'Locations'}
        </Text>
        <PrimaryButton title="Up" variant="secondary" disabled={!listing?.path} onPress={() => open(listing?.parent ?? '')} />
      </View>
      {error && <Text style={styles.error}>{error}</Text>}
      {listing === null && !error && <Text style={type.caption}>Loading…</Text>}
      {listing && listing.entries.length === 0 && <Text style={type.caption}>This folder is empty.</Text>}
      <View style={styles.list}>
        {(listing?.entries ?? []).map(entry => {
          const isDir = entry.type === 'dir';
          // at the roots an entry's name is already an absolute path
          const target = listing!.path === '' ? entry.name : join(listing!.path, entry.name);
          const pick = isDir ? () => open(target) : select === 'file' && block.action ? () => context.runAction(block.action, scope, target) : undefined;
          return (
            <Row
              key={entry.name}
              icon={isDir ? 'folder' : 'file'}
              title={String(entry.name)}
              value={!isDir && typeof entry.size === 'number' ? formatValue(entry.size, 'bytes') : undefined}
              onPress={pick}
            />
          );
        })}
      </View>
      {select === 'directory' && block.action && (
        <PrimaryButton
          title={asText(resolve(block.label, scope)) || 'Choose'}
          disabled={!listing?.path}
          onPress={() => context.runAction(block.action, scope, listing?.path)}
        />
      )}
    </View>
  );
}

/** Asks before an action that says to - resolves false when cancelled. */
export function confirmAction(message: string, label = 'Continue'): Promise<boolean> {
  return new Promise(done => {
    Alert.alert(message, undefined, [
      {text: 'Cancel', style: 'cancel', onPress: () => done(false)},
      {text: label, onPress: () => done(true)},
    ], {cancelable: true, onDismiss: () => done(false)});
  });
}

const styles = StyleSheet.create({
  body: {...type.body, color: palette.text},
  mono: {fontFamily: 'monospace', fontSize: 12, color: palette.text2},
  label: {...type.caption, color: palette.text2},
  value: {...type.label, fontWeight: '600', flexShrink: 1, textAlign: 'right'},
  metricValue: {...type.title, fontSize: 20},
  field: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: space.md},
  metric: {gap: space.sm},
  bar: {height: 6, borderRadius: 3, backgroundColor: palette.controlStrong, overflow: 'hidden'},
  barFill: {height: 6, borderRadius: 3},
  card: {gap: space.md},
  list: {gap: 2},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    minHeight: 52,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radii.control,
    backgroundColor: palette.control,
  },
  rowMain: {flex: 1, minWidth: 0, gap: 2},
  rowTitle: {...type.label, fontWeight: '600'},
  pressed: {opacity: 0.8},
  toggle: {flexDirection: 'row', alignItems: 'center', gap: space.md},
  danger: {
    minHeight: 48,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: space.lg,
    backgroundColor: 'rgba(238, 68, 75, 0.14)',
  },
  dangerLabel: {fontSize: 16, fontWeight: '700', color: palette.danger},
  form: {gap: space.md},
  inputField: {gap: space.xs},
  input: {
    minHeight: 46,
    paddingHorizontal: space.md,
    borderRadius: radii.control,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: palette.line,
    backgroundColor: palette.field,
    color: palette.text,
    fontSize: 15,
  },
  options: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
  option: {paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: 999, backgroundColor: palette.control},
  optionLabel: {...type.caption, color: palette.text, fontWeight: '600'},
  error: {color: palette.danger, fontSize: 13},
  unsupported: {...type.caption, padding: space.md, borderRadius: radii.control, backgroundColor: palette.control},
});
