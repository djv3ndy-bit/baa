# BaristaMatch — first iPhone build

The mobile app is configured with bundle identifier `com.baristajobmatch.app` and Expo/EAS profiles in `eas.json`.

## One-time Expo connection

From the repository root on a computer:

```bash
cd mobile
npm install
npx eas-cli@latest login
npx eas-cli@latest init
```

Sign in with the BaristaMatch Expo account when prompted. `eas init` will create/link the Expo project and write the Expo project ID into the app configuration.

## Set production-safe public Supabase variables

Use the project URL and **publishable** key only. Never put the Supabase secret/service-role key in the mobile app.

```bash
npx eas-cli@latest env:set --environment preview --name EXPO_PUBLIC_SUPABASE_URL --value "YOUR_SUPABASE_URL" --visibility plaintext
npx eas-cli@latest env:set --environment preview --name EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY --value "YOUR_PUBLISHABLE_KEY" --visibility sensitive
```

Repeat for `production` before App Store submission.

## Register the iPhone for an internal build

```bash
npx eas-cli@latest device:create
```

Open the registration link on the iPhone and complete Apple device registration.

## Create the first physical-iPhone build

```bash
npx eas-cli@latest build --platform ios --profile preview
```

EAS will request Apple Developer authentication the first time so it can create/manage signing credentials. Do not share Apple or Expo passwords with anyone.

When the build finishes, EAS provides an installation link/QR code for the registered iPhone.

## Production/TestFlight later

```bash
npx eas-cli@latest build --platform ios --profile production
npx eas-cli@latest submit --platform ios
```
