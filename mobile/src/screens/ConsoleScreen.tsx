import React, {useState} from 'react';
import {KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View} from 'react-native';
import {useAuth} from '../auth/AuthContext';
import {PrimaryButton} from '../components/PrimaryButton';
import {colors, spacing, typography} from '../theme';

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
      <ScrollView style={styles.log} contentContainerStyle={styles.logContent}>
        {history.length === 0 && <Text style={typography.caption}>Run a StarCore command to see its output here.</Text>}
        {history.map((entry, index) => (
          <View key={index} style={styles.entry}>
            <Text style={[typography.mono, styles.prompt]}>{'> '}{entry.command}</Text>
            {entry.output ? <Text style={typography.mono}>{entry.output}</Text> : null}
            {entry.error ? <Text style={[typography.mono, styles.error]}>{entry.error}</Text> : null}
          </View>
        ))}
      </ScrollView>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={command}
          onChangeText={setCommand}
          placeholder="Enter a command"
          placeholderTextColor={colors.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={run}
          returnKeyType="send"
        />
        <PrimaryButton title="Run" onPress={run} disabled={running || !command.trim()} loading={running} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  log: {flex: 1},
  logContent: {padding: spacing.lg, gap: spacing.sm},
  entry: {gap: spacing.xs},
  prompt: {color: colors.azure},
  error: {color: colors.alert},
  inputRow: {flexDirection: 'row', gap: spacing.sm, padding: spacing.md, borderTopColor: colors.line, borderTopWidth: 1},
  input: {
    flex: 1,
    color: colors.text,
    fontFamily: typography.mono.fontFamily,
    backgroundColor: colors.raised,
    borderRadius: 8,
    paddingHorizontal: spacing.sm,
  },
});
