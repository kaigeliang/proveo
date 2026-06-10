import {
  Boxes,
  ChartNoAxesCombined,
  ChevronDown,
  CirclePlus,
  Clapperboard,
  Loader2,
  PackageCheck,
  PanelLeftClose,
  PanelLeftOpen,
  Radar,
  Trash2,
  WandSparkles,
  Workflow,
} from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import type { AppPage } from '../studio-types';
import type { ChatHistoryItem } from '../useChatHistory';
import { groupByDate } from '../useChatHistory';

const PROJECT_ITEMS: Array<{ page: AppPage; label: string; icon: ReactNode; dataKey?: 'script' | 'research' }> = [
  { page: 'script', label: '制作台', icon: <Clapperboard size={16} />, dataKey: 'script' },
  { page: 'materials', label: '素材库', icon: <Boxes size={16} /> },
  { page: 'passport', label: '交付预览', icon: <PackageCheck size={16} /> },
  { page: 'analytics', label: '数据反馈', icon: <ChartNoAxesCombined size={16} /> },
];

const ADVANCED_ITEMS: Array<{ page: AppPage; label: string; icon: ReactNode }> = [
  { page: 'workflow', label: 'Agent 链路', icon: <Workflow size={16} /> },
];

const ADVANCED_PAGES = new Set<AppPage>(ADVANCED_ITEMS.map((item) => item.page));

const BUSY_LABELS: Record<'research' | 'script' | 'compose' | 'render', string> = {
  research: '调研中',
  script: '生成分镜',
  compose: '生成剧本分镜',
  render: '渲染视频',
};

function isMobileViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 720px)').matches;
}

export default function AppRail({
  activePage,
  collapsed,
  history,
  activeSessionId,
  productTitle,
  hasResearch,
  hasScript,
  busy,
  taskProgress,
  onNavigate,
  onReset,
  onToggleCollapse,
  onSelectSession,
  onDeleteSession,
}: {
  activePage: AppPage;
  collapsed?: boolean;
  history: ChatHistoryItem[];
  activeSessionId?: string;
  productTitle?: string;
  hasResearch?: boolean;
  hasScript?: boolean;
  busy?: 'research' | 'script' | 'compose' | 'render' | null;
  taskProgress?: number;
  onNavigate: (page: AppPage) => void;
  onReset: () => void;
  onToggleCollapse?: () => void;
  onSelectSession?: (sessionId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
}) {
  const groups = groupByDate(history);
  const hasProject = Boolean(productTitle);
  const advancedActive = ADVANCED_PAGES.has(activePage);
  const [debugOpen, setDebugOpen] = useState(false);
  const debugVisible = debugOpen || advancedActive;

  useEffect(() => {
    if (collapsed || !onToggleCollapse) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isMobileViewport()) onToggleCollapse();
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [collapsed, onToggleCollapse]);

  const dataReady = (dataKey?: 'script' | 'research') => {
    if (dataKey === 'script') return hasScript;
    if (dataKey === 'research') return hasResearch;
    return false;
  };

  const iconTile = (icon: ReactNode) => <span className="sidebar-nav-icon">{icon}</span>;
  const closeMobileDrawer = () => {
    if (!collapsed && onToggleCollapse && isMobileViewport()) onToggleCollapse();
  };
  const navigateTo = (page: AppPage) => {
    onNavigate(page);
    closeMobileDrawer();
  };
  const resetProject = () => {
    onReset();
    closeMobileDrawer();
  };
  const selectSession = (sessionId: string) => {
    onSelectSession?.(sessionId);
    closeMobileDrawer();
  };

  return (
    <>
      {!collapsed && onToggleCollapse && (
        <button
          type="button"
          className="sidebar-mobile-backdrop"
          onClick={onToggleCollapse}
          aria-label="关闭导航"
          tabIndex={-1}
        />
      )}
      <aside className={`app-rail${collapsed ? ' collapsed' : ''}`} aria-label="主导航">
        <div className="sidebar-header">
          {!collapsed && (
            <>
              <span className="sidebar-brand-name">Proveo</span>
            </>
          )}
          {onToggleCollapse && (
            <button
              type="button"
              className={`sidebar-toggle-btn${collapsed ? ' sidebar-toggle-btn--collapsed' : ''}`}
              onClick={onToggleCollapse}
              aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              title={collapsed ? '展开侧栏' : '收起侧栏'}
            >
              {collapsed ? (
                <>
                  <span className="sidebar-toggle-brand" aria-hidden="true" />
                  <span className="sidebar-toggle-open" aria-hidden="true">
                    <PanelLeftOpen size={15} />
                  </span>
                </>
              ) : (
                <PanelLeftClose size={15} />
              )}
            </button>
          )}
        </div>

        <div className="sidebar-new-chat-wrap">
          <button type="button" className="sidebar-new-chat" onClick={resetProject} title="新建项目">
            {iconTile(<CirclePlus size={16} />)}
            {!collapsed && <span className="sidebar-nav-label">新建项目</span>}
          </button>
        </div>

        {/* Chat entry point */}
        <nav className="sidebar-nav" aria-label="主页导航">
          <button
            type="button"
            className={`sidebar-nav-btn${activePage === 'chat' ? ' active' : ''}`}
            onClick={() => navigateTo('chat')}
            title="开始生成"
          >
            {iconTile(<WandSparkles size={16} />)}
            {!collapsed && <span className="sidebar-nav-label">开始生成</span>}
          </button>
          <button
            type="button"
            className={`sidebar-nav-btn${activePage === 'clone' ? ' active' : ''}`}
            onClick={() => navigateTo('clone')}
            title="爆款配方"
          >
            {iconTile(<Radar size={16} />)}
            {!collapsed && <span className="sidebar-nav-label">爆款配方</span>}
          </button>
        </nav>

        {/* Background task indicator */}
        {busy && (
          <button
            type="button"
            className="sidebar-task-chip"
            onClick={() => navigateTo('chat')}
            title={`${BUSY_LABELS[busy]}${taskProgress ? ` · ${taskProgress}%` : ''} · 点击回到对话页`}
            aria-label={`${BUSY_LABELS[busy]}中`}
          >
            <Loader2 size={collapsed ? 12 : 11} className="spin" />
            {!collapsed && (
              <>
                <span className="sidebar-task-chip-label">{BUSY_LABELS[busy]}</span>
                {taskProgress ? <span className="sidebar-task-chip-prog">{taskProgress}%</span> : null}
              </>
            )}
          </button>
        )}

        {/* Current project section */}
        {!collapsed && (
          <div className="sidebar-project-section">
            <div className="sidebar-section-label sidebar-section-label--project">
              当前项目
              {hasProject && (
                <span className="sidebar-project-name" title={productTitle}>
                  {productTitle && productTitle.length > 14 ? `${productTitle.slice(0, 14)}…` : productTitle}
                </span>
              )}
            </div>
            <nav className="sidebar-nav sidebar-nav--project" aria-label="当前项目步骤">
              {PROJECT_ITEMS.map((item) => {
                const ready = dataReady(item.dataKey);
                return (
                  <button
                    type="button"
                    key={item.page}
                    className={`sidebar-nav-btn${activePage === item.page ? ' active' : ''}${!hasProject ? ' sidebar-nav-btn--inactive' : ''}`}
                    onClick={() => navigateTo(item.page)}
                    title={item.label}
                  >
                    {iconTile(item.icon)}
                    <span className="sidebar-nav-label">{item.label}</span>
                    {ready && <span className="sidebar-step-dot" aria-label="已就绪" />}
                  </button>
                );
              })}
            </nav>
          </div>
        )}

        {/* Collapsed project items */}
        {collapsed && (
          <nav className="sidebar-nav sidebar-nav--project" aria-label="当前项目步骤">
            {PROJECT_ITEMS.map((item) => (
              <button
                type="button"
                key={item.page}
                className={`sidebar-nav-btn${activePage === item.page ? ' active' : ''}${!hasProject ? ' sidebar-nav-btn--inactive' : ''}`}
                onClick={() => navigateTo(item.page)}
                title={item.label}
              >
                {iconTile(item.icon)}
              </button>
            ))}
          </nav>
        )}

        {!collapsed && (
          <section className="sidebar-debug-section" aria-label="内部诊断工具">
            <button
              type="button"
              className={`sidebar-debug-toggle${debugVisible ? ' open' : ''}${advancedActive ? ' active' : ''}`}
              aria-expanded={debugVisible}
              aria-controls="sidebar-debug-nav"
              onClick={() => setDebugOpen((open) => !open)}
            >
              <span>
                {iconTile(<Workflow size={16} />)}
                <span className="sidebar-nav-label">内部诊断</span>
              </span>
              <ChevronDown size={14} aria-hidden="true" />
            </button>
            {debugVisible && (
              <nav id="sidebar-debug-nav" className="sidebar-nav sidebar-nav--advanced" aria-label="内部诊断导航">
                {ADVANCED_ITEMS.map((item) => (
                  <button
                    type="button"
                    key={item.page}
                    className={`sidebar-nav-btn ${activePage === item.page ? 'active' : ''}`}
                    onClick={() => navigateTo(item.page)}
                    title={item.label}
                  >
                    {iconTile(item.icon)}
                    <span className="sidebar-nav-label">{item.label}</span>
                  </button>
                ))}
              </nav>
            )}
          </section>
        )}

        {collapsed && advancedActive && (
          <nav className="sidebar-nav sidebar-nav--advanced" aria-label="当前内部诊断页">
            {ADVANCED_ITEMS.filter((item) => item.page === activePage).map((item) => (
              <button
                type="button"
                key={item.page}
                className="sidebar-nav-btn active"
                onClick={() => navigateTo(item.page)}
                title={item.label}
              >
                {iconTile(item.icon)}
              </button>
            ))}
          </nav>
        )}

        <div className="sidebar-divider" />

        {!collapsed && (
          <div className="sidebar-history" aria-label="历史对话">
            {groups.length === 0 ? (
              <div className="sidebar-history-empty">还没有项目</div>
            ) : (
              groups.map((group) => (
                <div key={group.label} className="history-group">
                  <div className="history-group-label">{group.label}</div>
                  {group.items.map((item) => (
                    <div key={item.id} className="history-item-wrap">
                      <button
                        type="button"
                        className={`history-item${activeSessionId === item.id ? ' active' : ''}`}
                        onClick={() => selectSession(item.id)}
                        title={item.title}
                      >
                        {item.title}
                      </button>
                      {onDeleteSession && (
                        <button
                          type="button"
                          className="history-item-del"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`删除"${item.title}"？`)) onDeleteSession(item.id);
                          }}
                          aria-label="删除"
                          title="删除"
                        >
                          <Trash2 size={11} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        )}

        {!collapsed && (
          <div className="sidebar-note">
            <strong>一页完成</strong>
            <span>商品 · 分镜 · 视频 · 交付</span>
          </div>
        )}
      </aside>
    </>
  );
}
