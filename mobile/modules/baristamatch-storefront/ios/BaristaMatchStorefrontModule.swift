import ExpoModulesCore
import StoreKit

public final class BaristaMatchStorefrontModule: Module {
  public func definition() -> ModuleDefinition {
    Name("BaristaMatchStorefront")

    AsyncFunction("getStorefrontCountryCode") { () async -> String? in
      // Never infer a storefront from the device locale or physical location.
      guard let storefront = await Storefront.current else {
        return nil
      }
      return storefront.countryCode
    }
  }
}
