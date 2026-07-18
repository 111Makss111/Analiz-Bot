-- Market Pulse initial schema. All application access goes through the Render backend.

create extension if not exists pgcrypto with schema extensions;

create type public.market_type as enum ('regular', 'otc');
create type public.asset_data_state as enum ('warming', 'ready', 'stale', 'unavailable', 'error');
create type public.prediction_direction as enum ('up', 'down');
create type public.prediction_source as enum ('manual', 'automatic_research');
create type public.prediction_status as enum ('pending', 'active', 'settled');
create type public.prediction_result as enum ('win', 'loss', 'draw', 'invalid', 'cancelled');
create type public.risk_level as enum ('stronger', 'normal', 'risky', 'very_risky');
create type public.algorithm_status as enum ('shadow', 'active', 'retired');
create type public.tick_sample_phase as enum ('context', 'entry', 'expiration');

create table public.telegram_users (
  telegram_user_id bigint primary key,
  first_name text not null,
  last_name text,
  username text,
  language_code text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint telegram_users_positive_id check (telegram_user_id > 0)
);

create table public.assets (
  id uuid primary key default gen_random_uuid(),
  pocket_symbol text not null unique,
  display_name text not null,
  market_type public.market_type not null,
  is_available boolean not null default false,
  payout_percent numeric(5,2),
  data_state public.asset_data_state not null default 'warming',
  last_quote numeric(24,10),
  last_quote_at timestamptz,
  pocket_server_time_at timestamptz,
  catalog_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint assets_payout_range check (payout_percent is null or payout_percent between 0 and 100),
  constraint assets_positive_quote check (last_quote is null or last_quote > 0)
);

create table public.algorithm_versions (
  id uuid primary key default gen_random_uuid(),
  version text not null unique,
  market_type public.market_type not null,
  status public.algorithm_status not null default 'shadow',
  description text not null,
  configuration jsonb not null default '{}'::jsonb,
  activated_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index algorithm_versions_one_active_per_market
  on public.algorithm_versions (market_type)
  where status = 'active';

create table public.candles (
  id bigint generated always as identity primary key,
  asset_id uuid not null references public.assets(id) on delete restrict,
  timeframe_seconds smallint not null,
  open_time timestamptz not null,
  close_time timestamptz not null,
  open numeric(24,10) not null,
  high numeric(24,10) not null,
  low numeric(24,10) not null,
  close numeric(24,10) not null,
  tick_count integer not null default 0,
  is_complete boolean not null default false,
  received_at timestamptz not null default now(),
  constraint candles_timeframe_supported check (timeframe_seconds in (30, 60, 300)),
  constraint candles_time_order check (close_time > open_time),
  constraint candles_ohlc_valid check (
    low > 0 and high >= low and open between low and high and close between low and high
  ),
  constraint candles_tick_count_nonnegative check (tick_count >= 0),
  unique (asset_id, timeframe_seconds, open_time)
);

create index candles_asset_timeframe_latest
  on public.candles (asset_id, timeframe_seconds, open_time desc);

create table public.ticks (
  id bigint generated always as identity primary key,
  asset_id uuid not null references public.assets(id) on delete restrict,
  pocket_time timestamptz not null,
  received_at timestamptz not null default now(),
  price numeric(24,10) not null,
  pocket_sequence text,
  constraint ticks_positive_price check (price > 0)
);

create index ticks_asset_latest on public.ticks (asset_id, pocket_time desc);
create index ticks_time_brin on public.ticks using brin (pocket_time);

create table public.predictions (
  id uuid primary key default gen_random_uuid(),
  telegram_user_id bigint references public.telegram_users(telegram_user_id) on delete set null,
  asset_id uuid not null references public.assets(id) on delete restrict,
  algorithm_version_id uuid not null references public.algorithm_versions(id) on delete restrict,
  source public.prediction_source not null default 'manual',
  market_type public.market_type not null,
  direction public.prediction_direction not null,
  expiration_seconds smallint not null,
  strength_score numeric(5,2) not null,
  risk_level public.risk_level not null,
  payout_percent numeric(5,2),
  explanation text not null,
  risks text[] not null default '{}',
  status public.prediction_status not null default 'pending',
  result public.prediction_result,
  created_at timestamptz not null default now(),
  actual_start_at timestamptz,
  entry_price numeric(24,10),
  expires_at timestamptz,
  final_price numeric(24,10),
  final_quote_at timestamptz,
  final_quote_delay_ms integer,
  cancelled_at timestamptz,
  error_code text,
  result_diagnostics jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint predictions_expiration_supported check (expiration_seconds in (60, 120, 180)),
  constraint predictions_strength_range check (strength_score between 0 and 100),
  constraint predictions_payout_range check (payout_percent is null or payout_percent between 0 and 100),
  constraint predictions_positive_prices check (
    (entry_price is null or entry_price > 0) and (final_price is null or final_price > 0)
  ),
  constraint predictions_delay_nonnegative check (final_quote_delay_ms is null or final_quote_delay_ms >= 0),
  constraint predictions_result_state check (
    (status in ('pending', 'active') and result is null)
    or (status = 'settled' and result is not null)
  )
);

create index predictions_user_latest on public.predictions (telegram_user_id, created_at desc);
create index predictions_asset_latest on public.predictions (asset_id, created_at desc);
create index predictions_statistics_filters
  on public.predictions (created_at desc, market_type, expiration_seconds, result, source);
create index predictions_algorithm_result
  on public.predictions (algorithm_version_id, result, created_at desc);
create index predictions_pending_expiration
  on public.predictions (expires_at)
  where status = 'active';

create table public.prediction_features (
  prediction_id uuid primary key references public.predictions(id) on delete cascade,
  local_slope numeric,
  acceleration numeric,
  ema_9 numeric(24,10),
  ema_20 numeric(24,10),
  ema_21 numeric(24,10),
  atr numeric(24,10),
  support_distance numeric,
  resistance_distance numeric,
  range_position numeric,
  tick_velocity numeric,
  tick_direction_changes integer,
  volatility_state text,
  candle_snapshot jsonb not null default '[]'::jsonb,
  tick_context jsonb not null default '{}'::jsonb,
  all_features jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table public.prediction_tick_samples (
  id bigint generated always as identity primary key,
  prediction_id uuid not null references public.predictions(id) on delete cascade,
  phase public.tick_sample_phase not null,
  pocket_time timestamptz not null,
  received_at timestamptz not null,
  price numeric(24,10) not null,
  ordinal smallint not null,
  constraint prediction_tick_samples_positive_price check (price > 0),
  unique (prediction_id, phase, ordinal)
);

create index prediction_tick_samples_time
  on public.prediction_tick_samples (prediction_id, phase, pocket_time);

create table public.learning_records (
  id uuid primary key default gen_random_uuid(),
  prediction_id uuid not null unique references public.predictions(id) on delete cascade,
  market_type public.market_type not null,
  expiration_seconds smallint not null,
  eligible_for_training boolean not null default false,
  outcome_analysis jsonb not null default '{}'::jsonb,
  shadow_algorithm_version_id uuid references public.algorithm_versions(id) on delete set null,
  shadow_direction public.prediction_direction,
  shadow_strength_score numeric(5,2),
  shadow_would_win boolean,
  created_at timestamptz not null default now(),
  constraint learning_expiration_supported check (expiration_seconds in (60, 120, 180)),
  constraint learning_shadow_strength_range check (
    shadow_strength_score is null or shadow_strength_score between 0 and 100
  )
);

create index learning_market_expiration
  on public.learning_records (market_type, expiration_seconds, eligible_for_training, created_at desc);

create table public.diagnostic_events (
  id bigint generated always as identity primary key,
  component text not null,
  severity text not null,
  code text not null,
  message text not null,
  asset_id uuid references public.assets(id) on delete set null,
  prediction_id uuid references public.predictions(id) on delete set null,
  context jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint diagnostic_severity_supported check (severity in ('info', 'warning', 'error', 'critical'))
);

create index diagnostic_events_latest on public.diagnostic_events (occurred_at desc, severity);
create index diagnostic_events_component on public.diagnostic_events (component, occurred_at desc);

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger telegram_users_set_updated_at
before update on public.telegram_users
for each row execute function public.set_updated_at();

create trigger assets_set_updated_at
before update on public.assets
for each row execute function public.set_updated_at();

create trigger predictions_set_updated_at
before update on public.predictions
for each row execute function public.set_updated_at();

create function public.get_prediction_statistics(
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_market_type public.market_type default null,
  p_source public.prediction_source default null,
  p_asset_id uuid default null,
  p_expiration_seconds smallint default null,
  p_direction public.prediction_direction default null,
  p_strength_min numeric default null,
  p_strength_max numeric default null,
  p_algorithm_version_id uuid default null
)
returns table (
  total bigint,
  wins bigint,
  losses bigint,
  draws bigint,
  invalid bigint,
  cancelled bigint,
  decided_win_rate numeric
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    count(*) as total,
    count(*) filter (where result = 'win') as wins,
    count(*) filter (where result = 'loss') as losses,
    count(*) filter (where result = 'draw') as draws,
    count(*) filter (where result = 'invalid') as invalid,
    count(*) filter (where result = 'cancelled') as cancelled,
    round(
      100 * count(*) filter (where result = 'win')::numeric
      / nullif(count(*) filter (where result in ('win', 'loss')), 0),
      2
    ) as decided_win_rate
  from public.predictions
  where (p_from is null or created_at >= p_from)
    and (p_to is null or created_at < p_to)
    and (p_market_type is null or market_type = p_market_type)
    and (p_source is null or source = p_source)
    and (p_asset_id is null or asset_id = p_asset_id)
    and (p_expiration_seconds is null or expiration_seconds = p_expiration_seconds)
    and (p_direction is null or direction = p_direction)
    and (p_strength_min is null or strength_score >= p_strength_min)
    and (p_strength_max is null or strength_score <= p_strength_max)
    and (p_algorithm_version_id is null or algorithm_version_id = p_algorithm_version_id);
$$;

alter table public.telegram_users enable row level security;
alter table public.assets enable row level security;
alter table public.algorithm_versions enable row level security;
alter table public.candles enable row level security;
alter table public.ticks enable row level security;
alter table public.predictions enable row level security;
alter table public.prediction_features enable row level security;
alter table public.prediction_tick_samples enable row level security;
alter table public.learning_records enable row level security;
alter table public.diagnostic_events enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on function public.get_prediction_statistics(
  timestamptz,
  timestamptz,
  public.market_type,
  public.prediction_source,
  uuid,
  smallint,
  public.prediction_direction,
  numeric,
  numeric,
  uuid
) from public, anon, authenticated;
grant execute on function public.get_prediction_statistics(
  timestamptz,
  timestamptz,
  public.market_type,
  public.prediction_source,
  uuid,
  smallint,
  public.prediction_direction,
  numeric,
  numeric,
  uuid
) to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

comment on column public.predictions.strength_score is
  'Deterministic strength score; not a calibrated probability.';
comment on column public.learning_records.eligible_for_training is
  'Must remain false for INVALID and CANCELLED results.';
comment on function public.get_prediction_statistics is
  'Server-only aggregate. Win rate excludes DRAW, INVALID and CANCELLED from the denominator.';
