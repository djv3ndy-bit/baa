// A short-lived, token-free receipt is written only after the authenticated API
// confirms deletion. Query parameters and fragments are never used as evidence.
(() => {
  try {
    const value = JSON.parse(sessionStorage.getItem('bjm-deletion-receipt-v1') || 'null');
    if (!value || !Number.isFinite(value.createdAt) || Date.now() - value.createdAt < 0 ||
        Date.now() - value.createdAt >= 30 * 60 * 1000 ||
        typeof value.appleDisconnectRequired !== 'boolean' || typeof value.localSignOutComplete !== 'boolean') return;
    document.getElementById('result-title').textContent = 'Account deleted';
    document.getElementById('result-message').textContent = 'Your BaristaMatch account has been deleted. Limited records may be retained as described in our Privacy Policy.';
    document.getElementById('local-warning').hidden = value.localSignOutComplete;
    document.getElementById('apple-guidance').hidden = !value.appleDisconnectRequired;
    if (value.appleDisconnectRequired) document.getElementById('apple-message').textContent = 'This account has no retained Apple authorization token in our deletion integration, so Apple access was not automatically revoked. Your BaristaMatch account deletion is complete; the separate steps below disconnect Apple.';
    // Consume the receipt; a later direct visit must not claim a new deletion.
    sessionStorage.removeItem('bjm-deletion-receipt-v1');
  } catch { /* Keep honest generic instructions when storage is blocked or corrupt. */ }
})();
