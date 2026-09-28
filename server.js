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
const { probarToken } = require('./scrapers/cruzdelsur');
const { construirExcel } = require('./lib/reporteExcel');
const { crearMonitor, MONITOR_INICIAL, REPORTE_AUTO_INICIAL } = require('./lib/monitor');

// Últimas líneas de la consola, para el panel "Ver logs" del admin. Solo en memoria y con tope fijo.
const LOGS = []; const MAX_LOGS = 200; let nLog = 0;
for (const nivel of ['log', 'warn', 'error']) {
  const original = console[nivel].bind(console);
  console[nivel] = (...args) => {
    original(...args);
    try {
      const txt = args.map((x) => (typeof x === 'string' ? x : x instanceof Error ? (x.stack || x.message) : JSON.stringify(x))).join(' ');
      for (const l of txt.split('\n')) if (l.trim()) LOGS.push({ i: ++nLog, t: Date.now(), n: nivel, l: l.slice(0, 500) });
      if (LOGS.length > MAX_LOGS) LOGS.splice(0, LOGS.length - MAX_LOGS);
    } catch (_) { /* nunca romper por un log */ }
  };
}

const RAIZ = __dirname;
const config = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.json'), 'utf8'));
const DATA = path.join(RAIZ, 'data');
const ENV = path.join(RAIZ, '.env');
fs.mkdirSync(DATA, { recursive: true });
const PUERTO = Number(process.env.PORT || config.puerto || 3000);
const HOST = process.env.HOST || config.host || '127.0.0.1';
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
  // Monitoreo diario. El periodo (desde/hasta) se hereda de la antigua consulta automática.
  a.monitor = { ...MONITOR_INICIAL, vigDesde: (a.auto && a.auto.vigDesde) || null, vigHasta: (a.auto && a.auto.vigHasta) || null, ...(a.monitor || {}) };
  if (typeof a.monitor.perpetuo !== 'boolean') a.monitor.perpetuo = !a.monitor.vigDesde && !a.monitor.vigHasta;
  a.reporteAuto = { ...REPORTE_AUTO_INICIAL, ...(a.reporteAuto || {}) };
  delete a.auto;
  delete a.permitirRangoUsuarios; // la búsqueda por rango de fechas ya no existe: todo es del día de hoy
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

// ---------------- monitoreo por día (ver lib/monitor.js) ----------------
const monitor = crearMonitor({ config, DATA, leerAjustes, guardarAjustes, registrarServicios, tokenCDS });
const hoyLima = () => new Date(Date.now() - 5 * 36e5).toISOString().slice(0, 10);

// Reportes del formato anterior (una sola consulta): siguen visibles en la grilla.
function normalizar(r) {
  if (r.tipo === 'dia') return monitor.comoReporte(r);
  const n = r.dias ? r : { desde: r.fecha, hasta: r.fecha, generado: r.generado, dias: [{ fecha: r.fecha, rutas: r.rutas }] };
  // Reportes antiguos de Peru Bus: completar el tipo de asiento vendido (= servicio del bus).
  n.dias.forEach((d) => d.rutas.forEach((ru) => (ru.pb.salidas || []).forEach((x) => {
    if (!x.porTarifa && x.vendidos != null) { x.porTarifa = { [`${x.servicio || 'Asiento'} S/ ${x.precio ?? '?'}`]: x.vendidos }; if (x.precio) x.ingresoEstimado = x.vendidos * x.precio; }
  })));
  return n;
}

// Resumen de cada reporte guardado para la grilla "Reportes guardados".
// Se guarda en memoria y se recalcula solo si el archivo cambió.
const cacheMeta = new Map();
function metaReporte(f) {
  const p = path.join(DATA, f);
  const mtime = fs.statSync(p).mtimeMs;
  const c = cacheMeta.get(f);
  if (c && c.mtime === mtime) return c.meta;
  const origen = f.startsWith('auto_') ? 'auto' : 'manual';
  let meta;
  try {
    const r = normalizar(JSON.parse(fs.readFileSync(p, 'utf8')));
    const vendidos = { cds: 0, pb: 0 }; let sinDato = 0;
    r.dias.forEach((d) => d.rutas.forEach((ru) => ['cds', 'pb'].forEach((k) => (ru[k].salidas || []).forEach((s) => {
      if (s.duplicadoDe) return;
      if (s.vendidos == null) { if (k === 'cds') sinDato++; return; }
      vendidos[k] += s.vendidos;
    }))));
    const norm = (x) => (Array.isArray(x) ? { incluidos: x, excluidos: [] } : x || null);
    meta = { tipo: 'reporte', archivo: f, origen, rol: r.rol || null, desde: r.desde, hasta: r.hasta, dias: r.dias.length, generado: r.generado,
      servicios: r.servicios ? { cds: norm(r.servicios.cds), pb: norm(r.servicios.pb) } : null, vendidos, sinDato };
  } catch (e) { meta = { tipo: 'reporte', archivo: f, origen, error: 'No se pudo leer el archivo' }; }
  cacheMeta.set(f, { mtime, meta });
  return meta;
}

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
    // --- monitoreo por día ---
    const fechaOk = (f) => /^\d{4}-\d{2}-\d{2}$/.test(f || '');
    if (req.method === 'POST' && u.pathname === '/api/dias/iniciar') {
      const { fecha } = await cuerpo(req);
      if (!fechaOk(fecha)) return json(res, 400, { error: 'Fecha inválida' });
      if (fecha !== hoyLima()) return json(res, 400, { error: 'Solo se puede monitorear el día de hoy.' });
      if (monitor.existe(fecha)) return json(res, 200, { existe: true, ...monitor.estadoDia(fecha) });
      if (!tokenCDS()) return json(res, 400, { error: 'Falta el token de Cruz del Sur. Agrégalo en la rueda de configuración ⚙.' });
      return json(res, 200, { id: monitor.iniciarDia(fecha, 'manual', ses.rol).id });
    }
    if (req.method === 'POST' && u.pathname === '/api/dias/actualizar') {
      const { fecha, ids, hora, ruta, desdeAhora } = await cuerpo(req);
      if (!fechaOk(fecha)) return json(res, 400, { error: 'Fecha inválida' });
      const que = Array.isArray(ids) ? { ids: ids.map(String) } : /^\d{2}:\d{2}$/.test(hora || '') ? { hora, ruta } : desdeAhora ? { desdeAhora: true, ruta } : null;
      if (!que) return json(res, 400, { error: 'Indica qué actualizar.' });
      try { return json(res, 200, monitor.actualizarAhora(fecha, que, ses.rol)); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    // --- reporte al instante (pestaña /reportes): una foto del día de hoy ---
    if (req.method === 'POST' && u.pathname === '/api/consultar') {
      const hoy = hoyLima(); const b = await cuerpo(req);
      // Cada usuario puede elegir los servicios de su reporte (sin tocar la configuración global).
      let sel = null;
      if (b.servicios) {
        const lista = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean).slice(0, 50) : []);
        sel = { cds: lista(b.servicios.cds), pb: lista(b.servicios.pb) };
        if (!sel.cds.length && !sel.pb.length) return json(res, 400, { error: 'Elige al menos un servicio para el reporte.' });
      }
      if ((!sel || sel.cds.length) && !tokenCDS()) return json(res, 400, { error: 'Falta el token de Cruz del Sur. Agrégalo en la rueda de configuración ⚙.' });
      return json(res, 200, { id: monitor.generarReporte(hoy, hoy, ses.rol, 'manual', null, sel).id });
    }
    if (u.pathname === '/api/cola') return json(res, 200, monitor.estadoCola());
    if (req.method === 'POST' && u.pathname === '/api/cancelar') {
      if (ses.rol !== 'admin') return json(res, 403, { error: 'Solo el administrador puede cancelar o detener actualizaciones.' });
      const { carril } = await cuerpo(req);
      return json(res, 200, { ok: monitor.cancelar(carril === 'reporte' ? 'reporte' : 'monitor') });
    }
    if (u.pathname.startsWith('/api/estado/')) {
      const t = monitor.trabajo(u.pathname.split('/').pop());
      if (!t) return json(res, 404, { error: 'No existe' });
      return json(res, 200, t);
    }
    if (u.pathname === '/api/historial') {
      const tipo = u.searchParams.get('tipo'); // 'dia' | 'reporte' | (vacío = todos)
      const reportes = tipo === 'dia' ? [] : fs.readdirSync(DATA).filter((f) => f.endsWith('.json') && f !== 'ajustes.json' && !f.startsWith('dia_')).map(metaReporte);
      const lista = [...(tipo === 'reporte' ? [] : monitor.metaDias()), ...reportes];
      return json(res, 200, lista.sort((a, b) => String(b.desde || '').localeCompare(String(a.desde || '')) || String(b.generado || '').localeCompare(String(a.generado || ''))));
    }
    if (u.pathname.startsWith('/api/dias/')) {
      const f = u.pathname.split('/').pop();
      const d = fechaOk(f) && monitor.leerDia(f);
      return d ? json(res, 200, d) : json(res, 404, { error: 'Ese día no está siendo monitoreado.' });
    }
    if (u.pathname.startsWith('/api/historial/')) {
      const f = path.basename(decodeURIComponent(u.pathname.split('/').pop()));
      const p = path.join(DATA, f);
      if (f === 'ajustes.json' || !fs.existsSync(p)) return json(res, 404, { error: 'No existe' });
      const r = normalizar(JSON.parse(fs.readFileSync(p, 'utf8'))); r.archivo = f;
      if (u.searchParams.get('descargar')) {
        if (ses.rol !== 'admin') return json(res, 403, { error: 'Solo el administrador puede descargar el JSON.' });
        return json(res, 200, r, { 'content-disposition': `attachment; filename="${f}"` });
      }
      return json(res, 200, r);
    }
    if (u.pathname === '/api/config') {
      const M = leerAjustes().monitor;
      return json(res, 200, { hoy: hoyLima(), enCurso: { monitor: monitor.trabajoActivo('monitor'), reporte: monitor.trabajoActivo('reporte') }, rol: ses.rol,
        monitor: ses.rol === 'admin' ? M : { activa: M.activa, perpetuo: M.perpetuo, actualizarSalidas: M.actualizarSalidas, hora: M.hora, minutosAntes: M.minutosAntes, vigDesde: M.vigDesde, vigHasta: M.vigHasta },
        reporteAuto: (({ hechas, ...R }) => R)(leerAjustes().reporteAuto) });
    }

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
      if (ses.rol !== 'admin') return json(res, 403, { error: 'Solo el administrador puede cambiar los servicios a consultar.' });
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
    if (u.pathname.startsWith('/api/admin/reportes/') && req.method === 'DELETE') {
      const f = path.basename(decodeURIComponent(u.pathname.split('/').pop()));
      const ruta = path.join(DATA, f);
      if (!f.endsWith('.json') || f === 'ajustes.json' || !fs.existsSync(ruta)) return json(res, 404, { error: 'No existe ese reporte' });
      const dia = f.match(/^dia_(\d{4}-\d{2}-\d{2})\.json$/);
      if (dia) monitor.borrar(dia[1]); else fs.unlinkSync(ruta); // inmediato, aunque se esté actualizando
      return json(res, 200, { ok: true });
    }
    // Cambio de servicios aplicado también al día en curso (simular = solo mostrar qué pasaría).
    if (u.pathname === '/api/admin/dias/servicios' && req.method === 'POST') {
      const { fecha, simular } = await cuerpo(req);
      if (!fechaOk(fecha)) return json(res, 400, { error: 'Fecha inválida' });
      try { return json(res, 200, simular ? monitor.simularServicios(fecha) : monitor.aplicarServicios(fecha, ses.rol)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if ((u.pathname === '/api/admin/dias/detener' || u.pathname === '/api/admin/dias/reanudar') && req.method === 'POST') {
      const { fecha } = await cuerpo(req);
      if (!fechaOk(fecha)) return json(res, 400, { error: 'Fecha inválida' });
      try { (u.pathname.endsWith('detener') ? monitor.detener : monitor.reanudar)(fecha, ses.rol); return json(res, 200, monitor.estadoDia(fecha)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    // Crons: cambios parciales (solo se tocan los campos enviados).
    if ((u.pathname === '/api/admin/monitor' || u.pathname === '/api/admin/reporte-auto') && req.method === 'POST') {
      const b = await cuerpo(req); const a = leerAjustes();
      const esMon = u.pathname.endsWith('monitor'); const C = esMon ? a.monitor : a.reporteAuto;
      const horaOk = (h) => /^([01]\d|2[0-3]):[0-5]\d$/.test(h || '');
      if ('activa' in b) C.activa = !!b.activa;
      if ('perpetuo' in b) C.perpetuo = !!b.perpetuo;
      for (const k of ['vigDesde', 'vigHasta']) if (k in b) { if (b[k] && !fechaOk(b[k])) return json(res, 400, { error: 'Fechas inválidas.' }); C[k] = b[k] || null; }
      if (!C.perpetuo && !C.vigDesde && !C.vigHasta) return json(res, 400, { error: 'Indica desde y/o hasta, o elige “Perpetuo”.' });
      if (!C.perpetuo && C.vigDesde && C.vigHasta && C.vigHasta < C.vigDesde) return json(res, 400, { error: 'La fecha "hasta" es anterior a "desde".' });
      if (esMon) {
        if ('hora' in b) { if (!horaOk(b.hora)) return json(res, 400, { error: 'Hora inválida (usa HH:MM).' }); C.hora = b.hora; }
        if ('actualizarSalidas' in b) C.actualizarSalidas = !!b.actualizarSalidas;
        if ('minutosAntes' in b) {
          const mins = String(b.minutosAntes ?? '').split(/[,;\s]+/).filter(Boolean).map(Number);
          if (!mins.length || mins.some((x) => !Number.isInteger(x) || x < 1 || x > 600)) return json(res, 400, { error: 'Minutos antes: números enteros entre 1 y 600, separados por coma (ej. 30,20,10).' });
          C.minutosAntes = [...new Set(mins)].sort((x, y) => y - x);
        }
        if ('reintentos' in b) C.reintentos = Math.max(1, Math.min(10, Number(b.reintentos) || 3));
        if ('esperaReintentoSeg' in b) C.esperaReintentoSeg = Math.max(10, Math.min(600, Number(b.esperaReintentoSeg) || 60));
      } else if ('horas' in b) {
        const hs = [...new Set(String(b.horas || '').split(/[,;\s]+/).filter(Boolean))].sort();
        if (!hs.length || !hs.every(horaOk)) return json(res, 400, { error: 'Horas inválidas: usa HH:MM separadas por coma (ej. 08:00, 14:00, 20:00).' });
        C.horas = hs;
      }
      guardarAjustes(a);
      const { hechas, ...salida } = C;
      return json(res, 200, esMon ? C : salida);
    }
    if (u.pathname === '/api/admin/logs') return json(res, 200, { lineas: LOGS, max: MAX_LOGS });
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
      if (monitor.ocupado() && !soloProbar) return json(res, 409, { error: 'Espera a que termine la consulta en curso para cambiar el token.' });
      let prueba;
      try { prueba = await probarToken(aProbar); } catch (e) { return json(res, 400, { error: `El token no funcionó: ${e.message}` }); }
      if (!soloProbar && nuevo) guardarEnv('CDS_TOKEN', nuevo);
      return json(res, 200, { ok: true, detalle: prueba.detalle, guardado: !soloProbar && !!nuevo });
    }

    const rel = u.pathname === '/' || u.pathname === '/reportes' ? 'index.html' : path.normalize(u.pathname.slice(1)).replace(/^(\.\.[/\\])+/, '');
    return archivo(res, rel);
  } catch (e) { console.error(`Error en ${req.method} ${u.pathname}:`, e); json(res, 500, { error: String(e.message || e) }); }
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
