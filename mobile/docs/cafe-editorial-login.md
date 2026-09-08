# Café Editorial login

Implements the owner's selected Option 2 login preview: a warm latte-pour photograph, overlaid BaristaMatch branding, and a rounded ivory form with email/password, recovery, Google, Apple and signup actions.

The hero is a bundled 147 KB JPEG, so sign-in does not depend on a remote image request. Provider marks are bundled raster assets. Authentication, OAuth, session recovery and role routing are unchanged. The login screen owns its safe-area insets; other routes retain their existing safe-area handling.

The photo explicitly uses the viewport width and resolved hero height. React Native otherwise preserves the bundled image's intrinsic 1536×1024 dimensions despite absolute-fill positioning, showing only the blurred top-left of the photograph. Sizing the image frame lets cover scaling reveal the latte and pouring milk on the right.

The complete login stays together in one viewport: photo header, rounded form, password recovery, primary action, Google and Apple options, and account creation. Three explicit height tiers cover small, compact and current Face ID iPhones; each tier budgets the real form height before choosing the photo height. This screen intentionally keeps the approved editorial typography and photo/form proportions fixed instead of inheriting the phone's system text enlargement. Scrolling is reserved for the keyboard, unusually small screens, or native measurements that genuinely overflow. Inputs retain accessible labels, a focus border, email-to-password focus, and touch targets at least 44 points high.

## Verification

- Mobile TypeScript check passed.
- iOS Metro/Hermes export passed with all new assets included.
- Authentication release verification passed (388 guarded checks).
- Store configuration verification passed.
- Existing native account/store regressions passed (43 tests), and the full native layout suite passed (328 tests).
- One-page height budgets are checked at 320×568, 375×667, 375×812, 390×844, 393×852 and the reported 402×874 device size. Every case retains spare vertical space, and every field/action remains at least 44 points high.
- The reported 1.5× system-text setting is checked to preserve the same approved logo, hero height and compact typography. Keyboard and true-overflow cases still keep scrolling available. These automated checks do not replace final signed-device review of native font rendering and photo cropping.
- Photo regression checks use the real bundled image dimensions and React Native's intrinsic-size behavior at all six phone sizes. They verify the photo matches its hero frame and that the latte/pour landmarks remain visible above the sheet overlap. Removing the explicit frame dimensions reproduces the original crop failure. Native screenshot verification of this photo correction is still pending; the current checks model geometry with Yoga.

## TestFlight acceptance

Build the merged revision with the existing guarded iOS TestFlight workflow. On the signed build, compare the screen with Option 2; check photo cropping and logo contrast, safe areas, email/password focus, keyboard scrolling on a small iPhone, larger text, password visibility, recovery/signup links and Google/Apple return flows. Record the exact source SHA and build number. Merging source alone does not update an installed TestFlight app. Public store release remains a separate action.
