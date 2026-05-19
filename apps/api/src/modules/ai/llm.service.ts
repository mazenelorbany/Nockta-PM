import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import { Env } from '../../config/env';

import { WorkspaceAiSettingsService } from './workspace-ai-settings.service';

export interface GenerateOptions {
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
}

/** Same as `generate()` but also returns token counts + the effective model
 *  name so cost-tracking callers can record a usage event without a second
 *  round-trip. Token counts are best-effort — Anthropic's SDK returns them
 *  precisely; Ollama doesn't, so we estimate from string length (≈4 chars
 *  per token, the canonical GPT-style heuristic). */
export interface GenerateWithUsageResult {
  text: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
}

/** Unified text-generation + embedding facade.
 *  Text: Ollama OR Anthropic, picked via LLM_PROVIDER env, optionally
 *  overridden by the workspace AI settings (`modelPreference`).
 *  Embeddings: always Ollama (nomic-embed-text) — Anthropic doesn't expose
 *  an embedding endpoint. */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private anthropic: Anthropic | null = null;

  constructor(
    // WorkspaceAiSettingsService lives in the same module — no forwardRef
    // needed. The settings row controls `modelPreference` and is read on
    // every generate() call (the service caches reads for 30s so the cost
    // is a memory hit, not a DB round-trip).
    private readonly settings: WorkspaceAiSettingsService,
  ) {}

  async generate(prompt: string, options: GenerateOptions = {}): Promise<string> {
    const provider = await this.resolveProvider();
    return provider === 'anthropic'
      ? this.generateAnthropic(prompt, options)
      : this.generateOllama(prompt, options);
  }

  /** Generation + usage. Callers wrap this with AiCostTrackingService.record()
   *  so every paid call appears in /ai/usage/summary. */
  async generateWithUsage(
    prompt: string,
    options: GenerateOptions = {},
  ): Promise<GenerateWithUsageResult> {
    const provider = await this.resolveProvider();
    if (provider === 'anthropic') {
      return this.generateAnthropicWithUsage(prompt, options);
    }
    const text = await this.generateOllama(prompt, options);
    // Ollama doesn't return tokens; estimate from char length (~4 chars / token
    // is the canonical heuristic). The number won't be billed against — Ollama
    // is local — but the dashboard's "tokens shipped" sparkline still wants a
    // sensible non-zero value.
    const promptChars = (options.systemPrompt?.length ?? 0) + prompt.length;
    return {
      text,
      modelName: Env.OLLAMA_MODEL,
      inputTokens: Math.ceil(promptChars / 4),
      outputTokens: Math.ceil(text.length / 4),
    };
  }

  /**
   * Resolve the effective provider at call-time. Order:
   *   1) Workspace setting `modelPreference` when concrete and provider is
   *      reachable (anthropic requires ANTHROPIC_API_KEY set).
   *   2) Env.LLM_PROVIDER as the default.
   * Misconfigurations fall back to env so an AI call never fails just because
   * the workspace setting is out of sync with credentials.
   */
  private async resolveProvider(): Promise<'ollama' | 'anthropic'> {
    try {
      return await this.settings.getEffectiveProvider(
        Env.LLM_PROVIDER,
        Boolean(Env.ANTHROPIC_API_KEY),
      );
    } catch {
      // DB unavailable (e.g. early-boot health probe) — degrade to env.
      return Env.LLM_PROVIDER;
    }
  }

  async embed(text: string): Promise<number[]> {
    // Always use Ollama for embeddings. Truncate long inputs (most embedders cap at ~8k tokens / ~32k chars).
    const trimmed = text.slice(0, 32_000);
    const res = await fetch(`${Env.OLLAMA_URL}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: trimmed }),
    });
    if (!res.ok) {
      throw new InternalServerErrorException(`Ollama embeddings failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { embedding: number[] };
    return body.embedding;
  }

  private async generateOllama(prompt: string, options: GenerateOptions): Promise<string> {
    const fullPrompt = options.systemPrompt ? `${options.systemPrompt}\n\n${prompt}` : prompt;
    const res = await fetch(`${Env.OLLAMA_URL}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: Env.OLLAMA_MODEL,
        prompt: fullPrompt,
        stream: false,
        options: {
          temperature: options.temperature ?? 0.2,
          num_predict: options.maxTokens ?? 1024,
        },
      }),
    });
    if (!res.ok) {
      throw new InternalServerErrorException(`Ollama generate failed: ${res.status} ${await res.text()}`);
    }
    const body = (await res.json()) as { response: string };
    return body.response.trim();
  }

  private async generateAnthropic(prompt: string, options: GenerateOptions): Promise<string> {
    const { text } = await this.generateAnthropicWithUsage(prompt, options);
    return text;
  }

  private async generateAnthropicWithUsage(
    prompt: string,
    options: GenerateOptions,
  ): Promise<GenerateWithUsageResult> {
    if (!Env.ANTHROPIC_API_KEY) throw new InternalServerErrorException('ANTHROPIC_API_KEY not set');
    this.anthropic ??= new Anthropic({ apiKey: Env.ANTHROPIC_API_KEY });
    const message = await this.anthropic.messages.create({
      model: Env.ANTHROPIC_MODEL,
      max_tokens: options.maxTokens ?? 1024,
      temperature: options.temperature ?? 0.2,
      ...(options.systemPrompt ? { system: options.systemPrompt } : {}),
      messages: [{ role: 'user', content: prompt }],
    });
    const text = message.content
      .filter((c): c is Extract<typeof c, { type: 'text' }> => c.type === 'text')
      .map((c) => c.text)
      .join('\n')
      .trim();
    return {
      text,
      modelName: Env.ANTHROPIC_MODEL,
      // The Anthropic SDK exposes usage on every successful response. The
      // field names follow the API contract: `input_tokens` includes the
      // system prompt + user message; `output_tokens` is the assistant reply.
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    };
  }
}
