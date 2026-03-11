/**
 * RepoManager -- manages git repos within project folders.
 *
 * Each project can have repos/ containing cloned git repositories.
 * The RepoManager handles cloning, moving, status checking, and pulling.
 */

import { existsSync, mkdirSync, renameSync, cpSync, rmSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { spawnSync } from "node:child_process";
import type { RepoConfig } from "./types.js";
import { getLogger } from "../util/logger.js";

const log = getLogger("repo-manager");

export interface CloneResult {
  repo: string;
  path: string;
  success: boolean;
  error?: string;
}

export interface RepoStatus {
  name: string;
  path: string;
  present: boolean;
  branch?: string;
  clean?: boolean;
  ahead?: number;
  behind?: number;
}

export class RepoManager {
  constructor(private personaPath: string) {}

  /** Get the project directory path. */
  getProjectDir(projectId: string): string {
    return join(this.personaPath, "projects", projectId);
  }

  /** Get the repos directory for a project. */
  getReposDir(projectId: string): string {
    return join(this.getProjectDir(projectId), "repos");
  }

  /** Check if a repo is present on disk. */
  isRepoPresent(projectId: string, repoPath: string): boolean {
    const fullPath = join(this.getReposDir(projectId), repoPath);
    return existsSync(join(fullPath, ".git"));
  }

  /** Clone a single repo into a project's repos/ directory. */
  async cloneRepo(projectId: string, repo: RepoConfig): Promise<CloneResult> {
    const reposDir = this.getReposDir(projectId);
    mkdirSync(reposDir, { recursive: true });

    const repoName = repo.path ?? basename(repo.url).replace(/\.git$/, "");
    const targetPath = join(reposDir, repoName);

    if (existsSync(join(targetPath, ".git"))) {
      log.info({ projectId, repo: repoName }, "repo already present, skipping clone");
      return { repo: repoName, path: targetPath, success: true };
    }

    const args = ["clone"];
    if (repo.branch) {
      args.push("--branch", repo.branch);
    }
    args.push(repo.url, targetPath);

    log.info({ projectId, repo: repoName, url: repo.url }, "cloning repo");

    const result = spawnSync("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });

    if (result.status !== 0) {
      const stderr = result.stderr?.toString().trim() ?? "unknown error";
      log.error({ projectId, repo: repoName, error: stderr }, "clone failed");
      return { repo: repoName, path: targetPath, success: false, error: stderr };
    }

    log.info({ projectId, repo: repoName }, "clone successful");
    return { repo: repoName, path: targetPath, success: true };
  }

  /** Move an existing repo into a project's repos/ directory. */
  moveRepo(sourcePath: string, projectId: string, repoName: string): string {
    const reposDir = this.getReposDir(projectId);
    mkdirSync(reposDir, { recursive: true });

    const targetPath = join(reposDir, repoName);

    if (existsSync(targetPath)) {
      log.warn({ projectId, repo: repoName, target: targetPath }, "target already exists, skipping move");
      return targetPath;
    }

    try {
      // Try rename first (fast, same filesystem)
      renameSync(sourcePath, targetPath);
      log.info({ from: sourcePath, to: targetPath }, "repo moved (rename)");
    } catch {
      // Fall back to copy + delete (cross-filesystem)
      cpSync(sourcePath, targetPath, { recursive: true });
      rmSync(sourcePath, { recursive: true, force: true });
      log.info({ from: sourcePath, to: targetPath }, "repo moved (copy+delete)");
    }

    return targetPath;
  }

  /** Ensure all repos in a project config are present, cloning any missing ones. */
  async ensureRepos(projectId: string, repos: RepoConfig[]): Promise<CloneResult[]> {
    const results: CloneResult[] = [];
    for (const repo of repos) {
      const repoName = repo.path ?? basename(repo.url).replace(/\.git$/, "");
      if (this.isRepoPresent(projectId, repoName)) {
        results.push({ repo: repoName, path: join(this.getReposDir(projectId), repoName), success: true });
        continue;
      }
      const result = await this.cloneRepo(projectId, repo);
      results.push(result);
    }
    return results;
  }

  /** Initialize a project folder with standard directories. */
  initProjectFolder(projectId: string): string {
    const projectDir = this.getProjectDir(projectId);
    mkdirSync(join(projectDir, "docs"), { recursive: true });
    mkdirSync(join(projectDir, "repos"), { recursive: true });
    log.info({ projectId, path: projectDir }, "project folder initialized");
    return projectDir;
  }

  /** Generate a CLAUDE.md file for a project. */
  generateProjectClaudeMd(
    projectId: string,
    project: { name: string; description?: string; repos?: RepoConfig[]; agents?: string[] },
  ): void {
    const projectDir = this.getProjectDir(projectId);
    mkdirSync(projectDir, { recursive: true });

    const lines: string[] = [];
    lines.push(`# ${project.name}`);
    lines.push("");
    if (project.description) {
      lines.push(project.description);
      lines.push("");
    }

    // List repos
    if (project.repos && project.repos.length > 0) {
      lines.push("## Repos");
      lines.push("");
      for (const repo of project.repos) {
        const repoName = repo.path ?? basename(repo.url).replace(/\.git$/, "");
        lines.push(`- \`repos/${repoName}/\` -- ${repo.url}${repo.branch ? ` (${repo.branch})` : ""}`);
      }
      lines.push("");
    }

    // List agents
    if (project.agents && project.agents.length > 0) {
      lines.push("## Agents");
      lines.push("");
      for (const agentId of project.agents) {
        lines.push(`- ${agentId}`);
      }
      lines.push("");
    }

    // Reference docs
    const docsDir = join(projectDir, "docs");
    if (existsSync(docsDir)) {
      try {
        const docs = readdirSync(docsDir).filter((f) => {
          const fp = join(docsDir, f);
          return statSync(fp).isFile() && (f.endsWith(".md") || f.endsWith(".yaml"));
        });
        if (docs.length > 0) {
          lines.push("## Docs");
          lines.push("");
          for (const doc of docs) {
            lines.push(`- [${doc}](docs/${doc})`);
          }
          lines.push("");
        }
      } catch {
        // ignore read errors
      }
    }

    writeFileSync(join(projectDir, "CLAUDE.md"), lines.join("\n"), "utf-8");
    log.info({ projectId }, "generated CLAUDE.md");
  }

  /** List repos present on disk for a project. */
  listRepos(projectId: string): RepoStatus[] {
    const reposDir = this.getReposDir(projectId);
    if (!existsSync(reposDir)) return [];

    const entries = readdirSync(reposDir);
    const results: RepoStatus[] = [];

    for (const entry of entries) {
      const entryPath = join(reposDir, entry);
      if (!statSync(entryPath).isDirectory()) continue;

      const status: RepoStatus = {
        name: entry,
        path: entryPath,
        present: existsSync(join(entryPath, ".git")),
      };

      if (status.present) {
        // Get current branch
        const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: entryPath,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (branchResult.status === 0) {
          status.branch = branchResult.stdout.toString().trim();
        }

        // Check clean/dirty
        const statusResult = spawnSync("git", ["status", "--porcelain"], {
          cwd: entryPath,
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (statusResult.status === 0) {
          status.clean = statusResult.stdout.toString().trim() === "";
        }
      }

      results.push(status);
    }

    return results;
  }

  /** Pull latest changes for a repo. */
  pullRepo(projectId: string, repoName: string): { success: boolean; output: string } {
    const repoPath = join(this.getReposDir(projectId), repoName);
    if (!existsSync(join(repoPath, ".git"))) {
      return { success: false, output: "Not a git repository" };
    }

    const result = spawnSync("git", ["pull"], {
      cwd: repoPath,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });

    const output = (result.stdout?.toString() ?? "") + (result.stderr?.toString() ?? "");
    return { success: result.status === 0, output: output.trim() };
  }

  /** Get git status for a repo. */
  getRepoStatus(projectId: string, repoName: string): RepoStatus | null {
    const repoPath = join(this.getReposDir(projectId), repoName);
    if (!existsSync(repoPath)) return null;

    const status: RepoStatus = {
      name: repoName,
      path: repoPath,
      present: existsSync(join(repoPath, ".git")),
    };

    if (status.present) {
      const branchResult = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (branchResult.status === 0) {
        status.branch = branchResult.stdout.toString().trim();
      }

      const statusResult = spawnSync("git", ["status", "--porcelain"], {
        cwd: repoPath,
        stdio: ["ignore", "pipe", "pipe"],
      });
      if (statusResult.status === 0) {
        status.clean = statusResult.stdout.toString().trim() === "";
      }
    }

    return status;
  }

  /** Remove a repo from disk. */
  removeRepo(projectId: string, repoName: string): boolean {
    const repoPath = join(this.getReposDir(projectId), repoName);
    if (!existsSync(repoPath)) return false;
    rmSync(repoPath, { recursive: true, force: true });
    log.info({ projectId, repo: repoName }, "repo removed from disk");
    return true;
  }
}
