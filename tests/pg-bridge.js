// A stand-in for Supabase's REST layer (PostgREST) backed by a real Postgres (PGlite) that runs
// supabase/setup.sql. Client code talks to it through a normal fetch(), so the SQL, the HTTP
// shapes and the client are all exercised together. Used by the sync tests and the browser test.
import fs from 'node:fs';

const SETUP = fs.readFileSync(new URL('../supabase/setup.sql', import.meta.url), 'utf8');

let shared; // PGlite takes seconds to boot, so one instance is reset and reused

export async function createBackend({ url = 'http://localhost:54321', key = 'sb_publishable_testkey', install = true } = {}) {
  if (!shared) {
    const { PGlite } = await import('@electric-sql/pglite');
    shared = new PGlite();
    await shared.exec('create role anon nologin; create role authenticated nologin;');
  }
  const db = shared;
  // Start from a blank database each time (like a brand-new Supabase project).
  await db.exec('reset role; drop schema public cascade; create schema public; grant usage on schema public to public;');
  if (install) await db.exec(SETUP);
  await db.exec('set role anon');

  const backend = {
    url,
    key,
    db,
    down: false, // simulate no connectivity
    calls: [],
    /** fetch()-compatible handler for `${url}/rest/v1/rpc/<function>` */
    async fetch(input, init = {}) {
      if (backend.down) throw new TypeError('Failed to fetch');
      const target = String(input);
      const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
      const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
      if (headers.apikey !== key) return json(401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' });
      if (/^eyJ/.test(key) && headers.authorization !== `Bearer ${key}`) return json(401, { message: 'Invalid JWT' });
      if (!/^sb_/.test(key) && !/^eyJ/.test(key)) return json(401, { message: 'Invalid API key' });
      const m = new RegExp(`^${url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/rest/v1/rpc/([a-z_]+)$`).exec(target);
      if (!m) return json(404, { message: 'Not found' });
      const name = m[1];
      const body = JSON.parse(init.body ?? '{}');
      backend.calls.push({ name, body });

      // Same way PostgREST calls it: by parameter name.
      const keys = Object.keys(body);
      const args = keys.map((k, i) => `${k} => $${i + 1}${body[k] !== null && typeof body[k] === 'object' ? '::jsonb' : ''}`);
      const values = keys.map((k) => (body[k] !== null && typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]));
      try {
        const res = await db.query(`select public.${name}(${args.join(', ')}) as r`, values);
        return json(200, res.rows[0].r);
      } catch (err) {
        if (err.code === '42883') return json(404, { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` });
        if (err.code === '42501') return json(401, { code: err.code, message: err.message });
        if (err.code === '22023') return json(400, { code: err.code, message: err.message });
        return json(500, { code: err.code, message: err.message });
      }
    },
  };
  return backend;
}
