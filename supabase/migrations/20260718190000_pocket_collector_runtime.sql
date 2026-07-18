-- Live read-only Pocket catalog updates. POCKET_AUTH_PACKET never reaches the database.

-- The bootstrap HTML catalog originally used display labels as keys. Preserve row IDs and
-- foreign keys while switching those rows to the exact symbols used by Pocket WebSocket.
drop table if exists pg_temp.pocket_asset_symbol_merge_map;
create temporary table pocket_asset_symbol_merge_map (
  legacy_id uuid primary key,
  canonical_id uuid not null
);

insert into pocket_asset_symbol_merge_map (legacy_id, canonical_id)
select legacy.id, canonical.id
from public.assets as legacy
join public.assets as canonical
  on canonical.pocket_symbol = replace(
    replace(upper(legacy.pocket_symbol), '/', ''),
    ' OTC',
    '_otc'
  )
  and canonical.asset_category = 'currency'
where legacy.asset_category = 'currency'
  and legacy.pocket_symbol ~* '^[A-Z]{3}/[A-Z]{3}( OTC)?$'
  and legacy.id <> canonical.id;

-- Keep the already canonical UUID and merge the freshest metadata/quote into it.
update public.assets as canonical
set
  display_name = coalesce(nullif(canonical.display_name, ''), legacy.display_name),
  base_currency = coalesce(canonical.base_currency, legacy.base_currency),
  quote_currency = coalesce(canonical.quote_currency, legacy.quote_currency),
  is_available = canonical.is_available or legacy.is_available,
  payout_percent = case
    when coalesce(legacy.catalog_updated_at, '-infinity'::timestamptz)
      > coalesce(canonical.catalog_updated_at, '-infinity'::timestamptz)
      then coalesce(legacy.payout_percent, canonical.payout_percent)
    else coalesce(canonical.payout_percent, legacy.payout_percent)
  end,
  data_state = case
    when coalesce(legacy.last_quote_at, '-infinity'::timestamptz)
      > coalesce(canonical.last_quote_at, '-infinity'::timestamptz)
      then legacy.data_state
    else canonical.data_state
  end,
  last_quote = case
    when coalesce(legacy.last_quote_at, '-infinity'::timestamptz)
      > coalesce(canonical.last_quote_at, '-infinity'::timestamptz)
      then legacy.last_quote
    else canonical.last_quote
  end,
  last_quote_at = greatest(canonical.last_quote_at, legacy.last_quote_at),
  pocket_server_time_at = greatest(
    canonical.pocket_server_time_at,
    legacy.pocket_server_time_at
  ),
  catalog_source = case
    when coalesce(legacy.catalog_updated_at, '-infinity'::timestamptz)
      > coalesce(canonical.catalog_updated_at, '-infinity'::timestamptz)
      then legacy.catalog_source
    else canonical.catalog_source
  end,
  catalog_updated_at = greatest(canonical.catalog_updated_at, legacy.catalog_updated_at),
  catalog_payload = legacy.catalog_payload || canonical.catalog_payload
from pocket_asset_symbol_merge_map as merge
join public.assets as legacy on legacy.id = merge.legacy_id
where canonical.id = merge.canonical_id;

-- Merge a candle collision before repointing remaining legacy rows.
update public.candles as canonical
set
  open = case
    when canonical.tick_count = 0 and legacy.tick_count > 0 then legacy.open
    else canonical.open
  end,
  high = greatest(canonical.high, legacy.high),
  low = least(canonical.low, legacy.low),
  close = case
    when legacy.last_tick_at > canonical.last_tick_at then legacy.close
    else canonical.close
  end,
  last_tick_at = greatest(canonical.last_tick_at, legacy.last_tick_at),
  tick_count = greatest(canonical.tick_count, legacy.tick_count),
  is_complete = canonical.is_complete or legacy.is_complete,
  received_at = greatest(canonical.received_at, legacy.received_at)
from pocket_asset_symbol_merge_map as merge
join public.candles as legacy on legacy.asset_id = merge.legacy_id
where canonical.asset_id = merge.canonical_id
  and canonical.timeframe_seconds = legacy.timeframe_seconds
  and canonical.open_time = legacy.open_time;

delete from public.candles as legacy
using pocket_asset_symbol_merge_map as merge, public.candles as canonical
where legacy.asset_id = merge.legacy_id
  and canonical.asset_id = merge.canonical_id
  and canonical.timeframe_seconds = legacy.timeframe_seconds
  and canonical.open_time = legacy.open_time;

update public.candles as candle
set asset_id = merge.canonical_id
from pocket_asset_symbol_merge_map as merge
where candle.asset_id = merge.legacy_id;

-- Identical transport samples can exist under both asset UUIDs.
delete from public.ticks as legacy
using pocket_asset_symbol_merge_map as merge, public.ticks as canonical
where legacy.asset_id = merge.legacy_id
  and canonical.asset_id = merge.canonical_id
  and canonical.pocket_time = legacy.pocket_time
  and canonical.price = legacy.price;

update public.ticks as tick
set asset_id = merge.canonical_id
from pocket_asset_symbol_merge_map as merge
where tick.asset_id = merge.legacy_id;

update public.predictions as prediction
set asset_id = merge.canonical_id
from pocket_asset_symbol_merge_map as merge
where prediction.asset_id = merge.legacy_id;

update public.diagnostic_events as event
set asset_id = merge.canonical_id
from pocket_asset_symbol_merge_map as merge
where event.asset_id = merge.legacy_id;

delete from public.assets as legacy
using pocket_asset_symbol_merge_map as merge
where legacy.id = merge.legacy_id;

update public.assets
set pocket_symbol = replace(replace(upper(pocket_symbol), '/', ''), ' OTC', '_otc')
where asset_category = 'currency'
  and pocket_symbol ~* '^[A-Z]{3}/[A-Z]{3}( OTC)?$';

drop table pocket_asset_symbol_merge_map;

create function public.normalize_currency_pocket_symbol()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.asset_category = 'currency'::public.asset_category
    and new.pocket_symbol ~* '^[A-Z]{3}/[A-Z]{3}( OTC)?$' then
    new.pocket_symbol = replace(replace(upper(new.pocket_symbol), '/', ''), ' OTC', '_otc');
  end if;
  return new;
end;
$$;

create trigger assets_normalize_currency_pocket_symbol
before insert or update of pocket_symbol, asset_category on public.assets
for each row execute function public.normalize_currency_pocket_symbol();

create function public.apply_pocket_live_asset_catalog(
  p_assets jsonb,
  p_received_at timestamptz
)
returns integer
language plpgsql
security invoker
set search_path = public
as $$
declare
  affected integer;
begin
  if jsonb_typeof(p_assets) <> 'array' or jsonb_array_length(p_assets) = 0 then
    raise exception 'Pocket live asset catalog must be a non-empty JSON array';
  end if;

  insert into public.assets (
    pocket_symbol,
    display_name,
    market_type,
    asset_category,
    base_currency,
    quote_currency,
    is_available,
    payout_percent,
    data_state,
    catalog_source,
    catalog_updated_at,
    catalog_payload
  )
  select
    item.pocket_symbol,
    item.display_name,
    item.market_type::public.market_type,
    'currency'::public.asset_category,
    item.base_currency,
    item.quote_currency,
    item.is_available,
    item.payout_percent,
    case
      when item.is_available then 'warming'::public.asset_data_state
      else 'unavailable'::public.asset_data_state
    end,
    'pocket-demo-websocket',
    p_received_at,
    jsonb_build_object('liveCatalogReceivedAt', p_received_at)
  from jsonb_to_recordset(p_assets) as item(
    pocket_symbol text,
    display_name text,
    base_currency text,
    quote_currency text,
    market_type text,
    payout_percent numeric,
    is_available boolean
  )
  where item.pocket_symbol ~* '^[A-Z]{6}(_otc)?$'
    and item.base_currency ~ '^[A-Z]{3}$'
    and item.quote_currency ~ '^[A-Z]{3}$'
    and item.market_type in ('regular', 'otc')
    and (item.payout_percent is null or item.payout_percent between 0 and 100)
  on conflict (pocket_symbol) do update
  set
    display_name = excluded.display_name,
    market_type = excluded.market_type,
    asset_category = excluded.asset_category,
    base_currency = excluded.base_currency,
    quote_currency = excluded.quote_currency,
    is_available = excluded.is_available,
    payout_percent = excluded.payout_percent,
    data_state = case
      when not excluded.is_available then 'unavailable'::public.asset_data_state
      when public.assets.last_quote_at is null then 'warming'::public.asset_data_state
      when public.assets.last_quote_at < p_received_at - interval '15 seconds'
        then 'stale'::public.asset_data_state
      else 'ready'::public.asset_data_state
    end,
    catalog_source = excluded.catalog_source,
    catalog_updated_at = excluded.catalog_updated_at,
    catalog_payload = public.assets.catalog_payload || excluded.catalog_payload;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.apply_pocket_live_asset_catalog(jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_pocket_live_asset_catalog(jsonb, timestamptz)
  to service_role;

comment on function public.apply_pocket_live_asset_catalog is
  'Updates currency availability and payouts from the authenticated Pocket Demo WebSocket catalog.';
comment on column public.candles.tick_count is
  'Accepted Pocket ticks in the bucket. Zero means Pocket supplied an OHLC history row without raw ticks.';
