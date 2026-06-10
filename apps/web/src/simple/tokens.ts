/**
 * AIGC 带货视频系统 · Design Tokens (TS)
 * 与 tokens.css 同源。CSS 变量负责样式，本文件供 JS 逻辑读取
 * （如 ECharts 配色、内联计算、条件样式）。
 */

export const tokens = {
  color: {
    neutral: {
      0: '#FFFFFF',
      50: '#FAFAF8',
      100: '#F3F3F0',
      200: '#E7E7E2',
      300: '#D4D4CE',
      400: '#A9A9A2',
      500: '#78786F',
      600: '#57574F',
      700: '#3C3C36',
      800: '#292924',
      900: '#1B1B17',
    },
    primary: {
      50: '#EFEFFB',
      100: '#E0E0F6',
      200: '#C4C3EE',
      300: '#A2A0E4',
      400: '#807DDA',
      500: '#5B5BD6',
      600: '#4B47C2',
      700: '#3C399B',
      800: '#2E2C76',
      900: '#222155',
    },
    success: { 50: '#E1F5EE', 500: '#1D9E75', 700: '#0F6E56' },
    warning: { 50: '#FAEEDA', 500: '#BA7517', 700: '#854F0B' },
    danger: { 50: '#FCEBEB', 500: '#E24B4A', 700: '#A32D2D' },
  },

  radius: { sm: 6, md: 10, lg: 14, xl: 20, pill: 9999 },

  space: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48 },

  font: {
    family: {
      sans: '"Inter","PingFang SC","Microsoft YaHei",system-ui,sans-serif',
      mono: '"SF Mono","JetBrains Mono",ui-monospace,monospace',
    },
    size: { xs: 11, sm: 13, base: 14, md: 16, lg: 18, xl: 20, '2xl': 24 },
    weight: { regular: 400, medium: 500 },
    leading: { tight: 1.3, normal: 1.6, relaxed: 1.75 },
  },

  motion: {
    ease: 'cubic-bezier(0.4, 0, 0.2, 1)',
    duration: { fast: 120, base: 200 },
  },
} as const;

/** 生成任务状态 → 语义色映射（看板、卡片角标、分镜状态统一用它） */
export type TaskStatus = 'done' | 'running' | 'failed' | 'queued';

export const statusColor: Record<TaskStatus, { bg: string; fg: string; label: string }> = {
  done: { bg: 'var(--bg-success)', fg: 'var(--text-success)', label: '已完成' },
  running: { bg: 'var(--bg-warning)', fg: 'var(--text-warning)', label: '进行中' },
  failed: { bg: 'var(--bg-danger)', fg: 'var(--text-danger)', label: '失败' },
  queued: { bg: 'var(--bg-subtle)', fg: 'var(--text-tertiary)', label: '排队中' },
};

export type Tokens = typeof tokens;
