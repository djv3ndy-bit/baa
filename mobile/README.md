# BaristaMatch Mobile

Native iOS + Android app foundation built with Expo, React Native, TypeScript, Expo Router, and the existing BaristaMatch Supabase backend.

## Local setup

1. `cd mobile`
2. `npm install`
3. Copy `.env.example` to `.env`
4. Set `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
5. Run `npm start`

## Launch candidate

- Supabase session persistence
- Login
- Role-aware signup (barista / café)
- Role-aware home dashboard
- Live counts from jobs, matches, and notifications
- Barista job discovery and applications
- Café candidate review and matching
- Private realtime messaging
- Profile and account settings

## Release status

- Store identity: `com.baristajobmatch.app`
- Version: `1.0.0`
- iPhone-first release configuration
- Production icon, adaptive icon, and splash branding configured
- TypeScript validation: `npm run typecheck`

## Post-launch roadmap

- Barista: Find Jobs, Matches, Messages, Profile
- Café: Job Posts, Candidates, Matches, Messages, Café Profile
- Notifications
- Account Settings + Help & Support
- Push notifications
- Coffee showcase video upload/playback
