# Android 7 HTTPS compatibility

This resource-only local Expo module adds the public ISRG Root X1 trust anchor for Android 7 (API 24–25), limited to the three exact BaristaMatch API hosts. It uses Android's normal TLS, certificate-chain, expiry and hostname validation. It does not trust user-installed certificates, override hostname verification, disable pins, change system trust, or alter website configuration.

Android 8+ selects the versioned empty configuration and retains platform defaults. Other hosts retain platform defaults on all versions. The existing development build's local HTTP permission is preserved; the three API hosts require HTTPS. No JavaScript, third-party dependency, permissions, or app configuration edit is needed: Expo automatically links local modules from `mobile/modules` and Android merges this library's manifest/resources.

The certificate is public, not a private signing key. Source: https://letsencrypt.org/certs/isrgrootx1.pem (downloaded 2026-09-13). DER SHA-256: `96bcec06264976f37460779acf28c5a7cfe8a3c0aae11a8ffcee05c0bddf08c6`. Certificate validity ends 2035-06-04; Let's Encrypt's current root-program guidance lists trust until 2030-06-04. Review before that date or on provider/root-policy changes. Do not replace this root with a leaf certificate, trust-all manager, or unverified download.

References: [Vercel compatibility notice](https://vercel.com/changelog/upcoming-change-in-lets-encrypt-chain-of-trust), [CA compatibility](https://letsencrypt.org/docs/certificate-compatibility/), [Android network security configuration](https://developer.android.com/privacy-and-security/security-config), [Expo local autolinking](https://docs.expo.dev/modules/autolinking/).

Native build and security/runtime verification are recorded in the repository's review evidence. Compilation alone does not establish release readiness.
