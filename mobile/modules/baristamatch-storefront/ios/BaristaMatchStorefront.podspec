Pod::Spec.new do |s|
  s.name = 'BaristaMatchStorefront'
  s.version = '1.0.0'
  s.summary = 'Reads the current Apple App Store storefront for BaristaMatch.'
  s.description = s.summary
  s.license = 'UNLICENSED'
  s.author = 'BaristaMatch'
  s.homepage = 'https://www.baristajobmatch.com'
  s.source = { git: 'https://github.com/djv3ndy-bit/baa.git' }
  s.platforms = { ios: '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'StoreKit'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
  s.source_files = '**/*.swift'
end
