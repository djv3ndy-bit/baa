import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

type Props = { children: ReactNode };
type State = { failed: boolean };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Recovered from app screen error', error, info.componentStack);
  }

  private recover = () => {
    this.setState({ failed: false });
    router.replace('/');
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <View style={styles.screen}>
        <Text style={styles.logo}>☕</Text>
        <Text style={styles.title}>Let’s try that again</Text>
        <Text style={styles.copy}>BaristaMatch recovered safely. Your account and information are unchanged.</Text>
        <Pressable accessibilityRole="button" onPress={this.recover} style={styles.button}>
          <Text style={styles.buttonText}>Reopen BaristaMatch</Text>
        </Pressable>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fbf7f1', padding: 28 },
  logo: { fontSize: 52, marginBottom: 18 },
  title: { fontSize: 26, fontWeight: '900', color: '#321708', textAlign: 'center' },
  copy: { maxWidth: 320, marginTop: 10, fontSize: 15, lineHeight: 22, color: '#746a61', textAlign: 'center' },
  button: { width: '100%', maxWidth: 340, marginTop: 24, borderRadius: 16, backgroundColor: '#a95820', paddingVertical: 16, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 16, fontWeight: '900' },
});
