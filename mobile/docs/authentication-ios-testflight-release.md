# Authentication iOS TestFlight Release Runbook

## Purpose

Ship the owner-approved mobile authentication callback fix to a new **internal TestFlight build** without submitting it for public App Store review.

This runbook covers the source revision that contains PR #32, including the canonical `baristamatch://auth/callback` route, cold-start callback handling, safe session creation, profile-role recovery, and generic invalid-link errors.

## Release boundaries

This release process:

- builds only the iOS app from the protected `main` branch;
- uses the existing EAS project `faef8923-6780-4373-bb0b-c789e3eb1bcc`;
- targets the existing App Store Connect app `6807117736`;
- uses bundle identifier `com.baristajobmatch.app`;
- auto-increments the iOS build number remotely;
- uploads only to TestFlight;
- does not submit for App Review;
- does not publish an EAS Update;
- does not modify users, profiles, subscriptions, payments, Stripe, Resend, or Supabase data.

## Required configuration

The repository already contains:

- `app.json` with the BaristaMatch iOS bundle identifier, URL scheme, EAS project ID, update URL, and export-compliance declaration;
- `eas.json` with remote version management, production build-number auto-increment, the production channel, and the App Store Connect app ID;
- `.eas/workflows/authentication-ios-testflight.yml` with exact-commit validation, a hold-by-default input, a second owner approval gate, a production iOS build, and an internal TestFlight upload.

The EAS account must already have valid iOS distribution credentials and an App Store Connect API key. Those credentials are managed by EAS/Apple and must never be committed to this repository.

## Preflight checks

Before starting the workflow:

1. Confirm PR #32 is merged into `main`.
2. Confirm the latest `Authentication reliability tests`, `Launch readiness check`, and `Engineering reliability monitor` runs are green.
3. Copy the full 40-character SHA for the exact current `main` commit.
4. Confirm the EAS production environment contains the mobile client variables required by the existing build, including `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
5. Do not add a Supabase service-role key, Stripe secret, Resend key, or Apple private key to the mobile runtime.

## Validate the prepared workflow

From the `mobile` directory:

```bash
npm ci
npm run release:verify-auth
npm run typecheck
npx eas-cli@latest workflow:validate .eas/workflows/authentication-ios-testflight.yml
```

All commands must pass before a build is started.

## Start the guarded TestFlight workflow

From the `mobile` directory, replace `<FULL_MAIN_SHA>` with the exact current `main` commit SHA:

```bash
npx eas-cli@latest workflow:run .eas/workflows/authentication-ios-testflight.yml \
  --ref main \
  -F release_sha=<FULL_MAIN_SHA> \
  -F release_mode=BUILD_AND_SUBMIT_TO_INTERNAL_TESTFLIGHT
```

The workflow will stop automatically unless all of these are true:

- the release mode is the explicit TestFlight value;
- the selected Git ref is `main`;
- the supplied SHA exactly matches the selected `main` revision;
- the deterministic authentication release checks pass;
- the complete mobile TypeScript check passes;
- the owner approves the `Owner approval before Apple upload` job in EAS.

## TestFlight verification matrix

Use fresh test accounts that contain no real customer information. Record pass/fail, device, iOS version, app version, and TestFlight build number for each case.

### Email signup and verification

- New barista signup creates an account and shows the verification screen.
- New café signup creates an account and shows the verification screen.
- Verification email arrives with the expected BaristaMatch branding.
- Tapping the verification link while the app is fully closed opens BaristaMatch, completes the session, and reaches the correct account flow.
- Tapping the verification link while the app is already open completes the session once and does not duplicate the profile.
- The correct barista or café role is restored from signup metadata.
- An expired, reused, incomplete, or provider-error link shows a generic retry message and never displays tokens or raw provider details.

### Login and session handling

- Existing barista email/password login reaches the barista home screen.
- Existing café email/password login reaches the café home screen.
- Incorrect credentials show a clear, non-sensitive error.
- Closing and reopening the app preserves a valid session.
- Logging out removes the local session and returns to login.
- A revoked or invalid session does not expose another account and returns safely to login.

### Password recovery

- Forgot-password accepts a valid email format.
- The reset email is delivered.
- The reset link opens the secure web reset screen.
- A strong new password is accepted.
- The old password stops working.
- The new password logs in successfully.
- An expired or reused reset link shows the safe invalid-link state.

### Social sign-in

- Google sign-in returns through the canonical callback and opens the correct profile.
- Apple sign-in returns through the canonical callback and opens the correct profile.
- A first-time social account without a role is asked to choose Barista or Café.
- Canceling role selection signs out locally and returns to login.

## Acceptance criteria

The build may be marked **TestFlight Verified** only when:

- every critical verification, login, reset, session, Google, and Apple test passes;
- no authentication token or provider error appears in the UI or logs;
- no duplicate or missing profile is created;
- no regression is found in existing barista or café accounts;
- the production reliability monitor remains healthy;
- the owner records a separate approval for any public App Store release.

## Failure and rollback

If a critical test fails:

1. Do not promote the build to external testing or App Review.
2. Keep the previous TestFlight build available.
3. Record the failing step, device, iOS version, app version, build number, and sanitized error.
4. Create a new fix branch and pull request; do not patch `main` directly.
5. Re-run the complete authentication suite and this guarded workflow with a new exact `main` SHA.

Because this preparation does not publish an over-the-air update or submit to App Review, stopping the TestFlight rollout is sufficient rollback until a corrected build is ready.
