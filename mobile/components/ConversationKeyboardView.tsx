import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { Keyboard, KeyboardAvoidingView, Platform, TextInput, type TextInputProps, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

export function ConversationKeyboardView({ children, style }: PropsWithChildren<{ style?: StyleProp<ViewStyle> }>) {
  const insets = useSafeAreaInsets();
  const [keyboardVisible, setKeyboardVisible] = useState(() => Keyboard.isVisible());

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const show = Keyboard.addListener('keyboardDidShow', () => setKeyboardVisible(true));
    const hide = Keyboard.addListener('keyboardDidHide', () => setKeyboardVisible(false));
    setKeyboardVisible(Keyboard.isVisible());
    return () => { show.remove(); hide.remove(); };
  }, []);

  // Older Android hide events report the visible window's height instead of a
  // screen coordinate. Disable avoidance after hiding so the top inset cannot
  // leave stale padding. The root layout already supplies Android safe areas.
  return (
    <KeyboardAvoidingView style={style} behavior="padding"
      enabled={Platform.OS !== 'android' || keyboardVisible}
      keyboardVerticalOffset={Platform.OS === 'android' ? insets.top : 0}>
      {children}
    </KeyboardAvoidingView>
  );
}

export function ConversationTextInput(props: TextInputProps) {
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    // Android Back can hide the keyboard while retaining native input focus.
    // Release this input's focus so another tap can open the keyboard again.
    const hide = Keyboard.addListener('keyboardDidHide', () => input.current?.blur());
    return () => hide.remove();
  }, []);
  return <TextInput {...props} ref={input} />;
}
