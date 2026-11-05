# Free account sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add Google account login and private cross-device fridge data using only free services.

**Architecture:** Keep GitHub Pages and buildless JavaScript. Supabase Auth handles Google OAuth with PKCE. A private versioned JSON document per user preserves existing purchase transactions; an atomic compare-and-swap RPC prevents stale devices from overwriting data. Realtime plus bounded visible-tab polling refreshes clean views.

**Tech Stack:** Existing ES modules and Node test runner; pinned Supabase JS 2.119.0; Supabase Postgres/Auth/Realtime Free.

**Spec:** C:/Users/12345/Documents/Codex/2026-11-04/x20/outputs/fridge-account-sync-design.md, including the approved free-only amendment.

## Global Constraints

- Free plans only; no billing enrollment, domain purchase, paid add-ons, SMTP, or automatic paid upgrades.
- Preserve `fridge-grocery:v1:state` and existing local-only use; never automatically upload local profiles.
- Keep server credentials out of static files; only public project URL and publishable key may be deployed.
- Online changes require server acknowledgment. Stale, uncertain, expired and offline writes must not silently overwrite.
- Keep account data hidden on logout and ignore responses belonging to old auth sessions.

## Review Focus

- Account changes during in-flight requests must not expose or mutate another account's data.
- Form drafts and unsaved price input must survive incoming updates and failed saves.
- Duplicate migration and replayed purchase requests must not duplicate stock or erase receipt flags.
- A server commit whose response is lost must be reconciled before any further write.
- Unconfigured services and quota/network failures must preserve local use and avoid false success messages.

### Task 1: State validation and migration

**Files:** Create `sync-state.js`; test `tests/sync-state.test.js`.
**Interfaces:** `validateAccountState(input) -> state`; `importProfile(state, profile, sourceId) -> state`; `readProfileExport(text) -> profile`; `accountCacheKey(userId) -> string`.

- [ ] Write tests for malformed IDs/collections/prices, preserved receipts and transferred flags, duplicate import, source immutability and isolated keys.
- [ ] Run `node --test tests/sync-state.test.js` and confirm expected missing-feature failure.
- [ ] Implement validation through the existing loader with stricter IDs and envelope limits, immutable deterministic migration metadata and file parsing.
- [ ] Run `node --test tests/*.test.js`; expect all tests pass.
- [ ] Commit state and migration changes.

### Task 2: Account storage and authentication boundary

**Files:** Create `cloud.js`, `cloud-config.js`, `supabase/schema.sql`, `tests/cloud.test.js`, `tests/database.test.js`.
**Interfaces:** `createCloudStore(client, options) -> store` with `connect(user)`, `read()`, `save(state)`, `disconnect()`; `createAccountClient(config) -> client|null`; snapshots `{state,revision,mutationId}`.

- [ ] Test atomic stale-write rejection, actual database RLS for two users and anon, duplicate mutation recovery, account-switch cancellation, network failure and retry.
- [ ] Run new tests to observe the missing boundary.
- [ ] Implement one document per `auth.uid()`, RLS select, RPC-owned writes with fixed search path and authenticated owner checks, bounded payload, revision increment and idempotent last mutation. Realtime sends change notifications; clients fetch latest authenticated snapshots.
- [ ] Implement Supabase adapter, per-user cache clearing and no configured-client fallback; pin SDK import and use PKCE without sending email.
- [ ] Run full suite and commit.

### Task 3: UI, free service setup and deployment

**Files:** Modify `app.js`, `index.html`, `styles.css`, `README.md`; add `supabase/SETUP.md`; tests `tests/ui.test.js`.
**Interfaces:** Existing commit helpers become async; cloud store exposes accepted snapshots and status, while original local persistence stays separate.

- [ ] Write tests executing the app against a real DOM for local persistence, unavailable config, login/logout, draft retention and failed-save behavior.
- [ ] Observe failures, then wire Google login, account status, manual profile/file migration, async saved-state acceptance and conflict recovery with draft export.
- [ ] Preserve visible inputs during remote updates. Poll only when logged in and visible; serialize saves, suspend refresh during edits, check versions on every write, and clear account data on logout.
- [ ] Configure a Supabase Free project and Google OAuth using the user's authenticated dashboard. User performs new secret entry and any required consent. No paid services or billing setup.
- [ ] Run full tests plus browser checks at desktop/mobile size. Check actual OAuth, two-account isolation and two-client updates once service access is available.
- [ ] Run whole-branch independent review; fix significant findings with regression tests. Publish only a verified functional configuration, then recheck public assets and actual login. If user access blocks configuration, keep the working public site and report exact remaining setup.
