const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
// Nunca dejar que el navegador guarde en caché el HTML/JS: si no,
// cada vez que actualicemos el código, algunos usuarios van a seguir
// viendo la versión vieja aunque el servidor ya tenga la nueva.
app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
  next();
});

app.use(express.static(__dirname, { etag: false, lastModified: false }));

const SUPERADMIN_EMAIL = 'dimirtorres3@gmail.com';
const SUPERADMIN_PASSWORD = '6569488Bt';

// Conexión a la base de datos que Railway inyecta sola como variable de entorno
// cuando agregás un PostgreSQL al mismo proyecto (DATABASE_URL).
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Códigos de verificación pendientes (en memoria, se pierden si el server
// reinicia — está bien, porque son de corta duración de todas formas).
// TODO EMAIL: acá es donde hay que mandar el código real por correo
// (por ejemplo con Resend o SendGrid) en vez de solo guardarlo en memoria.
const pendingRegistrations = {};

async function initDB(){
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 1000,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [SUPERADMIN_EMAIL]);
  if(existing.rows.length === 0){
    const hash = await bcrypt.hash(SUPERADMIN_PASSWORD, 10);
    await pool.query(
      'INSERT INTO users (name, email, password_hash, balance, role) VALUES ($1,$2,$3,$4,$5)',
      ['Súper Admin', SUPERADMIN_EMAIL, hash, 1000, 'superadmin']
    );
    console.log('Cuenta de súper admin creada');
  }
}

function publicUser(row){
  return { name: row.name, email: row.email, balance: row.balance, role: row.role };
}

function generateCode(){
  return String(Math.floor(100000 + Math.random() * 900000));
}

// ---- REGISTRO (paso 1: pide el código) ----
app.post('/api/register', async (req, res) => {
  try{
    const name = (req.body.name || '').trim();
    const email = (req.body.email || '').trim().toLowerCase();
    const password = (req.body.password || '').trim();

    if(!name || !email) return res.status(400).json({ error: 'Completá tu nombre y correo' });
    if(password.length < 6) return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if(existing.rows.length > 0) return res.status(400).json({ error: 'Ya existe una cuenta con ese correo' });

    const code = generateCode();
    pendingRegistrations[email] = { name, email, password, code, createdAt: Date.now() };

    // TODO EMAIL: enviar `code` al correo del usuario acá.
    // Por ahora se devuelve en la respuesta para poder probar sin email real.
    res.json({ ok: true, demoCode: code });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ---- VERIFICAR CÓDIGO (paso 2: crea la cuenta de verdad) ----
app.post('/api/verify', async (req, res) => {
  try{
    const email = (req.body.email || '').trim().toLowerCase();
    const code = (req.body.code || '').trim();

    const pending = pendingRegistrations[email];
    if(!pending) return res.status(400).json({ error: 'No hay un registro pendiente para ese correo' });
    if(pending.code !== code) return res.status(400).json({ error: 'Código incorrecto' });

    const hash = await bcrypt.hash(pending.password, 10);
    const result = await pool.query(
      'INSERT INTO users (name, email, password_hash, balance, role) VALUES ($1,$2,$3,1000,\'user\') RETURNING *',
      [pending.name, pending.email, hash]
    );
    delete pendingRegistrations[email];

    res.json({ ok: true, user: publicUser(result.rows[0]) });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ---- LOGIN ----
app.post('/api/login', async (req, res) => {
  try{
    const email = (req.body.email || '').trim().toLowerCase();
    const password = (req.body.password || '').trim();

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if(result.rows.length === 0) return res.status(400).json({ error: 'Correo o contraseña incorrectos' });

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if(!match) return res.status(400).json({ error: 'Correo o contraseña incorrectos' });

    res.json({ ok: true, user: publicUser(user) });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ---- GUARDAR SALDO ----
app.post('/api/balance', async (req, res) => {
  try{
    const email = (req.body.email || '').trim().toLowerCase();
    const balance = parseInt(req.body.balance, 10);
    if(isNaN(balance)) return res.status(400).json({ error: 'Saldo inválido' });

    await pool.query('UPDATE users SET balance = $1 WHERE email = $2', [balance, email]);
    res.json({ ok: true });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ---- PANEL DE ADMINISTRACIÓN: listar usuarios ----
app.get('/api/users', async (req, res) => {
  try{
    const result = await pool.query('SELECT name, email, balance, role FROM users ORDER BY name ASC');
    res.json({ ok: true, users: result.rows });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// ---- PANEL DE ADMINISTRACIÓN: cambiar rol (solo el súper admin puede) ----
app.post('/api/role', async (req, res) => {
  try{
    const requesterEmail = (req.body.requesterEmail || '').trim().toLowerCase();
    const targetEmail = (req.body.targetEmail || '').trim().toLowerCase();
    const role = req.body.role;

    if(!['user', 'admin'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });

    const requester = await pool.query('SELECT role FROM users WHERE email = $1', [requesterEmail]);
    if(requester.rows.length === 0 || requester.rows[0].role !== 'superadmin'){
      return res.status(403).json({ error: 'Solo el súper admin puede cambiar roles' });
    }
    if(targetEmail === SUPERADMIN_EMAIL){
      return res.status(400).json({ error: 'No se puede cambiar el rol del súper admin' });
    }

    await pool.query('UPDATE users SET role = $1 WHERE email = $2', [role, targetEmail]);
    res.json({ ok: true });
  }catch(err){
    console.error(err);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'casino-negro.html'));
});

initDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log('Casino Online corriendo en el puerto ' + PORT);
    });
  })
  .catch(err => {
    console.error('No se pudo conectar a la base de datos:', err.message);
    // igual levanta el servidor para que el sitio se vea, aunque sin guardado real
    app.listen(PORT, () => {
      console.log('Casino Online corriendo en el puerto ' + PORT + ' (sin base de datos)');
    });
  });
