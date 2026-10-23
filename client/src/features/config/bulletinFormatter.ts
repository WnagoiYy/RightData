type FormatterModules = Awaited<ReturnType<typeof loadFormatterModules>>

let formatterModules: Promise<FormatterModules> | undefined

async function loadFormatterModules() {
  const [prettier, html, babel, estree, postcss] = await Promise.all([
    import('prettier/standalone'),
    import('prettier/plugins/html'),
    import('prettier/plugins/babel'),
    import('prettier/plugins/estree'),
    import('prettier/plugins/postcss'),
  ])
  return { prettier, plugins: [html, babel, estree, postcss] }
}

export async function formatBulletinSource(source: string): Promise<string> {
  formatterModules ??= loadFormatterModules()
  const { prettier, plugins } = await formatterModules
  return prettier.format(source, {
    parser: 'html',
    plugins,
    tabWidth: 2,
    useTabs: false,
    printWidth: 120,
    htmlWhitespaceSensitivity: 'ignore',
    embeddedLanguageFormatting: 'auto',
  })
}
