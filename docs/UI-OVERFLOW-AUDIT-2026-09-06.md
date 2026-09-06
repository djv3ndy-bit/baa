# Mobile header and related overflow repair — September 6, 2026

Baseline: `fbfff22abcd72b96b8abddd0101de0fce263f3c2`. Owner reported that the café Profile settings button is partly outside the right screen edge. This is a UI-only repair, not store submission or an installed-app update.

## Cause and corrections

The Profile title/subtitle wrapper was an unconstrained child in a horizontal row. Long copy and increased text size could consume the space needed by the settings button. The fix gives the copy the remaining flexible width, a zero minimum width, and a gap while reserving a non-shrinking 44-by-44 settings action. Text remains scalable and can wrap; the icon glyph itself stays within its button.

The same bounded-copy pattern is applied to Home and Discover settings headers, candidate review and empty-state headings, job-list controls and café onboarding. Settings, job editing, café plans and conversation headers can grow vertically instead of clipping larger text. Back/settings/safety actions retain their routes and have labeled, non-shrinking touch areas. Long conversation names use two lines and retain the full accessibility label.

Related Profile editor media selectors, opening-hours rows and choice chips now wrap inside narrow cards. Profile name/location are bounded and centered. The existing five-/six-tab bottom navigation is tested and remains unchanged. No authentication, billing, role permissions, demographics, matching, user data or database operation is changed.

## Automated evidence and limitations

302 local layout/routing regression cases passed. The test harness renders actual TSX using inert React/native hosts and runs the actual style hierarchy through Yoga. Widths: 320, 360, 375, 393, 430 and 768 logical units. Font scales: 1, 1.3, 1.6 and 2. Additional cases cover Android/iOS branch selection, RTL, settings navigation, both-role bottom tabs, profile form controls and onboarding. Text metrics are deterministic approximations, not platform-font measurements.

A negative-control test against the unchanged baseline reproduced Profile settings overflow at width 393 and font scale 1.6: the button ended at 417, outside a 393-wide header. The same case passes after the repair. This is modelled regression evidence, not a measurement of the uploaded phone screenshot.

Fresh remote full repository tests, mobile TypeScript/store checks, both JavaScript exports and Android manifest validation must pass before merge. Temporary snapshot/patch tooling is removed from the final diff. Record exact final head, merge and CI results in the PR.

## Still required on the installed app

Build the intended signed iPhone/Android release and check Profile (both roles), Home, Discover, Candidates, Jobs, Settings, Café plans, café onboarding and a long-name conversation on physical devices. Verify small screens, larger text, keyboard/scrolling, portrait/landscape and every action. This source/geometry pass is not a comprehensive visual/device audit, nor proof that an existing TestFlight installation changed.

Public App Store/Google Play release remains on hold under the existing LLC seller and readiness gates.

Layout reference: https://reactnative.dev/docs/flexbox
