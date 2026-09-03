-- Chart indexer schema. RPC is the source of truth; this is a read-optimized
-- projection of it. Amounts are numeric(78,0) because they are uint256 in the
-- contracts; bigint would silently overflow at 9.2e18.

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename   text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_state (
  chain_id                bigint PRIMARY KEY,
  factory_address         text    NOT NULL,
  start_block             bigint  NOT NULL,
  last_indexed_block      bigint  NOT NULL,
  last_indexed_block_hash text,
  backfill_complete       boolean NOT NULL DEFAULT false,
  accepted_chunk          bigint,
  lease_until             timestamptz,
  lease_owner             text,
  last_error              text,
  last_tick_at            timestamptz,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

-- Only blocks CONTAINING indexed events. The timestamp cache and the reorg
-- witness. Never one row per chain block: that would be 1.7M rows of nothing.
CREATE TABLE IF NOT EXISTS blocks (
  chain_id     bigint      NOT NULL,
  block_number bigint      NOT NULL,
  block_hash   text        NOT NULL,
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS markets (
  chain_id        bigint  NOT NULL,
  question_id     bigint  NOT NULL,
  fpmm            text    NOT NULL,
  condition_id    text    NOT NULL,
  question        text    NOT NULL,
  category        text    NOT NULL,
  resolution_time timestamptz NOT NULL,
  resolver        text    NOT NULL,
  fee_bps         integer NOT NULL,
  created_block   bigint  NOT NULL,
  created_at      timestamptz NOT NULL,
  resolved        boolean NOT NULL DEFAULT false,
  resolved_block  bigint,
  payout_yes      numeric(78,0),
  payout_no       numeric(78,0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, question_id)
);

-- The join key from an FPMM log back to its market.
CREATE UNIQUE INDEX IF NOT EXISTS markets_fpmm_uk ON markets (chain_id, fpmm);

-- Raw event args AND replayed reserves AND derived prices, append-only.
-- One table rather than separate price/liquidity tables: liquidity events carry
-- a price too (addLiquidity moves it on an unbalanced pool), and their reserve
-- magnitudes are what every later replay step reads. One table means no join on
-- the hot path and one place to truncate on reorg.
CREATE TABLE IF NOT EXISTS market_events (
  chain_id     bigint  NOT NULL,
  block_number bigint  NOT NULL,
  log_index    integer NOT NULL,
  tx_hash      text    NOT NULL,
  question_id  bigint  NOT NULL,
  fpmm         text    NOT NULL,
  kind         text    NOT NULL
    CHECK (kind IN ('buy','sell','liquidity_added','liquidity_removed')),
  actor        text    NOT NULL,
  outcome      smallint CHECK (outcome IS NULL OR outcome IN (0,1)),
  collateral   numeric(78,0) NOT NULL,
  shares       numeric(78,0) NOT NULL,
  reserve_yes  numeric(78,0) NOT NULL,
  reserve_no   numeric(78,0) NOT NULL,
  total_supply numeric(78,0) NOT NULL,
  yes_bps      integer NOT NULL CHECK (yes_bps BETWEEN 0 AND 10000),
  exec_yes_bps integer CHECK (exec_yes_bps IS NULL OR exec_yes_bps BETWEEN 0 AND 10000),
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (chain_id, block_number, log_index)
);

-- The ONLY chart index. (chain_id, question_id, block_time) serves every chart
-- query; the primary key serves dedupe and ordering. Deliberately nothing else:
-- writes must stay cheap.
CREATE INDEX IF NOT EXISTS market_events_chart
  ON market_events (chain_id, question_id, block_time);
