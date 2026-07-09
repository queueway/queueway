import sqlite3 from "sqlite3";
import path from "path";
import { randomUUID, randomBytes } from "crypto";
import { logger } from "../logging/Logger";

export interface AuthUser {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

/**
 * Dashboard login storage — deliberately separate from whatever job store
 * is configured (SQLite/Postgres/In-Memory), so the dashboard login
 * persists across restarts even in zero-config/testing setups.
 */
export class AuthStore {
  private db: sqlite3.Database;

  constructor(filename?: string) {
    const dbPath = filename ?? path.resolve(process.cwd(), ".queueway", "auth.db");
    this.db = new sqlite3.Database(dbPath);
  }

  async initialize(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(`
          CREATE TABLE IF NOT EXISTS queueway_users (
            id TEXT PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL
          )
        `);
        this.db.run(`
          CREATE TABLE IF NOT EXISTS queueway_sessions (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          )
        `);
        this.db.run(
          `
          CREATE TABLE IF NOT EXISTS queueway_password_resets (
            token TEXT PRIMARY KEY,
            user_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            expires_at TEXT NOT NULL
          )
        `,
          (err) => {
            if (err) return reject(err);
            resolve();
          },
        );
      });
    });
  }

  async hasAnyUser(): Promise<boolean> {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT COUNT(*) as count FROM queueway_users`, (err, row: any) => {
        if (err) return reject(err);
        resolve((row?.count ?? 0) > 0);
      });
    });
  }

  async createUser(email: string, passwordHash: string): Promise<AuthUser> {
    const user: AuthUser = {
      id: randomUUID(),
      email: email.toLowerCase().trim(),
      passwordHash,
      createdAt: new Date().toISOString(),
    };
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO queueway_users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)`,
        [user.id, user.email, user.passwordHash, user.createdAt],
        (err) => (err ? reject(err) : resolve(user)),
      );
    });
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT * FROM queueway_users WHERE email = ?`,
        [email.toLowerCase().trim()],
        (err, row: any) => {
          if (err) return reject(err);
          if (!row) return resolve(null);
          resolve({ id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at });
        },
      );
    });
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT * FROM queueway_users WHERE id = ?`, [id], (err, row: any) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        resolve({ id: row.id, email: row.email, passwordHash: row.password_hash, createdAt: row.created_at });
      });
    });
  }

  async updatePassword(userId: string, passwordHash: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(
        `UPDATE queueway_users SET password_hash = ? WHERE id = ?`,
        [passwordHash, userId],
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }

  // --- Sessions ---

  async createSession(userId: string, ttlDays = 30): Promise<string> {
    const token = randomBytes(32).toString("hex");
    const now = new Date();
    const expires = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO queueway_sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        [token, userId, now.toISOString(), expires.toISOString()],
        (err) => (err ? reject(err) : resolve(token)),
      );
    });
  }

  async findSessionUser(token: string): Promise<AuthUser | null> {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT * FROM queueway_sessions WHERE token = ?`, [token], (err, row: any) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        if (new Date(row.expires_at).getTime() < Date.now()) return resolve(null);
        this.findUserById(row.user_id).then(resolve).catch(reject);
      });
    });
  }

  async deleteSession(token: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.run(`DELETE FROM queueway_sessions WHERE token = ?`, [token], (err) =>
        err ? reject(err) : resolve(),
      );
    });
  }

  // --- Password reset ---

  async createPasswordReset(userId: string, ttlMinutes = 60): Promise<string> {
    const token = randomBytes(32).toString("hex");
    const now = new Date();
    const expires = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO queueway_password_resets (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
        [token, userId, now.toISOString(), expires.toISOString()],
        (err) => (err ? reject(err) : resolve(token)),
      );
    });
  }

  async consumePasswordReset(token: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      this.db.get(`SELECT * FROM queueway_password_resets WHERE token = ?`, [token], (err, row: any) => {
        if (err) return reject(err);
        if (!row) return resolve(null);
        const expired = new Date(row.expires_at).getTime() < Date.now();
        this.db.run(`DELETE FROM queueway_password_resets WHERE token = ?`, [token], () => {
          resolve(expired ? null : row.user_id);
        });
      });
    });
  }
}
