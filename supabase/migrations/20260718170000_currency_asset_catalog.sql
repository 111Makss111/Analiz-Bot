-- Read-only currency catalog cache. Live quotes remain the responsibility of the Pocket collector.

create type public.asset_category as enum (
  'currency',
  'commodity',
  'stock',
  'cryptocurrency',
  'index'
);

alter table public.assets
  add column asset_category public.asset_category not null default 'currency',
  add column base_currency text,
  add column quote_currency text,
  add column catalog_source text,
  add column catalog_updated_at timestamptz;

alter table public.assets
  add constraint assets_currency_codes_valid check (
    asset_category <> 'currency'
    or (
      base_currency ~ '^[A-Z]{3}$'
      and quote_currency ~ '^[A-Z]{3}$'
    )
  );

create index assets_catalog_listing
  on public.assets (asset_category, is_available desc, payout_percent desc, display_name);

create function public.replace_currency_asset_catalog(
  p_assets jsonb,
  p_source text,
  p_fetched_at timestamptz
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
    raise exception 'Currency catalog must be a non-empty JSON array';
  end if;

  if nullif(trim(p_source), '') is null then
    raise exception 'Catalog source is required';
  end if;

  update public.assets
  set
    is_available = false,
    payout_percent = null,
    catalog_source = p_source,
    catalog_updated_at = p_fetched_at
  where asset_category = 'currency';

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
    true,
    item.payout_percent,
    'warming'::public.asset_data_state,
    p_source,
    p_fetched_at,
    jsonb_build_object(
      'catalogSource', p_source,
      'catalogFetchedAt', p_fetched_at
    ) || coalesce(item.catalog_payload, '{}'::jsonb)
  from jsonb_to_recordset(p_assets) as item(
    pocket_symbol text,
    display_name text,
    market_type text,
    base_currency text,
    quote_currency text,
    payout_percent numeric,
    catalog_payload jsonb
  )
  on conflict (pocket_symbol) do update
  set
    display_name = excluded.display_name,
    market_type = excluded.market_type,
    asset_category = excluded.asset_category,
    base_currency = excluded.base_currency,
    quote_currency = excluded.quote_currency,
    is_available = excluded.is_available,
    payout_percent = excluded.payout_percent,
    catalog_source = excluded.catalog_source,
    catalog_updated_at = excluded.catalog_updated_at,
    catalog_payload = excluded.catalog_payload;

  get diagnostics affected = row_count;
  return affected;
end;
$$;

revoke all on function public.replace_currency_asset_catalog(jsonb, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.replace_currency_asset_catalog(jsonb, text, timestamptz)
  to service_role;

comment on column public.assets.catalog_updated_at is
  'Time the catalog metadata was fetched. It is not a quote timestamp.';
comment on function public.replace_currency_asset_catalog is
  'Atomically replaces availability and payout metadata for cached Pocket currency assets.';
