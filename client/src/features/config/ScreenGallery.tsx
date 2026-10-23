import { useState } from 'react'
import { Button, Empty, Input, Table } from 'antd'
import type { DynamicMenu } from '../../lib/navigation'

export function ScreenGallery({ menus, navigate }: { menus: DynamicMenu[]; navigate(route: string): void }) {
  const [search, setSearch] = useState('')
  const screens = menus.filter(menu => menu.resourceKind === 'screen' && menu.resourceId && menu.name.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()))
  return <div className="workspace-stack">
    <div className="toolbar"><Input.Search allowClear aria-label="查找大屏" placeholder="查找大屏" className="search-input" value={search} onChange={event => setSearch(event.target.value)} /></div>
    <Table rowKey="id" size="small" dataSource={screens} pagination={false} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无可访问的大屏" /> }} columns={[
      { title: '名称', dataIndex: 'name' },
      { title: '操作', width: 90, render: (_, menu) => <Button size="small" type="link" onClick={() => navigate(`resource:${menu.id}`)}>打开</Button> },
    ]} />
  </div>
}
