# RightData 大屏开发模板

该目录是容器 API 1 的零依赖示例。`index.html` 只引用相对路径 `./screen.css` 和 `./screen.js`；运行时不访问 CDN、业务地址、Token 或原生系统能力。

先把 `screen.js` 顶部的 `definitionId` 改为当前 screen 配置已绑定的查询定义 ID。容器就绪后会触发 `rightdata:init`，模板通过 `window.rightData.query(definitionId, params)` 取数；容器参数变化时会收到 `rightdata:params` 事件并重新查询。查询仍由 RightData 校验当前资源、查询绑定和数据权限。

浏览器本地开发可用静态服务器打开 `http://localhost:端口/?mock=1`。Mock 只在 `localhost` 或 `127.0.0.1` 且显式带 `mock=1` 时启用，页面会显示“本地 Mock 数据”；发布包不会把 Mock 当作真实结果。不要直接双击 HTML 验证模块脚本。

React/Vite 项目先执行正式构建，再把 `dist/` 作为 `--source`。入口通常是 `index.html`，Vite 生成的相对 assets 会一并写入清单。构建时应使用相对 base，并确保包内不依赖外部网络。

实际容器中的 iframe 只启用 `sandbox="allow-scripts"`，不允许原生表单提交。查询、保存等交互应使用 `type="button"` 的按钮点击或显式键盘事件调用受控 API；React/Vite 页面也应避免依赖 `<form>` 的默认提交行为，并继续使用相对 base。

在项目根目录运行下面的命令可打包此示例。输出必须显式位于项目的 `client/`、`test/` 或 `deploy/` 中；示例排除开发说明与打包脚本：

```powershell
python client/screen-template/pack.py `
  --source client/screen-template `
  --output test/artifacts/screen-template-1.0.0.zip `
  --screen-id sales-screen `
  --version 1.0.0 `
  --exclude README.md `
  --exclude pack.py
```

打包器使用标准库生成确定性 Store/Deflate ZIP，并在原子替换输出前复核 `manifest.json`、路径、文件数量、大小、SHA-256、压缩比、入口和容器版本。输出已存在时默认拒绝覆盖；确认替换可加 `--force`。上传后仍需在管理端显式发布该版本。
