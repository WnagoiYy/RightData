import type { User } from './api';
import { hasPermission } from './api';

export type PageKey = 'overview' | 'screens' | 'screen-resources' | 'users' | 'roles' | 'connections' | 'reports' | 'dashboards' | 'menus' | 'bulletins' | 'queries' | 'files' | 'docs' | 'data' | 'import' | 'databases' | 'access-log' | 'relay-log' | 'query-log' | 'import-log' | 'export-log';
export type NavEntry = { key: PageKey; label: string; permission?: string };
export const navGroups: { key: string; label: string; groups: { key: string; label: string; entries: NavEntry[] }[] }[] = [
  { key: 'workspace', label: '数据工作台', groups: [{ key: 'home', label: '', entries: [{ key: 'overview', label: '系统概览' }, { key: 'screens', label: '数据大屏', permission: 'resources.read' }] }] },
  { key: 'system', label: '权限与系统', groups: [
    { key: 'admin', label: '系统管理', entries: [{ key: 'users', label: '用户管理', permission: 'users.manage' }, { key: 'roles', label: '角色配置', permission: 'config.write' }] },
    { key: 'config', label: '配置管理', entries: [
      { key: 'connections', label: '连接管理', permission: 'datasets.manage' },
      { key: 'queries', label: '查询定义', permission: 'config.write' },
      { key: 'reports', label: '报表配置', permission: 'config.write' },
      { key: 'dashboards', label: '看板管理', permission: 'config.write' },
      { key: 'menus', label: '菜单配置', permission: 'config.write' },
      { key: 'bulletins', label: '通报配置', permission: 'config.write' },
    ] },
  ] },
  { key: 'development', label: '开发与运维', groups: [
    { key: 'resources', label: '资源管理', entries: [{ key: 'screen-resources', label: '大屏资源', permission: 'config.write' }, { key: 'files', label: '文件管理', permission: 'files.read' }, { key: 'docs', label: '接口管理', permission: 'docs.read' }] },
    { key: 'data-management', label: '数据管理', entries: [{ key: 'data', label: '数据查询', permission: 'data.read' }, { key: 'import', label: '数据导入', permission: 'data.write' }, { key: 'databases', label: '数据库运维', permission: 'datasets.manage' }] },
    { key: 'logs', label: '系统日志', entries: [
      { key: 'access-log', label: '访问日志', permission: 'logs.read' }, { key: 'relay-log', label: '中转日志', permission: 'logs.read' },
      { key: 'query-log', label: '查询日志', permission: 'logs.read' }, { key: 'import-log', label: '导入日志', permission: 'logs.read' }, { key: 'export-log', label: '导出日志', permission: 'logs.read' },
    ] },
  ] },
];
export const pages = navGroups.flatMap(group => group.groups.flatMap(section => section.entries));
export function allowedPages(user: User) { return pages.filter(page => !page.permission || hasPermission(user.permissions, page.permission)); }
export type DynamicMenu = { id: string; name: string; resourceId?: string; resourceKind?: string; children?: DynamicMenu[]; parentId?: string; order?: number };
export function flattenMenus(menus: DynamicMenu[]): DynamicMenu[] { return menus.flatMap(menu => [menu, ...flattenMenus(menu.children || [])]); }
