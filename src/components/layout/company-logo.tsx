import { COMPANY } from '@/config/app'
import { cn } from '@/lib/utils'

/** Official ALTON® wordmark (public/alton-logo.png, 2354×621, transparent background). */
export const LOGO_SRC = '/alton-logo.png'
export const LOGO_ALT = 'ALTON Sanitary Ware logo'

type LogoSize = 'sidebar' | 'header' | 'auth'

// Width-led sizes with a height cap; object-contain keeps the original aspect ratio.
const SIZES: Record<LogoSize, string> = {
  sidebar: 'w-[144px] max-h-12',
  header: 'w-[76px] max-h-8 sm:w-[96px]',
  auth: 'w-[180px] max-h-14',
}

/**
 * The company logo, used by the shared sidebar, top bar and sign-in layout.
 * The image is never recoloured or redrawn. In the white sidebar and top bar it
 * sits on a white backing; on the sign-in page (grey) the transparent PNG is used
 * as is, so no white box shows around it.
 */
export function CompanyLogo({ size = 'sidebar', collapsed = false, className }: { size?: LogoSize; collapsed?: boolean; className?: string }) {
  return (
    <span className={cn('inline-flex min-w-0 shrink-0 items-center', size !== 'auth' && 'bg-white', className)} title={COMPANY.legalName}>
      <img
        src={LOGO_SRC}
        alt={LOGO_ALT}
        width={2354}
        height={621}
        decoding="async"
        draggable={false}
        // `collapsed` only applies to the 72px desktop rail; the mobile drawer always shows the full size.
        className={cn('block h-auto max-w-full object-contain object-left', SIZES[size], collapsed && 'lg:w-[48px] lg:object-center')}
      />
    </span>
  )
}
