import { Connection } from "@solana/web3.js";

export const createConnection = (rpcUrl: string): Connection => {
  return new Connection(rpcUrl, {
    commitment: "confirmed",
    confirmTransactionInitialTimeout: 60_000
  });
};