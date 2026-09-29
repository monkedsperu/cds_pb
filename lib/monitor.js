// Monitoreo por día de viaje.
//
// Cada día (a las 03:00 hora de Lima, configurable) se crea el "día monitoreado":
//   1) Recorrido inicial: todas las salidas de todas las rutas, de ambas empresas.
//   2) Como ya se conocen las horas de salida, N minutos antes de cada una (p. ej. 30, 20 y 10)
//      se vuelve a leer SOLO esa salida, con reintentos si falla.
//   3) Además se puede actualizar al instante un horario, una salida o todas desde ahora.
//   4) Días siguientes: al iniciar cada día se hace también el recorrido inicial de los N días
//      siguientes (3 por defecto). Mientras no les llegue su día reciben una "actualización total"
//      (se releen todas sus salidas, incluidas las nuevas) cada 3 a 5 h; el día de hoy, cada 4 a 5 h.
//      Esas tareas son "de fondo": desde el mínimo esperan un hueco sin lecturas programadas
//      cercanas y, si no aparece, se hacen igual al llegar al máximo. Al llegar su día siguen el plan normal.
// Todo pasa por una sola cola, así nunca hay dos consultas a la vez contra las webs.
// Cada día se guarda en data/dia_AAAA-MM-DD.json junto con el registro de sus actualizaciones.
const fs = require('fs');
const path = require('path');
const { scrapeCruzDelSur, leerBuses } = require('../scrapers/cruzdelsur');

const tSalida = (fecha, hora) => Date.parse(`${fecha}T${hora}:00-05:00`); // Perú no usa horario de verano
const limaAhora = () => { const d = new Date(Date.now() - 5 * 36e5).toISOString(); return { fecha: d.slice(0, 10), hm: d.slice(11, 16) }; };
const sumarDias = (f, n) => { const d = new Date(`${f}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const EMP = { cds: 'Cruz del Sur', pb: 'Peru Bus' };
// Vigencia del monitoreo (tiempo de vida del job): fuera de estas fechas no se inicia ni se muestrea nada automáticamente.
// Cada cron (monitoreo diario y reporte al instante) tiene la suya: perpetuo, o entre dos fechas.
const enVigencia = (C, fecha) => !!C.perpetuo || ((!C.vigDesde || fecha >= C.vigDesde) && (!C.vigHasta || fecha <= C.vigHasta));

const limaFecha = (iso) => new Date(Date.parse(iso) - 5 * 36e5).toISOString().slice(0, 10);
// Tareas de fondo: margen libre que necesitan antes de la próxima lectura programada, y espera máxima.
const HUECO_FONDO_MS = 10 * 60000;
const ESPERA_MAX_FONDO_MS = 60 * 60000;

// diasFuturo = hasta cuántos días adelante se puede pedir un reporte al instante.
const REPORTE_AUTO_INICIAL = { activa: false, horas: ['08:00'], perpetuo: true, vigDesde: null, vigHasta: null, hechas: null, ultimoResultado: null, diasFuturo: 7 };
// diasAdelante = días siguientes que se monitorean por adelantado. Actualización total de esos días
// y de hoy: entre refresco*Horas (mínimo, desde ahí se busca un buen momento) y refresco*MaxHoras
// (máximo, se hace sí o sí). refresco*Horas = 0 la apaga.
// minutosAntes = lecturas de Cruz del Sur (y de Peru Bus si minutosAntesPb es null). cierreMin = cuántos minutos
// antes de salir cierra cada empresa la venta online: desde ahí no se programa ninguna lectura (ya no hay datos).
const MONITOR_INICIAL = { activa: false, perpetuo: true, actualizarSalidas: true, hora: '03:00', minutosAntes: [180, 120, 70, 40], minutosAntesPb: null, cierreMin: { cds: 30, pb: 30 }, reintentos: 3, esperaReintentoSeg: 60,
  diasAdelante: 3, refrescoFuturoHoras: 3, refrescoFuturoMaxHoras: 5, refrescoHoyHoras: 4, refrescoHoyMaxHoras: 5, vigDesde: null, vigHasta: null, ultima: null, adelante: null, ultimoResultado: null };

// Minutos antes de cada salida en que se lee, según la empresa, sin los que caen después del cierre de la venta.
function ventanasDe(M, emp) {
  const base = emp === 'pb' && Array.isArray(M.minutosAntesPb) && M.minutosAntesPb.length ? M.minutosAntesPb : M.minutosAntes || [];
  const cierre = Number((M.cierreMin || {})[emp]) || 0;
  return [...new Set(base)].filter((m) => m > cierre).sort((a, b) => b - a);
}

function crearMonitor({ config, DATA, leerAjustes, guardarAjustes, registrarServicios, tokenCDS }) {
  const jornadas = new Map(); // fecha -> día monitoreado (en memoria)
  const trabajos = new Map(); // id -> progreso visible en la página (recorrido inicial / actualizar todas)
  const cola = [];
  // Dos carriles que corren en paralelo: "monitor" (recorrido inicial, actualizaciones, agregar servicios)
  // y "reporte" (reporte al instante). Comparten el ritmo de Cruz del Sur, así que no se duplican las consultas.
  const actuales = { monitor: null, reporte: null };
  const carrilDe = (x) => (x.tipo === 'reporte' ? 'reporte' : 'monitor');

  const archivoDe = (fecha) => path.join(DATA, `dia_${fecha}.json`);
  const todas = (j) => j.rutas.flatMap((r) => ['cds', 'pb'].flatMap((emp) => r[emp].salidas.map((s) => ({ r, emp, s }))));
  const buscar = (j, id) => todas(j).find((x) => x.s.id === id);
  const ajustesMonitor = () => leerAjustes().monitor;
  // Configuración con las capacidades de Peru Bus corregidas desde la página (⚙ → Servicios).
  const cfgPb = () => { const pb = config.peruBus || {}; return { ...config, peruBus: { ...pb, capacidad: { ...(pb.capacidad || {}), ...(leerAjustes().capacidadPb || {}) } } }; };
  // Una salida deja de consultarse cuando ya partió o cuando ya no aparece en la web (cerrada).
  const viva = (fecha, s) => !s.cerrada && tSalida(fecha, s.hora) > Date.now();
  const cerrado = (j) => j.completado || j.detenido;
  const borrados = new WeakSet(); // días eliminados: lo que aún esté corriendo no los vuelve a escribir

  function cargar(fecha) {
    if (jornadas.has(fecha)) return jornadas.get(fecha);
    const p = archivoDe(fecha);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Lo que quedó "en cola" antes de un reinicio se vuelve a programar.
    todas(j).forEach(({ s }) => { for (const k in s.prog || {}) if (s.prog[k] === 'encolada') delete s.prog[k]; });
    jornadas.set(fecha, j);
    return j;
  }
  function guardar(j) {
    if (borrados.has(j)) return;
    j.version = (j.version || 0) + 1; j.actualizado = new Date().toISOString();
    fs.writeFileSync(archivoDe(j.fecha), JSON.stringify(j));
  }
  const fechasGuardadas = () => fs.readdirSync(DATA).map((f) => (f.match(/^dia_(\d{4}-\d{2}-\d{2})\.json$/) || [])[1]).filter(Boolean).sort();
  // Saca de la cola todo lo de un día y corta lo que esté corriendo para ese día.
  function quitarDeCola(fecha, motivo) {
    for (let i = cola.length - 1; i >= 0; i--) {
      const x = cola[i]; if (x.fecha !== fecha || x.tipo === 'reporte') continue;
      if (x.trabajo) { x.trabajo.estado = 'error'; x.trabajo.error = motivo; }
      cola.splice(i, 1);
    }
    const a = actuales.monitor;
    if (a && a.fecha === fecha) { a.abortado = motivo; if (a.trabajo) a.trabajo.cancelar = true; }
  }
  // Eliminar es inmediato, aunque se esté actualizando algo de ese día.
  function borrar(fecha) {
    quitarDeCola(fecha, 'El día fue eliminado por el administrador.');
    const j = jornadas.get(fecha); if (j) borrados.add(j);
    jornadas.delete(fecha);
    const p = archivoDe(fecha); if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  function detener(fecha, rol) {
    const j = cargar(fecha); if (!j) throw new Error('Ese día no está siendo monitoreado.');
    if (j.completado) throw new Error('Ese día ya está COMPLETADO.');
    if (j.detenido) return;
    quitarDeCola(fecha, 'Actualizaciones detenidas por el administrador.');
    todas(j).forEach(({ s }) => { for (const k in s.prog || {}) if (s.prog[k] === 'encolada') delete s.prog[k]; });
    j.detenido = new Date().toISOString();
    j.actualizaciones.push({ t: j.detenido, tipo: 'detenido', rol, ok: true, detalle: 'El administrador detuvo las actualizaciones de este día.' });
    guardar(j);
  }
  function reanudar(fecha, rol) {
    const j = cargar(fecha); if (!j) throw new Error('Ese día no está siendo monitoreado.');
    if (!j.detenido) return;
    j.detenido = null;
    j.actualizaciones.push({ t: new Date().toISOString(), tipo: 'reanudado', rol, ok: true, detalle: 'El administrador reanudó las actualizaciones. Las ventanas que pasaron mientras estuvo detenido se omiten.' });
    j.leido = new Date().toISOString(); // no recuperar ventanas vencidas durante la pausa
    guardar(j);
  }

  function nuevoTrabajo(desc, fecha) {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const t = { id, desc, fecha, estado: 'corriendo', progreso: 0, paso: 'En cola…', mensajes: [], error: null, cancelar: false };
    t.log = (m) => { const l = `[${new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })}] ${m}`; t.mensajes.push(l); if (t.mensajes.length > 300) t.mensajes.shift(); console.log(l); };
    trabajos.set(id, t);
    return t;
  }
  const logSuelto = (m) => console.log(`[${new Date().toLocaleTimeString('es-PE', { timeZone: 'America/Lima' })}] ${m}`);

  async function abrirNavegadorPB(log) {
    if (!config.peruBus || config.peruBus.activo === false) { log('Peru Bus desactivado en config.json.'); return null; }
    let chromium;
    try { ({ chromium } = require('playwright')); } catch (_) { log('Peru Bus: Playwright no está instalado. Se omite Peru Bus.'); return null; }
    try {
      const navegador = await chromium.launch({ headless: true });
      const contexto = await navegador.newContext({ locale: 'es-PE', timezoneId: 'America/Lima', viewport: { width: 1280, height: 900 } });
      return { navegador, contexto };
    } catch (e) { log(`Peru Bus: no se pudo abrir el navegador (${e.message.split('\n')[0]}). Se omite Peru Bus.`); return null; }
  }

  // ---------------- lectura completa (recorrido inicial y reporte al instante) ----------------
  // sel (opcional) = { cds: [servicios], pb: [servicios] }: lee solo esos servicios en vez de la configuración global.
  async function leerTodo(fechas, t, sel = null) {
    const log = t.log; const rutas = config.rutas; const unidades = fechas.length * rutas.length;
    let hechas = 0;
    const marcar = (f, paso) => { t.progreso = Math.min(99, Math.round(((hechas + f) / unidades) * 100)); if (paso) t.paso = paso; };
    const token = tokenCDS(); const aj = leerAjustes();
    const permitido = (emp) => (n) => (sel ? sel[emp].includes(n) : aj.servicios[emp][n] !== false);
    const servs = (emp) => {
      const todos = [...new Set([...Object.keys(aj.servicios[emp]), ...(sel ? sel[emp] : [])])];
      const inc = todos.filter((k) => permitido(emp)(k));
      return { incluidos: inc, excluidos: todos.filter((k) => !inc.includes(k)) };
    };
    const usarCds = !sel || sel.cds.length > 0, usarPb = !sel || sel.pb.length > 0;
    const pb = usarPb ? await abrirNavegadorPB(log) : null;
    const { scrapePeruBus } = pb ? require('../scrapers/perubus') : {};
    const dias = [];
    try {
      for (const fecha of fechas) {
        const dia = { fecha, rutas: [] };
        for (const ruta of rutas) {
          if (t.cancelar) throw new Error('Consulta cancelada por el usuario.');
          const r = { id: ruta.id, nombre: ruta.nombre, cds: { salidas: [], error: null }, pb: { salidas: [], error: null } };
          const et = fechas.length > 1 ? `${fecha} · ${ruta.nombre}` : ruta.nombre;
          marcar(0, `${et}: Cruz del Sur`);
          if (usarCds) try {
            r.cds.salidas = await scrapeCruzDelSur({ origen: ruta.cds[0], destino: ruta.cds[1], fecha, config, token, log,
              servicioPermitido: permitido('cds'), alDescubrir: (n) => registrarServicios('cds', n),
              avance: (n, total) => marcar(total ? 0.8 * n / total : 0.8, `${et}: Cruz del Sur ${n}/${total} buses`) });
          } catch (e) { r.cds.error = String(e.message || e); log(`Cruz del Sur (${et}): ${r.cds.error}`); if (e.fatal) throw e; }
          marcar(0.8, `${et}: Peru Bus`);
          if (!usarPb) { /* sin servicios de Peru Bus seleccionados */ }
          else if (pb) {
            const pagina = await pb.contexto.newPage();
            try {
              const lista = await scrapePeruBus(pagina, { origen: ruta.pb[0], destino: ruta.pb[1], fecha, config: cfgPb(), log });
              registrarServicios('pb', [...new Set(lista.map((x) => x.servicio))]);
              r.pb.salidas = lista.filter((x) => permitido('pb')(x.servicio));
            } catch (e) { r.pb.error = String(e.message || e); log(`Peru Bus (${et}): ${r.pb.error}`); }
            await pagina.close();
          } else r.pb.error = 'Peru Bus no se consultó (ver config.json / README).';
          dia.rutas.push(r); hechas++; marcar(0);
        }
        dias.push(dia);
      }
    } finally { if (pb) await pb.navegador.close().catch(() => {}); }
    return { dias, servicios: { cds: servs('cds'), pb: servs('pb') } };
  }

  // Reporte al instante (pestaña "Reporte al instante"): una foto de uno o varios días, sin seguimiento.
  async function reporteInstantaneo({ desde, hasta, rol, origen = 'manual', sel = null, trabajo: t }) {
    const fechas = []; for (let f = desde; f <= hasta; f = sumarDias(f, 1)) fechas.push(f);
    const generado = new Date().toISOString();
    const { dias, servicios } = await leerTodo(fechas, t, sel);
    const resultado = { origen, rol, desde, hasta, generado, servicios, dias };
    const sello = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const pre = origen === 'auto' ? 'auto_' : '';
    const archivo = desde === hasta ? `${pre}reporte_${desde}_cap-${sello}.json` : `${pre}reporte_${desde}_a_${hasta}_cap-${sello}.json`;
    fs.writeFileSync(path.join(DATA, archivo), JSON.stringify(resultado));
    t.resultado = { archivo };
    t.log(`Listo. Guardado en data/${archivo}`);
  }

  function prepararSalida(s, r, emp, usados, ahora, tipo) {
    let id = `${r.id}|${emp}|${s.hora}|${s.origen}|${s.servicio}`; let n = 2;
    while (usados.has(id)) id = `${r.id}|${emp}|${s.hora}|${s.origen}|${s.servicio}#${n++}`;
    usados.add(id);
    Object.assign(s, { id, actualizado: ahora, nAct: 0, prog: {}, historial: s.vendidos != null ? [{ t: ahora, v: s.vendidos, tipo }] : [] });
  }

  // ---------------- cambio de servicios en un día en curso (solo admin) ----------------
  // Compara los servicios del día con la configuración actual.
  function diferenciaServicios(j) {
    const aj = leerAjustes(); const d = { quitar: { cds: [], pb: [] }, agregar: { cds: [], pb: [] }, nQuitar: 0 };
    for (const emp of ['cds', 'pb']) {
      const sel = Object.entries(aj.servicios[emp]).filter(([, v]) => v).map(([k]) => k);
      const antes = (j.servicios && j.servicios[emp] && j.servicios[emp].incluidos) || [...new Set(todas(j).filter((x) => x.emp === emp).map((x) => x.s.servicio))];
      d.quitar[emp] = antes.filter((x) => !sel.includes(x));
      d.agregar[emp] = sel.filter((x) => !antes.includes(x));
      d.nQuitar += todas(j).filter((x) => x.emp === emp && d.quitar[emp].includes(x.s.servicio) && viva(j.fecha, x.s)).length;
    }
    return d;
  }
  function simularServicios(fecha) {
    const j = cargar(fecha); if (!j) throw new Error('Ese día no está siendo monitoreado.');
    return { fecha, cerrado: !!cerrado(j), ...diferenciaServicios(j) };
  }
  function aplicarServicios(fecha, rol) {
    const j = cargar(fecha); if (!j) throw new Error('Ese día no está siendo monitoreado.');
    if (cerrado(j)) throw new Error('Ese día ya está COMPLETADO o DETENIDO: no se modifica.');
    const d = diferenciaServicios(j); const ahora = new Date().toISOString();
    // Quitar: las salidas de servicios desmarcados salen del día (se guardan aparte como registro).
    let quitadas = 0; j.excluidas = j.excluidas || [];
    j.rutas.forEach((r) => ['cds', 'pb'].forEach((emp) => {
      r[emp].salidas = r[emp].salidas.filter((s) => {
        if (!d.quitar[emp].includes(s.servicio)) return true;
        j.excluidas.push({ ...s, ruta: r.id, emp, excluidaEn: ahora }); quitadas++; return false;
      });
    }));
    const aj = leerAjustes();
    const servs = (emp) => ({ incluidos: Object.entries(aj.servicios[emp]).filter(([, v]) => v).map(([k]) => k), excluidos: Object.entries(aj.servicios[emp]).filter(([, v]) => !v).map(([k]) => k) });
    j.servicios = { cds: servs('cds'), pb: servs('pb') };
    const txt = (o) => [...o.cds.map((x) => 'CDS ' + x), ...o.pb.map((x) => 'PB ' + x)].join(', ');
    const hayAgregar = d.agregar.cds.length + d.agregar.pb.length > 0;
    j.actualizaciones.push({ t: ahora, tipo: 'servicios', rol, ok: true, detalle: `El administrador cambió los servicios.${quitadas ? ` Se dejaron de monitorear ${quitadas} salida(s) de: ${txt(d.quitar)}.` : ''}${hayAgregar ? ` Se agregan: ${txt(d.agregar)} (leyendo sus salidas…).` : ''}` });
    guardar(j);
    let t = null;
    if (hayAgregar) { t = nuevoTrabajo(`Agregar servicios al ${fecha}`, fecha); encolar({ tipo: 'agregar', fecha, rol, agregar: d.agregar, trabajo: t }); }
    return { quitadas, agregar: d.agregar, id: t ? t.id : null };
  }
  // Lee las salidas de los servicios agregados que aún no parten y las suma al día.
  async function agregarServicios(item) {
    const j = cargar(item.fecha); if (!j || cerrado(j)) return;
    const { dias } = await leerTodo([j.fecha], item.trabajo, item.agregar);
    if (item.abortado || borrados.has(j)) return;
    const ahora = new Date().toISOString(); const usados = new Set(todas(j).map((x) => x.s.id)); let n = 0;
    dias[0].rutas.forEach((nr) => {
      const r = j.rutas.find((x) => x.id === nr.id); if (!r) return;
      ['cds', 'pb'].forEach((emp) => {
        const nuevas = nr[emp].salidas.filter((s) => tSalida(j.fecha, s.hora) > Date.now());
        nuevas.forEach((s) => { prepararSalida(s, r, emp, usados, ahora, 'agregada'); r[emp].salidas.push(s); n++; });
        r[emp].salidas.sort((a, b) => a.hora.localeCompare(b.hora));
      });
    });
    const txt = [...item.agregar.cds.map((x) => 'CDS ' + x), ...item.agregar.pb.map((x) => 'PB ' + x)].join(', ');
    j.actualizaciones.push({ t: ahora, tipo: 'servicios', rol: item.rol, ok: true, detalle: `Se agregaron ${n} salida(s) por partir de: ${txt}. Desde ahora se monitorean con sus lecturas programadas.` });
    guardar(j);
    item.trabajo.log(`Agregadas ${n} salida(s) al ${j.fecha}.`);
  }

  // ---------------- recorrido inicial ----------------
  async function recorridoInicial(item) {
    const { fecha, origen, rol, trabajo: t } = item;
    const j = { tipo: 'dia', fecha, origen, rol, creado: new Date().toISOString(), leido: null, servicios: null, rutas: [], actualizaciones: [], version: 0 };
    const { dias, servicios } = await leerTodo([fecha], t);
    j.rutas = dias[0].rutas; j.servicios = servicios;
    const log = t.log;

    const ahora = new Date().toISOString(); const usados = new Set();
    todas(j).forEach(({ r, emp, s }) => prepararSalida(s, r, emp, usados, ahora, 'inicial'));
    const xs = todas(j); const sd = xs.filter(({ s }) => s.vendidos == null && !s.duplicadoDe).length;
    j.leido = ahora; j.refrescado = ahora;
    const adelanto = fecha > limaAhora().fecha ? ' · día siguiente, monitoreado por adelantado' : '';
    j.actualizaciones.push({ t: ahora, tipo: 'inicial', rol, ok: true, detalle: `${xs.length} salidas leídas${sd ? ` (${sd} sin dato)` : ''}${adelanto}` });
    if (item.abortado) { log(`Descartado: ${item.abortado}`); return; }
    jornadas.set(fecha, j); guardar(j);
    log(`Listo. Día ${fecha} guardado en data/dia_${fecha}.json`);
  }

  // ---------------- actualización total (días siguientes cada 2–3 h, hoy cada ~4 h) ----------------
  // Vuelve a leer todas las salidas del día con los servicios del día: actualiza las que ya estaban,
  // suma las nuevas y da por terminadas las que ya no aparecen. Las que ya partieron no se tocan.
  async function refrescoTotal(item) {
    const j = cargar(item.fecha); if (!j || cerrado(j)) return;
    const t = item.trabajo;
    const sel = j.servicios ? { cds: j.servicios.cds.incluidos || [], pb: j.servicios.pb.incluidos || [] } : null;
    const { dias } = await leerTodo([j.fecha], t, sel);
    if (item.abortado || borrados.has(j) || cerrado(j)) { t.log(`Actualización total del ${j.fecha} descartada: ${item.abortado || 'el día fue cerrado'}`); return; }
    const ahora = new Date().toISOString(); const usados = new Set(todas(j).map((x) => x.s.id));
    const suma = (emp) => todas(j).filter((x) => x.emp === emp && !x.s.duplicadoDe).reduce((a, x) => a + (x.s.vendidos || 0), 0);
    const antes = { cds: suma('cds'), pb: suma('pb') };
    let nAct = 0, nNuevas = 0, nFuera = 0, nSinDato = 0; const errores = [];
    const clave = (s) => `${s.hora}|${s.origen}|${s.servicio}`;
    dias[0].rutas.forEach((nr) => {
      const r = j.rutas.find((x) => x.id === nr.id); if (!r) return;
      ['cds', 'pb'].forEach((emp) => {
        if (sel && !sel[emp].length) return; // esa empresa no se monitorea en este día
        if (nr[emp].error) { errores.push(`${EMP[emp]} ${r.nombre}: ${nr[emp].error}`); return; } // sin lectura: se conserva todo
        const pendientes = [...r[emp].salidas];
        nr[emp].salidas.forEach((n) => {
          const i = pendientes.findIndex((s) => clave(s) === clave(n));
          if (i < 0) {
            if (tSalida(j.fecha, n.hora) <= Date.now()) return;
            prepararSalida(n, r, emp, usados, ahora, 'refresco'); r[emp].salidas.push(n); nNuevas++; return;
          }
          const s = pendientes.splice(i, 1)[0];
          if (!viva(j.fecha, s)) return;
          if (n.vendidos == null) { nSinDato++; return; } // sin dato: se conservan los de la lectura anterior
          aplicar(s, n, 'refresco'); if (!s.duplicadoDe) nAct++;
        });
        // Siguen por partir pero ya no figuran en la web: cerró la venta o se canceló.
        pendientes.filter((s) => viva(j.fecha, s)).forEach((s) => { s.cerrada = { t: ahora, motivo: 'Ya no aparece en la web (actualización total).' }; nFuera++; });
        r[emp].salidas.sort((a, b) => a.hora.localeCompare(b.hora));
      });
    });
    const despues = { cds: suma('cds'), pb: suma('pb') };
    const dif = (k) => `${EMP[k]} ${antes[k]} → ${despues[k]}`;
    j.refrescado = ahora;
    j.actualizaciones.push({ t: ahora, tipo: 'refresco', rol: null, ok: !errores.length, motivo: item.motivo || null,
      detalle: `Actualización total${item.motivo ? ` (${item.motivo})` : ''}: ${nAct} salidas releídas${nNuevas ? `, ${nNuevas} nuevas` : ''}${nFuera ? `, ${nFuera} ya no aparecen en la web` : ''}${nSinDato ? `, ${nSinDato} sin dato (se conserva la lectura anterior)` : ''}. Vendidos: ${dif('cds')} · ${dif('pb')}.${errores.length ? ` Sin lectura: ${errores.join(' · ')}` : ''}` });
    guardar(j);
    t.log(`Actualización total del ${j.fecha} lista: ${nAct} releídas, ${nNuevas} nuevas, ${nFuera} ya no aparecen.`);
  }

  // ---------------- actualización de salidas puntuales ----------------
  const datosCds = (m) => ({ capacidad: m.vendidos + m.libres, libres: m.libres, vendidos: m.vendidos, porTarifa: m.porTarifa, porPiso: m.porPiso, ingresoEstimado: m.ingreso });
  const datosPb = (n) => ({ precio: n.precio, capacidad: n.capacidad, libres: n.libres, vendidos: n.vendidos, porTarifa: n.porTarifa, ingresoEstimado: n.ingresoEstimado, nota: n.nota });
  const motivo = (s, m, txt) => { (s.progInfo = s.progInfo || {})[m] = { t: new Date().toISOString(), omitida: true, motivo: txt }; };
  function aplicar(s, d, tipo) {
    const t = new Date().toISOString();
    Object.assign(s, d);
    if (s.sinDato) { s.sinDato = false; if (/^Sin dato/.test(s.nota || '')) s.nota = ''; }
    s.actualizado = t; s.nAct = (s.nAct || 0) + 1;
    (s.historial = s.historial || []).push({ t, v: s.vendidos, tipo });
  }

  async function actualizar(item) {
    const j = cargar(item.fecha); if (!j) return;
    const t = item.trabajo; const log = t ? t.log : logSuelto;
    const M = ajustesMonitor(); const espera = Math.max(10, M.esperaReintentoSeg || 60) * 1000;
    if (cerrado(j)) return;
    // Las salidas que ya partieron o que ya no aparecen en la web no se vuelven a consultar.
    const obj = item.objetivos.map((o) => ({ ...o, x: buscar(j, o.id) })).filter((o) => o.x);
    const partidas = obj.filter((o) => !viva(j.fecha, o.x.s));
    partidas.forEach((o) => { if (o.m != null) { o.x.s.prog[o.m] = 'omitida'; motivo(o.x.s, o.m, o.x.s.cerrada ? 'La venta ya había cerrado.' : 'La salida ya había partido.'); } });
    if (partidas.length) { obj.splice(0, obj.length, ...obj.filter((o) => !partidas.includes(o))); if (!obj.length) { guardar(j); return; } }
    const res = new Map(obj.map((o) => [o.id, { antes: o.x.s.vendidos, hecho: false, error: null }]));
    const porRuta = new Map();
    obj.forEach((o) => { const k = o.x.r.id; if (!porRuta.has(k)) porRuta.set(k, { r: o.x.r, cds: [], pb: [] }); porRuta.get(k)[o.x.emp].push(o); });
    const cfgRuta = Object.fromEntries(config.rutas.map((r) => [r.id, r]));
    const unidades = [...porRuta.values()].reduce((a, g) => a + new Set(g.cds.map((o) => o.x.s.bus)).size + (g.pb.length ? 1 : 0), 0) || 1;
    let hechas = 0;
    const avance = (paso) => { hechas++; if (t) { t.progreso = Math.min(99, Math.round((hechas / unidades) * 100)); t.paso = paso; } };
    const falla = (o, e, definitivo) => { const r = res.get(o.id); if (!r.hecho && !r.error) { r.error = String((e && e.message) || e); r.definitivo = !!(definitivo || (e && e.definitivo)); } };
    log(`Actualizando ${obj.length} salida(s) del ${j.fecha} (${item.tipo}${item.via ? ' · ' + item.via : ''}${item.quien ? ' · ' + item.quien : item.rol ? ' · ' + item.rol : ''})…`);
    let pb = null; let cancelado = false;
    try {
      for (const g of porRuta.values()) {
        if (t && t.cancelar) throw Object.assign(new Error('Cancelada por el usuario.'), { cancelada: true });
        const rc = cfgRuta[g.r.id];
        if (g.cds.length && rc) {
          g.cds.filter((o) => !o.x.s.tripId).forEach((o) => falla(o, 'Salida sin identificador de viaje.'));
          const buses = [...new Map(g.cds.filter((o) => o.x.s.tripId).map((o) => [o.x.s.bus, o.x.s])).values()];
          try {
            const lect = await leerBuses({ origen: rc.cds[0], destino: rc.cds[1], fecha: j.fecha, config, token: tokenCDS(), log,
              viajes: buses.map((s) => ({ tripId: s.tripId, hora: s.hora, servicio: s.servicio })),
              alLeer: (i) => avance(`${g.r.nombre}: Cruz del Sur ${i + 1}/${buses.length}`) });
            buses.forEach((s, i) => {
              const L = lect[i];
              // Un mismo bus puede figurar desde varios terminales: se actualizan todas sus apariciones.
              if (L.ok) g.r.cds.salidas.filter((x) => x.bus === s.bus).forEach((x) => aplicar(x, datosCds(L.m), item.tipo));
              g.cds.filter((o) => o.x.s.bus === s.bus).forEach((o) => { if (L.ok) res.get(o.id).hecho = true; else falla(o, L.error, L.definitivo); });
              // Si el bus ya no aparece, se dan por terminadas todas sus apariciones.
              if (!L.ok && L.definitivo) g.r.cds.salidas.filter((x) => x.bus === s.bus).forEach((x) => { x.cerrada = { t: new Date().toISOString(), motivo: L.error }; });
            });
          } catch (e) { g.cds.forEach((o) => falla(o, e)); }
        }
        if (g.pb.length && rc) {
          try {
            if (!pb) pb = await abrirNavegadorPB(log);
            if (!pb) throw new Error('Peru Bus no disponible (navegador).');
            const { scrapePeruBus } = require('../scrapers/perubus');
            const pagina = await pb.contexto.newPage();
            let lista; try { lista = await scrapePeruBus(pagina, { origen: rc.pb[0], destino: rc.pb[1], fecha: j.fecha, config: cfgPb(), log }); } finally { await pagina.close().catch(() => {}); }
            g.pb.forEach((o) => {
              const s = o.x.s; const n = lista.find((x) => x.hora === s.hora && x.servicio === s.servicio);
              if (!n) falla(o, 'La salida ya no aparece en la web de Peru Bus (cerrada o ya partió).', true);
              else if (n.vendidos == null) falla(o, n.nota || 'Peru Bus ya no muestra asientos para esta salida (cerrada).', true);
              else { aplicar(s, datosPb(n), item.tipo); res.get(o.id).hecho = true; }
            });
          } catch (e) { g.pb.forEach((o) => falla(o, e)); }
          avance(`${g.r.nombre}: Peru Bus`);
        }
      }
    } catch (e) { if (!e.cancelada) throw e; cancelado = true; obj.forEach((o) => falla(o, item.abortado || 'Cancelada por el administrador.')); }
    finally { if (pb) await pb.navegador.close().catch(() => {}); }
    if (item.abortado || borrados.has(j)) { log(`Actualización del ${j.fecha} descartada: ${item.abortado || 'día eliminado'}`); return; }

    const reintentos = []; const lote = Date.now().toString(36);
    for (const o of obj) {
      const r = res.get(o.id); const s = o.x.s; const ok = r.hecho && !r.error;
      if (!ok && r.definitivo) s.cerrada = s.cerrada || { t: new Date().toISOString(), motivo: r.error };
      const reintenta = !ok && !cancelado && !r.definitivo && !j.detenido && o.intento < (M.reintentos || 1) && Date.now() + espera < tSalida(j.fecha, s.hora);
      if (o.m != null) {
        s.prog[o.m] = ok ? 'ok' : r.definitivo ? 'cerrada' : reintenta ? 'encolada' : 'error';
        // Qué pasó en esa lectura programada (la página lo muestra en cada casilla).
        (s.progInfo = s.progInfo || {})[o.m] = { t: new Date().toISOString(), ok, antes: r.antes ?? null, v: ok ? s.vendidos : null, error: ok ? null : r.error, cerrada: !ok && !!r.definitivo, intento: o.intento };
      }
      if (s.cerrada) for (const k in s.prog) if (s.prog[k] === 'encolada') delete s.prog[k]; // no se harán: la página las muestra con 🔒
      j.actualizaciones.push({ t: new Date().toISOString(), lote, tipo: item.tipo, m: o.m ?? null, rol: item.rol || null, ruta: o.x.r.nombre, emp: o.x.emp,
        id: o.id, hora: s.hora, servicio: s.servicio, origen: s.origen, antes: r.antes, despues: ok ? s.vendidos : null, ok, error: ok ? null : r.error, intento: o.intento, de: M.reintentos || 1, reintenta, cerrada: !ok && !!r.definitivo, via: item.via || null, quien: item.quien || null });
      log(`${EMP[o.x.emp]} ${o.x.r.nombre} ${s.hora} ${s.servicio}: ${ok ? `${r.antes ?? '?'} → ${s.vendidos} vendidos` : `falló (${r.error})${r.definitivo ? '; se da por terminada, no se consulta más' : reintenta ? `; reintento ${o.intento + 1} en ${espera / 1000} s` : ''}`}`);
      if (reintenta) reintentos.push({ id: o.id, m: o.m, intento: o.intento + 1 });
    }
    guardar(j);
    if (reintentos.length) encolar({ tipo: item.tipo, fecha: j.fecha, rol: item.rol, via: item.via, quien: item.quien, objetivos: reintentos, noAntes: Date.now() + espera });
  }

  // ---------------- cola ----------------
  const ORDEN = { manual: 0, todas: 1, inicial: 1, agregar: 1, reporte: 1, refresco: 1, programada: 2 };
  const prioridad = (x) => (x.fondo ? 3 : ORDEN[x.tipo]); // lo de fondo va siempre al final
  function encolar(item) { item.creado = Date.now(); cola.push(item); setImmediate(bombear); return item; }
  function bombear() { correr('monitor'); correr('reporte'); }
  // ¿Es buen momento para una tarea de fondo? Sí, si ninguna lectura programada vence pronto.
  function huecoLibre() {
    const M = ajustesMonitor(); const limite = Date.now() + HUECO_FONDO_MS;
    for (const j of jornadas.values()) { const p = proximaDe(j, M); if (p && Date.parse(p.t) < limite) return false; }
    return true;
  }
  async function correr(carril) {
    if (actuales[carril]) return;
    const ahora = Date.now(); let hueco = null;
    const puede = (x) => !x.fondo || ahora >= (x.forzarDesde || x.creado + ESPERA_MAX_FONDO_MS) || (hueco ??= huecoLibre());
    const listos = cola.filter((x) => carrilDe(x) === carril && (!x.noAntes || x.noAntes <= ahora)).sort((a, b) => prioridad(a) - prioridad(b) || a.creado - b.creado);
    if (!listos.length || !puede(listos[0])) return;
    const item = listos[0];
    if (item.fondo && item.trabajo) item.trabajo.log(`Buen momento para: ${item.trabajo.desc}.`);
    cola.splice(cola.indexOf(item), 1);
    if (!item.trabajo) { // juntar lo que esté listo del mismo día y tipo en una sola pasada
      for (const x of listos.slice(1)) if (!x.trabajo && x.tipo === item.tipo && x.fecha === item.fecha && (x.via || null) === (item.via || null)) { item.objetivos.push(...x.objetivos); cola.splice(cola.indexOf(x), 1); }
      const vistos = new Set(); item.objetivos = item.objetivos.filter((o) => !vistos.has(o.id) && vistos.add(o.id));
    }
    actuales[carril] = item;
    const t = item.trabajo;
    try {
      if (t) t.paso = 'Iniciando…';
      if (item.tipo === 'inicial') await recorridoInicial(item); else if (item.tipo === 'refresco') await refrescoTotal(item); else if (item.tipo === 'reporte') await reporteInstantaneo(item); else if (item.tipo === 'agregar') await agregarServicios(item); else await actualizar(item);
      if (t) { t.estado = 'listo'; t.progreso = 100; t.paso = 'Listo'; }
    } catch (e) {
      const msg = String(e.message || e);
      if (t) { t.estado = 'error'; t.error = msg; t.log(`ERROR: ${msg}`); } else logSuelto(`ERROR en actualización: ${msg}`);
    } finally {
      actuales[carril] = null;
      if (item.alTerminar) try { item.alTerminar(t); } catch (_) {}
      setImmediate(bombear);
    }
  }
  setInterval(bombear, 5000);

  // ---------------- programador ----------------
  function programar() {
    const aj = leerAjustes(); const M = aj.monitor;
    const { fecha: hoy, hm } = limaAhora();
    // 1) Recorrido inicial automático del día, a la hora configurada (solo si está activado).
    const enPeriodo = enVigencia(M, hoy);
    if (M.activa && enPeriodo && M.ultima !== hoy && hm >= M.hora && tokenCDS()) {
      M.ultima = hoy;
      const ya = cargar(hoy);
      if (ya && !cerrado(ya) && limaFecha(ya.creado) < hoy) {
        // Se venía monitoreando por adelantado: hoy arranca con una actualización total y sigue el plan normal.
        M.ultimoResultado = `${hoy} ${hm}: el día ya se monitoreaba por adelantado; actualización total de inicio en curso…`;
        encolarRefresco(ya, 'inicio del día', false, (t) => { const a = leerAjustes(); a.monitor.ultimoResultado = t.estado === 'listo' ? `${hoy} ${hm}: correcto (ya se monitoreaba por adelantado)` : `${hoy} ${hm}: error · ${t.error}`; guardarAjustes(a); });
      } else if (ya || inicialPendiente(hoy)) M.ultimoResultado = `${hoy}: el día ya estaba iniciado manualmente.`;
      else {
        M.ultimoResultado = `${hoy} ${hm}: recorrido inicial en curso…`;
        iniciarDia(hoy, 'auto', null, (t) => { const a = leerAjustes(); a.monitor.ultimoResultado = t.estado === 'listo' ? `${hoy} ${hm}: correcto` : `${hoy} ${hm}: error · ${t.error}`; guardarAjustes(a); });
      }
      guardarAjustes(aj);
    }
    // 1a) Días siguientes: recorrido inicial por adelantado (de fondo, cuando haya un hueco).
    //     Una vez por día; si se sube "días adelante", se completan los que falten ese mismo día.
    const nAdel = Math.max(0, Math.min(7, Number(M.diasAdelante) || 0));
    if (M.activa && M.ultima === hoy && nAdel && tokenCDS() && (!M.adelante || M.adelante.fecha !== hoy || M.adelante.n < nAdel)) {
      const desde = M.adelante && M.adelante.fecha === hoy ? M.adelante.n + 1 : 1;
      for (let i = desde; i <= nAdel; i++) {
        const f = sumarDias(hoy, i);
        if (enVigencia(M, f) && !cargar(f) && !inicialPendiente(f)) iniciarDia(f, 'auto', null, null, true);
      }
      M.adelante = { fecha: hoy, n: nAdel };
      guardarAjustes(aj);
    }
    // 1b) Cron del reporte al instante: una foto de hoy a cada hora configurada (independiente del monitoreo).
    const R = aj.reporteAuto;
    if (R && R.activa && enVigencia(R, hoy) && tokenCDS()) {
      if (!R.hechas || R.hechas.fecha !== hoy) R.hechas = { fecha: hoy, horas: [] };
      let cambio = false;
      for (const h of R.horas || []) {
        if (hm < h || R.hechas.horas.includes(h)) continue;
        R.hechas.horas.push(h); cambio = true;
        const [h1, m1] = h.split(':').map(Number); const [h2, m2] = hm.split(':').map(Number);
        if ((h2 * 60 + m2) - (h1 * 60 + m1) > 60) { R.ultimoResultado = `${hoy} ${h}: omitido (el servidor no estaba activo a esa hora)`; continue; }
        R.ultimoResultado = `${hoy} ${h}: generando…`;
        generarReporte(hoy, hoy, null, 'auto', (t) => { const a = leerAjustes(); a.reporteAuto.ultimoResultado = t.estado === 'listo' ? `${hoy} ${h}: correcto` : `${hoy} ${h}: error · ${t.error}`; guardarAjustes(a); });
      }
      if (cambio) guardarAjustes(aj);
    }
    // 2) Días cuya última salida ya partió: quedan COMPLETADOS y no se consulta nada más.
    const abiertos = fechasGuardadas().map(cargar).filter((j) => j && !cerrado(j) && !verificarFin(j));
    // 2b) Actualización total periódica (días siguientes y hoy): al cumplirse el mínimo se encola de fondo;
    //     corre en el primer hueco y, si no aparece, al cumplirse el máximo.
    if (tokenCDS()) for (const j of abiertos.filter((x) => x.fecha >= hoy && enVigencia(M, x.fecha))) {
      const iv = intervaloRefresco(j, M, hoy);
      if (!iv || refrescoPendiente(j.fecha) || inicialPendiente(j.fecha)) continue;
      const ult = Date.parse(j.refrescado || j.leido || j.creado);
      if (Date.now() - ult < iv.min * 36e5) continue;
      if (j.fecha === hoy && !todas(j).some(({ s }) => viva(j.fecha, s))) continue;
      const cada = `cada ${iv.min}–${iv.max} h`;
      encolarRefresco(j, j.fecha === hoy ? `periódica de hoy, ${cada}` : `día siguiente, ${cada}`, true, null, ult + iv.max * 36e5);
    }
    // 3) Actualización de cada salida N minutos antes: vale para todo día monitoreado,
    //    se haya iniciado solo o a mano. Tiene su propio interruptor.
    if (M.actualizarSalidas === false) return;
    const ahora = Date.now();
    for (const j of abiertos.filter((x) => enVigencia(M, x.fecha))) {
      const fecha = j.fecha;
      const leido = Date.parse(j.leido || j.creado);
      const objetivos = []; let cambio = false;
      for (const { emp, s } of todas(j)) {
        s.prog = s.prog || {};
        if (s.cerrada) continue;
        const mins = ventanasDe(M, emp); if (!mins.length) continue;
        const ts = tSalida(fecha, s.hora);
        const vencidas = mins.filter((m) => ahora >= ts - m * 60000 && !s.prog[m]);
        if (!vencidas.length) continue;
        cambio = true;
        // Las que vencieron antes del recorrido inicial, o con la salida ya partida, no se hacen.
        const utiles = vencidas.filter((m) => ts - m * 60000 > leido && ahora < ts);
        vencidas.forEach((m) => { if (utiles.length && m === Math.min(...utiles)) return;
          s.prog[m] = 'omitida';
          motivo(s, m, ts - m * 60000 <= leido ? 'Ese momento pasó antes del recorrido inicial del día.' : ahora >= ts ? 'La salida ya había partido.' : 'Se juntó con una lectura posterior (a esa hora el servidor no estaba activo o se cambiaron los minutos).'); });
        if (utiles.length) { const m = Math.min(...utiles); s.prog[m] = 'encolada'; objetivos.push({ id: s.id, m, intento: 1 }); }
      }
      if (cambio) guardar(j);
      if (objetivos.length) encolar({ tipo: 'programada', fecha, objetivos });
    }
  }
  function verificarFin(j) {
    if (j.fecha > limaAhora().fecha) return false; // un día que aún no llega nunca está completado
    const xs = todas(j);
    if (xs.some(({ s }) => viva(j.fecha, s))) return false;
    if ([actuales.monitor, ...cola].some((x) => x && x.fecha === j.fecha && (x.tipo === 'inicial' || x.tipo === 'agregar' || x.tipo === 'refresco'))) return false;
    for (let i = cola.length - 1; i >= 0; i--) if (cola[i].fecha === j.fecha && !cola[i].trabajo) cola.splice(i, 1);
    xs.forEach(({ s }) => { for (const k in s.prog || {}) if (s.prog[k] === 'encolada') s.prog[k] = 'omitida'; });
    const ultima = xs.map(({ s }) => s.hora).sort().pop();
    const nCerr = xs.filter(({ s }) => s.cerrada).length;
    j.completado = new Date().toISOString();
    j.actualizaciones.push({ t: j.completado, tipo: 'fin', ok: true, detalle: ultima ? `Ya no quedan salidas por partir (la última era ${ultima})${nCerr ? `; ${nCerr} se dieron por terminadas al no aparecer en la web` : ''}. Monitoreo COMPLETADO: ya no se consulta nada más.` : 'El día no tiene salidas. Monitoreo COMPLETADO.' });
    guardar(j);
    logSuelto(`Día ${j.fecha} COMPLETADO (última salida ${ultima || '—'}).`);
    return true;
  }
  setInterval(() => { try { programar(); } catch (e) { console.error('Programador:', e.message); } }, 30000);
  setTimeout(() => { try { programar(); } catch (e) { console.error('Programador:', e.message); } }, 3000);

  // ---------------- API para el servidor ----------------
  const inicialPendiente = (fecha) => [actuales.monitor, ...cola].find((x) => x && x.tipo === 'inicial' && x.fecha === fecha);
  const refrescoPendiente = (fecha) => [actuales.monitor, ...cola].find((x) => x && x.tipo === 'refresco' && x.fecha === fecha);
  // fondo = espera un buen momento (días siguientes). Uno pedido a mano deja de ser de fondo.
  function iniciarDia(fecha, origen, rol, alTerminar, fondo = false) {
    const p = inicialPendiente(fecha); if (p) { if (!fondo) p.fondo = false; return p.trabajo; }
    const t = nuevoTrabajo(`Recorrido inicial del ${fecha}${fondo ? ' (día siguiente, por adelantado)' : ''}`, fecha);
    encolar({ tipo: 'inicial', fecha, origen, rol, fondo, trabajo: t, alTerminar });
    return t;
  }
  // forzarDesde = desde cuándo una tarea de fondo se hace aunque no haya un buen momento.
  function encolarRefresco(j, motivo, fondo, alTerminar, forzarDesde) {
    const p = refrescoPendiente(j.fecha); if (p) { if (!fondo) p.fondo = false; return p.trabajo; }
    const t = nuevoTrabajo(`Actualización total del ${j.fecha} (${motivo})`, j.fecha);
    encolar({ tipo: 'refresco', fecha: j.fecha, motivo, fondo, forzarDesde, trabajo: t, alTerminar });
    return t;
  }
  // Rango de horas entre actualizaciones totales de un día: { min, max }, o null si no se hace.
  function intervaloRefresco(j, M, hoy) {
    const [a, b] = j.fecha > hoy ? [M.refrescoFuturoHoras, M.refrescoFuturoMaxHoras] : j.fecha === hoy ? [M.refrescoHoyHoras, M.refrescoHoyMaxHoras] : [0, 0];
    const min = Math.max(0, Number(a) || 0); if (!min) return null;
    return { min, max: Math.max(min, Number(b) || min + 1) };
  }
  function proximoRefresco(j, M) {
    const hoy = limaAhora().fecha; const iv = intervaloRefresco(j, M, hoy);
    if (!iv || cerrado(j) || j.fecha < hoy || !enVigencia(M, j.fecha)) return null;
    if (refrescoPendiente(j.fecha)) return { enCola: true, ...iv };
    const ult = Date.parse(j.refrescado || j.leido || j.creado);
    return { t: new Date(ult + iv.min * 36e5).toISOString(), hasta: new Date(ult + iv.max * 36e5).toISOString(), ...iv };
  }
  // que: { ids } | { hora } | { desdeAhora: true }
  function generarReporte(desde, hasta, rol, origen = 'manual', alTerminar, sel = null) {
    const t = nuevoTrabajo(`${origen === 'auto' ? 'Reporte automático' : 'Reporte al instante'} del ${desde}`, null);
    encolar({ tipo: 'reporte', desde, hasta, rol, origen, sel, trabajo: t, alTerminar });
    return t;
  }
  // via = qué botón lo pidió (fila, salida, ruta, todos, forzar): queda en el registro para saber qué pasó.
  function actualizarAhora(fecha, que, rol, via = null, quien = null) {
    const j = cargar(fecha); if (!j) throw new Error('Ese día no está siendo monitoreado.');
    if (j.detenido) throw new Error('Las actualizaciones de este día están DETENIDAS por el administrador.');
    if (j.completado || verificarFin(j)) throw new Error('Este día ya está COMPLETADO: partieron todas las salidas y ya no se consulta.');
    let xs = todas(j);
    if (que.ids) xs = xs.filter(({ s }) => que.ids.includes(s.id));
    else if (que.hora) xs = xs.filter(({ r, s }) => s.hora === que.hora && (!que.ruta || r.id === que.ruta));
    else if (que.desdeAhora) xs = xs.filter(({ r, s }) => viva(fecha, s) && (!que.ruta || r.id === que.ruta));
    if (!xs.length) throw new Error(que.desdeAhora ? 'No quedan salidas por partir ese día.' : 'No se encontró esa salida.');
    xs = xs.filter(({ s }) => viva(fecha, s)); // nunca las que ya partieron o ya no aparecen en la web
    if (!xs.length) throw new Error(que.ids ? 'Esa salida ya partió o ya no aparece en la web; no se consulta más.' : 'Esas salidas ya partieron o ya no aparecen en la web; no se consultan más.');
    const objetivos = xs.map(({ s }) => ({ id: s.id, m: null, intento: 1 }));
    if (que.desdeAhora) {
      const t = nuevoTrabajo(`Actualizar ${xs.length} salidas del ${fecha}`, fecha);
      encolar({ tipo: 'todas', fecha, rol, via, quien, objetivos, trabajo: t });
      return { id: t.id, n: xs.length };
    }
    encolar({ tipo: 'manual', fecha, rol, via, quien, objetivos });
    return { n: xs.length };
  }
  function proximaDe(j, M) {
    if (M.actualizarSalidas === false || cerrado(j) || !enVigencia(M, j.fecha)) return null;
    const ahora = Date.now(); let mejor = null;
    todas(j).forEach(({ r, emp, s }) => ventanasDe(M, emp).forEach((m) => {
      const t = tSalida(j.fecha, s.hora) - m * 60000;
      if (t > ahora && !s.cerrada && !(s.prog || {})[m] && (!mejor || t < mejor.t)) mejor = { t, hora: s.hora, servicio: s.servicio, emp, ruta: r.nombre, m };
    }));
    return mejor && { ...mejor, t: new Date(mejor.t).toISOString() };
  }
  function comoReporte(j) {
    return { tipo: 'dia', fecha: j.fecha, desde: j.fecha, hasta: j.fecha, generado: j.actualizado || j.creado, creado: j.creado, origen: j.origen, rol: j.rol,
      servicios: j.servicios, version: j.version, completado: j.completado || null, detenido: j.detenido || null, dias: [{ fecha: j.fecha, rutas: j.rutas }], actualizaciones: j.actualizaciones, archivo: `dia_${j.fecha}.json` };
  }
  function leerDia(fecha) { const j = cargar(fecha); if (!j) return null; const M = ajustesMonitor(); return { ...comoReporte(j), proxima: proximaDe(j, M), refrescado: j.refrescado || j.leido || null, proxRefresco: proximoRefresco(j, M) }; }
  function metaDias() {
    const M = ajustesMonitor();
    return fechasGuardadas().map((f) => {
      try {
        const j = cargar(f); const xs = todas(j);
        const vendidos = { cds: 0, pb: 0 }; const salidas = { cds: 0, pb: 0 }; let sinDato = 0;
        xs.forEach(({ emp, s }) => { if (s.duplicadoDe) return; salidas[emp]++; if (s.vendidos == null) sinDato++; else vendidos[emp] += s.vendidos; });
        const act = j.actualizaciones.filter((a) => a.id); // solo lecturas de salidas
        const quedan = xs.filter(({ s }) => viva(f, s)).length;
        return { tipo: 'dia', archivo: `dia_${f}.json`, fecha: f, desde: f, hasta: f, origen: j.origen, rol: j.rol, creado: j.creado, generado: j.creado, actualizado: j.actualizado,
          servicios: j.servicios, vendidos, salidas, sinDato, act: { ok: act.filter((a) => a.ok).length, error: act.filter((a) => !a.ok && !a.cerrada).length, cerradas: act.filter((a) => a.cerrada).length },
          ultima: act.length ? act[act.length - 1].t : null, proxima: proximaDe(j, M), refrescado: j.refrescado || j.leido || null, proxRefresco: proximoRefresco(j, M), completado: j.completado || null, detenido: j.detenido || null, quedan, total: xs.length };
      } catch (e) { return { tipo: 'dia', archivo: `dia_${f}.json`, fecha: f, desde: f, error: 'No se pudo leer el archivo' }; }
    }).concat(diasPorIniciar());
  }
  // Días cuyo recorrido inicial está en cola o en curso (aún sin archivo): se muestran en la grilla.
  function diasPorIniciar() {
    return [actuales.monitor, ...cola].filter((x) => x && x.tipo === 'inicial' && !jornadas.has(x.fecha)).map((x) => ({
      tipo: 'dia', pendiente: x === actuales.monitor ? 'curso' : x.fondo ? 'fondo' : 'cola', fecha: x.fecha, desde: x.fecha, hasta: x.fecha,
      origen: x.origen, rol: x.rol, creado: new Date(x.creado).toISOString(), generado: new Date(x.creado).toISOString(),
      forzarDesde: x.fondo ? new Date(x.forzarDesde || x.creado + ESPERA_MAX_FONDO_MS).toISOString() : null, progreso: x.trabajo ? x.trabajo.progreso : null }));
  }
  // Barra de estado de la página: qué hace ahora el monitoreo y cuál es la próxima lectura programada.
  function resumenSistema() {
    const M = ajustesMonitor(); let proxima = null;
    for (const j of jornadas.values()) { const p = proximaDe(j, M); if (p && (!proxima || p.t < proxima.t)) proxima = { ...p, fecha: j.fecha }; }
    const a = actuales.monitor;
    return { actual: a ? { tipo: a.tipo, fecha: a.fecha, n: a.objetivos ? a.objetivos.length : null, desc: a.trabajo ? a.trabajo.desc : null } : null,
      reporte: !!actuales.reporte, pendientes: cola.filter((x) => !x.fondo && x.tipo !== 'reporte').length, fondo: cola.filter((x) => x.fondo).length, proxima };
  }
  // Resumen para la confirmación de "Iniciar monitoreo" cuando el día ya existe.
  function estadoDia(fecha) {
    const j = cargar(fecha); if (!j) return null;
    const xs = todas(j);
    return { fecha, creado: j.creado, origen: j.origen, rol: j.rol, completado: j.completado || null, detenido: j.detenido || null, total: xs.length, quedan: xs.filter(({ s }) => viva(fecha, s)).length };
  }
  function estadoCola() {
    const ids = (dest) => (x) => x && x.objetivos && x.objetivos.forEach((o) => { (dest[x.fecha] = dest[x.fecha] || []).push(o.id); });
    const enCola = {}; const enCurso = {};
    ids(enCurso)(actuales.monitor); cola.forEach(ids(enCola));
    const versiones = {}; jornadas.forEach((j, f) => { versiones[f] = j.version; });
    const desc = (x) => x && { tipo: x.tipo, fecha: x.fecha, n: x.objetivos ? x.objetivos.length : null };
    const iniciando = diasPorIniciar().map((d) => `${d.fecha}:${d.pendiente}`);
    return { actual: desc(actuales.monitor), reporte: desc(actuales.reporte), pendientes: cola.length, enCola, enCurso, versiones, iniciando };
  }
  // Trabajo con progreso visible de un carril (cada pantalla sigue solo el suyo).
  // Las tareas de fondo que aún esperan su momento no cuentan (no deben bloquear la pantalla).
  const conTrabajo = (carril) => [actuales[carril], ...cola.filter((y) => carrilDe(y) === carril && !y.fondo)].find((y) => y && y.trabajo);
  const trabajoActivo = (carril = 'monitor') => { const x = conTrabajo(carril); return x ? x.trabajo.id : null; };
  function cancelar(carril = 'monitor') {
    const x = conTrabajo(carril); if (!x) return false;
    x.trabajo.cancelar = true;
    if (x !== actuales[carril]) { cola.splice(cola.indexOf(x), 1); x.trabajo.estado = 'error'; x.trabajo.error = 'Cancelada por el administrador.'; }
    return true;
  }

  return { resumenSistema, iniciarDia, generarReporte, actualizarAhora, leerDia, metaDias, estadoCola, trabajo: (id) => trabajos.get(id), trabajoActivo, cancelar, comoReporte, existe: (f) => !!cargar(f), estadoDia, detener, reanudar, simularServicios, aplicarServicios, borrar, ocupado: () => !!actuales.monitor || !!actuales.reporte || cola.some((x) => !x.fondo) };
}

module.exports = { crearMonitor, ventanasDe, MONITOR_INICIAL, REPORTE_AUTO_INICIAL };
