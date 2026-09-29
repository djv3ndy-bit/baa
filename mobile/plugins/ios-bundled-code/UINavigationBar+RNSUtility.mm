#import "UINavigationBar+RNSUtility.h"

@implementation UINavigationBar (RNSUtility)

// BaristaMatch uses its own visible headers. UIKit's internal content/button
// classes are not public API. Return the library's supported absent-view result;
// callers retain their existing safe-area and minimum button-width fallbacks.
- (nullable UIView *)rnscreens_findContentView
{
  return nil;
}

- (nullable UIView *)rnscreens_findBackButtonWrapperView
{
  return nil;
}

@end
