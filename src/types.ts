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
 * Tree operations, kept out of `ThreadStore` so a hand-written store need not implement them.
 * Every method takes the thread as well as the message: ids are a global key, so an unscoped
 * lookup would reach another thread's messages.
 */
export interface BranchingStore {
  forkAt(threadId: string, messageId: string, messages: UIMessage[]): Promise<StoredMessage[]>;
  /** Rewrites a message in place, keeping its id; the previous version becomes a sibling. */
  replaceMessage(threadId: string, messageId: string, message: UIMessage): Promise<StoredMessage>;
  /** Points the leaf where a fresh answer belongs: the message itself, or its parent if assistant. */
  regenerateFrom(threadId: string, messageId: string): Promise<{ leafId: string | null }>;
  /** Oldest first; siblings created in the same millisecond fall back to id order. */
  siblingsOf(
    threadId: string,
    messageId: string,
  ): Promise<{ siblings: StoredMessage[]; index: number }>;
  /** Switches which path through the tree is live; any message in the thread may be the leaf. */
  setActiveLeaf(threadId: string, messageId: string): Promise<void>;
  /** Every message in the thread, flat; walk `parentId` to rebuild the shape. */
  getTree(threadId: string): Promise<StoredMessage[]>;
}

/** Stream state, kept out of `ThreadStore` because only `resumableChat` uses it. */
export interface StreamStateStore {
  setActiveStream(threadId: string, streamId: string): Promise<void>;
  /** Clears only if `streamId` is still the active one, so a finishing stream cannot wipe a newer one. */
  clearActiveStream(threadId: string, streamId: string): Promise<void>;
  /** `null` when the thread has no active stream, or no row at all. */
  getActiveStream(threadId: string): Promise<string | null>;
}
