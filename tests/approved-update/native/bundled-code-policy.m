#import <Foundation/Foundation.h>
#include <stdio.h>
int main(int argc, char **argv) {
  @autoreleasepool {
    NSString *tmp = [NSString stringWithUTF8String:argv[1]];
    NSString *bundle = [tmp stringByAppendingPathComponent:@"App.app"];
    NSString *other = [tmp stringByAppendingPathComponent:@"App.app-other"];
    NSFileManager *fm = NSFileManager.defaultManager;
    for (NSString *dir in @[bundle, other, [bundle stringByAppendingPathComponent:@"nested"]]) {
      [fm createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
    }
    for (NSString *file in @[@"App.app/main.jsbundle", @"App.app/nested/segment.js", @"App.app-other/remote.js", @"cached.js"]) {
      [@"packaged fixture" writeToFile:[tmp stringByAppendingPathComponent:file] atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }
    [fm createSymbolicLinkAtPath:[bundle stringByAppendingPathComponent:@"escape.js"]
            withDestinationPath:[tmp stringByAppendingPathComponent:@"cached.js"] error:nil];
    NSURL *root = [NSURL fileURLWithPath:bundle];
    NSURL *(^file)(NSString *) = ^NSURL *(NSString *relative) { return [NSURL fileURLWithPath:[tmp stringByAppendingPathComponent:relative]]; };
    NSArray *cases = @[
      @[file(@"App.app/main.jsbundle"), @YES],
      @[file(@"App.app/nested/segment.js"), @YES],
      @[file(@"cached.js"), @NO],
      @[file(@"App.app-other/remote.js"), @NO],
      @[file(@"App.app/../cached.js"), @NO],
      @[file(@"App.app/escape.js"), @NO],
      @[file(@"App.app/missing.js"), @NO],
      @[root, @NO],
      @[[NSURL URLWithString:@"https://example.invalid/code.js"], @NO],
      @[[NSURL URLWithString:@"http://localhost:8081/index.bundle"], @NO],
      @[[NSURL URLWithString:@"data:text/javascript,alert(1)"], @NO],
      @[[NSURL URLWithString:@"file://remotehost/code.js"], @NO],
      @[[NSURL URLWithString:[file(@"App.app/main.jsbundle").absoluteString stringByAppendingString:@"?code=remote"]], @NO],
      @[[NSURL URLWithString:[root.absoluteString stringByAppendingString:@"/%2e%2e/cached.js"]], @NO]
    ];
    for (NSArray *test in cases) {
      if (RCTIsCodeURLInsideBundle(test[0], root) != [test[1] boolValue]) return 1;
    }
    if (RCTIsCodeURLInsideBundle(nil, root)) return 2;
    puts("15 native URL policy cases passed");
  }
  return 0;
}
