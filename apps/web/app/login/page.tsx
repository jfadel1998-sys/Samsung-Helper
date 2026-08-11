import { redirect } from 'next/navigation';
import { cookies } from 'next/headers';
import { isValidToken, SESSION_COOKIE, hasSession } from '../../lib/session';

export const dynamic = 'force-dynamic';

async function signIn(formData: FormData) {
  'use server';
  const token = String(formData.get('token') ?? '');
  if (!isValidToken(token)) redirect('/login?error=1');

  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 60 * 60 * 24 * 90,
  });
  redirect('/');
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await hasSession()) redirect('/');
  const { error } = await searchParams;

  return (
    <main>
      <h1>Ops Hub</h1>
      <form action={signIn}>
        <p>
          <input
            type="password"
            name="token"
            placeholder="Access token"
            autoFocus
            style={{ padding: '0.5rem', width: '20rem', maxWidth: '100%' }}
          />
        </p>
        <p>
          <button type="submit" style={{ padding: '0.5rem 1rem' }}>
            Sign in
          </button>
        </p>
        {error && <p className="pill bad">Invalid token</p>}
      </form>
    </main>
  );
}
