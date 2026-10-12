import { Platform } from 'react-native';

export const privacyPolicyUrl = () => Platform.OS === 'android'
  ? 'https://baristamatch-android-baristamatch.vercel.app/android-privacy'
  : 'https://www.baristajobmatch.com/privacy.html';

export const termsOfServiceUrl = () => Platform.OS === 'android'
  ? 'https://baristamatch-android-baristamatch.vercel.app/android-terms'
  : 'https://www.baristajobmatch.com/terms.html';
