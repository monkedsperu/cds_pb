// Monitor de buses Lima ⇄ Ica — servidor web.
// Uso: npm start  ->  http://localhost:3000 (puerto en config.json o variable PORT)
//
// Secretos en el archivo .env (junto a este archivo):
//   ADMIN_PASSWORD=claveAdmin         contraseña de administrador (gestiona contraseñas y token)
//   APP_PASSWORDS=clave1,clave2      contraseñas de usuarios (separadas por coma)
//   CDS_TOKEN=Token token=...        token de Cruz del Sur (también se cambia desde la rueda ⚙)
// El .env se vuelve a leer en cada inicio de sesión: para agregar o quitar una contraseña
// basta con editarlo, no hace falta reiniciar.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { scrapeCruzDelSur, probarToken } = require('./scrapers/cruzdelsur');
const { construirExcel } = require('./lib/reporteExcel');

const RAIZ = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.json'), 'utf8'));
const DATA = path.join(RAIZ, 'data');
const ENV = path.join(RAIZ, '.env');
fs.mkdirSync(DATA, { recursive: true });
const PUERTO = Number(process.env.PORT || config.puerto || 3000);
const HOST = process.env.HOST || config.host || '127.0.0.1';
const MAX_DIAS = config.maxDiasPorConsulta || 31;
const HORAS_SESION = config.horasSesion || 12;

// ---------------- .env (sin dependencias) ----------------
function leerEnv() {
  const out = {};
  if (!fs.existsSync(ENV)) return out;
  for (const linea of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m || linea.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}
function guardarEnv(clave, valor) {
  const lineas = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split(/\r?\n/) : [];
  const nueva = `${clave}="${valor.replace(/"/g, '')}"`;
  const i = lineas.findIndex((l) => new RegExp(`^\\s*${clave}\\s*=`).test(l));
  if (i >= 0) lineas[i] = nueva; else lineas.push(nueva);
  fs.writeFileSync(ENV, lineas.join('\n').replace(/\n*$/, '\n'));
}
const tokenCDS = () => (leerEnv().CDS_TOKEN || process.env.CDS_TOKEN || '').trim();
const contrasenas = () => (leerEnv().APP_PASSWORDS ?? process.env.APP_PASSWORDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const claveAdmin = () => (leerEnv().ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '').trim();
const huella = (clave) => crypto.createHash('sha256').update('mb:' + clave).digest('hex').slice(0, 16);

// ---------------- ajustes persistentes (data/ajustes.json) ----------------
// Servicios a consultar por empresa. true = se consulta. Los servicios nuevos que aparezcan
// se agregan marcados. Se guarda en el servidor (no en cookies) porque decide qué consulta
// el servidor y así vale para todos los usuarios y sobrevive a reinicios.
const AJUSTES = path.join(DATA, 'ajustes.json');
const SERVICIOS_INICIALES = {
  cds: ['Evolution', 'Suite', 'Confort Suite', 'Ica Express', 'Ica Eco Express', 'Cruzero Plus'],
  pb: ['Servicio Vip', 'Express', 'Express Paracas', 'Salon Cama'],
};
function leerAjustes() {
  let a = {};
  try { a = JSON.parse(fs.readFileSync(AJUSTES, 'utf8')); } catch (_) {}
  a.servicios = a.servicios || {};
  if (typeof a.permitirRangoUsuarios !== 'boolean') a.permitirRangoUsuarios = false; // por defecto solo el admin busca por rango
  a.auto = { activa: false, hora: '06:00', desdeDias: 1, cantidadDias: 1, ultima: null, ultimoResultado: null, ...(a.auto || {}) };
  for (const emp of ['cds', 'pb']) {
    a.servicios[emp] = a.servicios[emp] || {};
    for (const n of SERVICIOS_INICIALES[emp]) if (!(n in a.servicios[emp])) a.servicios[emp][n] = true;
  }
  return a;
}
function guardarAjustes(a) { fs.writeFileSync(AJUSTES, JSON.stringify(a, null, 2)); }
function registrarServicios(emp, nombres) {
  const a = leerAjustes(); let cambio = false;
  for (const n of nombres) if (n && !(n in a.servicios[emp])) { a.servicios[emp][n] = true; cambio = true; }
  if (cambio) guardarAjustes(a);
}

// ---------------- sesiones (en memoria) ----------------
const sesiones = new Map(); // id -> { vence, rol: 'admin'|'usuario', huella }
const intentos = new Map(); // ip -> {n, hasta}
function iguales(a, b) {
  const x = crypto.createHash('sha256').update(a).digest(); const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}
function sesionDe(req) {
  const c = Object.fromEntries((req.headers.cookie || '').split(';').map((p) => p.trim().split('=')).filter((p) => p.length === 2));
  const s = c.sid && sesiones.get(c.sid);
  if (!s) return null;
  if (s.vence < Date.now()) { sesiones.delete(c.sid); return null; }
  return s;
}
const ipDe = (req) => (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

// ---------------- trabajos ----------------
const trabajos = new Map();
let enCurso = null;

function fechasEntre(desde, hasta) {
  const out = []; const d = new Date(`${desde}T12:00:00Z`); const fin = new Date(`${hasta}T12:00:00Z`);
  while (d <= fin) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

async function abrirNavegadorPB(log) {
  if (!config.peruBus || config.peruBus.activo === false) { log('Peru Bus desactivado en config.json.'); return null; }
  let chromium;
  try { ({ chromium } = require('playwright')); } catch (_) {
    log('Peru Bus: Playwright no está instalado. Se omite Peru Bus.'); return null;
  }
  try {
    const navegador = await chromium.launch({ headless: true });
    const contexto = await navegador.newContext({ locale: 'es-PE', timezoneId: 'America/Lima', viewport: { width: 1280, height: 900 } });
    return { navegador, contexto };
  } catch (e) { log(`Peru Bus: no se pudo abrir el navegador (${e.message.split('\n')[0]}). Se omite Peru Bus.`); return null; }
}

function nuevoTrabajo(desde, hasta, origen = 'manual') {
  const id = Date.now().toString(36);
  const fechas = fechasEntre(desde, hasta);
  const t = { id, desde, hasta, origen, estado: 'corriendo', progreso: 0, paso: 'Iniciando…', mensajes: [], resultado: null, error: null, cancelar: false };
  trabajos.set(id, t); enCurso = id;
  const log = (m) => { const l = `[${new Date().toLocaleTimeString('es-PE')}] ${m}`; t.mensajes.push(l); if (t.mensajes.length > 300) t.mensajes.shift(); console.log(l); };
  ejecutar(t, fechas, log)
    .catch((e) => { t.estado = 'error'; t.error = String(e.message || e); log(`ERROR: ${t.error}`); })
    .finally(() => {
      enCurso = null;
      if (origen === 'auto') { try { const a = leerAjustes(); a.auto.ultimoResultado = t.estado === 'listo' ? `Correcta · ${t.resultado.archivo}` : `Error: ${t.error}`; guardarAjustes(a); } catch (_) {} }
    });
  return t;
}

async function ejecutar(t, fechas, log) {
  const rutas = config.rutas;
  const unidades = fechas.length * rutas.length;
  let hechas = 0;
  const marcar = (f, paso) => { t.progreso = Math.min(99, Math.round(((hechas + f) / unidades) * 100)); if (paso) t.paso = paso; };
  const token = tokenCDS();
  const aj = leerAjustes();
  const permitido = (emp) => (n) => aj.servicios[emp][n] !== false;
  const servs = (emp) => ({ incluidos: Object.entries(aj.servicios[emp]).filter(([, v]) => v).map(([k]) => k), excluidos: Object.entries(aj.servicios[emp]).filter(([, v]) => !v).map(([k]) => k) });
  const pb = await abrirNavegadorPB(log);
  const { scrapePeruBus } = pb ? require('./scrapers/perubus') : {};
  const resultado = { origen: t.origen, desde: fechas[0], hasta: fechas[fechas.length - 1], generado: new Date().toISOString(), servicios: { cds: servs('cds'), pb: servs('pb') }, dias: [] };
  try {
    for (const fecha of fechas) {
      const dia = { fecha, rutas: [] };
      for (const ruta of rutas) {
        if (t.cancelar) throw new Error('Consulta cancelada por el usuario.');
        const r = { id: ruta.id, nombre: ruta.nombre, cds: { salidas: [], error: null }, pb: { salidas: [], error: null } };
        const et = `${fecha} · ${ruta.nombre}`;
        marcar(0, `${et}: Cruz del Sur`);
        try {
          r.cds.salidas = await scrapeCruzDelSur({ origen: ruta.cds[0], destino: ruta.cds[1], fecha, config, token, log,
            servicioPermitido: permitido('cds'), alDescubrir: (n) => registrarServicios('cds', n),
            avance: (n, total) => marcar(total ? 0.8 * n / total : 0.8, `${et}: Cruz del Sur ${n}/${total} buses`) });
        } catch (e) { r.cds.error = String(e.message || e); log(`Cruz del Sur (${et}): ${r.cds.error}`); if (e.fatal) throw e; }
        marcar(0.8, `${et}: Peru Bus`);
        if (pb) {
          const pagina = await pb.contexto.newPage();
          try {
            const todas = await scrapePeruBus(pagina, { origen: ruta.pb[0], destino: ruta.pb[1], fecha, config, log });
            registrarServicios('pb', [...new Set(todas.map((x) => x.servicio))]);
            r.pb.salidas = todas.filter((x) => permitido('pb')(x.servicio));
            if (todas.length !== r.pb.salidas.length) log(`Peru Bus: ${todas.length - r.pb.salidas.length} salidas omitidas por servicio no marcado.`);
          }
          catch (e) { r.pb.error = String(e.message || e); log(`Peru Bus (${et}): ${r.pb.error}`); }
          await pagina.close();
        } else r.pb.error = 'Peru Bus no se consultó (ver config.json / README).';
        dia.rutas.push(r); hechas++; marcar(0);
      }
      resultado.dias.push(dia);
    }
  } finally { if (pb) await pb.navegador.close(); }
  const sello = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const pre = t.origen === 'auto' ? 'auto_' : '';
  const archivo = resultado.desde === resultado.hasta ? `${pre}reporte_${resultado.desde}_cap-${sello}.json` : `${pre}reporte_${resultado.desde}_a_${resultado.hasta}_cap-${sello}.json`;
  fs.writeFileSync(path.join(DATA, archivo), JSON.stringify(resultado));
  resultado.archivo = archivo;
  t.resultado = resultado; t.progreso = 100; t.paso = 'Listo'; t.estado = 'listo';
  log(`Listo. Guardado en data/${archivo}`);
}

function normalizar(r) {
  const n = r.dias ? r : { desde: r.fecha, hasta: r.fecha, generado: r.generado, dias: [{ fecha: r.fecha, rutas: r.rutas }] };
  // Reportes antiguos de Peru Bus: completar el tipo de asiento vendido (= servicio del bus).
  n.dias.forEach((d) => d.rutas.forEach((ru) => (ru.pb.salidas || []).forEach((x) => {
    if (!x.porTarifa && x.vendidos != null) { x.porTarifa = { [`${x.servicio || 'Asiento'} S/ ${x.precio ?? '?'}`]: x.vendidos }; if (x.precio) x.ingresoEstimado = x.vendidos * x.precio; }
  })));
  return n;
}

// ---------------- consulta automática diaria ----------------
// Se revisa cada minuto. A la hora configurada (hora de Lima) genera el reporte de los días
// indicados y lo guarda como "auto_reporte_…". Si a esa hora hay otra consulta en curso,
// lo intenta en los minutos siguientes (hasta 3 horas después).
function ahoraLima() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour}:${p.minute}` };
}
const sumarDias = (f, n) => { const d = new Date(`${f}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
setInterval(() => {
  try {
    const a = leerAjustes(); if (!a.auto.activa || !tokenCDS()) return;
    const { fecha, hm } = ahoraLima();
    if (a.auto.ultima === fecha || hm < a.auto.hora) return;
    const [h1, m1] = a.auto.hora.split(':').map(Number); const [h2, m2] = hm.split(':').map(Number);
    if ((h2 * 60 + m2) - (h1 * 60 + m1) > 180) return; // ventana de 3 horas
    if (enCurso) return;
    const desde = sumarDias(fecha, a.auto.desdeDias); const hasta = sumarDias(desde, a.auto.cantidadDias - 1);
    a.auto.ultima = fecha; a.auto.ultimoResultado = `Iniciada ${fecha} ${hm} (${desde}${hasta !== desde ? ' a ' + hasta : ''})`; guardarAjustes(a);
    console.log(`Consulta automática: ${desde} a ${hasta}`);
    nuevoTrabajo(desde, hasta, 'auto');
  } catch (e) { console.error('Consulta automática:', e.message); }
}, 60000);

// ---------------- HTTP ----------------
function json(res, code, obj, extra = {}) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }); res.end(JSON.stringify(obj)); }
async function cuerpo(req) { let b = ''; for await (const c of req) { b += c; if (b.length > 1e5) break; } try { return JSON.parse(b || '{}'); } catch (_) { return {}; } }
const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };
function archivo(res, rel) {
  const p = path.join(RAIZ, 'public', rel);
  if (!p.startsWith(path.join(RAIZ, 'public')) || !fs.existsSync(p)) { res.writeHead(404); return res.end('No encontrado'); }
  res.writeHead(200, { 'content-type': TIPOS[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(p).pipe(res);
}

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  try {
    // --- rutas abiertas (pantalla de bloqueo) ---
    if (u.pathname === '/login') return archivo(res, 'login.html');
    if (req.method === 'POST' && u.pathname === '/api/login') {
      const ip = ipDe(req); const it = intentos.get(ip) || { n: 0, hasta: 0 };
      if (it.hasta > Date.now()) return json(res, 429, { error: `Demasiados intentos. Espera ${Math.ceil((it.hasta - Date.now()) / 1000)} s.` });
      const { clave } = await cuerpo(req);
      const lista = contrasenas(); const adm = claveAdmin();
      if (!lista.length && !adm) return json(res, 503, { error: 'No hay contraseñas configuradas. Agrega ADMIN_PASSWORD en el archivo .env del servidor.' });
      const esAdmin = typeof clave === 'string' && !!adm && iguales(adm, clave);
      const ok = esAdmin || (typeof clave === 'string' && lista.some((p) => iguales(p, clave)));
      if (!ok) {
        it.n++; if (it.n >= 5) { it.hasta = Date.now() + 60000 * Math.min(it.n - 4, 15); }
        intentos.set(ip, it);
        await new Promise((r) => setTimeout(r, 800));
        return json(res, 401, { error: 'Contraseña incorrecta' });
      }
      intentos.delete(ip);
      const sid = crypto.randomBytes(32).toString('hex');
      sesiones.set(sid, { vence: Date.now() + HORAS_SESION * 36e5, rol: esAdmin ? 'admin' : 'usuario', huella: huella(clave) });
      const seguro = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
      return json(res, 200, { ok: true }, { 'set-cookie': `sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${HORAS_SESION * 3600}${seguro}` });
    }

    // --- todo lo demás exige sesión ---
    const ses = sesionDe(req);
    if (!ses) {
      if (u.pathname.startsWith('/api/')) return json(res, 401, { error: 'Sesión vencida', login: true });
      res.writeHead(302, { location: '/login' }); return res.end();
    }

    if (req.method === 'POST' && u.pathname === '/api/logout') {
      const c = (req.headers.cookie || '').match(/sid=([a-f0-9]+)/); if (c) sesiones.delete(c[1]);
      return json(res, 200, { ok: true }, { 'set-cookie': 'sid=; Path=/; Max-Age=0' });
    }
    if (req.method === 'POST' && u.pathname === '/api/consultar') {
      const { desde, hasta } = await cuerpo(req);
      const ok = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '');
      const h = hasta || desde;
      if (!ok(desde) || !ok(h)) return json(res, 400, { error: 'Fechas inválidas' });
      if (h < desde) return json(res, 400, { error: 'La fecha final es anterior a la inicial' });
      if (desde !== h && ses.rol !== 'admin' && !leerAjustes().permitirRangoUsuarios) return json(res, 403, { error: 'La búsqueda por varios días está reservada al administrador.' });
      if (fechasEntre(desde, h).length > MAX_DIAS) return json(res, 400, { error: `Máximo ${MAX_DIAS} días por consulta` });
      if (!tokenCDS()) return json(res, 400, { error: 'Falta el token de Cruz del Sur. Agrégalo en la rueda de configuración ⚙.' });
      if (enCurso) return json(res, 409, { error: 'Ya hay una consulta en curso', id: enCurso });
      return json(res, 200, { id: nuevoTrabajo(desde, h).id });
    }
    if (req.method === 'POST' && u.pathname === '/api/cancelar') {
      const t = enCurso && trabajos.get(enCurso); if (t) t.cancelar = true;
      return json(res, 200, { ok: !!t });
    }
    if (u.pathname.startsWith('/api/estado/')) {
      const t = trabajos.get(u.pathname.split('/').pop());
      if (!t) return json(res, 404, { error: 'No existe' });
      const { resultado, ...resto } = t;
      return json(res, 200, { ...resto, resultado: t.estado === 'listo' ? resultado : null });
    }
    if (u.pathname === '/api/historial') return json(res, 200, fs.readdirSync(DATA).filter((f) => f.endsWith('.json') && f !== 'ajustes.json').sort().reverse());
    if (u.pathname.startsWith('/api/historial/')) {
      const f = path.basename(decodeURIComponent(u.pathname.split('/').pop()));
      const p = path.join(DATA, f);
      if (f === 'ajustes.json' || !fs.existsSync(p)) return json(res, 404, { error: 'No existe' });
      const r = normalizar(JSON.parse(fs.readFileSync(p, 'utf8'))); r.archivo = f;
      if (u.searchParams.get('descargar')) return json(res, 200, r, { 'content-disposition': `attachment; filename="${f}"` });
      return json(res, 200, r);
    }
    if (u.pathname === '/api/config') return json(res, 200, { maxDias: MAX_DIAS, enCurso, rol: ses.rol, auto: ses.rol === 'admin' ? leerAjustes().auto : undefined, permitirRango: ses.rol === 'admin' || leerAjustes().permitirRangoUsuarios, permitirRangoUsuarios: leerAjustes().permitirRangoUsuarios });

    // --- descarga en Excel ---
    if (u.pathname.startsWith('/api/excel/')) {
      const f = path.basename(decodeURIComponent(u.pathname.split('/').pop()));
      const ruta = path.join(DATA, f);
      if (!f.endsWith('.json') || f === 'ajustes.json' || !fs.existsSync(ruta)) return json(res, 404, { error: 'No existe ese reporte' });
      const rep = normalizar(JSON.parse(fs.readFileSync(ruta, 'utf8')));
      const nombre = f.replace(/\.json$/, '.xlsx');
      const buf = construirExcel(rep);
      res.writeHead(200, { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': `attachment; filename="${nombre}"`, 'content-length': buf.length, 'cache-control': 'no-store' });
      return res.end(buf);
    }

    // --- servicios a consultar (todos los usuarios) ---
    if (u.pathname === '/api/ajustes' && req.method === 'GET') return json(res, 200, leerAjustes());
    if (u.pathname === '/api/ajustes' && req.method === 'POST') {
      const { servicios } = await cuerpo(req);
      const a = leerAjustes();
      for (const emp of ['cds', 'pb']) {
        const nuevo = (servicios && servicios[emp]) || {};
        for (const k of Object.keys(a.servicios[emp])) if (k in nuevo) a.servicios[emp][k] = !!nuevo[k];
      }
      if (!Object.values(a.servicios.cds).some(Boolean)) return json(res, 400, { error: 'Marca al menos un servicio de Cruz del Sur.' });
      guardarAjustes(a);
      return json(res, 200, a);
    }

    // --- solo administrador ---
    const soloAdmin = u.pathname.startsWith('/api/admin/') || u.pathname === '/api/token';
    if (soloAdmin && ses.rol !== 'admin') return json(res, 403, { error: 'Solo el administrador puede hacer esto.' });
    if (u.pathname === '/api/admin/permisos' && req.method === 'POST') {
      const { permitirRangoUsuarios } = await cuerpo(req);
      const a = leerAjustes(); a.permitirRangoUsuarios = !!permitirRangoUsuarios; guardarAjustes(a);
      return json(res, 200, { permitirRangoUsuarios: a.permitirRangoUsuarios });
    }
    if (u.pathname.startsWith('/api/admin/reportes/') && req.method === 'DELETE') {
      const f = path.basename(decodeURIComponent(u.pathname.split('/').pop()));
      const ruta = path.join(DATA, f);
      if (!f.endsWith('.json') || f === 'ajustes.json' || !fs.existsSync(ruta)) return json(res, 404, { error: 'No existe ese reporte' });
      fs.unlinkSync(ruta);
      return json(res, 200, { ok: true });
    }
    if (u.pathname === '/api/admin/auto' && req.method === 'POST') {
      const b = await cuerpo(req); const a = leerAjustes();
      if (b.hora && !/^([01]\d|2[0-3]):[0-5]\d$/.test(b.hora)) return json(res, 400, { error: 'Hora inválida (usa HH:MM).' });
      a.auto.activa = !!b.activa;
      if (b.hora) a.auto.hora = b.hora;
      if (b.desdeDias != null) a.auto.desdeDias = Math.max(0, Math.min(30, Number(b.desdeDias) || 0));
      if (b.cantidadDias != null) a.auto.cantidadDias = Math.max(1, Math.min(MAX_DIAS, Number(b.cantidadDias) || 1));
      guardarAjustes(a);
      return json(res, 200, a.auto);
    }
    if (u.pathname === '/api/admin/claves' && req.method === 'GET') return json(res, 200, { claves: contrasenas() });
    if (u.pathname === '/api/admin/claves' && req.method === 'POST') {
      const { clave } = await cuerpo(req);
      const c = String(clave || '').trim();
      if (c.length < 6) return json(res, 400, { error: 'La contraseña debe tener al menos 6 caracteres.' });
      if (/[,"'\s]/.test(c)) return json(res, 400, { error: 'La contraseña no puede tener comas, comillas ni espacios.' });
      const lista = contrasenas();
      if (lista.includes(c) || c === claveAdmin()) return json(res, 400, { error: 'Esa contraseña ya existe.' });
      guardarEnv('APP_PASSWORDS', [...lista, c].join(','));
      return json(res, 200, { claves: contrasenas() });
    }
    if (u.pathname === '/api/admin/claves' && req.method === 'DELETE') {
      const { clave } = await cuerpo(req);
      const lista = contrasenas();
      if (!lista.includes(clave)) return json(res, 404, { error: 'No existe esa contraseña.' });
      guardarEnv('APP_PASSWORDS', lista.filter((x) => x !== clave).join(','));
      const h = huella(clave); let cerradas = 0;
      for (const [id, s] of sesiones) if (s.huella === h && s.rol !== 'admin') { sesiones.delete(id); cerradas++; }
      return json(res, 200, { claves: contrasenas(), cerradas });
    }

    // --- token de Cruz del Sur ---
    if (u.pathname === '/api/token' && req.method === 'GET') {
      const t = tokenCDS();
      let actualizado = null; try { actualizado = fs.statSync(ENV).mtime; } catch (_) {}
      return json(res, 200, { configurado: !!t, final: t ? t.slice(-4) : null, largo: t.length, actualizado });
    }
    if (u.pathname === '/api/token' && req.method === 'POST') {
      const { token, soloProbar } = await cuerpo(req);
      const nuevo = String(token || '').trim().replace(/^authorization:\s*/i, '');
      const aProbar = nuevo || tokenCDS();
      if (!aProbar) return json(res, 400, { error: 'Pega un token primero.' });
      if (enCurso && !soloProbar) return json(res, 409, { error: 'Espera a que termine la consulta en curso para cambiar el token.' });
      let prueba;
      try { prueba = await probarToken(aProbar); } catch (e) { return json(res, 400, { error: `El token no funcionó: ${e.message}` }); }
      if (!soloProbar && nuevo) guardarEnv('CDS_TOKEN', nuevo);
      return json(res, 200, { ok: true, detalle: prueba.detalle, guardado: !soloProbar && !!nuevo });
    }

    const rel = u.pathname === '/' ? 'index.html' : path.normalize(u.pathname.slice(1)).replace(/^(\.\.[/\\])+/, '');
    return archivo(res, rel);
  } catch (e) { json(res, 500, { error: String(e.message || e) }); }
}).listen(PUERTO, HOST, () => {
  console.log(`\nMonitor de buses: http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PUERTO}`);
  if (!claveAdmin()) console.log('AVISO: falta ADMIN_PASSWORD en .env. Sin ella no se pueden administrar contraseñas ni el token desde la página.');
  if (!contrasenas().length && !claveAdmin()) console.log('AVISO: no hay contraseñas en .env. Nadie podrá entrar hasta agregarlas.');
  if (!tokenCDS()) console.log('AVISO: falta el token de Cruz del Sur (CDS_TOKEN). Se puede agregar desde la rueda ⚙ de la página.');
  console.log('');
}).on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`\nEl puerto ${PUERTO} ya está en uso. Cierra el otro programa o usa otro puerto: PORT=3001 npm start\n`); process.exit(1); }
  throw e;
});
