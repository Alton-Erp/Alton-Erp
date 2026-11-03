import { Suspense } from 'react'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'

import { AuthProvider } from '@/auth/auth-provider'
import { ProtectedRoute } from '@/auth/protected-route'
import { RequirePermission } from '@/auth/require-permission'
import { AuthLoadingScreen } from '@/components/auth/auth-screens'
import { AppLayout } from '@/components/layout/app-layout'
import { NAV_ITEMS, NAV_PERMISSIONS } from '@/config/navigation'
import { ForgotPasswordPage, LoginPage, NotFoundPage, PAGE_COMPONENTS, REDIRECTS, ResetPasswordPage, SUB_ROUTES } from '@/routes'

export default function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<AuthLoadingScreen label="Loading…" />}>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/reset-password" element={<ResetPasswordPage />} />

            <Route
              element={
                <ProtectedRoute>
                  <AppLayout />
                </ProtectedRoute>
              }
            >
              {NAV_ITEMS.map((item) => {
                const Page = PAGE_COMPONENTS[item.key]
                const element = (
                  <RequirePermission permission={NAV_PERMISSIONS[item.key] ?? undefined}>
                    <Page />
                  </RequirePermission>
                )
                return item.path === '/' ? (
                  <Route key={item.key} index element={element} />
                ) : (
                  <Route key={item.key} path={item.path} element={element} />
                )
              })}
              {SUB_ROUTES.map(({ path, permission, component: Page }) => (
                <Route
                  key={path}
                  path={path}
                  element={
                    <RequirePermission permission={permission ?? undefined}>
                      <Page />
                    </RequirePermission>
                  }
                />
              ))}
              {REDIRECTS.map(({ from, to }) => (
                <Route key={from} path={from} element={<Navigate to={to} replace />} />
              ))}
              <Route path="*" element={<NotFoundPage />} />
            </Route>
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  )
}
