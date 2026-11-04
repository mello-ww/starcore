import React, {useState} from 'react';
import {KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {Button} from '../components/Button';
import {ScreenTitle} from '../components/ScreenTitle';
import {Surface} from '../components/Surface';
import {fonts, tokens, useAccent, useTopInset} from '../theme';
import {FloatingPlayerSpacer} from '../components/FloatingPlayerInset';

const {palette, radii, space, type} = tokens;

interface CommandResult {
  command: string;
  output: string;
  error: string | null;
}

/**
 * "Console" tab: the Core's own console/logs, not a satellite's - see
 * "New mobile bottom navigation" in the task brief. Reuses
 * `POST /api/commands/execute`, the exact endpoint the terminal CLI and
 * Mission Control's own console already run through (see docs/api.md), so
 * behavior and output match them exactly.
 */
export function ConsoleScreen() {
  const {client} = useAuth();
  const {color: accent} = useAccent();
  const top = useTopInset();
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<CommandResult[]>([]);
  const [running, setRunning] = useState(false);

  const run = async () => {
    const trimmed = command.trim();
    if (!trimmed || running) {
      return;
    }
    setRunning(true);
    try {
      const {body} = await client.post('/api/commands/execute', {command: trimmed});
      setHistory(previous => [...previous, body as CommandResult]);
      setCommand('');
    } finally {
      setRunning(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView style={styles.log} contentContainerStyle={[styles.logContent, {paddingTop: top + space.xl}]}>
        <ScreenTitle eyebrow="StarCore" title="Console" subtitle="Runs commands on this server, as the terminal CLI does." developerToggle />
        <Surface style={styles.output}>
          {history.length === 0 && <Text style={styles.idle}>Run a StarCore command to see its output here.</Text>}
          {history.map((entry, index) => (
            <View key={index} style={styles.entry}>
              <Text style={styles.mono}>
                <Text style={{color: accent}}>{'> '}</Text>
                <Text style={styles.command}>{entry.command}</Text>
              </Text>
              {entry.output ? <Text style={styles.mono}>{entry.output}</Text> : null}
              {entry.error ? <Text style={[styles.mono, styles.error]}>{entry.error}</Text> : null}
            </View>
          ))}
        </Surface>
      </ScrollView>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={command}
          onChangeText={setCommand}
          placeholder="Enter a command"
          placeholderTextColor={palette.text3}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={run}
          returnKeyType="send"
        />
        <Button title="Run" onPress={run} disabled={running || !command.trim()} loading={running} />
      </View>
      {/* the command line stays clear of the floating player */}
      <FloatingPlayerSpacer />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: palette.bg},
  log: {flex: 1},
  logContent: {paddingHorizontal: space.lg, paddingBottom: space.lg, gap: space.md},
  output: {gap: space.md, minHeight: 160},
  idle: {...type.caption, color: palette.text3},
  entry: {gap: space.xs},
  mono: {fontFamily: fonts.mono, fontSize: 13, lineHeight: 19, color: palette.text2},
  command: {color: palette.text},
  error: {color: palette.danger},
  inputRow: {
    flexDirection: 'row',
    gap: space.sm,
    padding: space.md,
    borderTopColor: palette.line,
    borderTopWidth: 1,
    backgroundColor: palette.bg,
  },
  input: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: space.md,
    borderRadius: radii.control,
    backgroundColor: palette.field,
    color: palette.text,
    fontFamily: fonts.mono,
    fontSize: 14,
  },
});
