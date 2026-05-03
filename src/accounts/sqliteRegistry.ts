import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { redactSecret } from "../redact.js";
import type { StoredAccount } from "../types.js";

const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as typeof import("node:sqlite");
type SqliteDatabase = InstanceType<typeof DatabaseSync>;

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function encrypt(value: string | undefined, secret: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!secret) {
    return `redacted:${redactSecret(value)}`;
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(secret), iv);
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

function decrypt(value: string | undefined, secret: string | undefined): string | undefined {
  if (!value || value.startsWith("redacted:")) {
    return undefined;
  }
  if (!secret || !value.startsWith("v1:")) {
    return undefined;
  }
  const [, ivRaw, tagRaw, dataRaw] = value.split(":");
  const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(secret), Buffer.from(ivRaw, "base64"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataRaw, "base64")), decipher.final()]).toString("utf8");
}

export class SqliteAccountRegistry {
  private readonly db: SqliteDatabase;

  constructor(path: string, private readonly encryptionSecret?: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT,
        name TEXT,
        access_token TEXT,
        refresh_token TEXT,
        expires_at INTEGER,
        oauth_client_id TEXT,
        project_id TEXT,
        scopes TEXT NOT NULL DEFAULT '[]',
        supported_models TEXT NOT NULL,
        quota TEXT,
        status TEXT,
        health TEXT NOT NULL,
        last_success_at TEXT,
        last_failure_at TEXT,
        next_retry_at TEXT,
        source TEXT NOT NULL DEFAULT 'imported_json',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL
      )
    `);
    this.migrate();
  }

  private migrate(): void {
    const columns = new Set(
      this.db.prepare("PRAGMA table_info(accounts)").all().map((row: unknown) => String((row as { name: string }).name))
    );
    const addColumn = (name: string, ddl: string) => {
      if (!columns.has(name)) {
        this.db.exec(`ALTER TABLE accounts ADD COLUMN ${ddl}`);
      }
    };
    addColumn("source", "source TEXT NOT NULL DEFAULT 'imported_json'");
    addColumn("created_at", "created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP");
    addColumn("scopes", "scopes TEXT NOT NULL DEFAULT '[]'");
    addColumn("oauth_client_id", "oauth_client_id TEXT");
    addColumn("project_id", "project_id TEXT");
  }

  upsert(account: StoredAccount): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO accounts (
          id, email, name, access_token, refresh_token, expires_at, oauth_client_id, scopes, supported_models, quota, status,
          health, last_success_at, last_failure_at, next_retry_at, source, created_at, updated_at, project_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email=excluded.email,
          name=excluded.name,
          access_token=excluded.access_token,
          refresh_token=excluded.refresh_token,
          expires_at=excluded.expires_at,
          oauth_client_id=excluded.oauth_client_id,
          project_id=excluded.project_id,
          scopes=excluded.scopes,
          supported_models=excluded.supported_models,
          quota=excluded.quota,
          status=excluded.status,
          health=excluded.health,
          last_success_at=excluded.last_success_at,
          last_failure_at=excluded.last_failure_at,
          next_retry_at=excluded.next_retry_at,
          source=excluded.source,
          updated_at=excluded.updated_at`
      )
      .run(
        account.id,
        account.email ?? null,
        account.name ?? null,
        encrypt(account.accessToken, this.encryptionSecret) ?? null,
        encrypt(account.refreshToken, this.encryptionSecret) ?? null,
        account.expiresAt ?? null,
        account.oauthClientId ?? null,
        JSON.stringify(account.scopes ?? []),
        JSON.stringify(account.supportedModels),
        JSON.stringify(account.quota ?? null),
        account.status ?? null,
        JSON.stringify(account.health),
        account.lastSuccessAt ?? null,
        account.lastFailureAt ?? null,
        account.nextRetryAt ?? null,
        account.source ?? "imported_json",
        account.createdAt ?? now,
        now,
        account.projectId ?? null
      );
  }

  list(includeSecrets = false): StoredAccount[] {
    return this.db.prepare("SELECT * FROM accounts ORDER BY id").all().map((row: unknown) => {
      const record = row as Record<string, unknown>;
      return {
        id: String(record.id),
        email: record.email ? String(record.email) : undefined,
        name: record.name ? String(record.name) : undefined,
        accessToken: includeSecrets
          ? decrypt(record.access_token ? String(record.access_token) : undefined, this.encryptionSecret)
          : redactSecret(record.access_token ? String(record.access_token) : undefined),
        refreshToken: includeSecrets
          ? decrypt(record.refresh_token ? String(record.refresh_token) : undefined, this.encryptionSecret)
          : redactSecret(record.refresh_token ? String(record.refresh_token) : undefined),
        expiresAt: record.expires_at ? Number(record.expires_at) : undefined,
        oauthClientId: record.oauth_client_id ? String(record.oauth_client_id) : undefined,
        projectId: record.project_id ? String(record.project_id) : undefined,
        scopes: JSON.parse(String(record.scopes ?? "[]")) as string[],
        supportedModels: JSON.parse(String(record.supported_models)) as string[],
        quota: JSON.parse(String(record.quota ?? "null")),
        status: record.status ? String(record.status) : undefined,
        source:
          record.source === "oauth_login" || record.source === "manual_refresh_token"
            ? record.source
            : "imported_json",
        health: JSON.parse(String(record.health)),
        createdAt: record.created_at ? String(record.created_at) : undefined,
        updatedAt: record.updated_at ? String(record.updated_at) : undefined,
        lastSuccessAt: record.last_success_at ? String(record.last_success_at) : undefined,
        lastFailureAt: record.last_failure_at ? String(record.last_failure_at) : undefined,
        nextRetryAt: record.next_retry_at ? String(record.next_retry_at) : undefined
      };
    });
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    return Number(result.changes) > 0;
  }

  rawRows(): Array<Record<string, unknown>> {
    return this.db.prepare("SELECT * FROM accounts ORDER BY id").all() as Array<Record<string, unknown>>;
  }

  close(): void {
    this.db.close();
  }
}
