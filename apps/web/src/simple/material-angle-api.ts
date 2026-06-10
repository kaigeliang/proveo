import { API_BASE, type MaterialAngle, type TaskStatus } from './studio-types';

type AngleTaskPayload = TaskStatus & {
  payload?: {
    angles?: MaterialAngle[];
    fallbackReason?: string;
    provider?: 'local' | 'qwen';
    materialId?: string;
  };
};

async function readApiError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    return body.error || `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function listMaterialAngles(materialId: string): Promise<MaterialAngle[]> {
  const response = await fetch(`${API_BASE}/materials/${encodeURIComponent(materialId)}/angles`);
  if (!response.ok) throw new Error(await readApiError(response));
  const body = (await response.json()) as MaterialAngle[];
  return Array.isArray(body) ? body : [];
}

export async function createMaterialAngles(
  materialId: string,
  options: {
    force?: boolean;
    includePresets?: boolean;
    customAngles?: Array<{
      label: string;
      promptHint: string;
      azimuthDeg?: number;
      elevationDeg?: number;
      distanceLevel?: number;
    }>;
  } = {},
): Promise<{ taskId?: string; angles?: MaterialAngle[]; reused?: boolean }> {
  const response = await fetch(`${API_BASE}/materials/${encodeURIComponent(materialId)}/angles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      force: options.force === true,
      includePresets: options.includePresets !== false,
      customAngles: options.customAngles || [],
    }),
  });
  if (!response.ok) throw new Error(await readApiError(response));
  return (await response.json()) as { taskId?: string; angles?: MaterialAngle[]; reused?: boolean };
}

export async function waitForAngleTask(
  taskId: string,
  onUpdate?: (task: TaskStatus) => void,
): Promise<MaterialAngle[]> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`);
    if (!response.ok) throw new Error(await readApiError(response));
    const task = (await response.json()) as AngleTaskPayload;
    onUpdate?.(task);
    if (task.status === 'failed') throw new Error(task.error || '角度参考图生成失败');
    if (task.status === 'completed') return Array.isArray(task.payload?.angles) ? task.payload.angles : [];
    await new Promise((resolve) => window.setTimeout(resolve, 800));
  }
  throw new Error('角度参考图任务超时');
}
