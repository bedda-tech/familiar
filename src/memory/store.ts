import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { OpenAIConfig } from "../config.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("memory-store");

const CHUNK_TOKENS = 400;
const CHUNK_OVERLAP = 80;
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

export interface SearchResult {
  text: string;
  path: string;
  score: number;
  startLine: number;
  endLine: number;
}

export class MemoryStore {
  private db: Database.Database;

  constructor(
    db: Database.Database,
    private openai: OpenAIConfig,
    private workspaceDir: string,
  ) {
    this.db = db;
    this.loadExtensions();
    this.migrate();
  }

  private loadExtensions(): void {
    sqliteVec.load(this.db);
    log.debug("sqlite-vec loaded");
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memory_chunks_path ON memory_chunks(path);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts USING fts5(
        text,
        id UNINDEXED,
        path UNINDEXED,
        start_line UNINDEXED,
        end_line UNINDEXED
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_DIMS}]
      );
    `);
  }

  /** Search memories using hybrid FTS + vector similarity */
  async search(query: string, limit = 10): Promise<SearchResult[]> {
    // Get query embedding
    const embedding = await this.embed(query);

    // Vector search
    const vecResults = this.db
      .prepare(
        `
      SELECT id, distance
      FROM memory_chunks_vec
      WHERE embedding MATCH ?
      ORDER BY distance
      LIMIT ?
    `,
      )
      .all(new Float32Array(embedding), limit * 2) as Array<{ id: string; distance: number }>;

    // FTS search
    const ftsResults = this.db
      .prepare(
        `
      SELECT id, rank
      FROM memory_chunks_fts
      WHERE memory_chunks_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `,
      )
      .all(query.replace(/[^\w\s]/g, " "), limit * 2) as Array<{ id: string; rank: number }>;

    // Merge results with reciprocal rank fusion
    const scores = new Map<string, number>();

    vecResults.forEach((r, i) => {
      const score = 1 / (i + 1);
      scores.set(r.id, (scores.get(r.id) ?? 0) + score);
    });

    ftsResults.forEach((r, i) => {
      const score = 1 / (i + 1);
      scores.set(r.id, (scores.get(r.id) ?? 0) + score);
    });

    // Sort by combined score
    const topIds = [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, score]) => ({ id, score }));

    if (topIds.length === 0) return [];

    // Fetch full chunks
    const results: SearchResult[] = [];
    const stmt = this.db.prepare(
      `SELECT text, path, start_line, end_line FROM memory_chunks WHERE id = ?`,
    );

    for (const { id, score } of topIds) {
      const row = stmt.get(id) as
        | { text: string; path: string; start_line: number; end_line: number }
        | undefined;
      if (row) {
        results.push({
          text: row.text,
          path: row.path,
          score,
          startLine: row.start_line,
          endLine: row.end_line,
        });
      }
    }

    return results;
  }

  /** Index all memory files in the workspace */
  async indexAll(): Promise<{ indexed: number; skipped: number }> {
    const memoryDir = join(this.workspaceDir, "memory");
    let indexed = 0;
    let skipped = 0;

    // Index memory/ directory
    if (existsSync(memoryDir)) {
      const files = readdirSync(memoryDir).filter((f) => f.endsWith(".md"));
      for (const file of files) {
        const fullPath = join(memoryDir, file);
        const relPath = relative(this.workspaceDir, fullPath);
        const result = await this.indexFile(relPath, fullPath);
        if (result) indexed++;
        else skipped++;
      }
    }

    // Index top-level memory files
    for (const name of ["MEMORY.md", "TODO.md"]) {
      const fullPath = join(this.workspaceDir, name);
      if (existsSync(fullPath)) {
        const result = await this.indexFile(name, fullPath);
        if (result) indexed++;
        else skipped++;
      }
    }

    log.info({ indexed, skipped }, "memory indexing complete");
    return { indexed, skipped };
  }

  /** Index a single file if it's changed since last index */
  async indexFile(relPath: string, fullPath: string): Promise<boolean> {
    if (!existsSync(fullPath)) return false;

    const stat = statSync(fullPath);
    const content = readFileSync(fullPath, "utf-8");
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 16);

    // Check if file is unchanged
    const existing = this.db
      .prepare(`SELECT hash FROM memory_files WHERE path = ?`)
      .get(relPath) as { hash: string } | undefined;
    if (existing?.hash === hash) return false;

    // File changed — re-index
    const lines = content.split("\n");
    const chunks = this.chunkLines(lines);

    // Remove old chunks
    const oldChunks = this.db
      .prepare(`SELECT id FROM memory_chunks WHERE path = ?`)
      .all(relPath) as Array<{ id: string }>;
    for (const { id } of oldChunks) {
      this.db.prepare(`DELETE FROM memory_chunks_fts WHERE id = ?`).run(id);
      this.db.prepare(`DELETE FROM memory_chunks_vec WHERE id = ?`).run(id);
    }
    this.db.prepare(`DELETE FROM memory_chunks WHERE path = ?`).run(relPath);

    // Embed and insert new chunks
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const chunkHash = createHash("sha256").update(chunk.text).digest("hex").slice(0, 16);
      const id = `${relPath}:${i}:${chunkHash}`;

      const embedding = await this.embed(chunk.text);
      const embeddingBlob = new Float32Array(embedding);
      const now = Date.now();

      this.db
        .prepare(
          `
        INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, embedding, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          id,
          relPath,
          chunk.startLine,
          chunk.endLine,
          chunkHash,
          chunk.text,
          Buffer.from(embeddingBlob.buffer),
          now,
        );

      this.db
        .prepare(
          `
        INSERT INTO memory_chunks_fts (id, path, start_line, end_line, text)
        VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(id, relPath, chunk.startLine, chunk.endLine, chunk.text);

      this.db
        .prepare(
          `
        INSERT INTO memory_chunks_vec (id, embedding)
        VALUES (?, ?)
      `,
        )
        .run(id, embeddingBlob);
    }

    // Update file record
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO memory_files (path, hash, mtime, size)
      VALUES (?, ?, ?, ?)
    `,
      )
      .run(relPath, hash, stat.mtimeMs, stat.size);

    log.info({ path: relPath, chunks: chunks.length }, "indexed memory file");
    return true;
  }

  /** Chunk text by lines with overlap */
  private chunkLines(lines: string[]): Array<{ text: string; startLine: number; endLine: number }> {
    const chunks: Array<{ text: string; startLine: number; endLine: number }> = [];
    const approxCharsPerToken = 4;
    const chunkChars = CHUNK_TOKENS * approxCharsPerToken;
    const overlapChars = CHUNK_OVERLAP * approxCharsPerToken;

    let start = 0;
    while (start < lines.length) {
      let charCount = 0;
      let end = start;

      while (end < lines.length && charCount < chunkChars) {
        charCount += lines[end].length + 1;
        end++;
      }

      const text = lines.slice(start, end).join("\n").trim();
      if (text.length > 0) {
        chunks.push({ text, startLine: start + 1, endLine: end });
      }

      // Move forward, accounting for overlap
      let overlapCount = 0;
      let newStart = end;
      while (newStart > start && overlapCount < overlapChars) {
        newStart--;
        overlapCount += lines[newStart].length + 1;
      }
      start = Math.max(newStart, start + 1);
    }

    return chunks;
  }

  /** Get embedding from OpenAI API */
  private async embed(text: string): Promise<number[]> {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.openai.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: text.slice(0, 8000),
        model: EMBEDDING_MODEL,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Embedding API error ${response.status}: ${err}`);
    }

    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    return data.data[0].embedding;
  }

  /** Get stats about the memory index */
  stats(): { chunks: number; files: number } {
    const chunkCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM memory_chunks`).get() as { c: number }
    ).c;
    const fileCount = (
      this.db.prepare(`SELECT COUNT(*) as c FROM memory_files`).get() as { c: number }
    ).c;
    return { chunks: chunkCount, files: fileCount };
  }
}
