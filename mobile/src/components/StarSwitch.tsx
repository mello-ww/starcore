import React from 'react';
import {Switch, SwitchProps} from 'react-native';
import {tokens, useAccent} from '../theme';

/** StarCore's one on/off control: the accent track when on, neutral when off, on every screen. */
export function StarSwitch(props: Omit<SwitchProps, 'trackColor' | 'thumbColor' | 'ios_backgroundColor'>) {
  const {color} = useAccent();
  return (
    <Switch
      {...props}
      trackColor={{false: tokens.palette.controlStrong, true: color}}
      thumbColor={props.value ? tokens.palette.text : tokens.palette.text2}
      ios_backgroundColor={tokens.palette.controlStrong}
    />
  );
}
