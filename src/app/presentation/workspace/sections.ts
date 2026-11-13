/** The sections of the workspace side menu, in their default order. */
export const workspaceSections = [
  { id: 'collections', icon: '▤', label: 'Collections' },
  { id: 'environments', icon: '◫', label: 'Environments' },
  { id: 'history', icon: '◷', label: 'History' },
  { id: 'runner', icon: '▷', label: 'Runner' },
  { id: 'realtime', icon: '⇄', label: 'Protocols' },
  { id: 'mocks', icon: '◇', label: 'Mocks' },
  { id: 'datasets', icon: '▦', label: 'Datasets' },
  { id: 'mongo', icon: '⬮', label: 'MongoDB' },
  { id: 'git', icon: '⑂', label: 'Git' },
  { id: 'mcp', icon: '⌘', label: 'MCP' },
  { id: 'settings', icon: '⚙', label: 'Settings' },
] as const;
export const sectionIds: readonly string[] = workspaceSections.map((section) => section.id);
