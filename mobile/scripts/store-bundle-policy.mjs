// App code changes ship in a reviewed store binary. Data/media APIs remain available.
export function validateBundleOnlyConfiguration(app, pkg, eas) {
  const errors = [];
  if (app?.updates?.enabled !== false) errors.push('Remote app updates must be explicitly disabled.');
  if (app?.updates?.url || app?.runtimeVersion) errors.push('Remove remote update URLs and runtime mappings from store configuration.');
  for (const dependencies of [pkg?.dependencies, pkg?.devDependencies, pkg?.optionalDependencies]) {
    for (const name of ['expo-updates', 'expo-dev-client', 'expo-dev-launcher', 'react-native-code-push']) {
      if (dependencies?.[name]) errors.push(`Store app must not include ${name}.`);
    }
  }
  for (const [name, profile] of Object.entries(eas?.build || {})) {
    if (profile.channel) errors.push(`Remove the remote update channel from build profile ${name}.`);
    if ((name === 'production' || profile.distribution === 'store' || profile.extends === 'production') && profile.developmentClient) {
      errors.push(`Store profile ${name} must not be a development client.`);
    }
  }
  return errors;
}
