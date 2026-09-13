/**
 * What each provider ACTUALLY answered the scheduled Drift workflow, body and
 * all, when its probe presented a credential that cannot be valid.
 *
 * Recorded, not remembered. Source: the `Probe the real APIs with invalid
 * credentials` step of Drift run 34755742253 (2026-09-13, scheduled),
 * where each probe printed the error message it received — and the message
 * quotes the provider's body verbatim:
 *
 *     gh run view 34755742253 -R Particle-Academy/fancy-connectors --log
 *
 * Shared by `probes-read-the-status.test.ts` (does the probe see the status?)
 * and `provider-codes.test.ts` (is the provider's own code read where one is
 * declared, and nowhere else?). One table, so the two cannot quietly replay
 * different answers.
 *
 * Not a `*.test.ts` file, so `npm test` does not run it on its own.
 */
export const REAL_REFUSALS: Record<string, { status: number; body: string }> = {
  bluesky: { status: 401, body: '{"error":"AuthenticationRequired","message":"Invalid identifier or password"}' },
  mastodon: { status: 401, body: '{"error":"The access token is invalid"}' },
  discord: { status: 404, body: '{"message": "Unknown Webhook", "code": 10015}' },
  telegram: { status: 401, body: '{"ok":false,"error_code":401,"description":"Unauthorized: invalid token specified"}' },
};
