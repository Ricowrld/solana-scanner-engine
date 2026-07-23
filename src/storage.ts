import { promises as fs } from 'node:fs';
import path from 'node:path';

import logger from './logger';
import { AlertCacheEntry } from './types';

export type AlertCache = Record<string, AlertCacheEntry>;

export const ensureDirectory = async (filePath: string): Promise<void> => {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
};

const readJsonFile = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const sanitized = raw.replace(/\u0000/g, '').trim();

    if (!sanitized) {
      logger.warn({ filePath }, 'Cache file empty or invalid, using fallback');
      return fallback;
    }

    try {
      return JSON.parse(sanitized) as T;
    } catch (parseError) {
      logger.error({ err: parseError, filePath }, 'Failed to parse cache JSON, using fallback');
      return fallback;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.info({ filePath }, 'Cache file not found, creating new one');
      return fallback;
    }
    logger.error({ err: error }, 'Failed to load cache');
    throw error;
  }
};

const writeJsonFile = async (filePath: string, payload: unknown): Promise<void> => {
  try {
    await ensureDirectory(filePath);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (error) {
    logger.error({ err: error }, 'Failed to save cache');
    throw error;
  }
};

export const loadCache = async (filePath: string): Promise<AlertCache> => {
  return readJsonFile<AlertCache>(filePath, {} as AlertCache);
};

export const saveCache = async (
  filePath: string,
  cache: AlertCache
): Promise<void> => {
  await writeJsonFile(filePath, cache);
};

export const loadJsonCache = async <T>(filePath: string, fallback: T): Promise<T> => {
  return readJsonFile<T>(filePath, fallback);
};

export const saveJsonCache = async <T>(filePath: string, payload: T): Promise<void> => {
  await writeJsonFile(filePath, payload);
};
