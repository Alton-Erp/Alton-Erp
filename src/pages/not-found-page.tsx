import { Compass } from 'lucide-react'
import { Link } from 'react-router-dom'

import { EmptyState } from '@/components/common/empty-state'
import { PageHeader } from '@/components/common/page-header'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'

export default function NotFoundPage() {
  return (
    <>
      <PageHeader title="Page not found" description="The page you requested does not exist." />
      <Card>
        <EmptyState
          icon={Compass}
          title="We couldn't find that page"
          description="Check the address, or use the sidebar or search to open a module."
          action={
            <Button asChild>
              <Link to="/">Go to Dashboard</Link>
            </Button>
          }
        />
      </Card>
    </>
  )
}
