const fs = require('node:fs');
const path = require('node:path');

const ANDROID_PACKAGE = 'com.baristajobmatch.app';

module.exports = ({ config }) => {
  // Android credentials do not gate an iOS release or local configuration checks.
  if (process.env.EAS_BUILD_PLATFORM === 'ios') return config;
  const required = process.env.EAS_BUILD_PROFILE === 'production' && process.env.EAS_BUILD_PLATFORM === 'android';
  const localFile = path.join(__dirname, 'google-services.json');
  const supplied = process.env.GOOGLE_SERVICES_JSON || (fs.existsSync(localFile) ? localFile : '');
  if (!supplied) {
    if (required) throw new Error('Production Android push notifications require GOOGLE_SERVICES_JSON as an EAS file variable, or a reviewed mobile/google-services.json for com.baristajobmatch.app. Configure the real Firebase Android app before building.');
    return config;
  }

  const filename = path.resolve(__dirname, supplied);
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
