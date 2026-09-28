// Cruz del Sur (plataforma Reservamos) — solo consultas HTTP, sin navegador.
//
// Flujo (el mismo que hace la web):
//   1) POST /api/v2/search                      -> crea la búsqueda y devuelve search.id
//   2) GET  /api/v2/search/{id}?type=bus        -> se repite hasta state = "finished"; trae los viajes
//   3) POST /api/v2/trips/{tripId}/details_requests  {"with_pricing":true,"include":["bus"]}
//      GET  {poll_to}                           -> hasta "finished"; trae el mapa de asientos
// Vendidos = asientos con occupied (o sold) = true, en todos los pisos y tarifas.
//
// Para hacer pocas consultas (Cruz del Sur responde HTTP 429 si se le pregunta mucho):
//  • Solo se leen los servicios marcados en la configuración (Evolution, Suite, …).
//  • Un mismo bus aparece varias veces (Javier Prado + Atocongo, Ica + Hotel Las Dunas).
//    El id del viaje trae un código de servicio que es igual para todas esas apariciones:
//    se lee el mapa UNA sola vez por bus y se copia a las demás, sin consultar de nuevo.
//  • Se espera un poco antes de preguntar si el mapa ya está listo (menos sondeos).
//  • Ritmo fijo y parejo; si llega un 429 se hace una sola pausa (no una por cada consulta
//    que estaba en camino) y se sigue apenas un poco más despacio.

const API = 'https://one-api.cruzdelsur.com.pe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hhmm = (iso) => (iso ? iso.slice(11, 16) : '');
const minutos = (h) => { const [a, b] = h.split(':').map(Number); return a * 60 + b; };

// Código del bus dentro del id: lim076_ica019_27sep262015_<CODIGO>_3_pe
function codigoBus(id) {
  const p = String(id).split('_');
  return p.length >= 6 ? `${p[3]}_${p[4]}` : String(id);
}

class Ritmo {
  constructor(espacioMs, log) {
    this.base = espacioMs; this.espacio = espacioMs; this.log = log;
    this.proximo = 0; this.pausaHasta = 0; this.oks = 0; this.cadena = Promise.resolve();
  }
  turno() {
    const t = this.cadena.then(async () => {
      const espera = Math.max(this.proximo, this.pausaHasta) - Date.now();
      if (espera > 0) await sleep(espera);
      this.proximo = Date.now() + this.espacio;
    });
    this.cadena = t.catch(() => {});
    return t;
  }
  limite(ms) {
    if (Date.now() < this.pausaHasta) return; // ya estamos en pausa por un 429 anterior
    this.pausaHasta = Date.now() + ms;
    this.espacio = Math.min(Math.round(this.espacio * 1.25), this.base * 2.5);
    this.oks = 0;
    this.log(`Cruz del Sur pidió una pausa (HTTP 429): espero ${Math.round(ms / 1000)} s y sigo a 1 consulta cada ${(this.espacio / 1000).toFixed(1)} s.`);
  }
  ok() { if (++this.oks >= 15 && this.espacio > this.base) { this.espacio = Math.max(this.base, Math.round(this.espacio * 0.85)); this.oks = 0; } }
}

function cabeceras(token) {
  return {
    accept: 'application/json', 'content-type': 'application/json', 'accept-language': 'es-PE',
    authorization: token.startsWith('Token') ? token : `Token token=${token}`,
    origin: 'https://viajes.cruzdelsur.com.pe', referer: 'https://viajes.cruzdelsur.com.pe/',
  };
}

function crearPedir(ritmo, pausa429Ms) {
  return async function pedir(url, opciones, intentos = 5) {
    for (let i = 1; ; i++) {
      await ritmo.turno();
      let r;
      try { r = await fetch(url, { ...opciones, signal: AbortSignal.timeout(30000) }); }
      catch (e) { if (i >= intentos) throw e; await sleep(2000 * i); continue; }
      if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`Cruz del Sur rechazó el token (HTTP ${r.status}). Actualízalo en ⚙ Configuración.`), { fatal: true });
      if (r.status === 429) {
        const ra = Number(r.headers.get('retry-after'));
        ritmo.limite(Number.isFinite(ra) && ra > 0 ? ra * 1000 : pausa429Ms);
        if (i >= intentos) throw new Error('HTTP 429 (demasiadas consultas)');
        continue;
      }
      if (!r.ok) { if (i >= intentos) throw new Error(`HTTP ${r.status}`); await sleep(2000 * i); continue; }
      ritmo.ok();
      return r.json();
    }
  };
}

async function buscarViajes(pedir, origen, destino, fecha, h) {
  const [y, m, d] = fecha.split('-');
  const inicio = await pedir(`${API}/api/v2/search`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ origin: origen, destination: destino, date: `${d}-${m}-${y}`, passengers: ['adult'], way: 'departure', round: false }),
  });
  const id = inicio && inicio.search && inicio.search.id;
  if (!id) throw new Error('La búsqueda de Cruz del Sur no devolvió un id.');
  await sleep(1500);
  for (let i = 0; i < 30; i++) {
    const r = await pedir(`${API}/api/v2/search/${id}?type=bus`, { headers: h });
    if (r.state === 'finished') return r;
    await sleep(2000);
  }
  throw new Error('La búsqueda de Cruz del Sur no terminó a tiempo.');
}

async function mapaAsientos(pedir, tripId, h, intentos) {
  let d = await pedir(`${API}/api/v2/trips/${tripId}/details_requests`, {
    method: 'POST', headers: h, body: JSON.stringify({ with_pricing: true, include: ['bus'] }),
  }, intentos);
  if (d.state !== 'finished') await sleep(1500); // casi siempre ya está listo después de esto
  for (let i = 0; i < 20 && d.state !== 'finished' && d.poll_to; i++) {
    d = await pedir(API + d.poll_to, { headers: h });
    if (d.state !== 'finished') await sleep(1200);
  }
  if (d.state !== 'finished' || !Array.isArray(d.bus)) throw new Error('sin mapa de asientos');
  const ocupados = []; const porTarifa = {}; const porPiso = {}; let libres = 0;
  d.bus.forEach((piso, iPiso) => piso.forEach((fila) => fila.forEach((c) => {
    if (c.category !== 'seat') return;
    const nPiso = c.seat_floor || String(iPiso + 1);
    if (c.occupied || c.sold) {
      ocupados.push(`${nPiso}-${c.number}`);
      const tarifa = `${c.seat_fare_description || 'Asiento'} S/ ${c.price ?? '?'}`;
      porTarifa[tarifa] = (porTarifa[tarifa] || 0) + 1;
      porPiso[`Piso ${nPiso}`] = (porPiso[`Piso ${nPiso}`] || 0) + 1;
    } else libres++;
  })));
  const ingreso = Object.entries(porTarifa).reduce((a, [k, n]) => a + (Number(k.split('S/ ')[1]) || 0) * n, 0);
  return { vendidos: ocupados.length, libres, porTarifa, porPiso, ingreso };
}

// servicioPermitido(nombre) -> true/false (según ⚙ Configuración)
// alDescubrir(nombres)      -> avisa qué servicios existen, para mostrarlos en la configuración
async function scrapeCruzDelSur({ origen, destino, fecha, config, token, log, avance, servicioPermitido = () => true, alDescubrir = () => {} }) {
  if (!token) throw Object.assign(new Error('Falta el token de Cruz del Sur. Agrégalo en ⚙ Configuración.'), { fatal: true });
  const cfg = config.cruzDelSur || {};
  const h = cabeceras(token);
  const ritmo = new Ritmo(cfg.espacioEntreConsultasMs || 1000, log);
  const pedir = crearPedir(ritmo, cfg.pausaAnte429Ms || 15000);

  log(`Cruz del Sur ${origen}→${destino} ${fecha}: buscando viajes…`);
  const busqueda = await buscarViajes(pedir, origen, destino, fecha, h);
  const lineas = busqueda.lines || {};
  const terminales = busqueda.terminals || {};
  const nombreLinea = (id) => (lineas[id] && lineas[id].name) || id;
  const delDia = (busqueda.trips || []).filter((t) => (t.departure || '').startsWith(fecha));
  alDescubrir([...new Set(delDia.map((t) => nombreLinea(t.line_id)))]);
  const viajes = delDia.filter((t) => servicioPermitido(nombreLinea(t.line_id)));

  // Agrupar por bus: se consulta solo el primero de cada grupo.
  const grupos = new Map();
  viajes.sort((a, b) => a.departure.localeCompare(b.departure)).forEach((t) => {
    const k = codigoBus(t.id);
    if (!grupos.has(k)) grupos.set(k, []);
    grupos.get(k).push(t);
  });
  const omitidos = delDia.length - viajes.length;
  log(`Cruz del Sur ${origen}→${destino} ${fecha}: ${viajes.length} salidas${omitidos ? ` (${omitidos} omitidas por servicio no marcado)` : ''}, ${grupos.size} buses distintos por leer.`);

  const base = (t) => ({
    hora: hhmm(t.departure), llegada: hhmm(t.arrival), servicio: nombreLinea(t.line_id),
    origen: (terminales[t.origin_id] && terminales[t.origin_id].name) || t.origin_id,
    destino: (terminales[t.destination_id] && terminales[t.destination_id].name) || t.destination_id,
    escalas: t.stops || 0, precio: t.pricing ? t.pricing.total : null, duplicadoDe: null, nota: '',
    tripId: t.id, bus: codigoBus(t.id), // para volver a leer solo este bus más tarde
  });
  const llenar = (t, m) => ({ ...base(t), capacidad: m.vendidos + m.libres, libres: m.libres, vendidos: m.vendidos,
    porTarifa: m.porTarifa, porPiso: m.porPiso, ingresoEstimado: m.ingreso });

  const lista = [...grupos.values()];
  const mapas = new Array(lista.length);
  const fallidos = [];
  let hechos = 0;
  avance(0, lista.length);
  const conc = Math.max(1, cfg.consultasSimultaneas || 1);
  let idx = 0;
  async function trabajador() {
    while (idx < lista.length) {
      const i = idx++;
      try { mapas[i] = await mapaAsientos(pedir, lista[i][0].id, h); }
      catch (e) { if (e.fatal) throw e; fallidos.push(i); }
      avance(++hechos, lista.length);
    }
  }
  await Promise.all(Array.from({ length: conc }, trabajador));

  if (fallidos.length) {
    log(`Cruz del Sur: ${fallidos.length} buses sin leer; un reintento más…`);
    await sleep(cfg.esperaReintentoMs || 10000);
    for (const i of fallidos) {
      try { mapas[i] = await mapaAsientos(pedir, lista[i][0].id, h); } catch (e) { if (e.fatal) throw e; }
    }
  }

  const salidas = [];
  lista.forEach((grupo, i) => {
    const m = mapas[i];
    grupo.forEach((t, j) => {
      let s;
      if (m) s = llenar(t, m);
      else s = { ...base(t), capacidad: null, libres: null, vendidos: null, sinDato: true, nota: 'Sin dato: Cruz del Sur no entregó el mapa de asientos. No se suma.' };
      if (j > 0) {
        const p = grupo[0];
        s.duplicadoDe = `${hhmm(p.departure)} ${base(p).origen}`;
        s.nota = `Mismo bus que la salida de ${hhmm(p.departure)} (${base(p).origen} → ${base(p).destino}); no se suma otra vez.`;
      }
      salidas.push(s);
    });
  });
  const faltan = lista.length - mapas.filter(Boolean).length;
  if (faltan) log(`Cruz del Sur: ${faltan} buses quedaron sin dato.`);
  return salidas.sort((a, b) => minutos(a.hora) - minutos(b.hora));
}

// Vuelve a leer solo algunos buses (actualización de salidas puntuales).
// viajes: [{ tripId, hora, servicio }] -> [{ ok, m } | { ok: false, error }] en el mismo orden.
// Si el id guardado ya no sirve, busca el viaje de nuevo (mismo bus, o misma hora y servicio).
async function leerBuses({ origen, destino, fecha, config, token, log, viajes, alLeer = () => {} }) {
  if (!token) throw Object.assign(new Error('Falta el token de Cruz del Sur.'), { fatal: true });
  const cfg = config.cruzDelSur || {};
  const h = cabeceras(token);
  const pedir = crearPedir(new Ritmo(cfg.espacioEntreConsultasMs || 1000, log), cfg.pausaAnte429Ms || 15000);
  let busqueda = null;
  const out = [];
  for (let i = 0; i < viajes.length; i++) {
    const v = viajes[i];
    let m = null; let error = null;
    try { m = await mapaAsientos(pedir, v.tripId, h, 2); } catch (e) { if (e.fatal) throw e; error = e; }
    if (!m) {
      try {
        if (!busqueda) busqueda = await buscarViajes(pedir, origen, destino, fecha, h);
        const lineas = busqueda.lines || {};
        const trips = busqueda.trips || [];
        const t = trips.find((x) => codigoBus(x.id) === codigoBus(v.tripId))
          || trips.find((x) => hhmm(x.departure) === v.hora && ((lineas[x.line_id] || {}).name || x.line_id) === v.servicio);
        if (!t) throw Object.assign(new Error('La salida ya no aparece en la web de Cruz del Sur (cerrada o ya partió).'), { definitivo: true });
        m = await mapaAsientos(pedir, t.id, h);
      } catch (e) { if (e.fatal) throw e; error = e; }
    }
    out.push(m ? { ok: true, m } : { ok: false, error: String((error && error.message) || error), definitivo: !!(error && error.definitivo) });
    alLeer(i);
  }
  return out;
}

// Prueba del token: una búsqueda y un mapa de asientos (esa parte exige token).
async function probarToken(token) {
  const ritmo = new Ritmo(400, () => {});
  const pedir = crearPedir(ritmo, 5000);
  const h = cabeceras(token);
  const manana = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
  const b = await buscarViajes(pedir, 'lima', 'ica', manana, h);
  const t = (b.trips || [])[0];
  if (!t) return { ok: true, detalle: 'Búsqueda correcta (sin salidas para probar asientos).' };
  const m = await mapaAsientos(pedir, t.id, h);
  return { ok: true, detalle: `Token válido: se leyó el mapa de asientos de prueba (${m.vendidos + m.libres} asientos).` };
}

module.exports = { scrapeCruzDelSur, leerBuses, probarToken, codigoBus };
