import YahooFinance from "yahoo-finance2";

type Row = Record<string, unknown>;
const emptyRows = () => ({ results: [] } as unknown as D1Result<Row>);

export const FINANCE_CURRENCIES = ["CAD", "USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CHF"] as const;
export type FinanceCurrency = typeof FINANCE_CURRENCIES[number];
export const FINANCE_ALLOCATION_COLORS = ["#ec5f3e", "#f0ad43", "#d9c84d", "#73a66f", "#3d8f7c", "#4c91a8", "#6179ad", "#8270a8", "#ad668d", "#9a7460"] as const;

export class MarketDataError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export interface MarketPoint { date: string; close: number; }
export interface MarketSeries {
  symbol: string;
  name: string;
  currency: string;
  currentPrice: number;
  marketTime: number | null;
  points: MarketPoint[];
}

function finite(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeTicker(value: unknown): string | null {
  const ticker = String(value || "").trim().toUpperCase();
  return ticker && ticker.length <= 32 && /^[A-Z0-9^.][A-Z0-9.^=_-]*$/.test(ticker) ? ticker : null;
}

export function normalizeCurrency(value: unknown): FinanceCurrency | null {
  const currency = String(value || "").trim().toUpperCase();
  return FINANCE_CURRENCIES.includes(currency as FinanceCurrency) ? currency as FinanceCurrency : null;
}

function quoteCurrency(value: unknown): { currency: string; multiplier: number } {
  const raw = String(value || "").trim();
  if (raw === "GBp" || raw === "GBX") return { currency: "GBP", multiplier: .01 };
  return { currency: raw.toUpperCase(), multiplier: 1 };
}

function dateInZone(timestampSeconds: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(timestampSeconds * 1000)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

const yahooFinance = new YahooFinance({ versionCheck: false });

export async function fetchYahooChart(symbol: string): Promise<MarketSeries> {
  try {
    const result = await yahooFinance.chart(symbol, {
      period1: new Date(Date.now() - 93 * 24 * 60 * 60 * 1000),
      period2: new Date(), interval: "1d", includePrePost: false, events: "div,splits"
    });
    const normalizedCurrency = quoteCurrency(result.meta.currency);
    const current = finite(result.meta.regularMarketPrice);
    if (!normalizedCurrency.currency || current === null || current < 0)
      throw new MarketDataError(`Yahoo Finance did not return a usable quote for ${symbol}.`);
    const timeZone = result.meta.exchangeTimezoneName || "UTC";
    const byDate = new Map<string, MarketPoint>();
    result.quotes.forEach(quote => {
      const close = finite(quote.close);
      if (close === null || close < 0) return;
      const date = dateInZone(quote.date.getTime() / 1000, timeZone);
      byDate.set(date, { date, close: close * normalizedCurrency.multiplier });
    });
    return {
      symbol: String(result.meta.symbol || symbol).toUpperCase(),
      name: String(result.meta.longName || result.meta.shortName || result.meta.symbol || symbol),
      currency: normalizedCurrency.currency,
      currentPrice: current * normalizedCurrency.multiplier,
      marketTime: result.meta.regularMarketTime?.getTime() ?? null,
      points: [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date))
    };
  } catch (cause) {
    if (cause instanceof MarketDataError) throw cause;
    const status = finite((cause as { statusCode?: unknown })?.statusCode) ?? undefined;
    const detail = status === 429 ? " because its rate limit was reached. Try again later" : "";
    throw new MarketDataError(`Yahoo Finance could not return ${symbol}${detail}.`, status);
  }
}

async function batch(db: D1Database, statements: D1PreparedStatement[]) {
  for (let index = 0; index < statements.length; index += 100) await db.batch(statements.slice(index, index + 100));
}

export async function refreshFinances(db: D1Database, spaceId: number, loadMarketData: (symbol: string) => Promise<MarketSeries> = fetchYahooChart, now = Date.now()) {
  const [holdingResult, preference] = await Promise.all([
    db.prepare("SELECT asset_type,symbol,native_currency FROM finance_holdings WHERE space_id=? ORDER BY id").bind(spaceId).all<Row>(),
    db.prepare("SELECT finance_display_currency FROM spaces WHERE id=?").bind(spaceId).first<Row>()
  ]);
  const holdings = holdingResult.results || [];
  const target = normalizeCurrency(preference?.finance_display_currency) || "CAD";
  const symbols = [...new Set(holdings.filter(row => row.asset_type === "STOCK").map(row => String(row.symbol)))];
  const stocks: MarketSeries[] = [];
  for (const symbol of symbols) stocks.push(await loadMarketData(symbol));
  const stockBySymbol = new Map(stocks.map(stock => [stock.symbol, stock]));
  const sourceCurrencies = new Set(holdings.filter(row => row.asset_type === "CASH").map(row => String(row.native_currency)));
  stocks.forEach(stock => sourceCurrencies.add(stock.currency));
  sourceCurrencies.delete(target);
  const fxSeries: Array<{ source: string; series: MarketSeries }> = [];
  for (const source of sourceCurrencies) fxSeries.push({ source, series: await loadMarketData(`${source}${target}=X`) });
  const [latestPriceResult,latestFxResult]=await Promise.all([
    symbols.length?db.prepare(`SELECT symbol,MAX(price_date) AS latest_date FROM finance_daily_prices WHERE symbol IN (${symbols.map(()=>"?").join(",")}) GROUP BY symbol`).bind(...symbols).all<Row>():Promise.resolve(emptyRows()),
    sourceCurrencies.size?db.prepare(`SELECT from_currency,to_currency,MAX(rate_date) AS latest_date FROM finance_daily_fx_rates WHERE to_currency=? AND from_currency IN (${[...sourceCurrencies].map(()=>"?").join(",")}) GROUP BY from_currency,to_currency`).bind(target,...sourceCurrencies).all<Row>():Promise.resolve(emptyRows())
  ]);
  const latestPriceDates = new Map((latestPriceResult.results || []).map(row => [String(row.symbol), String(row.latest_date)]));
  const latestFxDates = new Map((latestFxResult.results || []).map(row => [`${row.from_currency}:${row.to_currency}`, String(row.latest_date)]));
  const statements: D1PreparedStatement[] = [];
  for (const stock of stocks) {
    statements.push(db.prepare("UPDATE finance_holdings SET native_currency=?,display_name=? WHERE space_id=? AND asset_type='STOCK' AND symbol=?")
      .bind(stock.currency, stock.name, spaceId, stock.symbol));
    statements.push(db.prepare("INSERT INTO finance_quotes(symbol,display_name,native_currency,market_price,synced_at) VALUES(?,?,?,?,?) ON CONFLICT(symbol) DO UPDATE SET display_name=excluded.display_name,native_currency=excluded.native_currency,market_price=excluded.market_price,synced_at=excluded.synced_at")
      .bind(stock.symbol, stock.name, stock.currency, stock.currentPrice, now));
    const latestDate = latestPriceDates.get(stock.symbol);
    stock.points.filter(point => !latestDate || point.date > latestDate).forEach(point => statements.push(
      db.prepare("INSERT INTO finance_daily_prices(symbol,native_currency,price_date,close_price) VALUES(?,?,?,?)")
        .bind(stock.symbol, stock.currency, point.date, point.close)
    ));
  }
  for (const { source, series } of fxSeries) {
    statements.push(db.prepare("INSERT INTO finance_fx_quotes(from_currency,to_currency,exchange_rate,synced_at) VALUES(?,?,?,?) ON CONFLICT(from_currency,to_currency) DO UPDATE SET exchange_rate=excluded.exchange_rate,synced_at=excluded.synced_at")
      .bind(source, target, series.currentPrice, now));
    const latestDate = latestFxDates.get(`${source}:${target}`);
    series.points.filter(point => !latestDate || point.date > latestDate).forEach(point => statements.push(
      db.prepare("INSERT INTO finance_daily_fx_rates(from_currency,to_currency,rate_date,exchange_rate) VALUES(?,?,?,?)")
        .bind(source, target, point.date, point.close)
    ));
  }
  await batch(db, statements);
  return { stocks: stockBySymbol.size, exchangeRates: fxSeries.length, refreshedAt: now };
}

function latestOnOrBefore<T extends { date: string }>(items: T[], date: string): T | null {
  let match: T | null = null;
  for (const item of items) if (item.date <= date && (!match || item.date > match.date)) match = item;
  return match;
}

function dateOffset(dateKey: string, days: number): string {
  const date = new Date(`${dateKey}T12:00:00Z`); date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export async function readFinances(db: D1Database, spaceId: number, now = Date.now()) {
  const [preference, holdingResult, categoryResult] = await Promise.all([
    db.prepare("SELECT timezone,finance_display_currency FROM spaces WHERE id=?").bind(spaceId).first<Row>(),
    db.prepare("SELECT id,asset_type,symbol,native_currency,display_name,quantity,allocation_category_id FROM finance_holdings WHERE space_id=? ORDER BY asset_type DESC,symbol,native_currency,id").bind(spaceId).all<Row>(),
    db.prepare("SELECT id,name,color,target_percentage FROM finance_allocation_categories WHERE space_id=? ORDER BY name,id").bind(spaceId).all<Row>()
  ]);
  const currency = normalizeCurrency(preference?.finance_display_currency) || "CAD";
  const today = dateInZone(now / 1000, String(preference?.timezone || "UTC"));
  const comparisons = { yesterday: dateOffset(today, -1), week: dateOffset(today, -7), month: dateOffset(today, -30) };
  const comparisonDates = Object.values(comparisons);
  const holdingRows=holdingResult.results||[];
  const symbols=[...new Set(holdingRows.filter(row=>row.asset_type==="STOCK"&&row.symbol).map(row=>String(row.symbol)))];
  const [quoteResult,pricesResult]=await Promise.all([
    symbols.length?db.prepare(`SELECT symbol,display_name,native_currency,market_price,synced_at FROM finance_quotes WHERE symbol IN (${symbols.map(()=>"?").join(",")})`).bind(...symbols).all<Row>():Promise.resolve(emptyRows()),
    symbols.length?db.prepare(`WITH requested_symbols(symbol) AS (VALUES ${symbols.map(()=>"(?)").join(",")}),comparison_dates(cutoff) AS (VALUES ${comparisonDates.map(()=>"(?)").join(",")})
      SELECT DISTINCT price.symbol,price.native_currency,price.price_date,price.close_price
      FROM requested_symbols requested CROSS JOIN comparison_dates comparison
      JOIN finance_daily_prices price ON price.id=(
        SELECT candidate.id FROM finance_daily_prices candidate
        WHERE candidate.symbol=requested.symbol AND candidate.price_date<=comparison.cutoff AND candidate.close_price>0
        ORDER BY candidate.price_date DESC LIMIT 1
      )
      ORDER BY price.symbol,price.price_date`).bind(...symbols,...comparisonDates).all<Row>():Promise.resolve(emptyRows())
  ]);
  const currencies=new Set(holdingRows.filter(row=>row.asset_type==="CASH"&&row.native_currency).map(row=>String(row.native_currency)));
  for(const row of quoteResult.results||[])currencies.add(String(row.native_currency));
  currencies.delete(currency);
  const sources=[...currencies];
  const [fxQuoteResult,fxResult]=await Promise.all([
    sources.length?db.prepare(`SELECT from_currency,to_currency,exchange_rate,synced_at FROM finance_fx_quotes WHERE to_currency=? AND from_currency IN (${sources.map(()=>"?").join(",")})`).bind(currency,...sources).all<Row>():Promise.resolve(emptyRows()),
    sources.length?db.prepare(`WITH requested_sources(from_currency) AS (VALUES ${sources.map(()=>"(?)").join(",")}),comparison_dates(cutoff) AS (VALUES ${comparisonDates.map(()=>"(?)").join(",")})
      SELECT DISTINCT rate.from_currency,rate.to_currency,rate.rate_date,rate.exchange_rate
      FROM requested_sources requested CROSS JOIN comparison_dates comparison
      JOIN finance_daily_fx_rates rate ON rate.id=(
        SELECT candidate.id FROM finance_daily_fx_rates candidate
        WHERE candidate.from_currency=requested.from_currency AND candidate.to_currency=? AND candidate.rate_date<=comparison.cutoff
        ORDER BY candidate.rate_date DESC LIMIT 1
      )
      ORDER BY rate.from_currency,rate.rate_date`).bind(...sources,...comparisonDates,currency).all<Row>():Promise.resolve(emptyRows())
  ]);
  const quotes = new Map((quoteResult.results || []).map(row => [String(row.symbol), row]));
  const prices = new Map<string, Array<{ date: string; price: number; currency: string }>>();
  for (const row of pricesResult.results || []) {
    const symbol = String(row.symbol), items = prices.get(symbol) || [];
    items.push({ date: String(row.price_date), price: Number(row.close_price), currency: String(row.native_currency) }); prices.set(symbol, items);
  }
  const fxQuotes = new Map((fxQuoteResult.results || []).map(row => [`${row.from_currency}:${row.to_currency}`, row]));
  const fxHistory = new Map<string, Array<{ date: string; rate: number }>>();
  for (const row of fxResult.results || []) {
    const key = `${row.from_currency}:${row.to_currency}`, items = fxHistory.get(key) || [];
    items.push({ date: String(row.rate_date), rate: Number(row.exchange_rate) }); fxHistory.set(key, items);
  }
  const holdings = (holdingResult.results || []).map(row => ({
    id: Number(row.id), type: String(row.asset_type), symbol: row.symbol == null ? null : String(row.symbol),
    currency: row.native_currency == null ? null : String(row.native_currency), name: row.display_name == null ? null : String(row.display_name), quantity: Number(row.quantity),
    allocationCategoryId: row.allocation_category_id == null ? null : Number(row.allocation_category_id)
  }));
  const rateAt = (source: string | null, date: string | null): number | null => {
    if (!source) return null; if (source === currency) return 1;
    const key = `${source}:${currency}`;
    if (date === null) return finite(fxQuotes.get(key)?.exchange_rate);
    return latestOnOrBefore(fxHistory.get(key) || [], date)?.rate ?? null;
  };
  const priceAt = (symbol: string, date: string | null): { price: number; currency: string } | null => {
    if (date === null) { const quote = quotes.get(symbol); return quote ? { price: Number(quote.market_price), currency: String(quote.native_currency) } : null; }
    return latestOnOrBefore((prices.get(symbol) || []).filter(point => point.price > 0), date);
  };
  const valueHolding = (holding: typeof holdings[number], date: string | null): number | null => {
    if (holding.type === "CASH") { const rate = rateAt(holding.currency, date); return rate === null ? null : holding.quantity * rate; }
    const price = priceAt(holding.symbol!, date); if (!price) return null;
    const rate = rateAt(price.currency, date); return rate === null ? null : holding.quantity * price.price * rate;
  };
  const totalAt = (date: string | null) => {
    const values = holdings.map(holding => valueHolding(holding, date));
    return values.some(value => value === null) ? null : values.reduce<number>((sum, value) => sum + (value || 0), 0);
  };
  const total = totalAt(null);
  const changes = Object.fromEntries(Object.entries(comparisons).map(([key, date]) => {
    const fallbackLabels = new Set<string>();
    const values = holdings.map(holding => {
      const historical = valueHolding(holding, date);
      if (historical !== null) return historical;
      const current = valueHolding(holding, null);
      if (current !== null) fallbackLabels.add(holding.type === "STOCK" ? holding.symbol! : holding.name || `${holding.currency} cash`);
      return current;
    });
    const previous = values.some(value => value === null) ? null : values.reduce<number>((sum, value) => sum + (value || 0), 0);
    return [key, { date, value: previous, change: total === null || previous === null ? null : total - previous, fallbackLabels: [...fallbackLabels] }];
  }));
  const valuedHoldings = holdings.map(holding => {
    const quote = holding.type === "STOCK" && holding.symbol ? quotes.get(holding.symbol) : null;
    const nativePrice = holding.type === "CASH" ? 1 : finite(quote?.market_price);
    const nativeCurrency = holding.type === "STOCK" && quote?.native_currency != null ? String(quote.native_currency) : holding.currency;
    const marketValue = valueHolding(holding, null);
    const previousMarketValue = valueHolding(holding, comparisons.yesterday);
    const valueChange = marketValue === null || previousMarketValue === null ? null : marketValue - previousMarketValue;
    const percentChange = valueChange === null || previousMarketValue === null || previousMarketValue === 0 ? null : valueChange / previousMarketValue * 100;
    const name = holding.type === "STOCK" && quote?.display_name != null ? String(quote.display_name) : holding.name;
    return { ...holding, currency: nativeCurrency, name, nativePrice, marketValue, previousMarketValue, valueChange, percentChange, quoteUpdatedAt: holding.type === "CASH" ? null : finite(quote?.synced_at) };
  });
  const allocationTotal = valuedHoldings.reduce((sum, holding) => sum + (holding.marketValue ?? 0), 0);
  const categories = (categoryResult.results || []).map(row => {
    const id = Number(row.id);
    const currentValue = valuedHoldings.filter(holding => holding.allocationCategoryId === id).reduce((sum, holding) => sum + (holding.marketValue ?? 0), 0);
    const currentPercentage = allocationTotal > 0 ? currentValue / allocationTotal * 100 : 0;
    const targetPercentage = Number(row.target_percentage);
    return { id, name: String(row.name), color: String(row.color), targetPercentage, currentValue, currentPercentage, driftPercentage: currentPercentage - targetPercentage };
  });
  const unassignedValue = valuedHoldings.filter(holding => holding.allocationCategoryId === null).reduce((sum, holding) => sum + (holding.marketValue ?? 0), 0);
  const allocation = { categories, targetTotal: categories.reduce((sum, category) => sum + category.targetPercentage, 0), unassignedValue, unassignedPercentage: allocationTotal > 0 ? unassignedValue / allocationTotal * 100 : 0 };
  const requiredUpdatedTimes: number[] = [];
  let refreshMetadataComplete = true;
  const stockSymbols = new Set(holdings.filter(holding => holding.type === "STOCK" && holding.symbol).map(holding => holding.symbol!));
  const sourceCurrencies = new Set(holdings.filter(holding => holding.type === "CASH" && holding.currency).map(holding => holding.currency!));
  for (const symbol of stockSymbols) {
    const quote = quotes.get(symbol);
    const updatedAt = finite(quote?.synced_at);
    if (updatedAt === null || quote?.native_currency == null) refreshMetadataComplete = false;
    else { requiredUpdatedTimes.push(updatedAt); sourceCurrencies.add(String(quote.native_currency)); }
  }
  sourceCurrencies.delete(currency);
  for (const source of sourceCurrencies) {
    const updatedAt = finite(fxQuotes.get(`${source}:${currency}`)?.synced_at);
    if (updatedAt === null) refreshMetadataComplete = false;
    else requiredUpdatedTimes.push(updatedAt);
  }
  const lastRefreshedAt = refreshMetadataComplete && requiredUpdatedTimes.length ? Math.min(...requiredUpdatedTimes) : null;
  return { currency, currencies: FINANCE_CURRENCIES, allocationColors: FINANCE_ALLOCATION_COLORS, allocation, totalValue: total, changes, holdings: valuedHoldings, lastRefreshedAt };
}
