# Password reset with a 6-digit email code

Password reset no longer uses a magic link. The user receives a 6-digit code by email and types it into the ERP.

## Flow

| Step | Screen | Supabase call |
|---|---|---|
| 1 | Sign in → **Forgot password?** → enter the email address | `supabase.auth.resetPasswordForEmail(email)` (no redirect) |
| 2 | **Enter the 6-digit code**: six boxes, paste, Backspace, resend after 60 s | — |
| 3 | Code checked | `supabase.auth.verifyOtp({ email, token, type: 'recovery' })` |
| 4 | **Choose a new password** + confirmation | `supabase.auth.updateUser({ password })` |
| 5 | **Password updated** → sign out on every device → Sign in | `supabase.auth.signOut()` (global) |

Code: [forgot-password-page.tsx](../src/pages/auth/forgot-password-page.tsx), [otp-input.tsx](../src/components/auth/otp-input.tsx), [password-recovery.ts](../src/features/auth/password-recovery.ts) and [auth-provider.tsx](../src/auth/auth-provider.tsx) (`requestPasswordReset`, `verifyRecoveryCode`, `completePasswordRecovery`, `cancelPasswordRecovery`).

## Security

- **The code is never stored.** It exists only in the page's memory and is cleared after each attempt. The browser keeps two non-secret values:
  - the email address and send time of the pending request (`sessionStorage`), so a refresh keeps the code screen and the countdown;
  - the id of the user who verified a code but has not set a password yet (`localStorage`).
- **A verified code is not a sign-in.** Until the new password is saved, every ERP page redirects to the password step, in every tab and after a refresh. Cancelling signs out and keeps the old password.
- **The password can change only after verification.** The password step appears only with a verified recovery session, and `updateUser` itself requires that session.
- **Password rules:**
  - 8 to 72 characters, with letters and numbers, and not containing the email name.
  - The confirmation must match.
  - Nothing is sent to Supabase until the password passes these checks.
  - Supabase's own password policy still applies on the server, and its errors are shown.
- **The response never reveals whether an address has an account.** The same screen is shown for every address. Only rate-limit and network errors are reported.
- **Invalid and expired codes get the same message**, because Supabase returns `otp_expired` for both. The boxes are then cleared.
- **Repeated requests are limited.** The page enforces a 60-second resend countdown. On the server, Supabase applies the minimum interval between emails (`max_frequency`), the email rate limit and the verification rate limit. When the server refuses, the page shows the wait time it states.
- **After the change, every session of the account is signed out.**
- **No service-role key is used.** Everything runs through the browser's publishable key and Supabase Auth.
- **Old reset links never sign in.** `/reset-password?code=…` ends any session the link opened, removes the tokens from the address bar and points to the code flow.

## Invitations (unchanged)

The `invite-user` Edge Function sends the Supabase **Reset password** email when it invites an existing account (delivery `PASSWORD_LINK`). For that case only, the template keeps an activation link to `/accept-invitation` (`token_hash`, `type=recovery`), which that page already accepts.

The template recognises an invitation when the redirect is `<Site URL>/accept-invitation`, or the older `<Site URL>/reset-password` value of `INVITE_REDIRECT_URL`. The ERP's own password reset sends no redirect, so it always gets the code version. No invitation code or page was changed.

## Hosted project setup (manual, not done automatically)

1. **Email template.** In Dashboard → Authentication → Emails → **Reset password**:
   - Subject: `Your Alton ERP password reset code`.
   - Body: paste [supabase/templates/recovery.html](../supabase/templates/recovery.html).
   - The template shows `{{ .Token }}` and does not use `{{ .ConfirmationURL }}`.
2. **Site URL.** Under Authentication → URL Configuration, the Site URL must be the ERP address **without a trailing slash**. The invitation template relies on this too.
3. **Email settings.** Under Authentication → Email (or Providers → Email):
   - Email OTP length: **6**.
   - Keep the OTP expiry. It also applies to invitation links, so shortening it shortens invitations.
   - Keep the minimum interval between emails at **60 s** or more.
4. **Rate limits.** Under Authentication → Rate Limits, review the email-sent and token-verification limits. The defaults are suitable.
5. **SMTP.** Custom SMTP is required for real delivery volumes. Supabase's built-in sender is limited to a few emails per hour.

The local CLI stack uses the same template ([config.toml](../supabase/config.toml) `[auth.email.template.recovery]`) and `max_frequency = "60s"`.

## Tests

- Unit: [password-recovery.test.ts](../tests/unit/password-recovery.test.ts). Covers the code boxes (digits, paste, Backspace), the password rules, the error messages, that browser storage never holds the code, and the template contents.
- UI smoke ([tests/ui-smoke/run.mjs](../tests/ui-smoke/run.mjs), "Password reset 1–7"), against the mock Auth API:
  - request, including an unknown address, a server rate limit and no redirect;
  - code input, wrong code and expired code;
  - refresh, resend, and the old code being refused;
  - verification, and the ERP staying closed during recovery;
  - password rules, mismatch, the update with global sign-out, and the redirect;
  - the old password refused and the new one signing in;
  - old links;
  - phone layout, cancel, and normal sign-in.

### Live check: required before release, not yet done

The tests above use a mock Supabase. These still need checking on the hosted project, after step 1 of the setup:

1. Request a code for a test account. Confirm the email arrives, shows a 6-digit code and contains no link.
2. Enter a wrong code. Then enter a code after it expires (or after a resend). Both must be refused.
3. Enter the correct code, set a new password and confirm the "Password updated" screen.
4. Sign in with the new password; the old one must fail.
5. Invite a new user and accept. Then invite an existing account that has no company: its email must contain the **Accept invitation** button, and accepting must work.
