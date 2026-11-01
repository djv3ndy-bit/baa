const FLOOR = '15.1';
const BEGIN = '# BaristaMatch: iOS Pod deployment target floor begin';
const END = '# BaristaMatch: iOS Pod deployment target floor end';

function rubyHook(indent) {
  const lines = [
    BEGIN,
    "require 'rubygems/version'",
    `bjm_minimum_ios = Gem::Version.new('${FLOOR}')`,
    'bjm_ios_version = lambda do |value|',
    '  text = value.to_s.strip',
    "  if text.empty? || ['$(inherited)', '${inherited}'].include?(text)",
    '    nil',
    '  elsif text.match?(/\\A[0-9]+(?:\\.[0-9]+)*\\z/)',
    '    Gem::Version.new(text)',
    '  else',
    "    raise 'BaristaMatch: review an unrecognized iOS deployment target before building.'",
    '  end',
    'end',
    'installer.pods_project.targets.each do |target|',
    '  target.build_configurations.each do |configuration|',
    '    project_configuration = installer.pods_project.build_configurations.find { |entry| entry.name == configuration.name }',
    '    project_settings = project_configuration ? project_configuration.build_settings : {}',
    "    all_keys = (configuration.build_settings.keys + project_settings.keys + ['IPHONEOS_DEPLOYMENT_TARGET']).uniq",
    '    all_keys.each do |key|',
    "      if key.start_with?('IPHONEOS_DEPLOYMENT_TARGET[') && !key.match?(/\\AIPHONEOS_DEPLOYMENT_TARGET\\[sdk=[A-Za-z0-9*?._-]+\\]\\z/)",
    "        raise 'BaristaMatch: review an unrecognized iOS deployment target selector before building.'",
    '      end',
    '    end',
    '    keys = all_keys.select do |key|',
    "      key == 'IPHONEOS_DEPLOYMENT_TARGET' || key.match?(/\\AIPHONEOS_DEPLOYMENT_TARGET\\[sdk=iphone(?:os|simulator)[^\\]]*\\]\\z/)",
    '    end',
    '    keys.each do |key|',
    "      if key != 'IPHONEOS_DEPLOYMENT_TARGET' && [configuration.build_settings[key], project_settings[key]].any? { |value| ['$(inherited)', '${inherited}'].include?(value.to_s.strip) }",
    "        raise 'BaristaMatch: review an inherited conditional iOS deployment target before building.'",
    '      end',
    '      current = bjm_ios_version.call(configuration.build_settings[key])',
    '      effective = current',
    '      if effective.nil?',
    '        inherited_values = [project_settings[key]]',
    "        inherited_values << configuration.build_settings['IPHONEOS_DEPLOYMENT_TARGET'] unless key == 'IPHONEOS_DEPLOYMENT_TARGET'",
    "        inherited_values << project_settings['IPHONEOS_DEPLOYMENT_TARGET'] unless key == 'IPHONEOS_DEPLOYMENT_TARGET'",
    '        effective = inherited_values.map { |value| bjm_ios_version.call(value) }.compact.max',
    '      end',
    '      if effective.nil? || effective < bjm_minimum_ios',
    `        configuration.build_settings[key] = '${FLOOR}'`,
    '      end',
    '    end',
    '  end',
    'end',
    END,
  ];
  return '\n\n' + lines.map(line => indent + line).join('\n');
}

/** Run after RN's existing post_install; never create a second CocoaPods hook. */
function patchPodfile(contents) {
  const hooks = [...contents.matchAll(/^([ \t]*)post_install do \|installer\|[ \t]*$/gm)];
  const calls = [...contents.matchAll(/^([ \t]*)react_native_post_install\([\s\S]*?^\1\)[ \t]*$/gm)];
  if (hooks.length !== 1 || calls.length !== 1 || calls[0].index <= hooks[0].index
    || calls[0][1] !== hooks[0][1] + '  ') throw Error('Review the Expo Podfile post_install template before applying the iOS floor.');
  const block = rubyHook(calls[0][1]);
  const beginCount = contents.split(BEGIN).length - 1;
  const endCount = contents.split(END).length - 1;
  if (beginCount || endCount) {
    if (beginCount !== 1 || endCount !== 1 || !contents.includes(block)) throw Error('Review the existing iOS Pod floor hook before replacing it.');
    const clean = contents.replace(block, '');
    if (patchPodfile(clean) !== contents) throw Error('The iOS Pod floor hook moved outside the reviewed post_install location.');
    return contents;
  }
  const end = calls[0].index + calls[0][0].length;
  if (!new RegExp('^\\n' + hooks[0][1] + 'end(?:\\n|$)').test(contents.slice(end))) {
    throw Error('Review statements after react_native_post_install before applying the iOS floor.');
  }
  return contents.slice(0, end) + block + contents.slice(end);
}

function withIosDeploymentTargetFloor(config) {
  const { withPodfile } = require('expo/config-plugins');
  return withPodfile(config, value => {
    if (value.modResults.language !== 'rb') throw Error('The iOS Pod floor requires a Ruby Podfile.');
    value.modResults.contents = patchPodfile(value.modResults.contents);
    return value;
  });
}
module.exports = withIosDeploymentTargetFloor;
Object.assign(module.exports, { patchPodfile, rubyHook, FLOOR });
