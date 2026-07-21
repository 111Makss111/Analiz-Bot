-- Compact collector storage: live ticks/current candles remain in bounded Render memory.

create index if not exists candles_open_time_brin
  on public.candles using brin (open_time);

create function public.ingest_pocket_completed_candles(p_candles jsonb)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected integer;
begin
  if jsonb_typeof(p_candles) <> 'array' then
    raise exception 'Completed candles input must be a JSON array';
  end if;
  if jsonb_array_length(p_candles) > 1000 then
    raise exception 'Completed candle batch exceeds 1000 rows';
  end if;

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
    true,
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
  where item.is_complete is true
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
    is_complete = true,
    received_at = excluded.received_at;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

-- Disable the former high-volume entry point for server deployments after this migration.
revoke execute on function public.ingest_pocket_market_data(jsonb, jsonb, jsonb)
  from service_role;
revoke all on function public.ingest_pocket_completed_candles(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_pocket_completed_candles(jsonb)
  to service_role;

create function public.prune_pocket_market_data(
  p_candles_before timestamptz,
  p_ticks_before timestamptz
)
returns table (deleted_candles bigint, deleted_ticks bigint)
language plpgsql
security invoker
set search_path = public
as $$
declare
  candle_count bigint;
  tick_count bigint;
begin
  if p_candles_before is null or p_ticks_before is null then
    raise exception 'Retention boundaries are required';
  end if;
  if p_candles_before > now() or p_ticks_before > now() then
    raise exception 'Retention boundaries cannot be in the future';
  end if;

  delete from public.candles
  where is_complete is true and open_time < p_candles_before;
  get diagnostics candle_count = row_count;

  delete from public.ticks where pocket_time < p_ticks_before;
  get diagnostics tick_count = row_count;

  return query select candle_count, tick_count;
end;
$$;

revoke all on function public.prune_pocket_market_data(timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.prune_pocket_market_data(timestamptz, timestamptz)
  to service_role;

comment on function public.ingest_pocket_completed_candles is
  'Low-volume collector endpoint. Persists only bounded, completed Pocket candles; never raw live ticks.';
comment on function public.prune_pocket_market_data is
  'Explicit indexed retention maintenance. Call at most once per day from a protected server workflow.';
