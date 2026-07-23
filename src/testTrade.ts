import config from "./config";
import logger from "./logger";
import { loadKeypairFromFile } from "./wallet";
import { createConnection } from "./solana";
import { getJupiterQuote, executeJupiterSwap } from "./trade";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";

const run = async () => {
  const wallet = loadKeypairFromFile(process.env.WALLET_PATH || "bot-wallet.json");
  const rpcUrl = process.env.RPC_URL || "https://api.mainnet-beta.solana.com";

  const connection = createConnection(rpcUrl);

  logger.info({ pubkey: wallet.publicKey.toBase58() }, "Loaded wallet");

  // 1 USDC = 1_000_000 (because USDC decimals = 6)
  const quote = await getJupiterQuote({
    inputMint: USDC,
    outputMint: SOL,
    amount: 1_000_000,
    slippageBps: 50
  });

  logger.info(
    {
      outAmount: quote.outAmount,
      priceImpactPct: quote.priceImpactPct
    },
    "Quote received"
  );

  if (process.env.TRADING_ENABLED !== "true") {
    logger.warn("TRADING_ENABLED is false, not executing swap.");
    return;
  }

  const sig = await executeJupiterSwap({
    connection,
    wallet,
    quoteResponse: quote
  });

  logger.info({ sig }, "Swap executed");
};

run().catch((err) => {
  logger.error({ err }, "Trade test failed");
});