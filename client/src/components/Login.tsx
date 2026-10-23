import { useState } from 'react';
import { Button, Checkbox, Form, Input } from 'antd';
import { LockOutlined, SettingOutlined, UserOutlined } from '@ant-design/icons';
import { native, type User } from '../lib/api';
import { Failure } from './Feedback';
import logo from '../assets/logo.svg';

export function Login({ onLogin, onSettings, initialError }: { onLogin: (user: User) => void; onSettings: () => void; initialError?: unknown }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(initialError);
  const submit = async (values: { username: string; password: string; remember: boolean }) => {
    setBusy(true); setError(undefined);
    try { const result = await native<{ user: User }>('auth_login', { request: values }); onLogin(result.user); }
    catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  return <main className="login-page">
    <section className="login-aside" aria-label="贵州权益数据平台">
      <div className="login-brand"><img src={logo} alt="" /><strong>贵州权益数据平台</strong></div>
      <div className="login-art" aria-hidden="true"><span /><span /><span /><span /><span /><span /><div className="art-grid" /></div>
      <div className="login-wordmark">RIGHTDATA<span>贵州权益数据平台</span></div>
    </section>
    <section className="login-main"><div className="login-card">
      <div className="login-mobile-brand"><img src={logo} alt="" />贵州权益数据平台</div>
      <h1>用户登录</h1>
      <Form layout="vertical" initialValues={{ remember: true }} onFinish={submit} requiredMark={false}>
        <Form.Item name="username" label="账号" rules={[{ required: true, message: '请输入账号' }]}><Input size="large" prefix={<UserOutlined />} autoComplete="username" placeholder="请输入账号" /></Form.Item>
        <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}><Input.Password size="large" prefix={<LockOutlined />} autoComplete="current-password" placeholder="请输入密码" /></Form.Item>
        <Form.Item name="remember" valuePropName="checked"><Checkbox>记住登录</Checkbox></Form.Item>
        <Failure error={error} />
        <Button aria-label="登录" className="login-submit" type="primary" htmlType="submit" size="large" loading={busy} block>登录</Button>
      </Form>
      <Button type="text" aria-label="连接设置" icon={<SettingOutlined />} onClick={onSettings}>连接设置</Button>
    </div></section>
  </main>;
}
