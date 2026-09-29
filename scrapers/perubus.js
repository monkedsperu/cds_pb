// Peru Bus (plataforma kupos)
// Su servidor firma cada consulta y cifra la respuesta, así que no se consulta directo:
// se abre la página de resultados en un navegador real y se lee lo que muestra
// ("N Asientos restantes" por salida). Vendidos = capacidad del bus − restantes.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function a24h(txt) {
  // La web muestra "12:00 AM", "05:00 AM", "13:30 PM" (ya en 24 h) o "12:45 PM".
  const m = txt.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/);
  if (!m) return txt;
  let h = Number(m[1]);
  if (m[3] === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

async function scrapePeruBus(page, { origen, destino, fecha, config, log }) {
  const [y, mo, d] = fecha.split('-');
  const url = `https://www.perubus.com.pe/es/pasajes-bus/${origen},peru/${destino},peru?date_onward=${d}-${mo}-${y}`;
  log(`Peru Bus: abriendo búsqueda ${origen} → ${destino} (${d}/${mo}/${y})`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  const listo = async () => page.evaluate(() => {
    const t = document.body.innerText;
    if (/Asientos restantes/.test(t)) return 'ok';
    if (/No hay servicios|no encontramos|Sin resultados/i.test(t)) return 'vacio';
    return null;
  });

  let estado = null;
  for (let i = 0; i < 15 && !estado; i++) { await sleep(1000); estado = await listo(); }
  if (!estado) {
    // A veces la página se queda en "Por favor espera…" hasta que se pulsa Buscar.
    const boton = page.getByText('Buscar', { exact: true }).first();
    if (await boton.count()) await boton.click().catch(() => {});
    for (let i = 0; i < 25 && !estado; i++) { await sleep(1000); estado = await listo(); }
  }
  if (!estado) throw new Error('La web de Peru Bus no mostró resultados a tiempo.');
  if (estado === 'vacio') { log('Peru Bus: sin salidas para esa fecha.'); return []; }

  const crudas = await page.evaluate(() => {
    const t = document.body.innerText;
    return t.split(/\nSalida\n/).slice(1).map((p) => {
      const L = p.split('\n').map((s) => s.trim()).filter(Boolean);
      const horas = L.filter((s) => /^\d{1,2}:\d{2} (AM|PM)$/.test(s));
      const iLl = L.indexOf('Llegada');
      const precio = L.find((s) => /^S\/\s?\d/.test(s));
      const rest = (L.find((s) => /Asientos restantes/.test(s)) || '').match(/\d+/);
      return {
        fechaTxt: L[0], salida: horas[0] || '', llegada: horas[1] || '',
        servicio: iLl >= 0 ? L[iLl + 3] : '',
        precio: precio ? Number(precio.replace(/[^\d.]/g, '')) : null,
        restantes: rest ? Number(rest[0]) : null,
        agotado: L.includes('Agotado'),
      };
    });
  });

  const ddmm = `${d}/${mo}`;
  const cap = (config.peruBus && config.peruBus.capacidad) || { default: 46 };
  const salidas = crudas
    .filter((c) => c.salida && (!c.fechaTxt || c.fechaTxt.includes(ddmm)))
    .map((c) => {
      const capacidad = cap[c.servicio] || cap.default || 46;
      // "Agotado" = no quedan asientos: el bus está lleno (vendidos = capacidad).
      const lleno = c.agotado && c.restantes == null;
      const restantes = lleno ? 0 : c.restantes;
      const vendidos = restantes == null ? null : Math.max(0, capacidad - restantes);
      return {
        hora: a24h(c.salida), llegada: a24h(c.llegada), servicio: c.servicio,
        origen: origen === 'lima' ? 'Lima [Av. México 333]' : 'Ica', destino: destino === 'lima' ? 'Lima' : 'Ica',
        escalas: null, precio: c.precio, capacidad,
        libres: restantes,
        vendidos,
        // Peru Bus usa un solo tipo de asiento por bus (en el mapa, todos los asientos de un bus
        // "Servicio Vip" dicen "SERVICIO VIP"; los de un "Express", "Express"). Por eso el tipo de
        // asiento vendido es el del servicio, al precio que muestra la salida.
        porTarifa: vendidos == null ? null : { [`${c.servicio || 'Asiento'} S/ ${c.precio ?? '?'}`]: vendidos },
        ingresoEstimado: vendidos == null || !c.precio ? null : vendidos * c.precio,
        duplicadoDe: null,
        nota: lleno ? 'Agotado: la web ya no ofrece asientos (bus lleno).' : '',
      };
    })
    .sort((a, b) => a.hora.localeCompare(b.hora));
  log(`Peru Bus: ${salidas.length} salidas leídas`);
  return salidas;
}

module.exports = { scrapePeruBus };
