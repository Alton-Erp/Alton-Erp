import { AlertTriangle } from 'lucide-react'
import { Component, type ErrorInfo, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { reportError } from '@/lib/error-reporting'

/**
 * Catches rendering errors of a page, reports them with a correlation id and
 * shows a plain message (no stack trace) with the reference to quote.
 */
/** Page code could not be loaded: after a new release (old tab) or a dropped connection. A reload fixes both. */
const isStaleBuild = (error: unknown) => /dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(String((error as Error)?.message ?? error))

export class ErrorBoundary extends Component<{ children: ReactNode; resetKey?: string }, { reference: string | null; resetKey?: string; staleBuild?: boolean }> {
  state: { reference: string | null; resetKey?: string; staleBuild?: boolean } = { reference: null, resetKey: this.props.resetKey }

  static getDerivedStateFromProps(props: { resetKey?: string }, state: { reference: string | null; resetKey?: string }) {
    return props.resetKey !== state.resetKey ? { reference: null, resetKey: props.resetKey, staleBuild: false } : null
  }

  static getDerivedStateFromError(error: unknown) {
    return { reference: 'pending', staleBuild: isStaleBuild(error) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isStaleBuild(error)) return
    this.setState({ reference: reportError('app:render', error, { component: (info.componentStack ?? '').split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? null }) })
  }

  render() {
    if (this.state.reference === null) return this.props.children
    if (this.state.staleBuild) {
      return (
        <Card role="alert" className="mx-auto mt-8 max-w-lg gap-3 p-6 text-center">
          <AlertTriangle className="mx-auto size-8 text-amber-600" />
          <p className="font-semibold">This page needs to be reloaded.</p>
          <p className="text-sm text-muted-foreground">Part of the application could not be loaded, usually because a new version was released or the connection was interrupted. Reload to continue; unsaved form entries on this page are lost.</p>
          <Button onClick={() => location.reload()}>Reload now</Button>
        </Card>
      )
    }
    return (
      <Card role="alert" className="mx-auto mt-8 max-w-lg gap-3 p-6 text-center">
        <AlertTriangle className="mx-auto size-8 text-shortage" />
        <p className="font-semibold">This page could not be displayed.</p>
        <p className="text-sm text-muted-foreground">The problem was recorded. If it continues, contact your administrator and quote the reference below.</p>
        {this.state.reference !== 'pending' && <p className="font-mono text-xs">Reference: {this.state.reference}</p>}
        <Button variant="outline" onClick={() => location.reload()}>Reload page</Button>
      </Card>
    )
  }
}
