import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, it } from 'node:test'

import {
  ALWAYS_OPEN_GROUPS,
  activeNavPath,
  ensureSectionOpen,
  sanitizeExpanded,
  toggleSection,
} from '../../src/components/layout/sidebar-sections.ts'
import { NAV_GROUPS, NAV_ITEMS } from '../../src/config/navigation.ts'

const root = path.resolve(import.meta.dirname, '..', '..')
const paths = NAV_ITEMS.map((i) => i.path)
const groups = NAV_GROUPS.map((g) => g.id)

describe('Sidebar sections: active page', () => {
  it('picks the longest matching nav path, so nested pages highlight one entry', () => {
    assert.equal(activeNavPath('/', paths), '/')
    assert.equal(activeNavPath('/inventory', paths), '/inventory')
    assert.equal(activeNavPath('/inventory/stock', paths), '/inventory/stock')
    assert.equal(activeNavPath('/billing/invoices/new', paths), '/billing/invoices/new')
    assert.equal(activeNavPath('/billing/invoices/123', paths), '/billing/invoices')
    assert.equal(activeNavPath('/products/new', paths), '/products')
    assert.equal(activeNavPath('/inventoryx', paths), null)
    assert.equal(activeNavPath('/nowhere', paths), null)
  })
})

describe('Sidebar sections: open and close', () => {
  it('toggles one section and leaves the others open', () => {
    assert.deepEqual(toggleSection([], 'inventory'), ['inventory'])
    assert.deepEqual(toggleSection(['inventory'], 'analytics'), ['inventory', 'analytics'])
    assert.deepEqual(toggleSection(['inventory', 'analytics'], 'inventory'), ['analytics'])
  })

  it('opens the section of the current page without closing others, and is a no-op when already open', () => {
    const open = ['sales']
    assert.deepEqual(ensureSectionOpen(open, 'inventory'), ['sales', 'inventory'])
    assert.equal(ensureSectionOpen(open, 'sales'), open)
    assert.equal(ensureSectionOpen(open, null), open)
  })

  it('ignores stored values that are not a list of known section ids', () => {
    assert.deepEqual(sanitizeExpanded(['inventory', 'gone', 3, 'inventory', 'sales'], groups), ['inventory', 'sales'])
    assert.deepEqual(sanitizeExpanded('inventory', groups), [])
    assert.deepEqual(sanitizeExpanded(null, groups), [])
    assert.deepEqual(sanitizeExpanded({ inventory: true }, groups), [])
  })
})

describe('Sidebar sections: navigation config unchanged', () => {
  it('Dashboard stays in an always-open Overview section; every other section is collapsible', () => {
    assert.deepEqual([...ALWAYS_OPEN_GROUPS], ['overview'])
    assert.equal(NAV_ITEMS.find((i) => i.key === 'dashboard')?.group, 'overview')
  })

  it('every nav item belongs to a known section and every path is unique', () => {
    for (const item of NAV_ITEMS) assert.ok(groups.includes(item.group), `${item.key} has unknown group ${item.group}`)
    assert.equal(new Set(paths).size, paths.length)
    assert.equal(new Set(NAV_ITEMS.map((i) => i.key)).size, NAV_ITEMS.length)
  })

  it('the sidebar keeps role filtering, the rail and the Collapse button', async () => {
    const src = await readFile(path.join(root, 'src', 'components', 'layout', 'sidebar.tsx'), 'utf8')
    assert.match(src, /useVisibleNavItems\(\)/)
    assert.match(src, /aria-expanded=\{open\}/)
    assert.match(src, /aria-label=\{collapsed \? 'Expand sidebar' : 'Collapse sidebar'\}/)
    assert.match(src, /<nav className="flex-1 overflow-y-auto/)
  })
})
