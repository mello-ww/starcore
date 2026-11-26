import React, {forwardRef, useState} from 'react';
import {TextInput, TextInputProps} from 'react-native';
import {useAccent} from '../theme';

/** The accent on a text field's caret and selection, for a field that draws its own frame (a
 * search bar's). */
export function useInputAccent() {
  const {color} = useAccent();
  return {cursorColor: color, selectionColor: `${color}66`};
}

/** StarCore's one text field: its frame takes the accent while it has the focus, as on the web,
 * and so do its caret and selection. Styled by the caller; the focused border replaces its own. */
export const StarInput = forwardRef<TextInput, TextInputProps>(function StarInput(
  {style, onFocus, onBlur, ...props},
  ref,
) {
  const {color} = useAccent();
  const accent = useInputAccent();
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      ref={ref}
      {...accent}
      {...props}
      style={[style, focused && {borderColor: color, borderWidth: 1}]}
      onFocus={event => {
        setFocused(true);
        onFocus?.(event);
      }}
      onBlur={event => {
        setFocused(false);
        onBlur?.(event);
      }}
    />
  );
});
