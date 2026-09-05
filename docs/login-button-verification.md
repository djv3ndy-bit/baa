# Login and button verification — 2026-09-05

Fixed web password, Google/Apple sign-in, and password-reset handlers that could leave controls unavailable after a rejected network request. Added duplicate-submit protection and reset-email validation. Successful web sign-in routes directly to the dashboard, which already loads and validates the profile; removed a redundant profile read that could block that transition.

The native login callback now uses the existing canonical callback parser, handles rejected session requests, and avoids decoding/displaying raw provider error text. Login JSX and styles are unchanged. Pricing, settings, logout, deletion, database policies, and provider redirect configuration are unchanged.

Validation: 66 automated tests pass (including nine new executable interaction regressions); native TypeScript passes. Browser checks on the layout preview confirmed the account chooser, correct barista/café signup selection, Resources menu, Pricing page, password visibility toggle, empty login validation, and empty reset-email feedback.

Limits: local authentication regressions use mocked responses. Real-account sign-in and authenticated dashboard navigation still require secure user sign-in. Native device testing and live Google/Apple provider round trips remain outstanding. Existing social-login redirects point to the production dashboard, so a social sign-in begun on preview returns to production. No account was deleted, payment made, message sent, or production release performed.
