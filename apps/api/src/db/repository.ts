import { DB_SCHEMA_VERSION } from "./schema.js";

export interface RepositoryHealth {
  ok: boolean;
  schemaVersion: number;
  dbPath: string;
}

export interface Repository {
  healthcheck(): Promise<RepositoryHealth>;
  close(): Promise<void>;
}

class InMemoryRepository implements Repository {
  public constructor(private readonly dbPath: string) {}

  public async healthcheck(): Promise<RepositoryHealth> {
    return {
      ok: true,
      schemaVersion: DB_SCHEMA_VERSION,
      dbPath: this.dbPath,
    };
  }

  public async close() {
    // Placeholder for future SQLite connection shutdown.
  }
}

export async function createRepository(dbPathRaw: string): Promise<Repository> {
  const dbPath = dbPathRaw.trim() || "data/local.db";
  return new InMemoryRepository(dbPath);
}

