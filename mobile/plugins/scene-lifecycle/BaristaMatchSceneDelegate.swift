import UIKit

/// Expo 54's public app-delegate hooks remain the bridge for module callbacks.
/// UIKit owns the actual scene lifecycle and aggregate UIApplication notifications.
@MainActor
@objc(BaristaMatchSceneDelegate)
final class BaristaMatchSceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?

  func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
    guard session.role == .windowApplication, let windowScene = scene as? UIWindowScene,
      let delegate = UIApplication.shared.delegate as? AppDelegate,
      let factory = delegate.reactNativeFactory else { return }

    if let existingWindow = delegate.window {
      // A disconnected/reconnected scene reuses the retained React root/runtime.
      existingWindow.windowScene = windowScene
      window = existingWindow
      existingWindow.makeKeyAndVisible()
      forward(connectionOptions, to: delegate)
      return
    }

    let sceneWindow = UIWindow(windowScene: windowScene)
    window = sceneWindow
    delegate.window = sceneWindow
    var launchOptions = delegate.bjmSceneLaunchOptions ?? [:]
    let urls = orderedURLs(connectionOptions)
    let activities = orderedActivities(connectionOptions)
    let savedInitialURL = launchOptions[.url] as? URL
    // Expo Linking stores its own initialURL. Seed its existing delegate hooks
    // before starting JS, as well as RN's independent launchOptions URL below.
    // UIKit supplies nil app launchOptions with scenes, but preserve a URL if an
    // existing launcher supplies one: activity forwarding must not replace it.
    if let savedInitialURL {
      var options: [UIApplication.OpenURLOptionsKey: Any] = [:]
      if let source = launchOptions[.sourceApplication] { options[.sourceApplication] = source }
      if let annotation = launchOptions[.annotation] { options[.annotation] = annotation }
      _ = delegate.application(UIApplication.shared, open: savedInitialURL, options: options)
    }
    forward(connectionOptions, to: delegate)
    if let initialURL = urls.last?.url ?? savedInitialURL ?? activities.first(where: { $0.activityType == NSUserActivityTypeBrowsingWeb && $0.webpageURL != nil })?.webpageURL {
      launchOptions[.url] = initialURL
    }
    delegate.bjmSceneLaunchOptions = nil
    factory.startReactNative(withModuleName: "main", in: sceneWindow, launchOptions: launchOptions)
    // Expo's early UNUserNotificationCenter delegate already queues cold tap
    // responses. Replaying connectionOptions.notificationResponse duplicates them.
  }

  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    guard let delegate = UIApplication.shared.delegate as? AppDelegate else { return }
    for context in URLContexts { open(context, with: delegate) }
  }

  func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
    guard let delegate = UIApplication.shared.delegate as? AppDelegate else { return }
    _ = delegate.application(UIApplication.shared, continue: userActivity, restorationHandler: { _ in })
  }

  func sceneDidBecomeActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidBecomeActive(UIApplication.shared)
  }
  func sceneWillResignActive(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillResignActive(UIApplication.shared)
  }
  func sceneWillEnterForeground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationWillEnterForeground(UIApplication.shared)
  }
  func sceneDidEnterBackground(_ scene: UIScene) {
    (UIApplication.shared.delegate as? AppDelegate)?.applicationDidEnterBackground(UIApplication.shared)
  }

  private func orderedURLs(_ options: UIScene.ConnectionOptions) -> [UIOpenURLContext] {
    options.urlContexts.sorted { $0.url.absoluteString < $1.url.absoluteString }
  }
  private func orderedActivities(_ options: UIScene.ConnectionOptions) -> [NSUserActivity] {
    options.userActivities.sorted { ($0.activityType, $0.webpageURL?.absoluteString ?? "") < ($1.activityType, $1.webpageURL?.absoluteString ?? "") }
  }
  private func forward(_ options: UIScene.ConnectionOptions, to delegate: AppDelegate) {
    for activity in orderedActivities(options) {
      _ = delegate.application(UIApplication.shared, continue: activity, restorationHandler: { _ in })
    }
    for context in orderedURLs(options) { open(context, with: delegate) }
  }
  private func open(_ context: UIOpenURLContext, with delegate: AppDelegate) {
    var options: [UIApplication.OpenURLOptionsKey: Any] = [.openInPlace: context.options.openInPlace]
    if let sourceApplication = context.options.sourceApplication { options[.sourceApplication] = sourceApplication }
    if let annotation = context.options.annotation { options[.annotation] = annotation }
    _ = delegate.application(UIApplication.shared, open: context.url, options: options)
  }
}
