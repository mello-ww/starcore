import type {BottomTabBarProps, BottomTabNavigationEventMap, BottomTabNavigationOptions} from '@react-navigation/bottom-tabs';
import {
  createNavigatorFactory,
  DefaultNavigatorOptions,
  ParamListBase,
  TabActionHelpers,
  TabNavigationState,
  TabRouter,
  TabRouterOptions,
  useNavigationBuilder,
} from '@react-navigation/native';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {Animated, Easing, PanResponder, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {MOTION, useReducedMotion} from '../components/motion';
import {tokens} from '../theme';
import {claimsSwipe, swipeTarget} from './tabSwipe';

/** How long a page takes to slide into place, a little longer than a selection's move. */
const SLIDE = MOTION.move + 60;
const ease = Easing.bezier(0.2, 0.8, 0.2, 1);
/** The finger has to travel this far before the pages follow it (claimsSwipe's margin). */
const SLOP = 24;
/** Past either end the pages give way to the finger at this fraction, then spring back. */
const EDGE = 0.25;

type Props = DefaultNavigatorOptions<
  ParamListBase,
  TabNavigationState<ParamListBase>,
  BottomTabNavigationOptions,
  BottomTabNavigationEventMap
> &
  TabRouterOptions & {
    /** The bar under the pages, drawn with bottom-tabs' own props (its `BottomTabBar` fits). */
    tabBar: (props: BottomTabBarProps) => React.ReactNode;
  };

/**
 * Where the pages row sits for a drag of `dx` from page `index` of `count` pages `width` wide:
 * it follows the finger, past the margin the swipe needs, and gives way only a little past
 * either end, like a launcher's home screens.
 */
export function dragOffset(index: number, count: number, width: number, dx: number): number {
  const follow = Math.sign(dx) * Math.max(0, Math.abs(dx) - SLOP);
  const offset = -index * width + follow;
  const first = 0;
  const last = -(count - 1) * width;
  if (offset > first) {
    return first + (offset - first) * EDGE;
  }
  if (offset < last) {
    return last + (offset - last) * EDGE;
  }
  return offset;
}

/**
 * The app's main tabs as pages side by side, the way a launcher lays out its home screens: a
 * sideways swipe moves the pages with the finger and lets go onto the neighbour (or back), and a
 * press in the bar slides the next page in. The bar is bottom-tabs' own, fed the same props.
 * A page is mounted once it has been shown, or once a swipe brings it into sight; the pages off
 * screen are hidden from accessibility. Reduced motion places the pages at once.
 */
function PagerTabNavigator({id, initialRouteName, backBehavior, children, screenListeners, screenOptions, tabBar}: Props) {
  const {state, descriptors, navigation, NavigationContent} = useNavigationBuilder<
    TabNavigationState<ParamListBase>,
    TabRouterOptions,
    TabActionHelpers<ParamListBase>,
    BottomTabNavigationOptions,
    BottomTabNavigationEventMap
  >(TabRouter, {id, initialRouteName, backBehavior, children, screenListeners, screenOptions});
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [width, setWidth] = useState(0);
  const position = useRef(new Animated.Value(0)).current;
  const count = state.routes.length;
  const index = state.index;
  // the pages shown so far stay mounted, so coming back to one finds it as it was left
  const [loaded, setLoaded] = useState<Record<string, true>>(() => ({[state.routes[index].key]: true}));
  const live = useRef({index, count, width, state, navigation});
  live.current = {index, count, width, state, navigation};
  const shown = useRef(index);

  const loadAround = (at: number) => {
    const keys = [at - 1, at, at + 1].filter(i => i >= 0 && i < live.current.count).map(i => live.current.state.routes[i].key);
    setLoaded(previous => (keys.every(key => previous[key]) ? previous : {...previous, ...Object.fromEntries(keys.map(key => [key, true]))}));
  };

  const settle = (to: number, animated: boolean) => {
    const target = -to * live.current.width;
    position.stopAnimation();
    if (!animated || reduced) {
      position.setValue(target);
      return;
    }
    Animated.timing(position, {toValue: target, duration: SLIDE, easing: ease, useNativeDriver: true}).start();
  };

  // a new page (a press in the bar, the end of a swipe, a link from elsewhere) slides in from
  // its neighbour; one further along the bar is simply shown, as passing the pages between
  // would only flash them by
  useEffect(() => {
    const from = shown.current;
    shown.current = index;
    setLoaded(previous => (previous[state.routes[index].key] ? previous : {...previous, [state.routes[index].key]: true}));
    settle(index, Math.abs(from - index) === 1);
  }, [index, width]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        // asked on the way down, before the screen's own views (tabSwipe.ts says why); a
        // slider, a drag handle or a native horizontal list keeps its own move
        onMoveShouldSetPanResponderCapture: (_, gesture) => claimsSwipe(gesture),
        onPanResponderGrant: () => {
          position.stopAnimation();
          loadAround(live.current.index);
        },
        onPanResponderMove: (_, gesture) => {
          const {index: at, count: pages, width: wide} = live.current;
          position.setValue(dragOffset(at, pages, wide, gesture.dx));
        },
        onPanResponderTerminationRequest: () => true,
        onPanResponderRelease: (_, gesture) => {
          const {state: now, navigation: tabs, index: at} = live.current;
          const target = swipeTarget(now, gesture.dx, gesture.dy, gesture.vx);
          if (target && target !== now.routes[at].name) {
            const route = now.routes.find(item => item.name === target)!;
            const event = tabs.emit({type: 'tabPress', target: route.key, canPreventDefault: true});
            if (!event.defaultPrevented) {
              tabs.navigate(target);
              return;
            }
          }
          settle(at, true);
        },
        onPanResponderTerminate: () => settle(live.current.index, true),
      }),
    [position, reduced],
  );

  return (
    <NavigationContent>
      <View style={styles.fill}>
        <View
          style={styles.viewport}
          onLayout={event => setWidth(Math.round(event.nativeEvent.layout.width))}
          {...pan.panHandlers}>
          {width > 0 && (
            <Animated.View style={[styles.row, {width: width * count, transform: [{translateX: position}]}]}>
              {state.routes.map((route, i) => (
                <View
                  key={route.key}
                  style={{width}}
                  testID={`pager-page-${route.name}`}
                  accessibilityElementsHidden={i !== index}
                  importantForAccessibility={i === index ? 'auto' : 'no-hide-descendants'}>
                  {loaded[route.key] ? descriptors[route.key].render() : null}
                </View>
              ))}
            </Animated.View>
          )}
        </View>
        {tabBar({state, descriptors, navigation, insets} as unknown as BottomTabBarProps)}
      </View>
    </NavigationContent>
  );
}

/** A tab navigator laid out as sliding pages (PagerTabNavigator), with bottom-tabs' screen options. */
export const createPagerTabNavigator = createNavigatorFactory<
  TabNavigationState<ParamListBase>,
  BottomTabNavigationOptions,
  BottomTabNavigationEventMap,
  typeof PagerTabNavigator
>(PagerTabNavigator);

const styles = StyleSheet.create({
  fill: {flex: 1},
  viewport: {flex: 1, overflow: 'hidden', backgroundColor: tokens.palette.bg},
  row: {flex: 1, flexDirection: 'row'},
});
