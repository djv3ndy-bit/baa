// BaristaMatch release policy. Only signed, installed app resources may be code.
// Data/media networking is intentionally outside this policy.
#pragma once
#import <Foundation/Foundation.h>

static inline BOOL RCTIsCodeURLInsideBundle(NSURL *url, NSURL *bundleURL)
{
  if (!url.isFileURL || !bundleURL.isFileURL || url.query || url.fragment ||
      (url.host.length && ![url.host isEqualToString:@"localhost"])) {
    return NO;
  }
  NSURL *resolvedURL = url.URLByResolvingSymlinksInPath.URLByStandardizingPath;
  NSURL *resolvedBundle = bundleURL.URLByResolvingSymlinksInPath.URLByStandardizingPath;
  NSString *root = [resolvedBundle.path stringByAppendingString:@"/"];
  if (!resolvedBundle.path.length || ![resolvedURL.path hasPrefix:root]) {
    return NO;
  }
  NSNumber *regular = nil;
  return [resolvedURL getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil] && regular.boolValue;
}

static inline BOOL RCTIsInstalledCodeURL(NSURL *url)
{
  return RCTIsCodeURLInsideBundle(url, NSBundle.mainBundle.bundleURL);
}

static inline NSError *RCTBundledCodePolicyError(void)
{
  return [NSError errorWithDomain:@"BJM_RELEASE_BUNDLED_CODE_ONLY"
                            code:1
                        userInfo:@{NSLocalizedDescriptionKey : @"This release loads app code only from its installed bundle."}];
}
