// Tiny document store: everything lives in memory and is persisted either to a JSON file (default)
// or to Postgres when DATABASE_URL is set (use that on hosts with ephemeral disks, e.g. Render free tier).
import fs from 'node:fs';
import path from 'node:path';

export async function openStore({ file = 'data/db.json', databaseUrl = process.env.DATABASE_URL } = {}) {
  const cols = new Map(); // col -> Map(id -> value)
  const col = (c) => { if (!cols.has(c)) cols.set(c, new Map()); return cols.get(c); };
  let persistSet, persistDel;

  if (databaseUrl) {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: databaseUrl, ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false }, max: 4 });
    await pool.query('CREATE TABLE IF NOT EXISTS docs (col text NOT NULL, id text NOT NULL, data jsonb NOT NULL, PRIMARY KEY (col, id))');
    const { rows } = await pool.query('SELECT col, id, data FROM docs');
    for (const r of rows) col(r.col).set(r.id, r.data);
    const queue = [];
    let busy = false;
    const pump = async () => {
      if (busy) return; busy = true;
      while (queue.length) {
        const job = queue.shift();
        try { await pool.query(job.sql, job.args); } catch (e) { console.error('db write failed', e.message); }
      }
      busy = false;
    };
    persistSet = (c, id, v) => { queue.push({ sql: 'INSERT INTO docs (col, id, data) VALUES ($1,$2,$3) ON CONFLICT (col, id) DO UPDATE SET data = EXCLUDED.data', args: [c, id, JSON.stringify(v)] }); pump(); };
    persistDel = (c, id) => { queue.push({ sql: 'DELETE FROM docs WHERE col=$1 AND id=$2', args: [c, id] }); pump(); };
    console.log(`  Storage: Postgres (${rows.length} documents)`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [c, obj] of Object.entries(raw)) for (const [id, v] of Object.entries(obj)) col(c).set(id, v);
      } catch (e) { console.error('could not read', file, e.message); }
    }
    let timer = null;
    const flush = () => {
      timer = null;
      const out = {};
      for (const [c, m] of cols) out[c] = Object.fromEntries(m);
      const tmp = file + '.tmp';
      fs.writeFile(tmp, JSON.stringify(out), (err) => { if (!err) fs.rename(tmp, file, () => {}); });
    };
    persistSet = persistDel = () => { if (!timer) timer = setTimeout(flush, 400); };
    process.on('exit', () => { if (timer) { try { const out = {}; for (const [c, m] of cols) out[c] = Object.fromEntries(m); fs.writeFileSync(file, JSON.stringify(out)); } catch { /* ignore */ } } });
    console.log(`  Storage: ${file}`);
  }

  return {
    get: (c, id) => col(c).get(id),
    set(c, id, v) { col(c).set(id, v); persistSet(c, id, v); return v; },
    del(c, id) { col(c).delete(id); persistDel(c, id); },
    /** all values of a collection */
    all: (c) => [...col(c).values()],
    entries: (c) => [...col(c).entries()],
  };
}
