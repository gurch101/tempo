CREATE TABLE finance_quotes_global (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  display_name TEXT NOT NULL,
  native_currency TEXT NOT NULL CHECK (native_currency GLOB '[A-Z][A-Z][A-Z]'),
  market_price REAL NOT NULL CHECK (market_price >= 0),
  synced_at INTEGER NOT NULL,
  UNIQUE (symbol)
);

INSERT INTO finance_quotes_global(symbol,display_name,native_currency,market_price,synced_at)
SELECT symbol,display_name,native_currency,market_price,synced_at
FROM (
  SELECT q.symbol,COALESCE(h.display_name,q.symbol) AS display_name,q.native_currency,q.market_price,q.synced_at,
         ROW_NUMBER() OVER (PARTITION BY q.symbol ORDER BY q.synced_at DESC,q.space_id DESC) AS rank
  FROM finance_quotes q
  LEFT JOIN finance_holdings h ON h.space_id=q.space_id AND h.asset_type='STOCK' AND h.symbol=q.symbol
)
WHERE rank=1;

CREATE TABLE finance_daily_prices_global (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol TEXT NOT NULL,
  native_currency TEXT NOT NULL CHECK (native_currency GLOB '[A-Z][A-Z][A-Z]'),
  price_date TEXT NOT NULL CHECK (price_date GLOB '????-??-??'),
  close_price REAL NOT NULL CHECK (close_price >= 0),
  UNIQUE (symbol,price_date)
);

INSERT INTO finance_daily_prices_global(symbol,native_currency,price_date,close_price)
SELECT symbol,native_currency,price_date,close_price
FROM (
  SELECT symbol,native_currency,price_date,close_price,
         ROW_NUMBER() OVER (PARTITION BY symbol,price_date ORDER BY space_id DESC) AS rank
  FROM finance_daily_prices
)
WHERE rank=1;

CREATE TABLE finance_fx_quotes_global (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_currency TEXT NOT NULL CHECK (from_currency GLOB '[A-Z][A-Z][A-Z]'),
  to_currency TEXT NOT NULL CHECK (to_currency GLOB '[A-Z][A-Z][A-Z]'),
  exchange_rate REAL NOT NULL CHECK (exchange_rate > 0),
  synced_at INTEGER NOT NULL,
  UNIQUE (from_currency,to_currency)
);

INSERT INTO finance_fx_quotes_global(from_currency,to_currency,exchange_rate,synced_at)
SELECT from_currency,to_currency,exchange_rate,synced_at
FROM (
  SELECT from_currency,to_currency,exchange_rate,synced_at,
         ROW_NUMBER() OVER (PARTITION BY from_currency,to_currency ORDER BY synced_at DESC,space_id DESC) AS rank
  FROM finance_fx_quotes
)
WHERE rank=1;

CREATE TABLE finance_daily_fx_rates_global (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_currency TEXT NOT NULL CHECK (from_currency GLOB '[A-Z][A-Z][A-Z]'),
  to_currency TEXT NOT NULL CHECK (to_currency GLOB '[A-Z][A-Z][A-Z]'),
  rate_date TEXT NOT NULL CHECK (rate_date GLOB '????-??-??'),
  exchange_rate REAL NOT NULL CHECK (exchange_rate > 0),
  UNIQUE (from_currency,to_currency,rate_date)
);

INSERT INTO finance_daily_fx_rates_global(from_currency,to_currency,rate_date,exchange_rate)
SELECT from_currency,to_currency,rate_date,exchange_rate
FROM (
  SELECT from_currency,to_currency,rate_date,exchange_rate,
         ROW_NUMBER() OVER (PARTITION BY from_currency,to_currency,rate_date ORDER BY space_id DESC) AS rank
  FROM finance_daily_fx_rates
)
WHERE rank=1;

DROP TABLE finance_quotes;
DROP TABLE finance_daily_prices;
DROP TABLE finance_fx_quotes;
DROP TABLE finance_daily_fx_rates;

ALTER TABLE finance_quotes_global RENAME TO finance_quotes;
ALTER TABLE finance_daily_prices_global RENAME TO finance_daily_prices;
ALTER TABLE finance_fx_quotes_global RENAME TO finance_fx_quotes;
ALTER TABLE finance_daily_fx_rates_global RENAME TO finance_daily_fx_rates;
