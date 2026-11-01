const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const SCENE_FILE = 'BaristaMatchSceneDelegate.swift';
const SCENE_CLASS = 'BaristaMatchSceneDelegate';
const MARKER = '// BaristaMatch: React starts in the application scene.';
const LEGACY_START = `#if os(iOS) || os(tvOS)
    window = UIWindow(frame: UIScreen.main.bounds)
    factory.startReactNative(
      withModuleName: "main",
      in: window,
      launchOptions: launchOptions)
#endif`;
const SCENE_START = `${MARKER}\n    bjmSceneLaunchOptions = launchOptions`;

function checkVersions(projectRoot) {
  for (const [name, version] of Object.entries({ expo: '54.0.37', 'expo-modules-core': '3.0.30', 'react-native': '0.81.5' })) {
    const file = require.resolve(`${name}/package.json`, { paths: [projectRoot] });
    if (JSON.parse(fs.readFileSync(file, 'utf8')).version !== version) throw Error(`Review scene integration before changing ${name}.`);
  }
}
function patchAppDelegate(source) {
  if (source.includes(MARKER)) {
    if (source.split(MARKER).length !== 2 || !source.includes(SCENE_START)
      || source.includes('UIWindow(frame:') || source.includes('factory.startReactNative(')
      || source.split('var bjmSceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?').length !== 2
      || source.split('bindReactNativeFactory(factory)').length !== 2
      || source.split('return super.application(application, didFinishLaunchingWithOptions: launchOptions)').length !== 2) {
      throw Error('Unexpected existing iOS scene integration.');
    }
    return source;
  }
  if (source.includes('SceneDelegate') || source.includes('bjmSceneLaunchOptions')
    || source.split(LEGACY_START).length !== 2 || source.split('  var window: UIWindow?').length !== 2
    || !source.includes('public class AppDelegate: ExpoAppDelegate')
    || !source.includes('bindReactNativeFactory(factory)')
    || source.split('return super.application(application, didFinishLaunchingWithOptions: launchOptions)').length !== 2) {
    throw Error('Review the Expo 54 AppDelegate before applying scene integration.');
  }
  return source.replace('  var window: UIWindow?', '  var window: UIWindow?\n  var bjmSceneLaunchOptions: [UIApplication.LaunchOptionsKey: Any]?')
    .replace(LEGACY_START, SCENE_START);
}
function addManifest(info) {
  const manifest = { UIApplicationSupportsMultipleScenes: false, UISceneConfigurations: {
    UIWindowSceneSessionRoleApplication: [{ UISceneConfigurationName: 'BaristaMatch', UISceneDelegateClassName: SCENE_CLASS }],
  } };
  if (info.UIApplicationSceneManifest && !isDeepStrictEqual(info.UIApplicationSceneManifest, manifest)) {
    throw Error('Review the existing UIApplicationSceneManifest before replacing it.');
  }
  return { ...info, UIApplicationSceneManifest: manifest };
}
function writeSceneFile(platformRoot, projectName) {
  if (!projectName || path.basename(projectName) !== projectName) throw Error('Missing iOS project name.');
  const target = path.join(platformRoot, projectName, SCENE_FILE);
  const asset = fs.readFileSync(path.join(__dirname, 'scene-lifecycle', SCENE_FILE), 'utf8');
  if (fs.existsSync(target)) {
    if (fs.readFileSync(target, 'utf8') !== asset) throw Error('Review the existing scene delegate before replacing it.');
    return;
  }
  fs.writeFileSync(target, asset);
}
function withIosSceneLifecycle(config) {
  const { withAppDelegate, withInfoPlist, withDangerousMod, withXcodeProject, IOSConfig } = require('expo/config-plugins');
  config = withAppDelegate(config, c => {
    checkVersions(c.modRequest.projectRoot);
    if (c.modResults.language !== 'swift') throw Error('Scene integration requires the reviewed Swift AppDelegate.');
    c.modResults.contents = patchAppDelegate(c.modResults.contents); return c;
  });
  config = withInfoPlist(config, c => { c.modResults = addManifest(c.modResults); return c; });
  config = withDangerousMod(config, ['ios', async c => {
    writeSceneFile(c.modRequest.platformProjectRoot, c.modRequest.projectName); return c;
  }]);
  return withXcodeProject(config, c => {
    const name = c.modRequest.projectName;
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({ filepath: `${name}/${SCENE_FILE}`, groupName: name, project: c.modResults });
    return c;
  });
}
module.exports = withIosSceneLifecycle;
Object.assign(module.exports, { patchAppDelegate, addManifest, writeSceneFile, checkVersions, SCENE_FILE, SCENE_CLASS, LEGACY_START });
