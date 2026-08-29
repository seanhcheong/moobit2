/**
 * Moobit exercise-recognition test harness.
 *
 * Scope is deliberately recognition only: camera -> pose -> continuous exercise state, with the
 * instrumentation needed to measure how good and how fast that is. No character, no animation, no
 * game state.
 */

import React from 'react';
import { StatusBar, StyleSheet, View } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { HarnessScreen } from './src/app/screens/HarnessScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <View style={styles.root}>
        <StatusBar barStyle="light-content" backgroundColor="#020617" />
        <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
          <HarnessScreen />
        </SafeAreaView>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#020617' },
  safe: { flex: 1 },
});
