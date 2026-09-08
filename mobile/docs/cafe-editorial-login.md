# Café Editorial login

Implements the owner's selected Option 2 login preview: a warm latte-pour photograph, overlaid BaristaMatch branding, and a rounded ivory form with email/password, recovery, Google, Apple and signup actions.

The hero is a bundled 147 KB JPEG, so sign-in does not depend on a remote image request. Provider marks are bundled raster assets. Authentication, OAuth, session recovery and role routing are unchanged. The login screen owns its safe-area insets; other routes retain their existing safe-area handling.

At normal text size, the complete login stays together in one viewport: photo header, rounded form, password recovery, primary action, Google and Apple options, and account creation. Three explicit height tiers cover small, compact and current Face ID iPhones; each tier budgets the real form height before choosing the photo height. Scrolling is reserved for the keyboard, enlarged text, unusually small screens, or native text measurements that genuinely overflow. Inputs retain accessible labels, a focus border, email-to-password focus, and touch targets at least 44 points high.

## Verification

- Mobile TypeScript check passed.
- iOS Metro/Hermes export passed with all new assets included.
- Authentication release verification passed (388 guarded checks).
- Store configuration verification passed.
- Existing native account/store regressions passed (43 tests), and the full native layout suite passed (314 tests).
- One-page height budgets are checked at 320×568, 375×667, 375×812, 390×844 and 393×852. Every normal-text case retains at least eight points of spare vertical space, and every field/action remains at least 44 points high.
- Keyboard, enlarged-text, their combined state, and true-overflow cases are checked to keep content available without clipping. These automated checks do not replace final signed-device review of native font rendering and photo cropping.

## TestFlight acceptance

Build the merged revision with the existing guarded iOS TestFlight workflow. On the signed build, compare the screen with Option 2; check photo cropping and logo contrast, safe areas, email/password focus, keyboard scrolling on a small iPhone, larger text, password visibility, recovery/signup links and Google/Apple return flows. Record the exact source SHA and build number. Merging source alone does not update an installed TestFlight app. Public store release remains a separate action.
