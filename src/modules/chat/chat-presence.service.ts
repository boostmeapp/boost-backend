import { Injectable } from '@nestjs/common';

/**
 * Who is actively looking at which conversation, right now.
 *
 * Only used to decide whether a new message needs a push: someone reading the
 * thread it arrived in has already seen it, and a banner over the open chat is
 * noise. Everyone else — chat list, another thread, another screen,
 * backgrounded, closed — still gets one.
 *
 * Deliberately separate from the gateway's `conv_` rooms. A socket joins those
 * to receive messages and may stay joined while the screen is gone or the app
 * is in the background; "viewing" is a narrower claim the client makes and
 * withdraws. It lives here rather than on the gateway so ChatService can read
 * it without the two depending on each other.
 *
 * In-memory and per-process: a restart clears it, and the worst outcome is a
 * push for a message someone was already reading. Across several instances a
 * client's socket and its messages are on the same node, so the entry is where
 * it is needed.
 */
@Injectable()
export class ChatPresenceService {
  /** userId -> the conversation they are currently viewing. */
  private readonly viewing = new Map<string, string>();

  /** `null` clears — the screen was left, or the app went to the background. */
  setViewing(userId: string, conversationId: string | null): void {
    const key = String(userId);
    if (conversationId) {
      this.viewing.set(key, String(conversationId));
    } else {
      this.viewing.delete(key);
    }
  }

  isViewing(userId: string, conversationId: string): boolean {
    return this.viewing.get(String(userId)) === String(conversationId);
  }

  /** A dropped socket is no longer viewing anything. */
  clear(userId: string): void {
    this.viewing.delete(String(userId));
  }
}
