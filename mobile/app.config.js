const fs = require('node:fs');
const path = require('node:path');

const ANDROID_PACKAGE = 'com.baristajobmatch.app';

module.exports = ({ config }) => {
  const platform = process.env.EAS_BUILD_PLATFORM;
  const profile = process.env.EAS_BUILD_PROFILE;
  const licenseTesting = process.env.EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING;
  const androidReview = profile === 'android-payment-review';
  // EAS supplies profile.env during local config resolution, but its built-in
  // profile/platform metadata and secret file variables exist on the builder.
  const hasBuilderMetadata = profile !== undefined || platform !== undefined || process.env.EAS_BUILD === 'true';
  if (licenseTesting && !['true', 'false'].includes(licenseTesting)) {
    throw new Error('EXPO_PUBLIC_GOOGLE_PLAY_LICENSE_TESTING must be true only in the isolated android-payment-review build.');
  }
  if (androidReview || licenseTesting === 'true') {
    if (licenseTesting !== 'true' || (hasBuilderMetadata && (!androidReview || platform !== 'android'))) {
      throw new Error('Google Play license testing requires the android-payment-review profile and Android platform.');
    }
    const androidKey = process.env.EXPO_PUBLIC_ANDROID_TEST_SUPABASE_PUBLISHABLE_KEY || '';
    if (process.env.EXPO_NO_DOTENV !== '1' || process.env.EXPO_PUBLIC_NATIVE_SUBSCRIPTIONS_ENABLED !== 'true'
      || process.env.EXPO_PUBLIC_API_BASE_URL !== 'https://android-testing.baristajobmatch.com/api'
      || process.env.EXPO_PUBLIC_SUPABASE_URL !== 'https://ojvjlvojvozvhktbclcg.supabase.co'
      || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(androidKey)
      || androidKey === 'sb_publishable_470rDNz5G4PrUD5mvMu4Eg_LPcLOM4x') {
      throw new Error('The Android payment-review build must use its pinned isolated test API and database configuration.');
    }
  }
  // Android credentials do not gate an iOS release or local configuration checks.
  if (platform === 'ios') return config;
  const required = (profile === 'production' || androidReview) && platform === 'android';
  const localFile = path.join(__dirname, 'google-services.json');
  const supplied = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(localFile) ? localFile : '');
  if (!supplied) {
    if (required) throw new Error(`${androidReview ? 'Android payment-review' : 'Production Android'} push notifications require GOOGLE_SERVICES_JSON as an EAS file variable, or a reviewed mobile/google-services.json for com.baristajobmatch.app. Configure the real Firebase Android app before building.`);
    return config;
  }

  const filename = path.resolve(__dirname, supplied);
  // A secret EAS file path may be unavailable to the local CLI. The remote
  // Android store build must still read and validate the actual Firebase file.
  if (licenseTesting === 'true' && !hasBuilderMetadata && !fs.existsSync(filename)) return config;
  let firebase;
  try { firebase = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch { throw new Error('The Android Firebase configuration could not be read as JSON. GOOGLE_SERVICES_JSON must point to the downloaded google-services.json file.'); }
  const client = Array.isArray(firebase?.client) ? firebase.client.find(entry => entry?.client_info?.android_client_info?.package_name === ANDROID_PACKAGE) : null;
  if (!client) throw new Error('The Android Firebase configuration has no client for com.baristajobmatch.app. Download google-services.json for the registered BaristaMatch Android app.');
  const text = value => typeof value === 'string' && value.trim().length > 0;
  if (!text(firebase.project_info?.project_id) || !text(firebase.project_info?.project_number) || !text(client.client_info?.mobilesdk_app_id) || !Array.isArray(client.api_key) || !client.api_key.some(entry => text(entry?.current_key))) {
    throw new Error('The Android Firebase client configuration is incomplete. Download a fresh google-services.json from the existing Firebase project.');
  }
  // Keep Firebase contents and credentials out of Expo extra and the JS runtime.
  return { ...config, android: { ...config.android, googleServicesFile: filename } };
};
