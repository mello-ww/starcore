import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { TOUCH_TARGET, tokens, useAccent } from "../theme";

const { palette, radii, space } = tokens;
const SWATCH_SLOP = 4;

function hslHex(h: number, s: number, l: number): string {
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) =>
        l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return `#${[0, 8, 4]
        .map((n) =>
            Math.round(f(n) * 255)
                .toString(16)
                .padStart(2, "0"),
        )
        .join("")}`;
}

/** A compact colour picker: seven hues in three shades, plus greys. Seven
 * columns keep each swatch (with its hit slop) at a 44dp touch target. */
export const PICKER_COLUMNS = 7;
export const PICKER_COLORS: string[][] = [0.72, 0.6, 0.45]
    .map((l) =>
        Array.from({ length: PICKER_COLUMNS }, (_, i) =>
            hslHex(Math.round((i * 360) / PICKER_COLUMNS), 0.82, l),
        ),
    )
    .concat([
        [
            "#ffffff",
            "#e6e7eb",
            "#a6a8b1",
            "#6e717a",
            "#3f4147",
            "#1c1d21",
            "#000000",
        ],
    ]);

/** The custom half of the accent menu: a colour grid and an editable HEX field. A valid HEX
 * previews and saves at once; an invalid one is flagged and never applied. */
export function AccentCustomColor() {
    const { color, onColor, setAccent } = useAccent();
    const [text, setText] = useState(color.toUpperCase());
    const [focused, setFocused] = useState(false);
    const valid = tokens.normalizeHex(text) !== null;

    useEffect(() => {
        if (!focused) {
            setText(color.toUpperCase());
        }
    }, [color, focused]);

    const onChange = (value: string) => {
        setText(value);
        const hex = tokens.normalizeHex(value);
        if (hex) {
            setAccent(hex);
        }
    };

    return (
        <View style={styles.wrap}>
            <View
                style={styles.grid}
                accessibilityLabel="Custom accent colours"
            >
                {PICKER_COLORS.map((row) => (
                    <View key={row[0]} style={styles.row}>
                        {row.map((swatch) => (
                            <Pressable
                                key={swatch}
                                onPress={() => setAccent(swatch)}
                                accessibilityRole="button"
                                accessibilityLabel={`Accent ${swatch.toUpperCase()}`}
                                accessibilityState={{
                                    selected: swatch === color,
                                }}
                                testID={`accent-color-${swatch.slice(1)}`}
                                hitSlop={SWATCH_SLOP}
                                style={[
                                    styles.cell,
                                    { backgroundColor: swatch },
                                    swatch === color && styles.cellActive,
                                ]}
                            />
                        ))}
                    </View>
                ))}
            </View>
            <View style={styles.hexRow}>
                <View style={[styles.preview, { backgroundColor: color }]}>
                    <Text style={[styles.previewLabel, { color: onColor }]}>
                        Aa
                    </Text>
                </View>
                <TextInput
                    value={text}
                    onChangeText={onChange}
                    onFocus={() => setFocused(true)}
                    onBlur={() => {
                        setFocused(false);
                        setText(color.toUpperCase());
                    }}
                    autoCapitalize="characters"
                    autoCorrect={false}
                    maxLength={7}
                    placeholder="#RRGGBB"
                    placeholderTextColor={palette.text3}
                    accessibilityLabel="Custom accent HEX value"
                    accessibilityHint={
                        valid ? undefined : "Enter a colour such as #EE444B"
                    }
                    testID="accent-hex"
                    style={[
                        styles.hex,
                        focused && { borderColor: color },
                        !valid && styles.hexInvalid,
                    ]}
                />
            </View>
            {!valid && (
                <Text style={styles.error}>
                    Use 3 or 6 HEX digits, like #EE444B.
                </Text>
            )}
        </View>
    );
}

const styles = StyleSheet.create({
    wrap: {
        gap: space.md,
        paddingHorizontal: space.sm,
        paddingBottom: space.sm,
    },
    grid: { gap: SWATCH_SLOP * 2 },
    row: { flexDirection: "row", gap: SWATCH_SLOP * 2 },
    cell: {
        flex: 1,
        aspectRatio: 1,
        borderRadius: 8,
        borderWidth: 2,
        borderColor: "transparent",
    },
    cellActive: { borderColor: palette.text },
    hexRow: { flexDirection: "row", alignItems: "center", gap: space.sm },
    preview: {
        width: TOUCH_TARGET,
        height: TOUCH_TARGET,
        borderRadius: radii.control,
        alignItems: "center",
        justifyContent: "center",
    },
    previewLabel: { fontSize: 15, fontWeight: "700" },
    hex: {
        flex: 1,
        height: TOUCH_TARGET,
        paddingHorizontal: space.md,
        borderRadius: radii.control,
        borderWidth: 1,
        borderColor: palette.line,
        backgroundColor: palette.field,
        color: palette.text,
        fontFamily: "monospace",
        fontSize: 15,
        letterSpacing: 1,
    },
    hexInvalid: { borderColor: palette.danger },
    error: { color: palette.danger, fontSize: 12 },
});
