import type { Litie } from './index.js';

export interface IdbStoreInfo {
  name: string;
  keyPath: string | string[] | null;
  autoIncrement: boolean;
  indexes: Array<{ name: string; keyPath: string | string[]; unique: boolean; multiEntry: boolean }>;
  count: number;
}

export interface IdbInfo { name: string; version: number; stores: IdbStoreInfo[] }

/** Read an existing IndexedDB database's schema and row counts without importing. */
export declare function inspectIndexedDB(dbName: string): Promise<IdbInfo>;

/** Derive a litie `stores({...})` spec string from an IndexedDB object store. */
export declare function schemaFromStore(store: IdbStoreInfo): string;

/** The whole `stores({...})` object matching an existing IndexedDB database. */
export declare function suggestSchema(dbName: string): Promise<Record<string, string>>;

/** Copy every record from an IndexedDB database into an OPEN Litie. Idempotent (bulkPut). */
export declare function importFromIndexedDB(
  db: Litie,
  opts: {
    from: string;
    stores?: string[];
    chunkSize?: number;
    onProgress?: (p: { store: string; done: number; total: number }) => void;
  }
): Promise<Record<string, number>>;
