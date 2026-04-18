import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { readFileSync, existsSync, statSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, extname, basename, dirname } from "node:path";
import { createHash } from "node:crypto";
import type { OpenAIConfig } from "../config.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("memory-store");

const CHUNK_TOKENS = 400;
const CHUNK_OVERLAP = 80;
const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

/**
 * The 8 memory categories (OpenViking pattern).
 *
 * User-facing:  profile | preferences | entities | events
 * Agent-facing: cases   | patterns    | tools    | skills
 *
 * Files stored under memory/<category>/ get that category automatically.
 * Legacy flat files get a category inferred from their filename.
 */
export const MEMORY_CATEGORIES = [
  "profile",
  "preferences",
  "entities",
  "events",
  "cases",
  "patterns",
  "tools",
  "skills",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number] | "general";

export interface SearchResult {
  text: string;
  path: string;
  score: number;
  startLine: number;
  endLine: number;
  category: MemoryCategory;
}

export interface CategoryCount {
  category: string;
  count: number;
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
        size INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'general'
      );

      CREATE TABLE IF NOT EXISTS memory_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        updated_at INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'general'
      );

      CREATE INDEX IF NOT EXISTS idx_memory_chunks_path ON memory_chunks(path);
      CREATE INDEX IF NOT EXISTS idx_memory_chunks_category ON memory_chunks(category);

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

    // Add category column to existing tables if upgrading from old schema
    const cols = this.db.prepare("PRAGMA table_info(memory_files)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "category")) {
      this.db.exec(`ALTER TABLE memory_files ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
    }
    const chunkCols = this.db.prepare("PRAGMA table_info(memory_chunks)").all() as Array<{ name: string }>;
    if (!chunkCols.some((c) => c.name === "category")) {
      this.db.exec(`ALTER TABLE memory_chunks ADD COLUMN category TEXT NOT NULL DEFAULT 'general'`);
    }
  }

  /**
   * Derive a memory category from a relative file path.
   *
   * Priority order:
   *  1. Explicit subdirectory: memory/cases/foo.md → "cases"
   *  2. Filename prefix heuristics for legacy flat files
   *  3. Falls back to "general"
   */
  static detectCategory(relPath: string): MemoryCategory {
    // 1. Explicit subdirectory under memory/ or .familiar/agents/*/memory/
    const subdirMatch = relPath.match(/(?:^|\/|\\)memory[/\\]([^/\\]+)[/\\]/);
    if (subdirMatch) {
      const sub = subdirMatch[1] as MemoryCategory;
      if ((MEMORY_CATEGORIES as readonly string[]).includes(sub)) return sub;
    }

    // 2. Heuristics based on filename
    const fname = basename(relPath, extname(relPath)).toLowerCase();

    // Daily notes and time-bound events
    if (/^\d{4}-\d{2}-\d{2}/.test(fname)) return "events";

    // Feedback = cases (problem + solution)
    if (fname.startsWith("feedback_") || fname.startsWith("feedback-")) return "cases";

    // Tool docs / CLIs / pipelines — check before project prefixes so "tools-inventory" wins
    if (
      fname.includes("tool") ||
      fname.includes("-cli") ||
      fname === "gog-cli" ||
      fname.includes("inventory") ||
      fname.includes("pipeline") ||
      fname.includes("integration")
    ) {
      return "tools";
    }

    // Runbooks, strategies, processes — check before project prefixes so "krain-listing-strategy" → patterns
    if (
      fname.includes("runbook") ||
      fname.includes("strategy") ||
      fname.includes("pattern") ||
      fname.includes("plan") ||
      fname.includes("migration") ||
      fname.includes("infra")
    ) {
      return "patterns";
    }

    // Research / competitive analysis / skills — before project prefixes so "crowdia-refactor-report" → skills
    if (
      fname.includes("research") ||
      fname.includes("analysis") ||
      fname.includes("evaluation") ||
      fname.includes("report")
    ) {
      return "skills";
    }

    // Project-named files = entities (after functional heuristics)
    if (
      fname.startsWith("project_") ||
      fname.startsWith("crowdia-") ||
      fname.startsWith("nozio-") ||
      fname.startsWith("krain-") ||
      fname.startsWith("bedda-") ||
      fname.startsWith("axon-") ||
      fname.startsWith("omnivi-")
    ) {
      return "entities";
    }

    return "general";
  }

  /** Search memories using hybrid FTS + vector similarity, optionally filtered by category */
  async search(query: string, limit = 10, category?: string): Promise<SearchResult[]> {
    // Get query embedding
    const embedding = await this.embed(query);

    // Vector search (optionally filtered by category).
    // sqlite-vec ≥0.1.7 rejects knn queries that don't pin k via MATCH-clause
    // `AND k = ?` — a JOIN+LIMIT combo no longer implicitly bounds the scan.
    // k is overfetched so the post-JOIN category filter has headroom.
    const k = category ? limit * 8 : limit * 2;
    let vecSql = `
      SELECT mc.id, mcv.distance
      FROM memory_chunks_vec mcv
      JOIN memory_chunks mc ON mc.id = mcv.id
      WHERE mcv.embedding MATCH ? AND k = ?
    `;
    const vecParams: unknown[] = [new Float32Array(embedding), k];
    if (category) {
      vecSql += ` AND mc.category = ?`;
      vecParams.push(category);
    }
    vecSql += ` ORDER BY mcv.distance LIMIT ?`;
    vecParams.push(limit * 2);

    const vecResults = this.db
      .prepare(vecSql)
      .all(...vecParams) as Array<{ id: string; distance: number }>;

    // FTS search (optionally filtered by category)
    let ftsSql = `
      SELECT mcf.id, mcf.rank
      FROM memory_chunks_fts mcf
      JOIN memory_chunks mc ON mc.id = mcf.id
      WHERE memory_chunks_fts MATCH ?
    `;
    const ftsParams: unknown[] = [query.replace(/[^\w\s]/g, " ")];
    if (category) {
      ftsSql += ` AND mc.category = ?`;
      ftsParams.push(category);
    }
    ftsSql += ` ORDER BY mcf.rank LIMIT ?`;
    ftsParams.push(limit * 2);

    const ftsResults = this.db
      .prepare(ftsSql)
      .all(...ftsParams) as Array<{ id: string; rank: number }>;

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
      `SELECT text, path, start_line, end_line, category FROM memory_chunks WHERE id = ?`,
    );

    for (const { id, score } of topIds) {
      const row = stmt.get(id) as
        | { text: string; path: string; start_line: number; end_line: number; category: string }
        | undefined;
      if (row) {
        results.push({
          text: row.text,
          path: row.path,
          score,
          startLine: row.start_line,
          endLine: row.end_line,
          category: row.category as MemoryCategory,
        });
      }
    }

    return results;
  }

  /** Return per-category chunk counts */
  categories(): CategoryCount[] {
    return this.db
      .prepare(
        `SELECT category, COUNT(*) as count
         FROM memory_chunks
         GROUP BY category
         ORDER BY count DESC`,
      )
      .all() as CategoryCount[];
  }

  /**
   * Write a memory file to the appropriate category subdirectory under memory/.
   * Creates the directory if needed, then re-indexes the file.
   * Returns the relative path of the written file.
   */
  async write(
    category: MemoryCategory,
    filename: string,
    content: string,
  ): Promise<{ relPath: string; category: MemoryCategory }> {
    if (!(MEMORY_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Invalid category: ${category}. Must be one of: ${MEMORY_CATEGORIES.join(", ")}`);
    }

    const safeFilename = basename(filename).replace(/[^a-z0-9._-]/gi, "-");
    const relPath = `memory/${category}/${safeFilename}`;
    const fullPath = join(this.workspaceDir, relPath);

    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content, "utf-8");

    await this.indexFile(relPath, fullPath);
    log.info({ relPath, category }, "wrote memory file");

    return { relPath, category };
  }

  // Directories to skip entirely during indexing
  private static EXCLUDED_DIRS = new Set([
    ".git",
    "node_modules",
    "backup",
    "claude-memory",
    ".vercel",
    ".next",
    "target",
    "dist",
    "build",
    "out",
    "coverage",
    "__pycache__",
    ".turbo",
    ".cache",
  ]);

  // Path prefixes to skip (matched against relative path)
  private static EXCLUDED_PREFIXES = [
    "projects/job-hunt/resumes/tailored",
    "projects/job-hunt/cover-letters",
    "projects/job-hunt/state",
  ];

  // Document/config extensions worth indexing (everything else is skipped)
  // Source code lives in grep, not the vector index
  private static INDEXABLE_EXTENSIONS = new Set([
    ".md",
    ".txt",
    ".yaml",
    ".yml",
    ".toml",
    ".html",
  ]);

  // Files in .familiar/agents/ that ARE worth indexing
  private static AGENT_INDEXABLE = new Set(["AGENTS.md", "memory.md"]);

  /** Index all text files in the workspace */
  async indexAll(): Promise<{ indexed: number; skipped: number }> {
    let indexed = 0;
    let skipped = 0;

    const files = this.walkDir(this.workspaceDir);

    for (const fullPath of files) {
      const relPath = relative(this.workspaceDir, fullPath);
      const result = await this.indexFile(relPath, fullPath);
      if (result) indexed++;
      else skipped++;
    }

    log.info({ indexed, skipped }, "memory indexing complete");
    return { indexed, skipped };
  }

  /** Recursively walk directory, returning indexable file paths */
  private walkDir(dir: string): string[] {
    const results: string[] = [];

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return results;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);

      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) continue;

      if (stat.isDirectory()) {
        // Skip excluded directory names
        if (MemoryStore.EXCLUDED_DIRS.has(entry)) continue;

        const relPath = relative(this.workspaceDir, fullPath);

        // For .familiar/agents/*, only descend into agent dirs (not output/)
        if (relPath.startsWith(".familiar/agents/")) {
          // We're inside an agent dir -- don't recurse into output/
          if (entry === "output") continue;
        }

        // Skip excluded path prefixes
        const skipPrefix = MemoryStore.EXCLUDED_PREFIXES.some((p) => relPath.startsWith(p));
        if (skipPrefix) continue;

        results.push(...this.walkDir(fullPath));
        continue;
      }

      if (!stat.isFile()) continue;

      // Only index document/config file types
      const ext = extname(entry).toLowerCase();
      if (!MemoryStore.INDEXABLE_EXTENSIONS.has(ext)) continue;

      // For .familiar/agents/*/*, only index AGENTS.md and memory.md
      const relPath = relative(this.workspaceDir, fullPath);
      if (relPath.startsWith(".familiar/agents/")) {
        if (!MemoryStore.AGENT_INDEXABLE.has(basename(fullPath))) continue;
      }

      // Skip very large files (>100KB) to avoid blowing up embedding costs
      if (stat.size > 100 * 1024) {
        log.debug({ path: relPath, size: stat.size }, "skipping large file");
        continue;
      }

      results.push(fullPath);
    }

    return results;
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

    const category = MemoryStore.detectCategory(relPath);

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
        INSERT OR REPLACE INTO memory_chunks (id, path, start_line, end_line, hash, text, embedding, updated_at, category)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          category,
        );

      this.db
        .prepare(
          `
        INSERT INTO memory_chunks_fts (id, path, start_line, end_line, text)
        VALUES (?, ?, ?, ?, ?)
      `,
        )
        .run(id, relPath, chunk.startLine, chunk.endLine, chunk.text);

      // OR REPLACE in case an orphan row from a prior crashed index run still
      // occupies this id in the vec table — memory_chunks gets wiped above but
      // vec rows can leak if indexing was interrupted between the two deletes.
      this.db
        .prepare(
          `
        INSERT OR REPLACE INTO memory_chunks_vec (id, embedding)
        VALUES (?, ?)
      `,
        )
        .run(id, embeddingBlob);
    }

    // Update file record
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO memory_files (path, hash, mtime, size, category)
      VALUES (?, ?, ?, ?, ?)
    `,
      )
      .run(relPath, hash, stat.mtimeMs, stat.size, category);

    log.info({ path: relPath, chunks: chunks.length, category }, "indexed memory file");
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

  /** List all indexed memory files, optionally filtered by category */
  files(category?: string): Array<{
    path: string;
    category: string;
    size: number;
    mtime: number;
    chunks: number;
  }> {
    let sql = `
      SELECT mf.path, mf.category, mf.size, mf.mtime,
             COUNT(mc.id) as chunks
      FROM memory_files mf
      LEFT JOIN memory_chunks mc ON mc.path = mf.path
    `;
    const params: unknown[] = [];
    if (category) {
      sql += ` WHERE mf.category = ?`;
      params.push(category);
    }
    sql += ` GROUP BY mf.path ORDER BY mf.category, mf.path`;
    return this.db.prepare(sql).all(...params) as Array<{
      path: string;
      category: string;
      size: number;
      mtime: number;
      chunks: number;
    }>;
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
