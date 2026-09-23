import React from 'react';
import {Alert, StyleSheet, Text, View} from 'react-native';
import {Card} from '../components/Card';
import {PrimaryButton} from '../components/PrimaryButton';
import {colors, spacing, typography} from '../theme';
import type {UiAction, UiItem, UiScreen} from './types';

/**
 * Renders the declarative UI a Satellite's "mobile" route describes (see
 * "Exposing a mobile interface" in docs/satellites.md) using this app's
 * own components - StarCore's server describes *what* to show, this
 * decides *how*. Never downloads or executes any code from the server;
 * `screen` is plain, already-parsed JSON data.
 *
 * An item whose `type` this renderer doesn't know yet is silently
 * skipped, so a Satellite ahead of this app version degrades instead of
 * crashing - see the schema's own forward-compatibility note.
 */
export function DeclarativeScreen({
  screen,
  onAction,
}: {
  screen: UiScreen;
  onAction: (action: UiAction) => void | Promise<void>;
}) {
  return (
    <View style={styles.content}>
      {screen.sections.map((section, sectionIndex) => (
        <Card key={sectionIndex} style={styles.card}>
          {section.title ? <Text style={typography.heading}>{section.title}</Text> : null}
          {section.items.map((item, itemIndex) => (
            <UiItemView key={itemIndex} item={item} onAction={onAction} />
          ))}
        </Card>
      ))}
    </View>
  );
}

function UiItemView({item, onAction}: {item: UiItem; onAction: (action: UiAction) => void | Promise<void>}) {
  switch (item.type) {
    case 'text': {
      const style = item.style === 'heading' ? typography.heading : item.style === 'caption' ? typography.caption : typography.body;
      return <Text style={style}>{String(item.value)}</Text>;
    }
    case 'status':
      return (
        <View style={styles.statusRow}>
          <Text style={typography.label}>{item.label}</Text>
          <Text style={typography.body}>{item.value}</Text>
        </View>
      );
    case 'list':
      return (
        <View style={styles.list}>
          {item.items.map((row, index) => (
            <View key={index} style={styles.listRow}>
              <Text style={typography.body}>{row.title}</Text>
              {row.subtitle ? <Text style={typography.caption}>{row.subtitle}</Text> : null}
            </View>
          ))}
        </View>
      );
    case 'button':
      return (
        <PrimaryButton
          title={item.label}
          variant="secondary"
          onPress={() => {
            if (item.action.confirm) {
              Alert.alert(item.action.confirm, undefined, [
                {text: 'Cancel', style: 'cancel'},
                {text: item.label, onPress: () => onAction(item.action)},
              ]);
            } else {
              onAction(item.action);
            }
          }}
        />
      );
    default:
      // an item type this build doesn't understand yet - see the module docstring
      return null;
  }
}

const styles = StyleSheet.create({
  content: {gap: spacing.md},
  card: {gap: spacing.sm},
  statusRow: {flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm},
  list: {gap: spacing.xs},
  listRow: {borderBottomColor: colors.line, borderBottomWidth: StyleSheet.hairlineWidth, paddingBottom: spacing.xs},
});
