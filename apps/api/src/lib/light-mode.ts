export function envBool(name: string, fallback: boolean) {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

export function vectorSearchEnabled() {
  const provider = (process.env.VECTOR_STORE_PROVIDER || 'qdrant').trim().toLowerCase();
  if (['off', 'none', 'false', '0', 'disabled'].includes(provider)) return false;
  if (!envBool('QDRANT_ENABLED', true) && provider !== 'pgvector') return false;
  if (!envBool('PGVECTOR_ENABLED', true) && provider === 'pgvector') return false;
  if (!envBool('CLIP_ENABLED', true)) return false;
  return true;
}

export function clipWarmupEnabled() {
  return envBool('CLIP_WARMUP_ENABLED', vectorSearchEnabled());
}
