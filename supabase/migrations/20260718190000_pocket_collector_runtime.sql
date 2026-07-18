-- Live read-only Pocket catalog updates. POCKET_AUTH_PACKET never reaches the database.

-- The bootstrap HTML catalog originally used display labels as keys. Preserve row IDs and
-- foreign keys while switching those rows to the exact symbols used by Pocket WebSocket.
update public.assets
set pocket_symbol = replace(replace(upper(pocket_symbol), '/', ''), ' OTC', '_otc')
where asset_category = 'currency'
  and pocket_symbol ~* '^[A-Z]{3}/[A-Z]{3}( OTC)?$';

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
