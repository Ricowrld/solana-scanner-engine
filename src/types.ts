export interface JupiterTokenMetadata {
  address: string;
  symbol: string;
  name?: string;
  decimals: number;
  logoURI?: string;
  tags?: string[];
}

export type JupiterTokenMap = Record<string, JupiterTokenMetadata>;

export type DiscoverySource =
  | 'birdeye_trending'
  | 'dexscreener_boosted'
  | 'dexscreener_trending'
  | 'jupiter_strict'
  | 'watchlist';

export interface DiscoveryCandidate {
  mint: string;
  symbol?: string;
  name?: string;
  pairAddress?: string;
  priceUsd?: number;
  liquidityUsd?: number;
  volume1hUsd?: number;
  marketCapUsd?: number;
  ageMinutes?: number;
  txns5mBuys?: number;
  txns5mSells?: number;
  buySellRatio?: number;
  volumeToLiquidityRatio?: number;
  marketCapToLiquidityRatio?: number;
  holderCount?: number;
  priceChange5mPercent?: number;
  priceChange1hPercent?: number;
  topHolderPercent?: number;
  top10HolderPercent?: number;
  creatorHoldPercent?: number;
  hasMintAuthority?: boolean;
  hasFreezeAuthority?: boolean;
  liquidityLocked?: boolean;
  liquidityBurned?: boolean;
  creatorAddress?: string;
  isHoneypot?: boolean;
  discoveryScore?: number;
  topHolders?: Array<{
    address: string;
    percent: number;
  }>;
  filterReasons?: string[];
  filterWarnings?: string[];
  filterSummary?: Record<string, boolean | null>;
  sources: DiscoverySource[];
}

export interface TokenCandidate {
  mint: string;
  metadata?: JupiterTokenMetadata;
  discovery?: DiscoveryCandidate;
}

export interface DiscoveryRejection {
  mint: string;
  symbol?: string;
  name?: string;
  reasons: string[];
  warnings?: string[];
  summary: Record<string, boolean | null>;
  sources: DiscoverySource[];
  discoveryScore?: number;
  liquidityUsd?: number;
  volume1hUsd?: number;
  marketCapUsd?: number;
  ageMinutes?: number;
  holderCount?: number;
}

export interface JupiterRouteStep {
  swapInfo?: {
    ammKey?: string;
    label?: string;
    inputMint?: string;
    outputMint?: string;
    feeAmount?: string;
    feeMint?: string;
  };
}

export interface JupiterQuoteResponse {
  inputMint: string;
  inAmount: string;
  outputMint: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: 'ExactIn' | 'ExactOut';
  slippageBps: number;
  priceImpactPct?: number;
  routePlan?: JupiterRouteStep[];
}

export interface JupiterConfig {
  enabled: boolean;
  apiKey?: string;
  tokenListUrl: string;
  inputMint: string;
  inputAmount: string;
  slippageBps: number;
  maxPriceImpactPct: number;
  maxRequestsPerSecond: number;
  batchSize: number;
  onlyDirectRoutes: boolean;
  excludeDexes: string[];
  includeDexes: string[];
  tokenListCacheFile: string;
  tokenListTtlMs: number;
  watchlistFile: string;
  failureCacheFile: string;
  failureTtlMs: number;
  dnsFallbackHost?: string;
  dnsFallbackIp?: string;
}

export interface FilterThresholds {
  minPriceChange1mPercent: number;
  minPriceChange5mPercent: number;
  minPriceChange1hPercent: number;
}

export interface DiscoveryFilters {
  minLiquidityUsd: number;
  minVolume1hUsd: number;
  minMarketCapUsd: number;
  minAgeMinutes: number;
  maxAgeMinutes: number;
  minHolderCount: number;
  minPriceChange5mPercent: number;
  minVolumeToLiquidityRatio: number;
  maxVolumeToLiquidityRatio: number;
  maxMarketCapToLiquidityRatio: number;
  minBuySellRatio: number;
  maxCreatorHoldPercent: number;
  maxTopHolderPercent: number;
  maxTop10HolderPercent: number;
  minDiscoveryScore: number;
  requireMintAuthorityDisabled: boolean;
  requireFreezeAuthorityDisabled: boolean;
  requireLiquidityLockOrBurn: boolean;
  allowMissingSecurityData: boolean;
}

export interface BirdeyeDiscoveryConfig {
  enabled: boolean;
  apiKey?: string;
  trendingLimit: number;
  cacheTtlMs: number;
  minIntervalMs: number;
}

export interface DexScreenerDiscoveryConfig {
  enabled: boolean;
  trendingUrl: string;
  boostedUrl: string;
  trendingLimit: number;
  boostedLimit: number;
  cacheTtlMs: number;
  minIntervalMs: number;
}

export interface DiscoveryConfig {
  enabled: boolean;
  includeWatchlist: boolean;
  birdeye: BirdeyeDiscoveryConfig;
  dexscreener: DexScreenerDiscoveryConfig;
  jupiterStrictList: string[];
  filters: DiscoveryFilters;
  topDiscoveryCandidates: number;
  rejectionChannelId?: string;
  rejectionLogSampleSize: number;
}

export interface PaperTradingConfig {
  enabled: boolean;
  startingBalanceUsd: number;
  stateFile: string;
  maxOpenPositions: number;
  takeProfitPercent: number;
  stopLossPercent: number;
  trailingStopPercent: number;
  maxHoldMinutes: number;
  positionFractionOfBalance: number;
  maxPositionUsd: number;
  minPositionUsd: number;
  historyLimit: number;
  summaryChannelId?: string;
  summaryIntervalMinutes: number;
  summaryMinEquityChangeUsd: number;
}

export interface PaperTradePosition {
  mint: string;
  quantity: number;
  decimals: number;
  entryPrice: number;
  entryValueUsd: number;
  entryTimestamp: number;
  sources: DiscoverySource[];
  lastPrice?: number;
  lastUpdatedAt: number;
  peakPrice?: number;
}

export interface PaperTradeFill {
  mint: string;
  action: 'buy' | 'sell';
  quantity: number;
  price: number;
  valueUsd: number;
  timestamp: number;
  reason?: string;
  sources?: DiscoverySource[];
  pnlUsd?: number;
  pnlPercent?: number;
  holdTimeMs?: number;
  isWinner?: boolean;
}

export interface PaperTradingState {
  balanceUsd: number;
  startingBalanceUsd: number;
  positions: Record<string, PaperTradePosition>;
  realizedPnlUsd: number;
  tradeHistory: PaperTradeFill[];
}

export interface PaperTradingUpdate {
  action: 'buy' | 'sell' | 'hold' | 'skip';
  mint: string;
  reason?: string;
  pnlUsd?: number;
  pnlPercent?: number;
  position?: PaperTradePosition;
}

export interface PaperTradingSummary {
  balanceUsd: number;
  equityUsd: number;
  realizedPnlUsd: number;
  unrealizedPnlUsd: number;
  openPositions: number;
  tradeCount: number;
  winRatePercent: number;
  averageHoldMinutes: number;
}

export interface AppConfig {
  botToken: string;
  channelId: string;
  scanIntervalMs: number;
  cooldownMs: number;
  thresholds: FilterThresholds;
  minObservationAgeMinutes: number;
  logLevel: string;
  cacheFile: string;
  trendCacheFile: string;
  rpcUrl: string;
  walletPath: string;
  tradingEnabled: boolean;
  discovery: DiscoveryConfig;
  paperTrading: PaperTradingConfig;
  jupiter: JupiterConfig;
}

export interface QuoteEvaluation {
  shouldAlert: boolean;
  reason?: string;
  priceImpactPct?: number;
  inputAmount?: number;
  outputAmount?: number;
  route?: string[];
}

export interface TokenTrendPoint {
  timestamp: number;
  priceQuote: number;
}

export interface TokenTrendHistory {
  mint: string;
  firstSeenAt?: number;
  points: TokenTrendPoint[];
}

export interface TokenAlert {
  tokenName: string;
  tokenSymbol: string;
  contractAddress: string;
  priceQuote: number;
  priceChange1mPercent: number;
  priceChange5mPercent: number;
  priceChange1hPercent: number;
  priceImpactPercent: number;
  inputAmount: number;
  outputAmount: number;
  inputTokenSymbol: string;
  route: string[];
  chartUrl?: string;
  bestDex?: string;
  discoverySources?: DiscoverySource[];
  discoveryLiquidityUsd?: number;
  discoveryVolume1hUsd?: number;
  discoveryMarketCapUsd?: number;
  discoveryAgeMinutes?: number;
  discoveryHolderCount?: number;
  discoveryScore?: number;
  discoveryWarnings?: string[];
}

export interface AlertCacheEntry {
  lastAlertedAt: number;
}

export interface ScanResult {
  alert: TokenAlert;
  decision: QuoteEvaluation;
  candidate: TokenCandidate;
}

export interface ScanCycleResult {
  results: ScanResult[];
  discoveryRejections: DiscoveryRejection[];
}

export interface CooldownAwareScanOptions {
  cooldownMints?: Set<string>;
}

export type QuoteFailureReason =
  | 'NO_ROUTE'
  | 'HIGH_IMPACT'
  | 'API_ERROR'
  | 'BAD_REQUEST'
  | 'RATE_LIMITED';

export interface QuoteFailureEntry {
  reason: QuoteFailureReason;
  recordedAt: number;
}

export type QuoteFailureCache = Record<string, QuoteFailureEntry>;

export interface QuoteFetchResult {
  quote: JupiterQuoteResponse | null;
  failureReason?: QuoteFailureReason;
  httpStatus?: number;
  latencyMs?: number;
}
