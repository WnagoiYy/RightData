import { Component, lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { App as AntApp, Avatar, Badge, Breadcrumb, Button, ConfigProvider, Drawer, Dropdown, Form, Input, Layout, Menu, Modal, Result, Space, Spin } from 'antd';
import type { MenuProps, ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { DatabaseOutlined, FileTextOutlined, FolderOutlined, HomeOutlined, LockOutlined, LogoutOutlined, MenuFoldOutlined, MenuUnfoldOutlined, SettingOutlined, TeamOutlined, UserOutlined } from '@ant-design/icons';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { api, errorMessage, hasPermission, native, type TransportState, type User } from './lib/api';
import { allowedPages, navGroups, pages, type DynamicMenu, type PageKey } from './lib/navigation';
import { Login } from './components/Login';
import { Failure } from './components/Feedback';
import { Overview } from './features/admin/Overview';
import logo from './assets/logo.svg';
import './App.css';

const DataWorkspace = lazy(() => import('./features/data/DataWorkspace').then(module => ({ default: module.DataWorkspace })));
const ImportWorkspace = lazy(() => import('./features/data/ImportWorkspace').then(module => ({ default: module.ImportWorkspace })));
const DatabaseWorkspace = lazy(() => import('./features/data/DatabaseWorkspace').then(module => ({ default: module.DatabaseWorkspace })));
const ConfigWorkspace = lazy(() => import('./features/config/ConfigWorkspace').then(module => ({ default: module.ConfigWorkspace })));
const ResourceView = lazy(() => import('./features/config/ResourceView').then(module => ({ default: module.ResourceView })));
const ScreenGallery = lazy(() => import('./features/config/ScreenGallery').then(module => ({ default: module.ScreenGallery })));
const UsersWorkspace = lazy(() => import('./features/admin/UsersWorkspace').then(module => ({ default: module.UsersWorkspace })));
const ConnectionsWorkspace = lazy(() => import('./features/admin/ConnectionsWorkspace').then(module => ({ default: module.ConnectionsWorkspace })));
const FilesWorkspace = lazy(() => import('./features/admin/FilesWorkspace').then(module => ({ default: module.FilesWorkspace })));
const LogsWorkspace = lazy(() => import('./features/admin/LogsWorkspace').then(module => ({ default: module.LogsWorkspace })));
const DocsWorkspace = lazy(() => import('./features/admin/DocsWorkspace').then(module => ({ default: module.DocsWorkspace })));
const PreviewWindow = lazy(() => import('./features/admin/PreviewWindow').then(module => ({ default: module.PreviewWindow })));
const ConnectionDialog = lazy(() => import('./components/ConnectionDialog').then(module => ({ default: module.ConnectionDialog })));
const UpdateDialog = lazy(() => import('./components/UpdateDialog').then(module => ({ default: module.UpdateDialog })));

const theme: ThemeConfig = {
  token: { colorPrimary: '#0066ff', colorText: '#354b7d', colorTextHeading: '#142052', colorTextSecondary: '#7c8db1', colorBgLayout: '#f4f8ff', colorBorder: '#e1eaf9', fontFamily: '"Microsoft YaHei", "PingFang SC", sans-serif', fontSize: 14, borderRadius: 6, controlHeight: 34, colorSuccess: '#169447' },
  components: { Table: { headerBg: '#f0f5ff', headerColor: '#142052', borderColor: '#edf2fa', cellPaddingBlockSM: 9, cellPaddingInlineSM: 12 }, Menu: { itemHeight: 38, itemMarginBlock: 2, itemMarginInline: 8, itemSelectedBg: '#eaf3ff' }, Modal: { borderRadiusLG: 12 } },
};

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? <Result status="error" title="页面加载失败" extra={<Button onClick={() => this.setState({ failed: false })}>重新加载</Button>} /> : this.props.children; }
}

const readRoute = () => { try { return decodeURIComponent(window.location.hash.slice(1)) || 'overview'; } catch { return 'overview'; } };
function Application() {
  const { message } = AntApp.useApp();
  const [user, setUser] = useState<User>();
  const [state, setState] = useState<TransportState>();
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<unknown>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [updatesOpen, setUpdatesOpen] = useState(false);
  const [menus, setMenus] = useState<DynamicMenu[]>([]);
  const [route, setRoute] = useState(readRoute);
  const [collapsed, setCollapsed] = useState(false);
  const [mobile, setMobile] = useState(window.innerWidth < 900);
  const [drawer, setDrawer] = useState(false);
  const [contextError, setContextError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordForm] = Form.useForm();
  const initialize = useRef<Promise<{ state: TransportState; user?: User; warmConnection?: boolean }> | undefined>(undefined);
  const warmConnection = useRef<Promise<TransportState> | undefined>(undefined);
  const contextRequest = useRef(0);
  const userRef = useRef(user); userRef.current = user;
  const navigate = useCallback((next: string) => { window.location.hash = encodeURIComponent(next); setRoute(next); setDrawer(false); }, []);
  const clearSession = useCallback(() => { userRef.current = undefined; setUser(undefined); setMenus([]); setContextError(undefined); setRevision(value => value + 1); setPasswordOpen(false); navigate('overview'); }, [navigate]);
  useEffect(() => {
    const resize = () => setMobile(window.innerWidth < 900);
    const change = () => setRoute(readRoute());
    window.addEventListener('resize', resize); window.addEventListener('hashchange', change); window.addEventListener('rightdata:session-expired', clearSession);
    return () => { window.removeEventListener('resize', resize); window.removeEventListener('hashchange', change); window.removeEventListener('rightdata:session-expired', clearSession); };
  }, [clearSession]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen('auth-session-expired', clearSession).then(stop => { if (disposed) stop(); else unlisten = stop; }).catch(() => {});
    return () => { disposed = true; unlisten?.(); };
  }, [clearSession]);
  useEffect(() => {
    let alive = true;
    if (!isTauri()) { setBooting(false); return; }
    if (!initialize.current) initialize.current = (async () => {
      const initial = await native<TransportState>('transport_get_state');
      if (new URLSearchParams(window.location.search).has('preview')) return { state: initial, user: initial.session.user };
      if (!initial.session.authenticated) return { state: initial, warmConnection: true };
      const session = await native<{ authenticated: boolean; user?: User }>('auth_restore');
      const current = await native<TransportState>('transport_get_state');
      return { state: current, user: session.authenticated ? session.user : undefined };
    })();
    initialize.current.then(result => {
      if (!alive) return;
      setState(result.state); setUser(result.user); setBooting(false);
      if (result.warmConnection && !warmConnection.current) {
        const pending = native('transport_probe').then(() => native<TransportState>('transport_get_state'));
        warmConnection.current = pending;
        void pending.then(value => { if (alive) { setState(value); setBootError(undefined); } }).catch(cause => {
          if (warmConnection.current === pending) warmConnection.current = undefined;
          if (alive) { setBootError(cause); void native<TransportState>('transport_get_state').then(value => { if (alive) setState(value); }).catch(() => {}); }
        });
      }
    }).catch(cause => { if (alive) { setBootError(cause); setBooting(false); void native<TransportState>('transport_get_state').then(value => { if (alive) setState(value); }).catch(() => {}); } });
    return () => { alive = false; };
  }, []);
  const beforeLogin = useCallback(async () => {
    const pending = warmConnection.current;
    if (!pending) return;
    try { await pending; }
    finally { if (warmConnection.current === pending) warmConnection.current = undefined; }
  }, []);
  const refreshContext = useCallback(async () => {
    const before = userRef.current;
    if (!before) return;
    const request = ++contextRequest.current;
    try {
      const current = await api.request<User>('/api/v1/auth/me');
      const [transportState, nav] = await Promise.all([
        native<TransportState>('transport_get_state'),
        hasPermission(current.permissions, 'resources.read') ? api.request<{ items: DynamicMenu[] }>('/api/v1/menus') : Promise.resolve({ items: [] }),
      ]);
      if (request !== contextRequest.current || userRef.current?.id !== before.id) return;
      setState(transportState);
      if (JSON.stringify(current.permissions) !== JSON.stringify(before.permissions) || current.authzRevision !== before.authzRevision) { setRevision(value => value + 1); userRef.current = current; setUser(current); }
      setMenus(nav.items); setContextError(undefined);
    } catch (cause) { if (request === contextRequest.current && userRef.current?.id === before.id) { setMenus([]); setContextError(cause); } }
  }, []);
  useEffect(() => {
    if (!user) return;
    void refreshContext();
    const timer = window.setInterval(() => void refreshContext(), 30000);
    const onFocus = () => void refreshContext();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [user?.id, refreshContext]);
  const loggedIn = async (current: User) => { setBootError(undefined); setContextError(undefined); setUser(current); setState(await native<TransportState>('transport_get_state')); navigate('overview'); };
  const logout = async () => { try { const result = await native<{ remoteRevoked: boolean }>('auth_logout'); if (!result.remoteRevoked) message.warning('本机已退出，服务端会话尚未注销'); clearSession(); } catch (cause) { message.error(errorMessage(cause)); } };
  const changePassword = async () => {
    const values = await passwordForm.validateFields(); setPasswordBusy(true);
    try { await api.request('/api/v1/auth/password', { method: 'PUT', body: { oldPassword: values.oldPassword, newPassword: values.newPassword } }); await native('auth_logout'); clearSession(); message.success('密码已修改，请重新登录'); }
    catch (cause) { message.error(errorMessage(cause)); } finally { setPasswordBusy(false); }
  };
  const connectionChanged = (next: TransportState) => { setState(next); setBootError(undefined); if (!next.session.authenticated) clearSession(); else if (next.session.user) setUser(next.session.user); };
  const accessible = useMemo(() => user ? new Set(allowedPages(user).map(page => page.key)) : new Set<PageKey>(), [user]);
  const activeResource = route.startsWith('resource:') ? menus.find(menu => menu.id === route.slice(9) && menu.resourceId) : undefined;
  const currentPage = pages.find(page => page.key === route);
  const pageTitle = activeResource?.name || currentPage?.label || '数据工作台';
  const buildDynamic = (parentId = '', depth = 0): NonNullable<MenuProps['items']> => depth > 32 ? [] : menus.filter(menu => (menu.parentId || '') === parentId).map(menu => {
    const children = buildDynamic(menu.id, depth + 1);
    return { key: `resource:${menu.id}`, label: menu.name, icon: <FileTextOutlined />, ...(children.length ? { children } : {}) };
  });
  const icons: Record<string, ReactNode> = { home: <HomeOutlined />, admin: <TeamOutlined />, config: <SettingOutlined />, resources: <FolderOutlined />, 'data-management': <DatabaseOutlined />, logs: <FileTextOutlined /> };
  const menuItems: NonNullable<MenuProps['items']> = [];
  for (const group of navGroups) {
    const children: NonNullable<MenuProps['items']> = [];
    for (const section of group.groups) {
      const entries = section.entries.filter(page => accessible.has(page.key)).map(page => ({ key: page.key, label: page.label }));
      if (!entries.length) continue;
      if (section.label) children.push({ key: section.key, label: section.label, icon: icons[section.key], children: entries });
      else children.push(...entries.map(entry => ({ ...entry, icon: icons[section.key] })));
    }
    if (group.key === 'workspace') children.push(...buildDynamic());
    if (children.length) menuItems.push({ type: 'group', key: group.key, label: group.label, children });
  }
  const previewId = new URLSearchParams(window.location.search).get('preview');
  let content: ReactNode = null;
  if (user) {
    const props = { api, permissions: user.permissions, taskScope: state?.connection.instanceId ? `${state.connection.instanceId}:${user.id}` : undefined };
    if (previewId) content = hasPermission(user.permissions, 'config.write') ? <PreviewWindow api={api} /> : <Result status="403" title="无权预览此资源" />;
    else if (activeResource?.resourceId) content = <ResourceView api={api} resourceId={activeResource.resourceId} permissions={user.permissions} />;
    else if (!accessible.has(route as PageKey)) content = <Result status="403" title="无权访问此页面" extra={<Button onClick={() => navigate('overview')}>返回工作台</Button>} />;
    else switch (route) {
      case 'overview': content = <Overview api={api} user={user} state={state} menus={menus} navigate={navigate} />; break;
      case 'screens': content = <ScreenGallery menus={menus} navigate={navigate} />; break;
      case 'data': content = <DataWorkspace {...props} />; break;
      case 'import': content = <ImportWorkspace {...props} />; break;
      case 'databases': content = <DatabaseWorkspace {...props} />; break;
      case 'users': content = <UsersWorkspace api={api} currentUser={user} />; break;
      case 'connections': content = <ConnectionsWorkspace api={api} />; break;
      case 'files': content = <FilesWorkspace {...props} />; break;
      case 'docs': content = <DocsWorkspace api={api} />; break;
      case 'reports': case 'dashboards': case 'bulletins': case 'menus': case 'queries': case 'roles': case 'screen-resources': {
        const kinds = { reports: 'report', dashboards: 'dashboard', bulletins: 'bulletin', menus: 'menu', queries: 'query', roles: 'role', 'screen-resources': 'screen' } as const;
        content = <ConfigWorkspace api={api} kind={kinds[route]} historyScope={state?.connection.instanceId ? `${state.connection.instanceId}:${user.id}` : undefined} onChanged={() => void refreshContext()} onOpenResource={(resource, previewParams) => { void native('preview_open', { request: { resourceId: resource.id, title: resource.name, draft: resource, params: previewParams } }).catch(cause => message.error(errorMessage(cause))); }} />; break;
      }
      case 'access-log': case 'relay-log': case 'query-log': case 'import-log': case 'export-log': content = <LogsWorkspace api={api} permissions={user.permissions} category={route.replace('-log', '') as 'access' | 'relay' | 'query' | 'import' | 'export'} />; break;
    }
  }
  const menu = <Menu mode="inline" items={menuItems} selectedKeys={[route]} defaultOpenKeys={['data-management', 'config']} onClick={({ key }) => navigate(key)} className="side-menu" />;
  return <>
    {booting ? <div className="app-loading"><Spin size="large" /><span>正在恢复登录…</span></div> : !user ? <Login onLogin={current => void loggedIn(current).catch(cause => message.error(errorMessage(cause)))} onSettings={() => setSettingsOpen(true)} initialError={bootError} beforeLogin={beforeLogin} /> : previewId ? <main className="preview-main"><Suspense fallback={<Spin />}><PageBoundary key={`preview:${revision}`}>{contextError ? <Failure error={contextError} retry={() => void refreshContext()} /> : content}</PageBoundary></Suspense></main> : <Layout className="app-shell">
      {!mobile && <Layout.Sider theme="light" width={212} collapsedWidth={64} collapsed={collapsed} className="app-sider"><div className="brand"><img src={logo} alt="贵州权益数据平台" />{!collapsed && <span>贵州权益数据平台</span>}</div>{menu}<Button className="sider-collapse" type="text" icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />} onClick={() => setCollapsed(value => !value)}>{collapsed ? null : '收起菜单'}</Button></Layout.Sider>}
      <Drawer title="贵州权益数据平台" placement="left" size={260} open={drawer} onClose={() => setDrawer(false)} styles={{ body: { padding: 0 } }}>{menu}</Drawer>
      <Layout className="main-layout"><Layout.Header className="app-header"><Space>{mobile && <Button aria-label="打开菜单" type="text" icon={<MenuUnfoldOutlined />} onClick={() => setDrawer(true)} />}<Breadcrumb items={[{ title: '工作台' }, { title: pageTitle }]} /></Space><Space size={14}>
        <Button className="connection-button" type="text" onClick={() => setSettingsOpen(true)}><Badge status={state?.connection.ready ? 'success' : 'default'} />{state?.connection.ready ? state.connection.mode === 'peer' ? '节点中转' : '内网直连' : '连接设置'}</Button>
        <Dropdown menu={{ items: [{ key: 'connection', label: '连接设置', icon: <SettingOutlined /> }, { key: 'password', label: '修改密码', icon: <LockOutlined /> }, { key: 'updates', label: '检查更新' }, { type: 'divider' }, { key: 'logout', label: '退出登录', icon: <LogoutOutlined />, danger: true }], onClick: ({ key }) => { if (key === 'connection') setSettingsOpen(true); else if (key === 'updates') setUpdatesOpen(true); else if (key === 'password') { passwordForm.resetFields(); setPasswordOpen(true); } else void logout(); } }}><Button type="text" className="user-button"><Avatar size={28} icon={<UserOutlined />} />{user.username}</Button></Dropdown>
      </Space></Layout.Header>
      <Layout.Content className="app-content"><Failure error={contextError} retry={() => void refreshContext()} />{!contextError && <PageBoundary key={`${route}:${revision}`}><Suspense fallback={<div className="page-loading"><Spin /></div>}>{content}</Suspense></PageBoundary>}</Layout.Content></Layout>
    </Layout>}
    {settingsOpen && <Suspense fallback={null}><ConnectionDialog open state={state} onClose={() => setSettingsOpen(false)} onChange={connectionChanged} /></Suspense>}
    {updatesOpen && <Suspense fallback={null}><UpdateDialog open onClose={() => setUpdatesOpen(false)} /></Suspense>}
    <Modal title="修改密码" open={passwordOpen} onCancel={() => setPasswordOpen(false)} onOk={() => void changePassword()} confirmLoading={passwordBusy} destroyOnHidden><Form form={passwordForm} layout="vertical"><Form.Item name="oldPassword" label="当前密码" rules={[{ required: true }]}><Input.Password autoComplete="current-password" /></Form.Item><Form.Item name="newPassword" label="新密码" rules={[{ required: true }, { min: 12, message: '至少 12 个字符' }]}><Input.Password autoComplete="new-password" /></Form.Item><Form.Item name="confirmPassword" label="确认新密码" dependencies={['newPassword']} rules={[{ required: true }, ({ getFieldValue }) => ({ validator: (_, value) => !value || value === getFieldValue('newPassword') ? Promise.resolve() : Promise.reject(new Error('两次密码不一致')) })]}><Input.Password autoComplete="new-password" /></Form.Item></Form></Modal>
  </>;
}

export default function App() { return <ConfigProvider locale={zhCN} theme={theme} button={{ autoInsertSpace: false }}><AntApp><Application /></AntApp></ConfigProvider>; }
