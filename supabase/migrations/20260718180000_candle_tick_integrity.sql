-- Market-data integrity used by the read-only Pocket tick and candle pipeline.

delete from public.ticks as duplicate
using public.ticks as original
where duplicate.id > original.id
  and duplicate.asset_id = original.asset_id
  and duplicate.pocket_time = original.pocket_time
  and duplicate.price = original.price;

create unique index ticks_deduplicate_identical_samples
  on public.ticks (asset_id, pocket_time, price);

comment on index public.ticks_deduplicate_identical_samples is
  'Prevents transport retries from counting an identical Pocket tick more than once.';
comment on column public.candles.tick_count is
  'Number of accepted Pocket ticks in the bucket; it is not exchange volume.';

alter table public.candles add column last_tick_at timestamptz;
update public.candles set last_tick_at = open_time where last_tick_at is null;
alter table public.candles alter column last_tick_at set not null;
alter table public.candles add constraint candles_last_tick_in_bucket check (
  last_tick_at >= open_time and last_tick_at < close_time
);

create function public.ingest_pocket_market_data(
  p_ticks jsonb,
  p_candles jsonb,
  p_quotes jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if jsonb_typeof(p_ticks) <> 'array'
    or jsonb_typeof(p_candles) <> 'array'
    or jsonb_typeof(p_quotes) <> 'array' then
    raise exception 'Market data inputs must be JSON arrays';
  end if;

  insert into public.ticks (
    asset_id,
    pocket_time,
    received_at,
    price,
    pocket_sequence
  )
  select
    item.asset_id,
    item.pocket_time,
    item.received_at,
    item.price,
    item.pocket_sequence
  from jsonb_to_recordset(p_ticks) as item(
    asset_id uuid,
    pocket_time timestamptz,
    received_at timestamptz,
    price numeric,
    pocket_sequence text
  )
  on conflict (asset_id, pocket_time, price) do nothing;

  insert into public.candles (
    asset_id,
    timeframe_seconds,
    open_time,
    close_time,
    last_tick_at,
    open,
    high,
    low,
    close,
    tick_count,
    is_complete,
    received_at
  )
  select
    item.asset_id,
    item.timeframe_seconds,
    item.open_time,
    item.close_time,
    item.last_tick_at,
    item.open,
    item.high,
    item.low,
    item.close,
    item.tick_count,
    item.is_complete,
    now()
  from jsonb_to_recordset(p_candles) as item(
    asset_id uuid,
    timeframe_seconds smallint,
    open_time timestamptz,
    close_time timestamptz,
    last_tick_at timestamptz,
    open numeric,
    high numeric,
    low numeric,
    close numeric,
    tick_count integer,
    is_complete boolean
  )
  on conflict (asset_id, timeframe_seconds, open_time) do update
  set
    close_time = excluded.close_time,
    high = greatest(public.candles.high, excluded.high),
    low = least(public.candles.low, excluded.low),
    close = case
      when excluded.last_tick_at >= public.candles.last_tick_at then excluded.close
      else public.candles.close
    end,
    last_tick_at = greatest(public.candles.last_tick_at, excluded.last_tick_at),
    tick_count = greatest(public.candles.tick_count, excluded.tick_count),
    is_complete = public.candles.is_complete or excluded.is_complete,
    received_at = excluded.received_at;

  update public.assets as asset
  set
    last_quote = quote.price,
    last_quote_at = quote.pocket_time,
    pocket_server_time_at = quote.pocket_time,
    data_state = 'ready'
  from jsonb_to_recordset(p_quotes) as quote(
    asset_id uuid,
    pocket_time timestamptz,
    received_at timestamptz,
    price numeric
  )
  where asset.id = quote.asset_id
    and (asset.last_quote_at is null or quote.pocket_time >= asset.last_quote_at);
end;
$$;

revoke all on function public.ingest_pocket_market_data(jsonb, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_pocket_market_data(jsonb, jsonb, jsonb)
  to service_role;

comment on function public.ingest_pocket_market_data is
  'Atomically persists accepted Pocket ticks, candle snapshots and latest quotes.';
