// The Sharkive — manage-users Edge Function
// Lets the owner create reviewer accounts, reset passwords and delete accounts
// from the review page. It holds the secret key, so the browser never does.
//
// Deploy from the Supabase Dashboard: Edge Functions → Deploy a new function →
// Via Editor, name it  manage-users , paste this file, Deploy. Then open the
// function's Details and turn OFF "Verify JWT with legacy secret" (this file
// checks the caller itself, which also works with the new signing keys).
//
// Actions (POST JSON body):
//   { action: 'create', email, name?, role }   → new account with a temporary
//        password (or an existing account given access); returns { temp_password? }
//   { action: 'reset_password', user_id }       → returns { temp_password }
//   { action: 'delete_account', user_id }       → removes reviewer access and the account
import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const fail = (message: string, status = 400) => reply({ error: message }, status);

const secretKey = (() => {
  try { const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '{}'); if (k.default) return k.default as string; } catch { /* legacy only */ }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
})();
const admin = createClient(Deno.env.get('SUPABASE_URL')!, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });

const ROLES = ['reviewer', 'expert', 'admin'];

// 14 characters, no look-alikes (0/O, 1/l/I), always letters + digits.
function tempPassword() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(14));
    const pw = Array.from(bytes, b => abc[b % abc.length]).join('');
    if (/\d/.test(pw) && /[a-z]/.test(pw) && /[A-Z]/.test(pw)) return pw;
  }
}

async function isOwnerRow(user_id: string) {
  const { data } = await admin.from('reviewers').select('owner').eq('user_id', user_id).maybeSingle();
  return !!data?.owner;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return fail('POST only', 405);

  // Who is calling? Must be the active owner.
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return fail('Sign in first', 401);
  const { data: who, error: whoErr } = await admin.auth.getUser(token);
  if (whoErr || !who?.user) return fail('Your sign-in has expired. Reload the page and sign in again.', 401);
  const { data: me } = await admin.from('reviewers').select('owner, active').eq('user_id', who.user.id).maybeSingle();
  if (!me?.owner || !me.active) return fail('Only the owner can manage accounts', 403);

  let body: Record<string, string>;
  try { body = await req.json(); } catch { return fail('Bad request'); }

  try {
    switch (body.action) {
      case 'create': {
        const email = String(body.email ?? '').trim().toLowerCase();
        const name = String(body.name ?? '').trim().slice(0, 80) || null;
        const role = String(body.role ?? 'reviewer');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('That email address doesn\'t look right');
        if (!ROLES.includes(role)) return fail('Unknown role');

        let user_id: string | null = null;
        let temp_password: string | undefined;
        const { data: existing, error: lookErr } = await admin.rpc('user_id_by_email', { p_email: email });
        if (lookErr) throw lookErr;
        if (existing) {
          user_id = existing as string;
          if (await isOwnerRow(user_id)) return fail('That is your own account');
        } else {
          temp_password = tempPassword();
          const { data: made, error } = await admin.auth.admin.createUser({
            email, password: temp_password, email_confirm: true,
            user_metadata: { name, must_change_password: true },
          });
          if (error) throw error;
          user_id = made.user.id;
        }
        const { error: upErr } = await admin.from('reviewers')
          .upsert({ user_id, email, role, active: true, ...(name ? { name } : {}) }, { onConflict: 'user_id' });
        if (upErr) throw upErr;
        return reply({ user_id, created: !!temp_password, temp_password });
      }

      case 'reset_password': {
        const user_id = String(body.user_id ?? '');
        if (!user_id) return fail('Which account?');
        if (await isOwnerRow(user_id)) return fail('Change your own password from your account, not here');
        const temp_password = tempPassword();
        const { data: u, error: getErr } = await admin.auth.admin.getUserById(user_id);
        if (getErr) throw getErr;
        const { error } = await admin.auth.admin.updateUserById(user_id, {
          password: temp_password,
          user_metadata: { ...(u.user.user_metadata ?? {}), must_change_password: true },
        });
        if (error) throw error;
        return reply({ temp_password });
      }

      case 'delete_account': {
        const user_id = String(body.user_id ?? '');
        if (!user_id) return fail('Which account?');
        if (user_id === who.user.id || await isOwnerRow(user_id)) return fail('You can\'t delete the owner\'s account');
        const { error: rmErr } = await admin.from('reviewers').delete().eq('user_id', user_id);
        if (rmErr) throw rmErr;
        // Soft delete: the account can no longer sign in, but the records it
        // reviewed keep their history (hard delete would break those links).
        const { error } = await admin.auth.admin.deleteUser(user_id, true);
        if (error) throw error;
        return reply({ deleted: true });
      }

      default:
        return fail('Unknown action');
    }
  } catch (e) {
    console.error(e);
    return fail((e as Error).message ?? 'Something went wrong', 500);
  }
});
