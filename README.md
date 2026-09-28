# Monitor Lima ⇄ Ica · Cruz del Sur vs Peru Bus

Aplicación web en Node.js que **monitorea cada día de viaje**: hace un recorrido inicial de todas las salidas y luego vuelve a leer cada salida poco antes de que parta. Para cada día ves, en pestañas separadas para Lima → Ica e Ica → Lima:

- los asientos vendidos de cada empresa;
- los horarios en que salen las dos a la misma hora;
- la diferencia de vendidos entre ambas.

La página tiene dos secciones (arriba, en la barra):
- **⏱ Monitoreo diario** (`/`): el seguimiento automático descrito abajo.
- **📋 Reporte al instante** (`/reportes`): pulsas **📸 Generar reporte de hoy** y obtienes la foto de ese momento, sin seguimiento. Tiene su propia lista de "Reportes guardados" y un enlace para volver al monitoreo.

En las dos secciones se trabaja **solo con el día de hoy** (hora de Lima): no se elige fecha ni rango. El servidor también lo exige.

Si pasas el cursor sobre los vendidos de Cruz del Sur, aparece el desglose por servicio, tarifa y piso, y el ingreso estimado.

## Estructura
```
server.js               servidor web, acceso con contraseña y API
lib/monitor.js          monitoreo por día: recorrido inicial, programador, cola y reintentos
scrapers/cruzdelsur.js  Cruz del Sur: solo consultas HTTP (fetch)
scrapers/perubus.js     Peru Bus: lee la página con un navegador sin ventana (opcional)
public/index.html       la pantalla principal
public/login.html       la pantalla de bloqueo
lib/xlsx.js             generador de Excel (sin dependencias)
lib/reporteExcel.js     contenido de cada hoja del Excel
data/                   días monitoreados (dia_AAAA-MM-DD.json) y reportes anteriores
config.json             ajustes generales
.env                    contraseñas y token (lo creas tú a partir de .env.example)
```

## 1. Instalar
Requiere Node.js 18 o superior.
```
npm install
npx playwright install --with-deps chromium     # solo si usarás Peru Bus
```
Si no usarás Peru Bus, pon `"peruBus": { "activo": false }` en `config.json`.

## 2. Contraseñas y token (archivo .env)
Copia `.env.example` como `.env` y edítalo:
```
ADMIN_PASSWORD=una-clave-larga-para-el-admin
APP_PASSWORDS=
CDS_TOKEN=
```
- **ADMIN_PASSWORD:** la contraseña del administrador. El administrador ve en ⚙ Configuración:
  - **Contraseñas:** agregar, ver, copiar y eliminar contraseñas de usuarios. Se guardan en `APP_PASSWORDS` dentro de `.env`. Al eliminar una, se cierran las sesiones abiertas con ella.
  - **Token Cruz del Sur:** pegar el token, probarlo y guardarlo.
  - La contraseña de administrador solo se cambia editando `.env`.
- **Usuarios normales:** pueden iniciar y actualizar días y elegir los servicios a consultar. No ven contraseñas ni el token.
- Tras 5 contraseñas incorrectas desde la misma IP, esa IP queda bloqueada unos minutos.
- Las sesiones duran 12 horas (`horasSesion` en `config.json`).

Cómo obtener el token: abre viajes.cruzdelsur.com.pe, busca un viaje, pulsa F12 → Red (Network) → filtra `one-api` → abre una consulta → Request Headers → `authorization`. Copia el valor completo.

## Servicios a consultar (solo admin)
En ⚙ Configuración → **Servicios a consultar** el administrador marca los servicios de cada empresa (Cruz del Sur: Evolution, Suite, Confort Suite…; Peru Bus: Servicio Vip, Express…). Los demás usuarios la ven en solo lectura; el servidor también lo exige.

- La selección se guarda en `data/ajustes.json` y vale para el monitoreo diario, el cron del reporte y como selección inicial del reporte al instante. Si aparece un servicio nuevo, se agrega solo, ya marcado.
- En Cruz del Sur, desmarcar servicios **reduce las consultas**. En Peru Bus solo filtra, porque la página trae todo de una vez.
- De cada bus consultado se cuentan todos sus asientos y tarifas; los servicios eligen **qué buses** se consultan.

**Si hoy ya se está monitoreando** y el administrador cambia la selección, al guardar se le muestra qué cambiaría y elige:
- **Aplicar también a hoy:** las salidas de los servicios desmarcados salen del día y no se consultan más (quedan guardadas aparte en el archivo como registro); de los servicios nuevos se leen ahora las salidas que aún no parten y entran al monitoreo con sus lecturas programadas. Queda anotado en el registro del día (“⚙ Servicios · admin”).
- **Cancelar:** hoy sigue con la selección anterior y el cambio aplica desde el próximo recorrido.

**Reporte al instante:** cualquier usuario elige, en “🎫 Servicios de este reporte”, qué servicios incluir en el reporte que va a generar (arranca con la selección de la configuración). No cambia la configuración global. El cron del reporte usa siempre la configuración global.

## 3. Ejecutar
```
npm start
```
Abre http://localhost:3000. Si el puerto está ocupado: `PORT=3001 npm start`.

## 4. En un servidor (Amazon EC2 u otro)
```
npm install -g pm2
pm2 start server.js --name monitor-buses
pm2 save && pm2 startup
```
- Ponle **nginx** delante con tu dominio y HTTPS (con HTTPS la cookie de sesión se marca como segura).
- Para ver lo que pasa: `pm2 logs monitor-buses`. Tras cambiar `config.json`: `pm2 restart monitor-buses`.

## Descargas
Botones para el reporte abierto:
- **⬇ Descargar Excel:** un `.xlsx` completo, con las hojas que se detallan abajo.
- **Exportar CSV** (solo admin): una tabla simple con todas las salidas.
- **JSON** (solo admin): los datos crudos del reporte. El servidor también rechaza la descarga del JSON a quien no sea administrador.

Hojas del Excel:
- **Resumen:** por día y ruta, las salidas, vendidos, capacidad, % de ocupación, ingreso estimado y salidas sin dato de cada empresa, los horarios coincidentes y la diferencia. En un rango, además, trae los totales.
- **Por hora:** la comparación hora por hora, con los horarios coincidentes en verde.
- **Salidas:** el detalle de cada salida de ambas empresas: terminales, servicio, precio, capacidad, libres, vendidos, % de ocupación, si se suma o es el mismo bus, vendidos por tarifa y por piso, ingreso estimado y notas.
- **Por servicio:** vendidos y ocupación de Evolution, Suite, Express, etc.
- **Por tipo de asiento:** asientos vendidos e ingreso por tipo de asiento, de las dos empresas.
- **Info:** el periodo, la hora de captura, los servicios incluidos y excluidos, y cómo se calcula cada dato.

El Excel se genera en el servidor sin librerías externas, y también funciona con los reportes guardados antes.

## Tipos de asiento de Peru Bus
En Peru Bus cada bus tiene un solo tipo de asiento, el de su servicio: en el mapa de asientos, todos los de un bus "Servicio Vip" dicen SERVICIO VIP. Por eso los vendidos de Peru Bus se desglosan por tipo de asiento y precio (por ejemplo "Servicio Vip S/ 65: 83"), igual que en Cruz del Sur, al pasar el cursor sobre los vendidos. El ingreso estimado de Peru Bus usa el precio que muestra cada salida.

## Monitoreo diario (admin)
### Crons (uno por pantalla, independientes)
Cada pantalla tiene su tarjeta **⏱ Cron**, visible para todos; solo el administrador la cambia:
- **⏱ Cron del monitoreo diario:** cada día dentro de su vigencia, a la hora indicada (hora de Lima, por defecto 03:00), crea el día de hoy y hace el recorrido inicial sin que nadie entre.
- **⏱ Cron del reporte al instante:** cada día dentro de su vigencia, genera solo una foto de hoy a cada hora indicada (por ejemplo `08:00, 14:00, 20:00`). Esos reportes aparecen como "⏱ Automático" en "Reportes guardados". Si el servidor no estuvo activo a una hora y ya pasó más de una hora, esa corrida se omite.

Cada cron se **enciende / apaga** con su interruptor y se programa con **✎ Programar horario y fechas**: hora(s) y vigencia **♾ Perpetuo** o **📅 Entre fechas** (desde / hasta, con atajos de 7 días, 30 días o resto del mes). La vigencia del monitoreo diario también limita las lecturas antes de cada salida: fuera de ella no se toma ninguna muestra automática.

En ⚙ Configuración → **Monitoreo** quedan los ajustes de las lecturas:
- **Actualizar cada salida antes de que parta:** encendido por defecto. Se configuran los **minutos antes** (por ejemplo `30,20,10`), los **reintentos** y la **espera entre reintentos**, con botones rápidos y un ejemplo en vivo.

Cómo funciona:
1. A la hora indicada el servidor crea el día de hoy y hace el **recorrido inicial**: todas las salidas de todas las rutas, de las dos empresas. Así sabe a qué hora sale cada bus.
2. Luego, en cada ventana (30, 20, 10 min antes), actualiza **solo esa salida**. En Cruz del Sur es 1 consulta (el mapa de asientos de ese bus); si el bus aparece desde varios terminales, se actualizan todas sus apariciones. En Peru Bus se abre la página de la ruta y se toma solo esa salida.
3. Si falla (429, sin respuesta, etc.) se reintenta hasta el número configurado, siempre antes de la hora de salida.
4. Las ventanas que ya pasaron cuando se hizo el recorrido inicial, o cuando la salida ya partió (por ejemplo, si el servidor estuvo apagado), se marcan como omitidas.
5. Hay dos carriles independientes que corren en paralelo: **monitoreo** (recorrido inicial y actualizaciones; las manuales van primero) y **reporte al instante**. Comparten un solo ritmo de consultas a Cruz del Sur (1 por segundo, una sola pausa ante un 429), así que correr los dos a la vez no aumenta la carga sobre la web: cada uno avanza un poco más lento. Cada pantalla muestra solo el progreso de su propio carril y “Cancelar consulta” cancela solo ese.

**Salidas que ya no aparecen:** si al actualizar una salida la web (Peru Bus o Cruz del Sur) ya no la muestra, se da por **terminada**: no se reintenta y no se vuelve a consultar. En la tabla aparece como "🔒 Cerró la venta" con la hora en que se detectó; se conservan los vendidos de la última lectura.

**Fin del día:** cuando ya no quedan salidas por partir (todas partieron o ya no aparecen en la web), el día queda **COMPLETADO**. Desde ahí no se consulta nada más, ni automático ni manual, y los datos quedan como registro final. Las salidas que ya partieron tampoco se vuelven a consultar nunca.

**Iniciar monitoreo a mano:** cualquier usuario puede iniciar el día de hoy con **▶ Iniciar monitoreo**. Si ese día ya se está monitoreando, aparece una confirmación:
- **Ver monitoreo actual:** lo abre.
- **Forzar actualización:** vuelve a leer ahora todas las salidas que aún no parten. Las que ya partieron no se tocan. No está disponible si el día ya está COMPLETADO.

**Días considerados:** debajo del botón, todos los usuarios ven la vigencia (con los días ya monitoreados marcados), si el inicio automático está activo y a qué hora, y si hoy ya se está monitoreando. Solo el administrador puede cambiar esa configuración.

## Actualizar al instante
Con un día abierto:
- **↻ Actualizar ahora todos los horarios** (arriba): todas las salidas que aún no parten, en las dos rutas, con barra de progreso.
- **↻ Actualizar ahora todos los horarios de <ruta>** (sobre la tabla "Comparación por hora"): lo mismo, solo para la ruta visible.
- **↻ Actualizar** en cada fila de la comparación: todas las salidas de esa hora en la ruta visible.
- **↻ Actualizar** en cada salida (tablas "Todas las salidas…"): solo esa salida.

Mientras tanto:
- Una columna chica por cada lectura programada (por ejemplo **30' · 20' · 10'**) indica si se hizo: ✔ hecha, ✖ falló, ⏳ en cola, ○ pendiente, – omitida, 🔒 esa lectura encontró la venta cerrada (y 🔒 atenuado: ya no se hizo porque la venta había cerrado). Las lecturas hechas antes del cierre siguen mostrándose. En la tabla por hora hay un ícono por cada salida de esa hora; al pasar el cursor se ve la empresa, la salida y la hora exacta de la lectura.
- Cada fila muestra su **última actualización** y su **próxima actualización programada** (hora, cuántos minutos antes de la salida y cuánto falta), o "partió" si ya salió. Al pasar el cursor por la última actualización se ve la evolución de los vendidos en cada lectura.
- Una fila que se está actualizando queda **en gris y bloqueada** ("actualizando…" o "en cola") hasta que termina.
- Al terminar aparece un **aviso** abajo a la derecha con lo que cambió: salida, vendidos antes → después y la diferencia. Si falló, dice por qué y si se reintentará. Cuando se actualizan muchas salidas juntas, sale un solo aviso con el resumen y los cambios más grandes.
- La página se refresca sola: cada 3 s revisa si hubo cambios.

**Avisos con sonido:** cada aviso suena (tonos generados por el navegador, sin archivos): uno alegre y el aviso resaltado en verde con la diferencia en grande cuando hubo ventas, uno descendente y el aviso en ámbar (“↩ Se liberaron asientos”) cuando los vendidos **bajan**, uno suave si no hubo cambios, uno grave si falló y una fanfarria cuando el día queda COMPLETADO. El botón 🔔 / 🔕 de la barra superior los silencia; la preferencia se guarda en una cookie (`sonido=0`). Los navegadores solo permiten sonar después de que hiciste algún clic en la página.

Las acciones delicadas (actualizar todos los horarios, detener / reanudar, eliminar, cancelar consulta, borrar contraseñas, aplicar servicios a hoy) piden confirmación en un diálogo propio de la página (no el del navegador, que puede quedar bloqueado).

## Solo el administrador
- **⏹ Detener actualizaciones / ▶ Reanudar** (en la cabecera del día): detener quita de la cola todo lo de ese día y no se consulta nada hasta reanudar. Al reanudar, las ventanas que pasaron mientras estuvo detenido se omiten.
- **🗑 Eliminar día** (en la cabecera del día o en la grilla): se borra **de inmediato**, aunque se esté actualizando; lo que estaba en curso para ese día se descarta y no vuelve a escribir el archivo.
- **Cancelar consulta** (barra de progreso).
- **📜 Ver logs** (barra superior): consola con las últimas 200 líneas del servidor (se guardan solo en memoria, con tope fijo). Se puede filtrar por texto, ver solo avisos y errores, actualizar cada 3 s y copiar. Tras reiniciar el servidor empieza vacía; el historial completo sigue en `pm2 logs monitor-buses`.

**¿Por qué pueden bajar los vendidos?** Las webs marcan como ocupados también los asientos reservados mientras alguien está pagando. Si esa reserva vence sin pagarse, o se anula un pasaje, el asiento vuelve a quedar libre y en la siguiente lectura los vendidos bajan (por ejemplo 15 → 14, “-1”). No es un error de lectura.

En **Monitoreo diario** también se ve el bloque “🎫 Servicios que consulta el monitoreo” (solo lectura; el administrador tiene el botón para cambiarlos).

## Días monitoreados (grilla)
Haz clic en una fila para desplegar su registro de actualizaciones y otra vez para ocultarlo; el botón **📊 Ver** abre el día. Lista un día por fila: etiqueta de origen (⏱ Automático, 👤 Usuario, 👤 Admin), hora del recorrido inicial, actualizaciones correctas y fallidas, última y próxima, servicios y vendidos. El registro de cada día muestra cada actualización con su tipo (recorrido inicial, ⏱ N min antes, 👤 manual, ↻ todas), la salida, los vendidos antes → después y el resultado (con el número de intento). La grilla se minimiza haciendo clic en su título. El admin puede borrar un día con 🗑.

Los reportes de una sola consulta (los anteriores y los nuevos) están en la sección **📋 Reporte al instante**.

El Excel de un día monitoreado trae además la hoja **Actualizaciones** y, en "Salidas", la hora de la última actualización de cada salida.

## Reporte al instante
En **📋 Reporte al instante** se genera una foto de los vendidos de hoy en ese momento. Corre en su propio carril, en paralelo con el monitoreo: no espera a que termine un recorrido o una actualización (comparten el ritmo de consultas a Cruz del Sur). Los reportes antiguos de varios días se pueden seguir abriendo desde "Reportes guardados".

## Cómo se calculan los datos
- **Cruz del Sur:** hace la búsqueda del día y, por cada viaje, pide el mapa de asientos. Vendidos = asientos con `occupied: true`, sumando todos los pisos y tarifas.
- **Menos consultas:** un mismo bus aparece varias veces (Javier Prado + Atocongo, Ica + Hotel Las Dunas). El id de cada viaje trae un código de bus que se repite en todas esas apariciones, así que el mapa de asientos se pide **una sola vez por bus** y se copia a las demás. En el detalle, las copias aparecen en gris y no se suman dos veces.
- **Ritmo:** una consulta por segundo (`espacioEntreConsultasMs`), con dos en curso a la vez. Si Cruz del Sur responde HTTP 429, se hace **una sola** pausa (`pausaAnte429Ms`, 15 s) y se sigue apenas un poco más despacio. Los buses que fallen se reintentan una vez; si aún fallan quedan **"sin dato"** y no se suman.
- **Peru Bus:** vendidos = capacidad (46) − "asientos restantes" que muestra su página.

## ¿Qué pasa si recargo la página o reinicio el servidor?
Todo corre en el servidor, no en tu navegador: puedes cerrar la pestaña y volver después. Cada actualización se guarda de inmediato en `data/dia_….json`.

Si se reinicia el servidor, se corta lo que estaba en curso, pero al volver a arrancar el programador retoma las ventanas pendientes de cada día. El recorrido inicial o "Actualizar todas" se pueden parar con **Cancelar consulta**.

## Tiempos
Con todos los servicios marcados, el recorrido inicial toma alrededor de 1 minuto por ruta (unos 30 buses distintos, 2 consultas cada uno). Cada actualización programada de una salida de Cruz del Sur toma unos segundos; la de Peru Bus, lo que tarde en cargar su página (unos 10–20 s). Desmarcar servicios lo acorta.

No conviene bajar `espacioEntreConsultasMs` de 1000: Cruz del Sur empieza a responder 429 y al final se tarda más.

## Límites
- Es una foto del momento: los vendidos cambian con cada venta.
- Si alguna web cambia sus consultas o su diseño, hay que ajustar el archivo correspondiente en `scrapers/`.
- Úsalo con moderación y revisa los términos de uso de cada sitio.
