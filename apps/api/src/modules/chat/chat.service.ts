import { Injectable, InternalServerErrorException, Logger } from '@nestjs/common';
import { google, type chat_v1 } from 'googleapis';
import type { JWT } from 'google-auth-library';

import { Env } from '../../config/env';

@Injectable()
export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  private chatClient: chat_v1.Chat | null = null;
  // Hold onto the JWT auth client we constructed; we use it directly for the
  // user-lookup REST call (the googleapis Chat client doesn't expose
  // users.get). Caching avoids re-parsing the service account JSON.
  private authClient: JWT | null = null;

  private get configured(): boolean {
    return Boolean(Env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON);
  }

  private getChatClient(): chat_v1.Chat {
    if (this.chatClient) return this.chatClient;
    if (!this.configured) throw new InternalServerErrorException('GOOGLE_CHAT_SERVICE_ACCOUNT_JSON not set');
    const sa = JSON.parse(Env.GOOGLE_CHAT_SERVICE_ACCOUNT_JSON!) as {
      client_email: string;
      private_key: string;
    };
    const auth = new google.auth.JWT({
      email: sa.client_email,
      key: sa.private_key,
      scopes: [
        'https://www.googleapis.com/auth/chat.bot',
        // chat.users.readonly is required for users.get below. Service
        // accounts in workspace orgs need this scope explicitly granted
        // (Admin console → API Controls → Domain-wide delegation).
        'https://www.googleapis.com/auth/chat.users.readonly',
      ],
    });
    this.authClient = auth;
    this.chatClient = google.chat({ version: 'v1', auth });
    return this.chatClient;
  }

  async sendCard(spaceName: string, card: { cardId: string; card: unknown }): Promise<void> {
    if (!this.configured) {
      this.logger.warn({ spaceName, cardId: card.cardId }, 'Chat not configured — skipping send');
      return;
    }
    const client = this.getChatClient();
    await client.spaces.messages.create({
      parent: spaceName,
      requestBody: { cardsV2: [card] as unknown as chat_v1.Schema$CardWithId[] },
    });
  }

  /**
   * Resolve a Chat user's display name + email from their `users/{id}` resource.
   *
   * The previous implementation reached into a private `client.context._options.auth`
   * field on the googleapis Chat client. That field is undocumented and broke
   * across googleapis 130 → 131. We now use the JWT auth client we already
   * constructed in `getChatClient` (cached on `this.authClient`) and call
   * `request()` directly — `request` is part of the documented BaseExternalAccountClient
   * API surface, not a private internal.
   *
   * Best-effort: empty result on any error so callers can degrade gracefully.
   */
  async lookupUser(userResourceName: string): Promise<{ email?: string; displayName?: string }> {
    if (!this.configured) return {};
    try {
      this.getChatClient(); // ensures this.authClient is populated
      if (!this.authClient) return {};
      const url = `https://chat.googleapis.com/v1/${userResourceName}`;
      const res = await this.authClient.request<{ email?: string; displayName?: string }>({
        url,
        method: 'GET',
      });
      const data = res.data;
      return {
        ...(data.email ? { email: data.email } : {}),
        ...(data.displayName ? { displayName: data.displayName } : {}),
      };
    } catch (err) {
      this.logger.warn({ err, userResourceName }, 'failed to lookup chat user');
      return {};
    }
  }
}
