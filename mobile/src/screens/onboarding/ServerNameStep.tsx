import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import React, {useState} from 'react';
import {KeyboardAvoidingView, Platform, StyleSheet, Text, TextInput, View} from 'react-native';
import {Card} from '../../components/Card';
import {PrimaryButton} from '../../components/PrimaryButton';
import {Starfield} from '../../components/Starfield';
import type {OnboardingStackParamList} from '../../navigation/OnboardingNavigator';
import {colors, spacing, typography} from '../../theme';

type Props = NativeStackScreenProps<OnboardingStackParamList, 'ServerName'>;

/** First onboarding step - purely a label, optional, same field the "Add
 * Server" flow (ConnectScreen) collects. Nothing here is validated; the
 * address step that follows is where a real server has to answer. */
export function ServerNameStep({navigation, route}: Props) {
  const [name, setName] = useState(route.params?.name ?? '');

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Starfield />
      <View style={styles.content}>
        <Text style={typography.title}>Welcome to StarCore</Text>
        <Text style={[typography.caption, styles.subtitle]}>
          Let's connect to your own StarCore server. First, what should we call it?
        </Text>

        <Card style={styles.card}>
          <Text style={typography.label}>NAME (OPTIONAL)</Text>
          <TextInput
            style={styles.input}
            value={name}
            onChangeText={setName}
            placeholder="Home"
            placeholderTextColor={colors.textFaint}
            autoCapitalize="words"
            testID="onboarding-name-input"
          />
        </Card>

        <PrimaryButton title="Continue" onPress={() => navigation.navigate('ServerAddress', {name})} />
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {flex: 1, backgroundColor: colors.void},
  content: {flex: 1, justifyContent: 'center', padding: spacing.lg, gap: spacing.md},
  subtitle: {marginBottom: spacing.md},
  card: {gap: spacing.xs, marginBottom: spacing.lg},
  input: {color: colors.text, fontSize: 16, paddingVertical: spacing.sm},
});
