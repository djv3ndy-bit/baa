# Café Editorial login

Implements the owner's selected Option 2 login preview: a warm latte-pour photograph, overlaid BaristaMatch branding, and a rounded ivory form with email/password, recovery, Google, Apple and signup actions.

The hero is a bundled 147 KB JPEG, so sign-in does not depend on a remote image request. Provider marks are bundled raster assets. Authentication, OAuth, session recovery and role routing are unchanged. The login screen owns its safe-area insets; other routes retain their existing safe-area handling.

The form scrolls on short displays and with larger text. Keyboard events reduce the decorative header, and iOS uses keyboard avoidance. Inputs have accessible labels, a focus border, email-to-password focus, and touch targets at least 44 points high.

## Verification

- Mobile TypeScript check passed.
- iOS Metro/Hermes export passed with all new assets included.
- Authentication release verification passed (380 checks).
- Store configuration verification passed.
- Existing authentication and native-account tests passed (23 tests).
- Actual TSX/style-tree geometry was checked at 320, 375, 393 and 430 point widths, text scales 1, 1.5 and 2, with keyboard state shown/hidden (24 cases). Horizontal containment, touch targets and recovery/signup destinations passed. Text measurement was synthetic; this does not verify system font rendering or actual keyboard behavior.
- The preview browser blocked local pages. Visual device verification remains pending.

## TestFlight acceptance

Build the merged revision with the existing guarded iOS TestFlight workflow. On the signed build, compare the screen with Option 2; check photo cropping and logo contrast, safe areas, email/password focus, keyboard scrolling on a small iPhone, larger text, password visibility, recovery/signup links and Google/Apple return flows. Record the exact source SHA and build number. Merging source alone does not update an installed TestFlight app. Public store release remains a separate action.
