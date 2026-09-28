// Arma el Excel de un reporte con toda la información disponible.
const { crearXlsx } = require('./xlsx');

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const dia = (f) => DIAS[new Date(`${f}T12:00:00Z`).getUTCDay()];
const cuenta = (s) => !s.duplicadoDe && s.vendidos != null;
const EMP = { cds: 'Cruz del Sur', pb: 'Peru Bus' };
const H = (t, emp) => ({ v: t, s: emp === 'cds' ? 'cabCds' : emp === 'pb' ? 'cabPb' : 'cab' });
const n = (v, s = 'entero') => ({ v: v == null ? '' : v, s });
const p = (v) => ({ v: v == null ? '' : v, s: 'pct' });

function resumen(salidas) {
  const v = salidas.filter(cuenta);
  const vend = v.reduce((a, s) => a + s.vendidos, 0); const cap = v.reduce((a, s) => a + (s.capacidad || 0), 0);
  const ingreso = v.reduce((a, s) => a + (s.ingresoEstimado || 0), 0);
  return { salidas: v.length, vendidos: vend, capacidad: cap, ocup: cap ? vend / cap : null, ingreso, sinDato: salidas.filter((s) => s.sinDato).length };
}
function porHora(cds, pb) {
  const m = new Map();
  const add = (s, k) => { if (!cuenta(s)) return; const h = m.get(s.hora) || { hora: s.hora, cds: { n: 0, v: 0, c: 0 }, pb: { n: 0, v: 0, c: 0 } }; h[k].n++; h[k].v += s.vendidos; h[k].c += s.capacidad || 0; m.set(s.hora, h); };
  cds.forEach((s) => add(s, 'cds')); pb.forEach((s) => add(s, 'pb'));
  return [...m.values()].sort((a, b) => a.hora.localeCompare(b.hora)).map((h) => ({ ...h, coinc: h.cds.n > 0 && h.pb.n > 0 }));
}
const fh = (iso) => (iso ? new Date(iso).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '');
const TIPO_ACT = { inicial: 'Recorrido inicial', programada: 'Automática (programada)', manual: 'Manual · una fila / salida', todas: 'Manual · todos los horarios', fin: 'Completado', detenido: 'Detenido por el admin', reanudado: 'Reanudado por el admin', servicios: 'Cambio de servicios' };
const listaServicios = (x) => (Array.isArray(x) ? { incluidos: x, excluidos: [] } : x || { incluidos: [], excluidos: [] });

function construirExcel(rep) {
  const hojas = [];

  // ---- Resumen ----
  const R = [
    [{ v: 'Cruz del Sur vs. Peru Bus · Resumen por día y ruta', s: 'titulo' }],
    [rep.desde === rep.hasta ? `Fecha: ${rep.desde}` : `Del ${rep.desde} al ${rep.hasta}`],
    [],
    [H('Fecha'), H('Día'), H('Ruta'), H('CDS salidas', 'cds'), H('CDS vendidos', 'cds'), H('CDS capacidad', 'cds'), H('CDS % ocupación', 'cds'), H('CDS ingreso estimado', 'cds'), H('CDS salidas sin dato', 'cds'),
      H('PB salidas', 'pb'), H('PB vendidos', 'pb'), H('PB capacidad', 'pb'), H('PB % ocupación', 'pb'), H('PB ingreso estimado', 'pb'), H('Horarios coincidentes'), H('Dif. vendidos en coincidencias (PB − CDS)')],
  ];
  const tot = {};
  rep.dias.forEach((d) => d.rutas.forEach((r) => {
    const c = resumen(r.cds.salidas); const b = resumen(r.pb.salidas); const hs = porHora(r.cds.salidas, r.pb.salidas); const co = hs.filter((h) => h.coinc);
    const dif = co.reduce((a, h) => a + h.pb.v - h.cds.v, 0);
    R.push([{ v: d.fecha, s: 'fecha' }, dia(d.fecha), r.nombre, n(c.salidas), n(c.vendidos), n(c.capacidad), p(c.ocup), n(c.ingreso, 'soles'), n(c.sinDato), n(b.salidas), n(b.vendidos), n(b.capacidad), p(b.ocup), n(b.ingreso, 'soles'), n(co.length), n(dif)]);
    const t = tot[r.nombre] || (tot[r.nombre] = { cs: 0, cv: 0, cc: 0, ci: 0, csd: 0, ps: 0, pv: 0, pc: 0, pi: 0, co: 0, dif: 0 });
    t.cs += c.salidas; t.cv += c.vendidos; t.cc += c.capacidad; t.ci += c.ingreso; t.csd += c.sinDato; t.ps += b.salidas; t.pv += b.vendidos; t.pc += b.capacidad; t.pi += b.ingreso; t.co += co.length; t.dif += dif;
  }));
  if (rep.dias.length > 1) {
    R.push([]);
    Object.entries(tot).forEach(([ruta, t]) => R.push([{ v: 'TOTAL', s: 'total' }, { v: '', s: 'total' }, { v: ruta, s: 'total' }, { v: t.cs, s: 'total' }, { v: t.cv, s: 'total' }, { v: t.cc, s: 'total' },
      { v: t.cc ? t.cv / t.cc : '', s: 'totalPct' }, { v: t.ci, s: 'total' }, { v: t.csd, s: 'total' }, { v: t.ps, s: 'total' }, { v: t.pv, s: 'total' }, { v: t.pc, s: 'total' },
      { v: t.pc ? t.pv / t.pc : '', s: 'totalPct' }, { v: t.pi, s: 'total' }, { v: t.co, s: 'total' }, { v: t.dif, s: 'total' }]));
  }
  hojas.push({ nombre: 'Resumen', filas: R, filaEncabezado: 3, anchos: [12, 11, 12, 10, 11, 11, 11, 14, 11, 10, 11, 11, 11, 14, 12, 16], altos: { 3: 32 } });

  // ---- Por hora ----
  const PH = [[H('Fecha'), H('Ruta'), H('Hora'), H('CDS salidas', 'cds'), H('CDS vendidos', 'cds'), H('CDS capacidad', 'cds'), H('PB salidas', 'pb'), H('PB vendidos', 'pb'), H('PB capacidad', 'pb'), H('¿Coinciden?'), H('Diferencia (PB − CDS)')]];
  rep.dias.forEach((d) => d.rutas.forEach((r) => porHora(r.cds.salidas, r.pb.salidas).forEach((h) => {
    const s = h.coinc ? 'verde' : null; const w = (v, st) => ({ v, s: h.coinc ? 'verde' : st });
    PH.push([{ v: d.fecha, s: 'fecha' }, w(r.nombre), w(h.hora), w(h.cds.n || ''), w(h.cds.n ? h.cds.v : ''), w(h.cds.n ? h.cds.c : ''), w(h.pb.n || ''), w(h.pb.n ? h.pb.v : ''), w(h.pb.n ? h.pb.c : ''), w(h.coinc ? 'Sí' : ''), w(h.coinc ? h.pb.v - h.cds.v : '')]);
    void s;
  })));
  hojas.push({ nombre: 'Por hora', filas: PH, filaEncabezado: 0, anchos: [12, 12, 8, 10, 11, 11, 10, 11, 11, 11, 14], altos: { 0: 30 } });

  // ---- Salidas (detalle completo) ----
  const S = [[H('Fecha'), H('Día'), H('Ruta'), H('Empresa'), H('Hora salida'), H('Hora llegada'), H('Servicio'), H('Origen'), H('Destino'), H('Escalas'), H('Precio desde (S/)'), H('Capacidad'), H('Libres'), H('Vendidos'), H('% ocupación'),
    H('¿Se suma?'), H('Mismo bus que'), H('Vendidos por tipo de asiento'), H('Vendidos por piso'), H('Ingreso estimado'), H('Nota'), H('Última actualización'), H('N° actualizaciones')]];
  rep.dias.forEach((d) => d.rutas.forEach((r) => ['cds', 'pb'].forEach((k) => r[k].salidas.forEach((s) => {
    const g = !cuenta(s) ? 'gris' : null; const w = (v, st) => ({ v: v == null ? '' : v, s: g || st });
    S.push([{ v: d.fecha, s: 'fecha' }, w(dia(d.fecha)), w(r.nombre), w(EMP[k]), w(s.hora), w(s.llegada), w(s.servicio), w(s.origen), w(s.destino), w(s.escalas), w(s.precio, 'soles'),
      w(s.capacidad, 'entero'), w(s.libres, 'entero'), w(s.vendidos == null ? 'sin dato' : s.vendidos, 'entero'), w(s.capacidad && s.vendidos != null ? s.vendidos / s.capacidad : null, 'pct'),
      w(cuenta(s) ? 'Sí' : 'No'), w(s.duplicadoDe || ''),
      w(s.porTarifa ? Object.entries(s.porTarifa).map(([t, c]) => `${t}: ${c}`).join(' | ') : ''),
      w(s.porPiso ? Object.entries(s.porPiso).map(([t, c]) => `${t}: ${c}`).join(' | ') : ''),
      w(s.ingresoEstimado, 'soles'), w(s.nota || ''), w(fh(s.actualizado)), w(s.nAct ?? '', 'entero')]);
  }))));
  hojas.push({ nombre: 'Salidas', filas: S, filaEncabezado: 0, anchos: [12, 11, 12, 13, 9, 9, 16, 22, 20, 8, 10, 10, 8, 10, 10, 9, 24, 34, 20, 13, 60, 20, 12], altos: { 0: 30 } });

  // ---- Por servicio ----
  const PS = [[H('Fecha'), H('Ruta'), H('Empresa'), H('Servicio'), H('Salidas'), H('Vendidos'), H('Capacidad'), H('% ocupación'), H('Ingreso estimado')]];
  rep.dias.forEach((d) => d.rutas.forEach((r) => ['cds', 'pb'].forEach((k) => {
    const m = {};
    r[k].salidas.filter(cuenta).forEach((s) => { const x = m[s.servicio] || (m[s.servicio] = { n: 0, v: 0, c: 0, i: 0 }); x.n++; x.v += s.vendidos; x.c += s.capacidad || 0; x.i += s.ingresoEstimado || 0; });
    Object.entries(m).sort((a, b) => b[1].v - a[1].v).forEach(([sv, x]) => PS.push([{ v: d.fecha, s: 'fecha' }, r.nombre, EMP[k], sv, n(x.n), n(x.v), n(x.c), p(x.c ? x.v / x.c : null), n(k === 'cds' ? x.i : null, 'soles')]));
  })));
  hojas.push({ nombre: 'Por servicio', filas: PS, filaEncabezado: 0, anchos: [12, 12, 13, 18, 9, 10, 10, 11, 14] });

  // ---- Por tipo de asiento (ambas empresas) ----
  const PT = [[H('Fecha'), H('Ruta'), H('Empresa'), H('Tipo de asiento'), H('Precio (S/)'), H('Asientos vendidos'), H('Ingreso estimado')]];
  rep.dias.forEach((d) => d.rutas.forEach((r) => ['cds', 'pb'].forEach((k) => {
    const m = {};
    r[k].salidas.filter(cuenta).forEach((s) => Object.entries(s.porTarifa || {}).forEach(([t, c]) => { m[t] = (m[t] || 0) + c; }));
    Object.entries(m).sort((a, b) => b[1] - a[1]).forEach(([t, c]) => { const precio = Number(t.split('S/ ')[1]) || null; PT.push([{ v: d.fecha, s: 'fecha' }, r.nombre, EMP[k], t.split(' S/')[0], n(precio, 'soles'), n(c), n(precio ? precio * c : null, 'soles')]); });
  })));
  hojas.push({ nombre: 'Por tipo de asiento', filas: PT, filaEncabezado: 0, anchos: [12, 12, 13, 18, 12, 16, 16] });

  // ---- Actualizaciones (días monitoreados) ----
  if (rep.actualizaciones && rep.actualizaciones.length) {
    const A = [[H('Fecha y hora'), H('Tipo'), H('Minutos antes'), H('Ruta'), H('Empresa'), H('Salida'), H('Servicio'), H('Origen'), H('Vendidos antes'), H('Vendidos después'), H('Diferencia'), H('Resultado'), H('Intento'), H('Detalle')]];
    rep.actualizaciones.forEach((a) => {
      const g = a.ok ? null : 'gris'; const w = (v, st) => ({ v: v == null ? '' : v, s: g || st });
      A.push([w(fh(a.t)), w(TIPO_ACT[a.tipo] || a.tipo), w(a.m, 'entero'), w(a.ruta), w(EMP[a.emp]), w(a.hora), w(a.servicio), w(a.origen),
        w(a.antes, 'entero'), w(a.despues, 'entero'), w(a.ok && a.antes != null && a.despues != null ? a.despues - a.antes : null, 'entero'),
        w(a.ok ? 'Correcta' : a.cerrada ? 'Falló · salida terminada' : 'Falló'), w(a.intento ? `${a.intento}/${a.de}` : ''), w(a.error || a.detalle || '')]);
    });
    hojas.push({ nombre: 'Actualizaciones', filas: A, filaEncabezado: 0, anchos: [20, 16, 9, 12, 13, 8, 16, 22, 10, 10, 10, 10, 8, 60], altos: { 0: 30 } });
  }

  // ---- Info ----
  const sv = rep.servicios || {}; const sc = listaServicios(sv.cds); const sp = listaServicios(sv.pb);
  hojas.push({ nombre: 'Info', anchos: [30, 100], filas: [
    [{ v: 'Información del reporte', s: 'titulo' }], [],
    [{ v: 'Periodo', s: 'negrita' }, rep.desde === rep.hasta ? rep.desde : `${rep.desde} a ${rep.hasta}`],
    [{ v: 'Datos tomados', s: 'negrita' }, new Date(rep.generado).toLocaleString('es-PE', { timeZone: 'America/Lima' })],
    [{ v: 'Cruz del Sur · servicios incluidos', s: 'negrita' }, sc.incluidos.join(', ') || 'todos'],
    [{ v: 'Cruz del Sur · no incluidos', s: 'negrita' }, sc.excluidos.join(', ') || '—'],
    [{ v: 'Peru Bus · servicios incluidos', s: 'negrita' }, sp.incluidos.join(', ') || 'todos'],
    [{ v: 'Peru Bus · no incluidos', s: 'negrita' }, sp.excluidos.join(', ') || '—'], [],
    [{ v: 'Cómo se calcula', s: 'negrita' }],
    ['Vendidos Cruz del Sur', 'Asientos marcados como ocupados en el mapa de asientos de cada bus (todos los pisos y tarifas).'],
    ['Vendidos Peru Bus', 'Capacidad del bus (46) menos los "asientos restantes" que muestra su web.'],
    ['Mismo bus', 'Un bus que aparece desde varios terminales o hacia varios destinos se cuenta una sola vez. Las copias figuran en gris con "¿Se suma? = No".'],
    ['Sin dato', 'La web no entregó el mapa de asientos de esa salida; no se suma en los totales.'],
    ['Tipo de asiento', 'Cruz del Sur: tarifa de cada asiento ocupado en el mapa (REGULAR, VIP…). Peru Bus: cada bus tiene un solo tipo de asiento (el de su servicio), así que todos sus vendidos son de ese tipo.'],
    ['Ingreso estimado', 'Cruz del Sur: suma del precio de tarifa de cada asiento ocupado. Peru Bus: vendidos × precio que muestra la salida. No considera descuentos ni ventas a otro precio.'],
    ['Horarios coincidentes', 'Horas en que ambas empresas tienen una salida a la misma hora exacta.'],
    ['Aviso', 'Es una foto del momento de la consulta: los vendidos cambian con cada venta.'],
  ] });

  return crearXlsx(hojas);
}

module.exports = { construirExcel };
