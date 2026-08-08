import type { UIMessage } from "ai";

/**
 * The `ai` major that wrote a message row. Stored per row so a future major can
 * migrate `parts` rather than guess which shape it is looking at.
 */
export const CURRENT_SDK_MAJOR = 7;

export interface Thread {
  id: string;
  userId: string | null;
  title: string | null;
  visibility: "private" | "public";
  activeLeafId: string | null;
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
