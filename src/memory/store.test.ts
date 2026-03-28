/**
 * Tests for MemoryStore — category detection logic.
 * Full integration tests (embed/search) require OpenAI key, so we test only the pure logic.
 */

import { describe, it, expect } from "vitest";
import { vi } from "vitest";
import { MemoryStore, MEMORY_CATEGORIES } from "./store.js";

vi.mock("../util/logger.js", () => ({
  getLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

// We only test detectCategory (a static pure function — no DB or OpenAI needed)
describe("MemoryStore.detectCategory", () => {
  it("returns category for explicit subdirectory", () => {
    expect(MemoryStore.detectCategory("memory/cases/some-case.md")).toBe("cases");
    expect(MemoryStore.detectCategory("memory/patterns/runbook.md")).toBe("patterns");
    expect(MemoryStore.detectCategory("memory/entities/crowdia.md")).toBe("entities");
    expect(MemoryStore.detectCategory("memory/tools/gog-cli.md")).toBe("tools");
    expect(MemoryStore.detectCategory("memory/skills/research.md")).toBe("skills");
    expect(MemoryStore.detectCategory("memory/profile/oliver.md")).toBe("profile");
    expect(MemoryStore.detectCategory("memory/preferences/matt.md")).toBe("preferences");
    expect(MemoryStore.detectCategory("memory/events/2026-03-01.md")).toBe("events");
  });

  it("detects daily notes as events", () => {
    expect(MemoryStore.detectCategory("memory/2026-01-15.md")).toBe("events");
    expect(MemoryStore.detectCategory("memory/2026-03-27.md")).toBe("events");
    expect(MemoryStore.detectCategory("memory/2026-02-09-security-incident.md")).toBe("events");
  });

  it("detects feedback_ prefix as cases", () => {
    expect(MemoryStore.detectCategory("memory/feedback_agents_must_be_effective.md")).toBe("cases");
    expect(MemoryStore.detectCategory("memory/feedback_personality_priority.md")).toBe("cases");
    expect(MemoryStore.detectCategory("memory/feedback-something.md")).toBe("cases");
  });

  it("detects project_ prefix as entities", () => {
    expect(MemoryStore.detectCategory("memory/project_budget_governor.md")).toBe("entities");
    expect(MemoryStore.detectCategory("memory/project_hyvee_job.md")).toBe("entities");
  });

  it("detects project-named files as entities", () => {
    expect(MemoryStore.detectCategory("memory/crowdia-project.md")).toBe("entities");
    expect(MemoryStore.detectCategory("memory/krain-competitive-landscape.md")).toBe("entities");
    expect(MemoryStore.detectCategory("memory/bedda-ai-something.md")).toBe("entities");
    expect(MemoryStore.detectCategory("memory/axon-protocol-update.md")).toBe("entities");
    expect(MemoryStore.detectCategory("memory/nozio-overview.md")).toBe("entities");
  });

  it("functional keywords beat project prefixes", () => {
    // nozio-task-plan has 'plan' → patterns, not entities
    expect(MemoryStore.detectCategory("memory/nozio-task-plan.md")).toBe("patterns");
    // krain-listing-strategy has 'strategy' → patterns
    expect(MemoryStore.detectCategory("memory/krain-listing-strategy.md")).toBe("patterns");
    // crowdia-refactor-report has 'report' → skills
    expect(MemoryStore.detectCategory("memory/crowdia-refactor-report.md")).toBe("skills");
  });

  it("detects tool-related files as tools", () => {
    expect(MemoryStore.detectCategory("memory/gog-cli.md")).toBe("tools");
    expect(MemoryStore.detectCategory("memory/tools-inventory.md")).toBe("tools");
    expect(MemoryStore.detectCategory("memory/some-pipeline.md")).toBe("tools");
  });

  it("detects runbooks/strategies as patterns", () => {
    expect(MemoryStore.detectCategory("memory/gb10-migration-runbook.md")).toBe("patterns");
    expect(MemoryStore.detectCategory("memory/gb10-migration-plan.md")).toBe("patterns");
    expect(MemoryStore.detectCategory("memory/krain-listing-strategy.md")).toBe("patterns");
    expect(MemoryStore.detectCategory("memory/infra-setup.md")).toBe("patterns");
  });

  it("detects research/reports as skills", () => {
    expect(MemoryStore.detectCategory("memory/gb10-self-hosting-research.md")).toBe("skills");
    expect(MemoryStore.detectCategory("memory/crowdia-refactor-report.md")).toBe("skills");
    expect(MemoryStore.detectCategory("memory/vercel-chat-sdk-research.md")).toBe("skills");
  });

  it("returns general for unclassifiable files", () => {
    expect(MemoryStore.detectCategory("memory/some-random-note.md")).toBe("general");
    expect(MemoryStore.detectCategory("docs/README.md")).toBe("general");
  });

  it("MEMORY_CATEGORIES contains all 8 categories", () => {
    expect(MEMORY_CATEGORIES).toHaveLength(8);
    expect(MEMORY_CATEGORIES).toContain("profile");
    expect(MEMORY_CATEGORIES).toContain("preferences");
    expect(MEMORY_CATEGORIES).toContain("entities");
    expect(MEMORY_CATEGORIES).toContain("events");
    expect(MEMORY_CATEGORIES).toContain("cases");
    expect(MEMORY_CATEGORIES).toContain("patterns");
    expect(MEMORY_CATEGORIES).toContain("tools");
    expect(MEMORY_CATEGORIES).toContain("skills");
  });
});
