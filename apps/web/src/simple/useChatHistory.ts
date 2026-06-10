import { useCallback, useEffect, useState } from 'react';
import type { MagicProgressState } from './generation-pipeline';
import {
  API_BASE,
  type MaterialAngle,
  type RenderResult,
  type RenderVersion,
  type ResearchData,
  type ScriptVersion,
  type TaskStatus,
} from './studio-types';

const STORAGE_KEY = 'proveo:chat-history:v1';
const BACKEND_SYNC_DELAY_MS = 500;
const backendSyncTimers = new Map<string, number>();

export interface ChatHistoryMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatHistoryAttachment {
  id: string;
  name: string;
  size: number;
  type: string;
  status: 'uploading' | 'ready' | 'failed';
  materialId?: string;
  taskId?: string;
  sourceUrl?: string;
  savedToLibrary?: boolean;
  error?: string;
}

export interface ChatHistoryActivityItem {
  id: string;
  kind: 'chat-user' | 'chat-bot' | 'tool' | 'error';
  text: string;
  meta?: string;
  attachments?: ChatHistoryAttachment[];
  toolName?: string;
  toolStatus?: 'running' | 'done' | 'failed' | 'stopped';
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
}

export interface ChatProjectSnapshot {
  productId?: string;
  productTitle?: string;
  research?: ResearchData | null;
  selectedAngle?: MaterialAngle | null;
  scriptVersions: ScriptVersion[];
  activeScriptVersionId?: string | null;
  renderVersions: RenderVersion[];
  activeRenderVersionId?: string | null;
  renderResult?: RenderResult | null;
  task?: TaskStatus | null;
  activeAgentRunId?: string | null;
  activeRunKind?: 'one_click_video' | 'script_generate' | 'render_full' | 'repair_shot' | 'ab_test' | null;
}

export interface ChatHistoryItem {
  id: string;
  title: string;
  productId?: string;
  productTitle?: string;
  scriptId?: string;
  taskId?: string;
  runId?: string;
  messages: ChatHistoryMessage[];
  activityItems?: ChatHistoryActivityItem[];
  magicProgress?: MagicProgressState;
  projectSnapshot?: ChatProjectSnapshot;
  createdAt: number;
  updatedAt: number;
}

function loadHistory(): ChatHistoryItem[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is ChatHistoryItem =>
        Boolean(item && typeof item === 'object' && (item as ChatHistoryItem).id),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50);
  } catch {
    return [];
  }
}

function saveHistory(items: ChatHistoryItem[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 50)));
  } catch {
    /* ignore quota errors */
  }
}

function mergeHistoryItems(localItems: ChatHistoryItem[], remoteItems: ChatHistoryItem[]) {
  const byId = new Map<string, ChatHistoryItem>();
  for (const item of localItems) byId.set(item.id, item);
  for (const item of remoteItems) {
    const existing = byId.get(item.id);
    if (!existing || item.updatedAt >= existing.updatedAt) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
}

async function loadBackendHistory() {
  const response = await fetch(`${API_BASE}/projects?limit=50`);
  if (!response.ok) throw new Error(`projects HTTP ${response.status}`);
  const payload = (await response.json()) as { items?: unknown };
  if (!Array.isArray(payload.items)) return [];
  return payload.items.filter((item): item is ChatHistoryItem =>
    Boolean(item && typeof item === 'object' && (item as ChatHistoryItem).id),
  );
}

function scheduleBackendUpsert(session: ChatHistoryItem) {
  if (typeof window === 'undefined') return;
  const existing = backendSyncTimers.get(session.id);
  if (existing) window.clearTimeout(existing);
  const timer = window.setTimeout(() => {
    backendSyncTimers.delete(session.id);
    void fetch(`${API_BASE}/projects/${encodeURIComponent(session.id)}/snapshot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session }),
    }).catch(() => {
      /* localStorage remains the fallback when API is offline */
    });
  }, BACKEND_SYNC_DELAY_MS);
  backendSyncTimers.set(session.id, timer);
}

function deleteBackendProject(sessionId: string) {
  if (typeof window === 'undefined') return;
  const existing = backendSyncTimers.get(sessionId);
  if (existing) {
    window.clearTimeout(existing);
    backendSyncTimers.delete(sessionId);
  }
  void fetch(`${API_BASE}/projects/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {
    /* localStorage delete still applies when API is offline */
  });
}

export function useChatHistory() {
  const [items, setItems] = useState<ChatHistoryItem[]>(() => loadHistory());

  useEffect(() => {
    saveHistory(items);
  }, [items]);

  useEffect(() => {
    let cancelled = false;
    void loadBackendHistory()
      .then((remoteItems) => {
        if (cancelled) return;
        const remoteById = new Map(remoteItems.map((item) => [item.id, item]));
        setItems((current) => {
          current.forEach((item) => {
            const remote = remoteById.get(item.id);
            if (!remote || item.updatedAt > remote.updatedAt) scheduleBackendUpsert(item);
          });
          return mergeHistoryItems(current, remoteItems);
        });
      })
      .catch(() => {
        /* localStorage remains the fallback when API is offline */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const upsert = useCallback((session: ChatHistoryItem) => {
    scheduleBackendUpsert(session);
    setItems((prev) => {
      const next = prev.filter((it) => it.id !== session.id);
      next.unshift(session);
      return next.slice(0, 50);
    });
  }, []);

  const remove = useCallback((sessionId: string) => {
    deleteBackendProject(sessionId);
    setItems((prev) => prev.filter((it) => it.id !== sessionId));
  }, []);

  const clear = useCallback(() => {
    items.forEach((item) => deleteBackendProject(item.id));
    setItems([]);
  }, [items]);

  const get = useCallback((sessionId: string) => items.find((it) => it.id === sessionId), [items]);

  return { items, upsert, remove, clear, get };
}

export function newSessionId() {
  return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function deriveTitle(input: { productTitle?: string; firstUserText?: string }): string {
  if (input.productTitle && input.productTitle.trim()) return input.productTitle.trim().slice(0, 40);
  if (input.firstUserText && input.firstUserText.trim()) {
    const text = input.firstUserText.trim();
    return text.length > 28 ? text.slice(0, 28) + '…' : text;
  }
  return '新对话';
}

export function groupByDate(items: ChatHistoryItem[]): Array<{ label: string; items: ChatHistoryItem[] }> {
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const today = todayStart.getTime();
  const yesterday = today - dayMs;
  const weekAgo = today - 7 * dayMs;

  const buckets: Record<string, ChatHistoryItem[]> = { today: [], yesterday: [], week: [], older: [] };
  for (const item of items) {
    if (item.updatedAt >= today) buckets.today.push(item);
    else if (item.updatedAt >= yesterday) buckets.yesterday.push(item);
    else if (item.updatedAt >= weekAgo) buckets.week.push(item);
    else buckets.older.push(item);
  }

  const groups: Array<{ label: string; items: ChatHistoryItem[] }> = [];
  if (buckets.today.length) groups.push({ label: '今天', items: buckets.today });
  if (buckets.yesterday.length) groups.push({ label: '昨天', items: buckets.yesterday });
  if (buckets.week.length) groups.push({ label: '本周', items: buckets.week });
  if (buckets.older.length) groups.push({ label: '更早', items: buckets.older });
  void now;
  return groups;
}
