import React, {useCallback, useEffect, useMemo, useState} from 'react';
// core Clipboard: deprecated in favour of a separate package, but still
// shipped and working in React Native 0.73 - not worth a new native dependency
import {Clipboard, StyleSheet, Text, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {
  appBuildInfo,
  buildInfoReport,
  commitLabel,
  EngineBuildInfo,
  parseEngineBuild,
} from '../platform/buildInfo';
import {tokens} from '../theme';
import {fonts} from '../theme/typography';
import {Button} from './Button';
import {Surface} from './Surface';

const {palette, space, type} = tokens;

function Fact({label, value, testID}: {label: string; value: string; testID?: string}) {
  return (
    <View style={styles.fact}>
      <Text style={styles.factLabel}>{label}</Text>
      <Text style={styles.factValue} testID={testID} selectable>
        {value}
      </Text>
    </View>
  );
}

/** Settings > About: this app's build, and - separately, since they are
 * released and updated independently - the connected Engine's. */
export function AboutCard() {
  const {client} = useAuth();
  const app = useMemo(appBuildInfo, []);
  const [engine, setEngine] = useState<EngineBuildInfo | null>(null);
  const [engineError, setEngineError] = useState<string | undefined>();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    client
      .get('/api/status')
      .then(({status, body}) => {
        if (!live) {
          return;
        }
        const build = status === 200 ? parseEngineBuild(body?.build) : null;
        setEngine(build);
        setEngineError(status !== 200 ? 'unreachable' : build ? undefined : 'version not reported (older Engine)');
      })
      .catch(() => live && setEngineError('unreachable'));
    return () => {
      live = false;
    };
  }, [client]);

  useEffect(() => {
    if (!copied) {
      return;
    }
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = useCallback(() => {
    Clipboard.setString(buildInfoReport(app, engine, engineError));
    setCopied(true);
  }, [app, engine, engineError]);

  return (
    <Surface style={styles.card}>
      <Text style={styles.eyebrow}>About</Text>

      <Text style={type.title}>StarCore for Android</Text>
      <View style={styles.facts}>
        <Fact label="Version" value={app.version} testID="about-app-version" />
        <Fact label="Channel" value={app.channel} />
        <Fact label="Build" value={app.buildNumber ? String(app.buildNumber) : 'unknown'} />
        <Fact label="Commit" value={commitLabel(app.commit, app.dirty)} testID="about-app-commit" />
        <Fact label="Build date" value={app.buildDate ?? 'unknown'} />
      </View>

      <Text style={type.title}>Connected Engine</Text>
      {engine ? (
        <View style={styles.facts}>
          <Fact label="Version" value={engine.version} testID="about-engine-version" />
          <Fact label="Channel" value={engine.channel} />
          <Fact label="Build" value={engine.build ? String(engine.build) : 'unknown'} />
          <Fact label="Commit" value={commitLabel(engine.commit, engine.dirty)} />
          <Fact label="Date" value={engine.date ? engine.date.slice(0, 10) : 'unknown'} />
        </View>
      ) : (
        <Text style={type.caption} testID="about-engine-missing">
          {engineError ? `Engine ${engineError}.` : 'Checking...'}
        </Text>
      )}

      <View style={styles.actions}>
        <Button title={copied ? 'Copied' : 'Copy build info'} variant="secondary" onPress={copy} />
      </View>
    </Surface>
  );
}

/** The quiet version line at the very bottom of Settings. */
export function VersionFootnote() {
  const app = useMemo(appBuildInfo, []);
  const build = app.buildNumber ? ` · build ${app.buildNumber}` : '';
  return (
    <Text style={styles.footnote} testID="version-footnote">
      StarCore {app.version}
      {build}
    </Text>
  );
}

const styles = StyleSheet.create({
  card: {gap: space.md},
  eyebrow: {...type.eyebrow, textTransform: 'uppercase'},
  facts: {flexDirection: 'row', flexWrap: 'wrap', rowGap: space.md, columnGap: space.lg},
  fact: {minWidth: '40%', gap: 2},
  factLabel: {color: palette.text3, fontSize: 11, fontWeight: '600', letterSpacing: 1.2, textTransform: 'uppercase'},
  factValue: {color: palette.text, fontFamily: fonts.mono, fontSize: 13},
  actions: {flexDirection: 'row'},
  footnote: {color: palette.text3, fontFamily: fonts.mono, fontSize: 11, textAlign: 'center', opacity: 0.7},
});
