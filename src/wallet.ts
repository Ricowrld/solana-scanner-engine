import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

export const loadKeypairFromFile = (filePath: string): Keypair => {
  const absolutePath = path.isAbsolute(filePath)
    ? filePath
    : path.join(process.cwd(), filePath);

  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Wallet file not found: ${absolutePath}`);
  }

  const raw = fs.readFileSync(absolutePath, "utf-8");
  const secretKey = Uint8Array.from(JSON.parse(raw));

  return Keypair.fromSecretKey(secretKey);
};