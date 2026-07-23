import axios from "axios";
import {
  Connection,
  Keypair,
  VersionedTransaction
} from "@solana/web3.js";

interface JupiterQuoteParams {
  inputMint: string;
  outputMint: string;
  amount: number; // in smallest units (lamports style)
  slippageBps: number;
}

export const getJupiterQuote = async ({
  inputMint,
  outputMint,
  amount,
  slippageBps
}: JupiterQuoteParams) => {
  const url = "https://quote-api.jup.ag/v6/quote";

  const { data } = await axios.get(url, {
    params: {
      inputMint,
      outputMint,
      amount,
      slippageBps
    },
    timeout: 15000
  });

  return data;
};

export const executeJupiterSwap = async ({
  connection,
  wallet,
  quoteResponse
}: {
  connection: Connection;
  wallet: Keypair;
  quoteResponse: any;
}): Promise<string> => {
  const swapUrl = "https://quote-api.jup.ag/v6/swap";

  const { data } = await axios.post(
    swapUrl,
    {
      quoteResponse,
      userPublicKey: wallet.publicKey.toBase58(),
      wrapAndUnwrapSol: true
    },
    {
      timeout: 20000,
      headers: { "Content-Type": "application/json" }
    }
  );

  if (!data?.swapTransaction) {
    throw new Error("Jupiter swap response missing swapTransaction");
  }

  const txBuf = Buffer.from(data.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(txBuf);

  tx.sign([wallet]);

  const sig = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3
  });

  await connection.confirmTransaction(sig, "confirmed");

  return sig;
};