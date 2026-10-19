#!/usr/bin/env node
/**
 * Nightly Meta sync trigger (Railway cron service "meta-sync").
 * Calls the app's /api/meta/sync with the shared secret; the app syncs every enabled ad account.
 * Env: APP_URL, META_CRON_SECRET
 */
const { APP_URL, META_CRON_SECRET } = process.env;
if (!APP_URL || !META_CRON_SECRET) { console.error("APP_URL and META_CRON_SECRET are required"); process.exit(1); }
const res = await fetch(`${APP_URL.replace(/\/$/, "")}/api/meta/sync`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "x-cron-secret": META_CRON_SECRET },
  body: "{}",
  signal: AbortSignal.timeout(14 * 60 * 1000),
});
const text = await res.text();
console.log(res.status, text.slice(0, 2000));
if (!res.ok) process.exit(1);
