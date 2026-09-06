# BaristaMatch Google Play submission record

Prepared September 6, 2026. No Play Console submission, organization verification or Android release is certified by this document.

## Identity and public resources

- App: BaristaMatch
- Package: `com.baristajobmatch.app` (keep the registered package unchanged)
- Operator: BaristaMatch LLC
- Suggested category: Business; answer all content/audience questions accurately.
- Privacy: `https://www.baristajobmatch.com/privacy.html`
- Support: `https://www.baristajobmatch.com/support.html`
- Account deletion: `https://www.baristajobmatch.com/delete-account.html`
- Public support email: `hello@baristajobmatch.com`

The deletion page supports requests without reinstalling the app. Its email/support process needs actual owner verification, fulfillment and confirmation. Do not mark a request complete merely because it arrived.

## Technical and account requirements

- [ ] Correct organization account verified using consistent legal business information and D-U-N-S details where required; account ownership is not verified by source code.
- [ ] Production AAB signed with the intended upload key; Play App Signing setup and increasing version code confirmed.
- [ ] Final AAB targets API 36 or higher. Expo SDK 54 defaults to compile/target API 36; validate the artifact, not only that dependency version.
- [ ] Native libraries verified for 16 KB page-size compatibility in the final AAB/device environment.
- [ ] App access instructions include working café and barista reviewer accounts supplied privately.
- [ ] Data Safety answers cover actual personal information, user content, messages, approximate location, identifiers, activity, diagnostics, demographics, SDK processing and applicable billing data. Reconcile collection/sharing definitions rather than treating service providers as automatically exempt.
- [ ] In-app deletion, external deletion resource, associated-data cleanup and disclosed retention verified.
- [ ] Permission inventory reviewed. Use the system photo picker where appropriate instead of unnecessary broad media access; test Android permission denial, limited access and upload behavior.
- [ ] Content rating, target audience, ads declaration and any applicable social/child-safety policies completed. Do not confuse the service's minimum age with Google's content rating.
- [ ] Accurate description, icon, screenshots, feature graphic and contact details completed.
- [ ] Full physical Android flow tested, including gesture/three-button navigation, keyboard, system bars, large screens, all login methods, deletion, UGC reporting/blocking and push delivery.
- [ ] Internal testing and Play pre-launch report reviewed. If the actual account is a new personal account, check its applicable closed-testing/production-access requirements; do not assume those apply to a verified organization account.
- [ ] Public release expressly authorized only after all readiness and LLC identity gates pass.

The native app currently does not initiate new purchases. Website billing is separate. Do not add in-app external checkout or assert an exemption merely because this is a job marketplace; assess the actual paid functionality, storefront and current payment policy.

## Primary references

- https://support.google.com/googleplay/android-developer/answer/11926878?hl=en
- https://support.google.com/googleplay/android-developer/answer/13327111?hl=en
- https://support.google.com/googleplay/android-developer/answer/10144311?hl=en
- https://docs.expo.dev/versions/v54.0.0/
