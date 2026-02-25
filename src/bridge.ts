import type { Channel, IncomingMessage } from "./channels/types.js";
import type { ClaudeCLI, ClaudeRequest } from "./claude/cli.js";
import type { SessionStore } from "./session/store.js";
import type { OpenAIConfig, SessionConfig } from "./config.js";
import type { AgentManager } from "./agents/manager.js";
import type { MemoryStore } from "./memory/store.js";
import type { DeliveryQueue } from "./delivery/queue.js";
import type { CronScheduler } from "./cron/scheduler.js";
import type { ProcessTracker } from "./claude/process-tracker.js";
import { transcribeAudio } from "./voice/transcribe.js";
import { chunkMessage } from "./streaming/chunker.js";
import { createDraft, appendToDraft, finalizeDraft, type DraftContext } from "./streaming/draft.js";
import { getLogger } from "./util/logger.js";

const log = getLogger("bridge");

// Input length limits to prevent memory exhaustion and abuse
const MAX_TASK_LENGTH = 50_000; // 50 KB — max /spawn task text
const MAX_LABEL_LENGTH = 256; // max /spawn label length
const MAX_SEARCH_QUERY_LENGTH = 1_000; // max /search query length;

export class Bridge {
  private showThinking = true;
  private openai: OpenAIConfig | undefined;
  private agents: AgentManager | undefined;
  private memoryStore: MemoryStore | undefined;
  private deliveryQueue: DeliveryQueue | undefined;
  private cronScheduler: CronScheduler | undefined;
  private processTracker: ProcessTracker | undefined;
  private sessionConfig: SessionConfig;

  constructor(
    private channel: Channel,
    private claude: ClaudeCLI,
    private sessions: SessionStore,
    openai?: OpenAIConfig,
    agents?: AgentManager,
    sessionConfig?: SessionConfig,
    memoryStore?: MemoryStore,
    deliveryQueue?: DeliveryQueue,
    cronScheduler?: CronScheduler,
    processTracker?: ProcessTracker,
  ) {
    this.openai = openai;
    this.agents = agents;
    this.memoryStore = memoryStore;
    this.deliveryQueue = deliveryQueue;
    this.cronScheduler = cronScheduler;
    this.processTracker = processTracker;
    this.sessionConfig = sessionConfig ?? { inactivityTimeout: "24h" };
  }

  /** Wire up the channel to the Claude backend */
  start(): void {
    // Handle regular messages
    this.channel.onMessage(async (msg) => {
      await this.handleMessage(msg);
    });

    // Handle /new — fresh session
    this.channel.onCommand("new", async (msg) => {
      this.sessions.clearSession(msg.chatId);
      await this.channel.sendText(
        msg.chatId,
        "Session cleared. Next message starts a fresh conversation.",
        msg.replyContext,
      );
    });

    // Handle /status — session info
    this.channel.onCommand("status", async (msg) => {
      const info = this.sessions.getSessionInfo(msg.chatId);
      if (!info) {
        await this.channel.sendText(msg.chatId, "No active session.", msg.replyContext);
        return;
      }
      const status = [
        `*Session Info*`,
        `ID: \`${info.sessionId.slice(0, 8)}...\``,
        `Messages: ${info.messageCount}`,
        `Started: ${info.createdAt}`,
        `Last used: ${info.lastUsedAt}`,
      ].join("\n");
      await this.channel.sendText(msg.chatId, status, msg.replyContext);
    });

    // Handle /model — switch model at runtime or show current
    this.channel.onCommand("model", async (msg) => {
      const requested = msg.text.trim().toLowerCase();
      if (requested) {
        const valid = ["opus", "sonnet", "haiku"];
        if (valid.includes(requested)) {
          this.claude.setModel(requested);
          await this.channel.sendText(
            msg.chatId,
            `Model switched to *${requested}*. Use \`/model\` to check, or \`/model reset\` to revert to config default.`,
            msg.replyContext,
          );
        } else if (requested === "reset") {
          this.claude.setModel(null);
          await this.channel.sendText(
            msg.chatId,
            `Model reverted to config default: *${this.claude.getModel()}*`,
            msg.replyContext,
          );
        } else {
          await this.channel.sendText(
            msg.chatId,
            `Unknown model: ${requested}\nAvailable: opus, sonnet, haiku\nUse \`/model reset\` to revert to config default.`,
            msg.replyContext,
          );
        }
      } else {
        await this.channel.sendText(
          msg.chatId,
          `Current model: *${this.claude.getModel()}*\nUsage: \`/model opus\`, \`/model sonnet\`, \`/model haiku\`, \`/model reset\``,
          msg.replyContext,
        );
      }
    });

    // Handle /cost — show usage costs
    this.channel.onCommand("cost", async (msg) => {
      const summary = this.sessions.getCostSummary(msg.chatId);
      const fmt = (n: number) => `$${n.toFixed(4)}`;
      const text = [
        `*Usage Costs*`,
        ``,
        `Session: ${fmt(summary.session.cost)} (${summary.session.messages} msgs)`,
        `Today: ${fmt(summary.today.cost)} (${summary.today.messages} msgs)`,
        `Last 24h: ${fmt(summary.last24h)}`,
        `All time: ${fmt(summary.allTime.cost)} (${summary.allTime.messages} msgs)`,
      ].join("\n");
      await this.channel.sendText(msg.chatId, text, msg.replyContext);
    });

    // Handle /thinking — toggle thinking block display
    this.channel.onCommand("thinking", async (msg) => {
      const arg = msg.text.trim().toLowerCase();
      if (arg === "on") {
        this.showThinking = true;
        await this.channel.sendText(
          msg.chatId,
          "Thinking blocks *enabled*. You'll see reasoning before responses.",
          msg.replyContext,
        );
      } else if (arg === "off") {
        this.showThinking = false;
        await this.channel.sendText(msg.chatId, "Thinking blocks *disabled*.", msg.replyContext);
      } else {
        const state = this.showThinking ? "ON" : "OFF";
        await this.channel.sendText(
          msg.chatId,
          `Thinking display: *${state}*\nUsage: \`/thinking on\`, \`/thinking off\``,
          msg.replyContext,
        );
      }
    });

    // Handle /spawn — spawn a sub-agent with a task
    this.channel.onCommand("spawn", async (msg) => {
      if (!this.agents) {
        await this.channel.sendText(msg.chatId, "Sub-agents not configured.", msg.replyContext);
        return;
      }
      const text = msg.text.trim();
      if (!text) {
        await this.channel.sendText(
          msg.chatId,
          `Usage: \`/spawn <task>\`\nOptional flags: \`--model sonnet\`, \`--label name\`\n\nExample: \`/spawn Research the top 5 TypeScript ORMs\``,
          msg.replyContext,
        );
        return;
      }

      // Parse optional flags
      let task = text;
      let model: string | undefined;
      let label: string | undefined;
      const modelMatch = text.match(/--model\s+(\S+)/);
      if (modelMatch) {
        model = modelMatch[1];
        task = task.replace(modelMatch[0], "").trim();
      }
      const labelMatch = text.match(/--label\s+"([^"]+)"|--label\s+(\S+)/);
      if (labelMatch) {
        label = labelMatch[1] ?? labelMatch[2];
        task = task.replace(labelMatch[0], "").trim();
      }

      // Validate input lengths
      if (task.length > MAX_TASK_LENGTH) {
        await this.channel.sendText(
          msg.chatId,
          `Task is too long (${task.length} chars). Maximum is ${MAX_TASK_LENGTH} characters.`,
          msg.replyContext,
        );
        return;
      }
      if (label && label.length > MAX_LABEL_LENGTH) {
        await this.channel.sendText(
          msg.chatId,
          `Label is too long (${label.length} chars). Maximum is ${MAX_LABEL_LENGTH} characters.`,
          msg.replyContext,
        );
        return;
      }

      const result = await this.agents.spawn({ task, label, model, chatId: msg.chatId });
      if ("error" in result) {
        await this.channel.sendText(msg.chatId, result.error, msg.replyContext);
      } else {
        const display = label ? `*${label}* (\`${result.id}\`)` : `\`${result.id}\``;
        await this.channel.sendText(
          msg.chatId,
          `Sub-agent spawned: ${display}\nModel: ${model ?? "sonnet"}\nTask: ${task.slice(0, 200)}`,
          msg.replyContext,
        );
      }
    });

    // Handle /agents — list, kill, info
    this.channel.onCommand("agents", async (msg) => {
      if (!this.agents) {
        await this.channel.sendText(msg.chatId, "Sub-agents not configured.", msg.replyContext);
        return;
      }
      const args = msg.text.trim().split(/\s+/);
      const sub = args[0]?.toLowerCase();

      if (!sub || sub === "list") {
        const active = this.agents.listActive(msg.chatId);
        const recent = this.agents.listRecent(msg.chatId, 5);
        const lines: string[] = [];

        if (active.length > 0) {
          lines.push(`*Active (${active.length}):*`);
          for (const a of active) {
            const elapsed = Math.round((Date.now() - new Date(a.createdAt + "Z").getTime()) / 1000);
            lines.push(
              `  \`${a.id}\` ${a.label ?? ""} (${a.model}, ${elapsed}s) — ${a.task.slice(0, 60)}`,
            );
          }
        } else {
          lines.push("No active sub-agents.");
        }

        const completed = recent.filter((r) => r.status !== "running");
        if (completed.length > 0) {
          lines.push("");
          lines.push(`*Recent:*`);
          for (const r of completed) {
            const cost = r.costUsd ? ` $${r.costUsd.toFixed(4)}` : "";
            lines.push(`  \`${r.id}\` ${r.status} (${r.model}${cost}) — ${r.task.slice(0, 50)}`);
          }
        }

        await this.channel.sendText(msg.chatId, lines.join("\n"), msg.replyContext);
      } else if (sub === "kill") {
        const target = args[1];
        if (!target) {
          await this.channel.sendText(
            msg.chatId,
            "Usage: `/agents kill <id>` or `/agents kill all`",
            msg.replyContext,
          );
          return;
        }
        if (target === "all") {
          const count = this.agents.killAll();
          await this.channel.sendText(
            msg.chatId,
            `Killed ${count} sub-agent(s).`,
            msg.replyContext,
          );
        } else {
          const killed = this.agents.kill(target);
          await this.channel.sendText(
            msg.chatId,
            killed
              ? `Killed sub-agent \`${target}\`.`
              : `No running sub-agent matching \`${target}\`.`,
            msg.replyContext,
          );
        }
      } else if (sub === "info") {
        const target = args[1];
        if (!target) {
          await this.channel.sendText(msg.chatId, "Usage: `/agents info <id>`", msg.replyContext);
          return;
        }
        const agent = this.agents.getInfo(target);
        if (!agent) {
          await this.channel.sendText(
            msg.chatId,
            `No sub-agent matching \`${target}\`.`,
            msg.replyContext,
          );
          return;
        }
        const lines = [
          `*Sub-Agent \`${agent.id}\`*`,
          `Status: ${agent.status}`,
          `Model: ${agent.model}`,
          `Task: ${agent.task.slice(0, 500)}`,
          `Created: ${agent.createdAt}`,
        ];
        if (agent.endedAt) lines.push(`Ended: ${agent.endedAt}`);
        if (agent.costUsd) lines.push(`Cost: $${agent.costUsd.toFixed(4)}`);
        if (agent.durationMs) lines.push(`Duration: ${agent.durationMs}ms`);
        if (agent.resultText) {
          lines.push(`\nResult:\n${agent.resultText.slice(0, 2000)}`);
        }
        await this.channel.sendText(msg.chatId, lines.join("\n"), msg.replyContext);
      } else {
        await this.channel.sendText(
          msg.chatId,
          "Usage: `/agents list`, `/agents kill <id|all>`, `/agents info <id>`",
          msg.replyContext,
        );
      }
    });

    // Handle /search — search message history and semantic memory
    this.channel.onCommand("search", async (msg) => {
      const query = msg.text.replace(/^\/search\s*/i, "").trim();
      if (!query) {
        await this.channel.sendText(msg.chatId, "Usage: `/search <query>`", msg.replyContext);
        return;
      }
      if (query.length > MAX_SEARCH_QUERY_LENGTH) {
        await this.channel.sendText(
          msg.chatId,
          `Search query is too long (${query.length} chars). Maximum is ${MAX_SEARCH_QUERY_LENGTH} characters.`,
          msg.replyContext,
        );
        return;
      }

      let results = "";

      // Search message log (SQLite LIKE)
      try {
        const rows = this.sessions
          .getDb()
          .prepare(
            `SELECT content, role, created_at FROM message_log
           WHERE chat_id = ? AND content LIKE '%' || ? || '%'
           ORDER BY created_at DESC LIMIT 5`,
          )
          .all(msg.chatId, query) as Array<{ content: string; role: string; created_at: string }>;

        if (rows.length > 0) {
          results += "*Message History:*\n";
          for (const row of rows) {
            const snippet = row.content.slice(0, 100).replace(/\n/g, " ");
            results += `\u2022 _${row.role}_ (${row.created_at}): ${snippet}...\n`;
          }
        }
      } catch (e) {
        log.error({ err: e }, "search: message log query failed");
      }

      // Search semantic memory if available
      if (this.memoryStore) {
        try {
          const memResults = await this.memoryStore.search(query, 5);
          if (memResults.length > 0) {
            results += "\n*Memory:*\n";
            for (const r of memResults) {
              const snippet = r.text.slice(0, 100).replace(/\n/g, " ");
              results += `\u2022 _${r.path}:${r.startLine}_ (${r.score.toFixed(2)}): ${snippet}...\n`;
            }
          }
        } catch (e) {
          log.error({ err: e }, "search: semantic memory query failed");
        }
      }

      if (!results) {
        results = "No results found.";
      }

      await this.channel.sendText(msg.chatId, results, msg.replyContext);
    });

    // Handle /processes (aliased as /ps) — system status overview
    const processesHandler = async (msg: IncomingMessage) => {
      const lines: string[] = [];

      // System uptime
      const uptimeSec = process.uptime();
      const hours = Math.floor(uptimeSec / 3600);
      const minutes = Math.floor((uptimeSec % 3600) / 60);
      const uptimeStr = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

      lines.push("*System Status*");
      lines.push(`Uptime: ${uptimeStr}`);

      // Active Claude requests
      if (this.processTracker) {
        const active = this.processTracker.list();
        lines.push("");
        lines.push(`*Active Requests:* ${active.length} in-flight`);
        for (const req of active) {
          const elapsed = Math.round((Date.now() - req.startedAt.getTime()) / 1000);
          const elapsedStr =
            elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
          lines.push(`\u2022 chat \`${req.chatId}\` \u2014 PID ${req.pid ?? "?"} (${elapsedStr})`);
        }
      }

      // Sub-agents
      if (this.agents) {
        const active = this.agents.listActive();
        lines.push("");
        lines.push(`*Sub-agents:* ${active.length} running`);
        for (const a of active) {
          const elapsed = Math.round((Date.now() - new Date(a.createdAt + "Z").getTime()) / 1000);
          const elapsedStr =
            elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`;
          const label = a.label ? `"${a.label}"` : `"${a.task.slice(0, 40)}"`;
          lines.push(`\u2022 \`${a.id}\` \u2014 ${label} (${elapsedStr})`);
        }
      } else {
        lines.push("");
        lines.push("*Sub-agents:* not configured");
      }

      // Delivery queue
      if (this.deliveryQueue) {
        const pending = this.deliveryQueue.pendingCount();
        lines.push("");
        lines.push(`*Delivery Queue:* ${pending} pending`);
      } else {
        lines.push("");
        lines.push("*Delivery Queue:* not available");
      }

      // Cron jobs
      if (this.cronScheduler) {
        const jobs = this.cronScheduler.listJobs();
        const enabledJobs = jobs.filter((j) => j.enabled !== false);
        lines.push("");
        lines.push(`*Cron Jobs:* ${enabledJobs.length} active`);
        for (const job of enabledJobs) {
          let nextStr = "unknown";
          if (job.nextRun) {
            const nextDate = new Date(job.nextRun);
            nextStr = nextDate.toLocaleTimeString("en-US", {
              hour: "2-digit",
              minute: "2-digit",
              hour12: false,
            });
          }
          const label = job.label ?? job.id;
          lines.push(`\u2022 ${label} \u2014 next: ${nextStr}`);
        }
      } else {
        lines.push("");
        lines.push("*Cron Jobs:* not configured");
      }

      await this.channel.sendText(msg.chatId, lines.join("\n"), msg.replyContext);
    };

    this.channel.onCommand("processes", processesHandler);
    this.channel.onCommand("ps", processesHandler);

    log.info("bridge wired up");
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    if (!msg.text && (!msg.filePaths || msg.filePaths.length === 0)) {
      return;
    }

    log.info(
      {
        chatId: msg.chatId,
        textLen: msg.text.length,
        files: msg.filePaths?.length ?? 0,
        isVoice: msg.isVoice,
      },
      "incoming message",
    );

    // Transcribe voice messages if OpenAI is configured
    let prompt = msg.text;
    if (msg.isVoice && msg.filePaths?.length && this.openai) {
      try {
        const transcription = await transcribeAudio(msg.filePaths[0], this.openai);
        prompt = transcription;
        // Show transcription to user
        await this.channel.sendDirectMessage(msg.chatId, `_Voice: ${transcription}_`);
        // Don't pass audio file to Claude — the transcription is the prompt
        msg.filePaths = undefined;
      } catch (e) {
        log.error({ err: e }, "voice transcription failed");
        await this.channel.sendDirectMessage(
          msg.chatId,
          "Voice transcription failed. Sending audio file to Claude directly.",
        );
      }
    }

    // Look up session
    const sessionId = this.sessions.getSession(msg.chatId);

    // Memory management: periodic saves and pre-compaction flush
    const flushEnabled = this.sessionConfig.preCompactionFlush !== false;
    if (flushEnabled && sessionId) {
      const info = this.sessions.getSessionInfo(msg.chatId);
      if (info) {
        const rotateAt = this.sessionConfig.rotateAfterMessages ?? 200;
        const count = info.messageCount;

        if (count > rotateAt * 0.8) {
          // Urgent: context is about to be compacted
          prompt +=
            "\n\n[SYSTEM: Context is getting long and may be compacted soon. Before answering, save any important pending context to memory/YYYY-MM-DD.md. Be brief — just capture what you'd need to continue if context resets.]";
          log.info(
            { chatId: msg.chatId, messageCount: count, rotateAt },
            "injecting pre-compaction flush",
          );
        } else if (count > 0 && count % 20 === 0) {
          // Periodic: every 20 messages, nudge a lightweight memory save
          prompt +=
            "\n\n[SYSTEM: Periodic checkpoint — if you've accumulated important context, decisions, or learnings in this session that aren't yet saved, briefly update memory/YYYY-MM-DD.md. Skip if nothing new to save.]";
          log.info(
            { chatId: msg.chatId, messageCount: count },
            "injecting periodic memory checkpoint",
          );
        }
      }
    }

    const request: ClaudeRequest = {
      prompt,
      sessionId: sessionId ?? undefined,
      filePaths: msg.filePaths,
    };

    // Log the user message
    this.sessions.logMessage(msg.chatId, "user", prompt);

    // Set up draft streaming
    const draft = createDraft();
    const draftCtx: DraftContext = {
      reply: async (text) => {
        const handle = await this.channel.sendDraft(msg.chatId, text, msg.replyContext);
        return handle.messageId ?? 0;
      },
      edit: async (messageId, text) => {
        await this.channel.updateDraft({ messageId, chatId: msg.chatId }, text);
      },
      sendChunks: async (chunks) => {
        await this.channel.sendChunks(msg.chatId, chunks, msg.replyContext);
      },
    };

    // Show typing indicator while Claude is processing
    let stopTyping = this.channel.startTyping(msg.chatId);

    // Stream response from Claude
    let fullText = "";
    const toolsUsed: string[] = [];
    let typingStopped = false;

    try {
      for await (const event of this.claude.send(request)) {
        switch (event.type) {
          case "text_delta":
            if (!typingStopped) {
              stopTyping();
              typingStopped = true;
            }
            fullText += event.text;
            await appendToDraft(draft, draftCtx, event.text);
            break;

          case "thinking":
            // Send thinking as a separate message in italics
            if (this.showThinking && event.text.length > 0) {
              const preview =
                event.text.length > 3000 ? event.text.slice(0, 3000) + "..." : event.text;
              // Escape for Telegram Markdown v1: only _ * ` [ need escaping
              const escaped = preview.replace(/[_*`[]/g, "\\$&");
              await this.channel.sendDirectMessage(msg.chatId, `_${escaped}_`);
            }
            break;

          case "system":
            log.info({ subtype: event.subtype, message: event.message }, "claude system event");
            break;

          case "tool_use":
            toolsUsed.push(event.name);
            log.debug({ tool: event.name }, "tool use");
            // Show tool usage to the user
            await this.channel.sendDirectMessage(msg.chatId, `\`${event.name}\``);
            // Restart typing during tool execution
            if (typingStopped) {
              stopTyping = this.channel.startTyping(msg.chatId);
              typingStopped = false;
            }
            break;

          case "done": {
            const { result } = event;
            // Stop typing if still active
            if (!typingStopped) {
              stopTyping();
              typingStopped = true;
            }

            // Store/update session
            if (result.sessionId) {
              if (sessionId && sessionId === result.sessionId) {
                this.sessions.touchSession(msg.chatId);
              } else {
                this.sessions.upsertSession(msg.chatId, result.sessionId);
              }
            }

            // Use the final text from result if we got nothing from streaming
            const responseText = fullText || result.text;

            // Log assistant response
            this.sessions.logMessage(msg.chatId, "assistant", responseText, result.costUsd);

            // Finalize the draft
            const chunks = chunkMessage(responseText);
            await finalizeDraft(draft, draftCtx, chunks);

            if (result.isError) {
              log.warn(
                { chatId: msg.chatId, error: result.text.slice(0, 200) },
                "claude returned error",
              );
            } else {
              log.info(
                {
                  chatId: msg.chatId,
                  cost: result.costUsd,
                  duration: result.durationMs,
                  turns: result.numTurns,
                  tools: toolsUsed,
                  responseLen: responseText.length,
                },
                "response complete",
              );
            }
            break;
          }
        }
      }
    } catch (e) {
      stopTyping();
      log.error({ err: e, chatId: msg.chatId }, "error processing message");
      const errorText = `Error: ${e instanceof Error ? e.message : "Unknown error"}\n\nTry /new to start a fresh session.`;
      const chunks = chunkMessage(errorText);
      await finalizeDraft(draft, draftCtx, chunks);
    }
  }
}
