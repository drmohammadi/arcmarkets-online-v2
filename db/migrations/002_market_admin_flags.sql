-- Admin-authored curation state: which markets have been removed from the app.
--
-- WHY A SEPARATE TABLE RATHER THAN COLUMNS ON `markets`.
-- `markets` is a read-optimized PROJECTION of RPC (see 001_init.sql): every
-- column in it is reconstructible by replaying logs, and the indexer rewrites
-- rows via ON CONFLICT DO UPDATE on every re-index. These flags are the
-- opposite — they exist nowhere on-chain and cannot be reconstructed from
-- anything. Keeping them out of the projection means a reindex, a reorg
-- truncation, or a future `DELETE FROM markets` can never destroy them, and it
-- keeps them clear of `upsertMarkets`' conflict clause.
--
-- NO FOREIGN KEY TO `markets`, matching 001's reasoning. An admin may remove a
-- market the indexer has not reached yet — cron runs daily — and an FK would
-- reject that legitimate write. The frontend enumerates markets from the
-- factory over RPC, so an orphan flag row is inert rather than harmful.
--
-- WHAT THIS IS NOT. Removing a market here changes NOTHING on-chain. The
-- market, its pool and every outstanding position remain live and redeemable;
-- `MarketFactory` has no delete. This table only decides what the application
-- lists.
CREATE TABLE IF NOT EXISTS market_admin_flags (
  chain_id    bigint      NOT NULL,
  question_id bigint      NOT NULL,
  deleted     boolean     NOT NULL DEFAULT false,
  reason      text,
  -- The address recovered from the signed request, not a client-supplied name.
  updated_by  text        NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, question_id)
);

-- The only read path is "every deleted market on this chain". Partial, so
-- restoring a market shrinks the index rather than leaving a dead entry, and so
-- the index stays proportional to the deleted set rather than to the market count.
CREATE INDEX IF NOT EXISTS market_admin_flags_deleted
  ON market_admin_flags (chain_id) WHERE deleted;

-- Append-only. Answers "who removed this, when, and under which signed request".
-- Kept separate from the flags table because the flags table holds CURRENT state
-- (one row per market, overwritten) while this holds HISTORY (one row per
-- transition, never overwritten). Collapsing them would lose every prior action.
--
-- `sig_digest` is a SHA-256 of the signature, not the signature itself: paired
-- with `nonce` it is enough to identify which signed request caused a change,
-- without persisting raw credential material. The nonce is single-use and
-- already consumed by the time this row is written, so the signature has no
-- remaining authority either way.
CREATE TABLE IF NOT EXISTS market_admin_audit (
  id          bigserial   PRIMARY KEY,
  chain_id    bigint      NOT NULL,
  question_id bigint      NOT NULL,
  deleted     boolean     NOT NULL,
  actor       text        NOT NULL,
  reason      text,
  nonce       text        NOT NULL,
  sig_digest  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS market_admin_audit_market
  ON market_admin_audit (chain_id, question_id, created_at DESC);

-- Single-use nonces: the replay guard for signed admin writes.
--
-- `used_at` is nullable rather than the row being deleted on use, so a replayed
-- nonce is distinguishable from one that never existed while it remains in the
-- table. Expired rows are swept opportunistically on issue.
CREATE TABLE IF NOT EXISTS admin_nonces (
  nonce      text        PRIMARY KEY,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

CREATE INDEX IF NOT EXISTS admin_nonces_expiry ON admin_nonces (expires_at);
