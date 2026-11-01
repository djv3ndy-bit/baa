#import <UIKit/UIKit.h>

NS_ASSUME_NONNULL_BEGIN
@interface UINavigationBar (RNSUtility)
// Internal UIKit views are intentionally unavailable in BaristaMatch.
// Callers must use their existing nullable-view fallbacks.
- (nullable UIView *)rnscreens_findContentView;
- (nullable UIView *)rnscreens_findBackButtonWrapperView;
@end
NS_ASSUME_NONNULL_END
