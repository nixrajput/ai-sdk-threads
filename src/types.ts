import type { UIMessage } from "ai";

/** Stamped on each row so a future SDK major can migrate stored parts rather than guess. */
export const CURRENT_SDK_MAJOR = 7;

export interface Thread {
  id: string;
  userId: string | null;
  title: string | null;
  visibility: "private" | "public";
  activeLeafId: string | null;
  /** Set while a reply is streaming, so a reconnecting client can resume it. */
  activeStreamId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface StoredMessage {
  id: string;
  threadId: string;
  parentId: string | null;
  role: "system" | "user" | "assistant";
  parts: unknown[];
  metadata: Record<string, unknown> | null;
  sdkVersion: number;
  createdAt: Date;
}

export interface CreateThreadInput {
  id?: string;
  userId?: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

export interface ListThreadsQuery {
  userId?: string;
  limit?: number;
  cursor?: string;
}

export interface ListThreadsResult {
  threads: Thread[];
  nextCursor?: string;
}

export type UpdateThreadPatch = Partial<Pick<Thread, "title" | "visibility" | "metadata">>;

export interface ThreadStore {
  createThread(input?: CreateThreadInput): Promise<Thread>;
  getThread(id: string): Promise<Thread | null>;
  listThreads(query?: ListThreadsQuery): Promise<ListThreadsResult>;
  updateThread(id: string, patch: UpdateThreadPatch): Promise<Thread>;
  deleteThread(id: string): Promise<void>;
  appendMessages(threadId: string, messages: UIMessage[]): Promise<StoredMessage[]>;
  loadMessages(threadId: string): Promise<UIMessage[]>;
}

/**
 * Tree operations over the `parentId` links every message already carries. Kept out of
 * `ThreadStore` so a hand-written store is not forced to implement them; the drizzle store does.
 */
export interface BranchingStore {
  /**
   * Starts a new branch in place of `messageId`: the new messages chain from that message's
   * PARENT, so `messageId` and everything after it on that path are left behind but not deleted.
   */
  forkAt(messageId: string, messages: UIMessage[]): Promise<StoredMessage[]>;
  /** Moves the active leaf back to `messageId`'s parent so the caller can re-answer from there. */
  regenerateFrom(messageId: string): Promise<{ parentId: string | null }>;
  /** Every message sharing `messageId`'s parent, oldest first, and which one `messageId` is. */
  siblingsOf(messageId: string): Promise<{ siblings: StoredMessage[]; index: number }>;
  /** Switches which path through the tree is live. Any message in the thread may be the leaf. */
  setActiveLeaf(threadId: string, messageId: string): Promise<void>;
  /** Every message in the thread, flat; walk `parentId` to rebuild the shape. */
  getTree(threadId: string): Promise<StoredMessage[]>;
}

/**
 * Stream state, kept out of `ThreadStore` so a hand-written store is not forced to implement
 * what only `resumableChat` uses. The drizzle store provides both.
 */
export interface StreamStateStore {
  setActiveStream(threadId: string, streamId: string): Promise<void>;
  /** Clears only if `streamId` is still the active one, so a finishing stream cannot wipe a newer one. */
  clearActiveStream(threadId: string, streamId: string): Promise<void>;
  /** `null` when the thread has no active stream, or no row at all. */
  getActiveStream(threadId: string): Promise<string | null>;
}
