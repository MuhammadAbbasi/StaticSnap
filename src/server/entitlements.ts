/**
 * Subscription gating for Pro-only capabilities.
 *
 * The monetization roadmap (`docs/future-roadmap-and-monetization.md`) defines
 * Free / Pro / Developer tiers, but billing (Stripe/Supabase) is not wired up
 * yet. Until then Pro features are unlocked with environment flags so a
 * self-hosted "subscribed" deployment can enable them without code changes:
 *
 *   STATICSNAP_PRO_ENABLED=1        unlocks every Pro feature
 *   STATICSNAP_SECRET_SCAN_ENABLED=1 unlocks only the secret-exposure scan
 *
 * Both accept `1`, `true` or `yes` (case-insensitive). Anything else is off.
 */

function flag(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isProEnabled(): boolean {
  return flag("STATICSNAP_PRO_ENABLED");
}

export function isSecretScanAvailable(): boolean {
  return isProEnabled() || flag("STATICSNAP_SECRET_SCAN_ENABLED");
}

/** Machine-readable reason used for 402 responses and locked UI states. */
export const SECRET_SCAN_UPGRADE_MESSAGE =
  "Secret exposure scan is a Pro (subscribed) feature. Set STATICSNAP_PRO_ENABLED=1 or STATICSNAP_SECRET_SCAN_ENABLED=1 on the server to unlock it.";
