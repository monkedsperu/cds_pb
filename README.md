# Monitor Lima ⇄ Ica · Cruz del Sur vs Peru Bus

Aplicación web en Node.js que **monitorea cada día de viaje**: hace un recorrido inicial de todas las salidas y luego vuelve a leer cada salida poco antes de que parta. Para cada día ves, en pestañas separadas para Lima → Ica e Ica → Lima:

- los asientos vendidos de cada empresa, hora por hora;
- la comparación por franjas de 2 horas (quién vende más en cada una);
- la **curva de ventas** de cada salida (vendidos según las horas que faltaban para salir);
- las lecturas programadas de cada salida, con su resultado.

La página tiene dos secciones (arriba, en la barra):
- **⏱ Monitoreo diario** (`/`): el seguimiento automático descrito abajo.
- **📋 Reporte al instante** (`/reportes`): eliges el día (hoy o hasta 7 días adelante, configurable) y pulsas **📸 Generar reporte**: obtienes la foto de ese momento, sin seguimiento. Tiene su propia lista de "Reportes guardados" y un enlace para volver al monitoreo.

**Cómo está organizada la pantalla** (para no saturar: a la vista solo lo esencial, el resto en tooltips y desplegables):
- Arriba, el automático y los servicios ocupan una línea cada uno; "▸ Ver detalles" y el cursor sobre los servicios muestran el resto.
- Al abrir un día aparece una **franja fija** con el día que estás viendo (morada si está en monitoreo, verde si está completado; "HOY" / "MAÑANA"), la ruta y la vista: **📋 Tabla**, **📊 Gráfico**, **⏰ Por franjas** o **📈 Curva de ventas**. Se queda visible al bajar. En la lista de días, el que estás viendo lleva "👁 viendo".
- Debajo, una sola línea: "↻ Actualizar todo ahora", la próxima lectura y cuántas salidas quedan. "▸ Detalles" despliega los servicios, la semana anterior y más; las acciones de admin están en el menú "⋯".
- En la tabla, cada empresa muestra vendidos/capacidad; las salidas que ya cerraron o partieron quedan ocultas tras "▸ Mostrar las N salidas…". La leyenda de las lecturas está en el ⓘ del encabezado.
- La pantalla recuerda (en tu navegador) la vista elegida y qué desplegables dejaste abiertos.

Debajo de la cabecera, una **barra de estado** (en las dos secciones) muestra siempre: si el token de Cruz del Sur funciona, si el monitoreo automático está encendido, qué se está haciendo en ese momento, cuántas tareas esperan y cuál es la próxima lectura programada. Si Cruz del Sur rechaza el token, aparece un aviso rojo arriba (el admin tiene ahí el botón para cambiarlo). El servidor prueba el token solo cada 6 horas y ~30 minutos antes del inicio automático, para avisar **antes** de que falle el monitoreo de la madrugada.

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
Usa **pm2** para que el servidor esté siempre encendido: lo reinicia si se cae y lo arranca al prender la máquina. El proyecto trae `ecosystem.config.js`:
```
npm install -g pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup      # muestra un comando: cópialo y ejecútalo
```
- Ponle **nginx** delante con tu dominio y HTTPS (con HTTPS la cookie de sesión se marca como segura).
- Estado: `pm2 status`. Tras copiar una versión nueva o cambiar `config.json`: `pm2 restart monitor-buses`.
- **Logs:** además de la consola, todo queda en `logs/AAAA-MM-DD.log` (uno por día, hora de Lima; se guardan 14 días).
- **Sesiones:** se guardan en `data/sesiones.json`, así que reiniciar el servidor ya no cierra la sesión de nadie.

## Descargas
Botones en la cabecera del día o reporte abierto (junto a “▸ Detalles”), así se descarga justo lo que se está viendo. El Excel trae el día completo (las dos rutas), no solo la ruta o la pestaña visible:
- **⬇ Descargar Excel:** un `.xlsx` completo, con las hojas que se detallan abajo.
- **⬇ Excel histórico** (en la lista de días monitoreados): todos los días en un solo Excel, con una hoja "Resumen por día" (vendidos de cada empresa por día y ruta) y una hoja "Salidas" con el último dato de cada salida, a qué hora se tomó y cuántas horas antes de salir.
- **JSON** (solo admin): los datos crudos del reporte. El servidor también rechaza la descarga del JSON a quien no sea administrador.

Hojas del Excel:
- **Resumen:** por día y ruta, las salidas, vendidos, capacidad, % de ocupación, ingreso estimado y salidas sin dato de cada empresa, los horarios coincidentes y la diferencia. En un rango, además, trae los totales.
- **Por hora:** la comparación hora por hora, con los horarios coincidentes en verde.
- **Salidas:** el detalle de cada salida de ambas empresas: terminales, servicio, precio, capacidad, libres, vendidos, % de ocupación, si se suma o es el mismo bus, vendidos por tarifa y por piso, ingreso estimado y notas.
- **Por servicio:** vendidos y ocupación de Evolution, Suite, Express, etc.
- **Por tipo de asiento:** asientos vendidos e ingreso por tipo de asiento, de las dos empresas.
- **Evolución** (días monitoreados): cada lectura de cada salida, con la hora, las horas que faltaban para salir y los vendidos. Sirve para graficar la curva de ventas en Excel.
- **Info:** el periodo, la hora de captura, los servicios incluidos y excluidos, y cómo se calcula cada dato.

El Excel se genera en el servidor sin librerías externas, y también funciona con los reportes guardados antes.

## Tipos de asiento de Peru Bus
En Peru Bus cada bus tiene un solo tipo de asiento, el de su servicio: en el mapa de asientos, todos los de un bus "Servicio Vip" dicen SERVICIO VIP. Por eso los vendidos de Peru Bus se desglosan por tipo de asiento y precio (por ejemplo "Servicio Vip S/ 65: 83"), igual que en Cruz del Sur, al pasar el cursor sobre los vendidos. El ingreso estimado de Peru Bus usa el precio que muestra cada salida.

**Capacidad:** Peru Bus solo muestra los asientos restantes, así que vendidos = capacidad del bus − restantes. La capacidad de cada servicio se corrige en ⚙ Configuración → Servicios a consultar (casilla "cap." junto a cada servicio de Peru Bus; vacío = 46). Conviene confirmarla con el mapa de asientos de su web.

**Agotado:** cuando la web muestra una salida como "Agotado", el bus está lleno: se cuenta vendidos = capacidad (antes se tomaba como venta cerrada y se quedaba con la lectura anterior).

## Monitoreo diario (admin)
### Automático (⚙ Configuración → ⏱ Automático)
Todo lo que corre solo se configura en **una sola pestaña** (solo admin). Cada pantalla tiene además su tarjeta con el interruptor y un resumen, visible para todos:
- **Monitoreo automático:** a la hora indicada (hora de Lima, por defecto 03:00) inicia el día. Termina: **sin fecha de fin** o **el día** que elijas.
- **Lecturas antes de cada salida:** los minutos antes de cada salida para **Cruz del Sur** (por defecto 180, 120, 70 y 40) y, si quieres otros, para **Peru Bus** (por defecto, los mismos). Reintentos y espera entre reintentos.
- **Cierre de la venta online:** cuántos minutos antes de salir cierra cada empresa la venta en su web (por defecto 30). **Las dos empresas quitan la salida de su web unos 30 min antes**: una lectura después de eso solo descubre que ya cerró. Por eso no se programa ninguna lectura a partir del cierre; la vista previa avisa si algún minuto queda después.
- **Días siguientes** (ver más abajo) y **Reporte al instante:** la foto automática de hoy a las horas indicadas (por ejemplo `08:00, 14:00, 20:00`) con su propio fin, y hasta cuántos días adelante se puede pedir un reporte a mano. Si el servidor no estuvo activo a una hora y ya pasó más de una hora, esa corrida se omite.
- **Limpieza:** los reportes al instante con más de N días (por defecto 90) se borran solos. Los días monitoreados nunca se borran.

Cómo funciona:
1. A la hora indicada el servidor crea el día de hoy y hace el **recorrido inicial**: todas las salidas de todas las rutas, de las dos empresas. Así sabe a qué hora sale cada bus.
2. Luego, en cada lectura programada (por defecto 180, 120, 70 y 40 min antes), actualiza **solo esa salida**. En Cruz del Sur es 1 consulta (el mapa de asientos de ese bus); si el bus aparece desde varios terminales, se actualizan todas sus apariciones. En Peru Bus se abre la página de la ruta y se toma solo esa salida.
3. Si falla (429, sin respuesta, etc.) se reintenta hasta el número configurado, siempre antes de la hora de salida.
4. **Días siguientes:** a la misma hora hace también el recorrido inicial de los días siguientes (por defecto 3: si hoy es lunes, se monitorean ya martes, miércoles y jueves; cada día solo se agrega el nuevo). Mientras no les llegue su día, cada 3 a 5 h reciben una **actualización total**: se releen todas sus salidas, se suman las nuevas y se dan por terminadas las que ya no aparecen. Las lecturas antes de cada salida les llegan normalmente cuando se acerca su hora (una salida de las 01:00 tiene su lectura de 3 h antes a las 22:00 del día anterior). Al llegar su día, a la hora del cron, se hace una actualización total de inicio y sigue el plan normal.
5. **Hoy** recibe además una actualización total cada 4 a 5 h mientras queden salidas por partir.
6. Las tareas de fondo (días siguientes y actualizaciones totales periódicas) **esperan un buen momento**: corren cuando no hay ninguna lectura programada en los próximos 10 min y van después de todo lo demás en la cola. Si no aparece un hueco, se hacen igual al cumplirse el máximo de horas (el recorrido inicial de un día siguiente, a más tardar una hora después). Mientras esperan no bloquean la pantalla ni el cambio de token.
7. Las ventanas que ya pasaron cuando se hizo el recorrido inicial, o cuando la salida ya partió (por ejemplo, si el servidor estuvo apagado), se marcan como omitidas.
8. Hay dos carriles independientes que corren en paralelo: **monitoreo** (recorrido inicial y actualizaciones; las manuales van primero) y **reporte al instante**. Comparten un solo ritmo de consultas a Cruz del Sur (1 por segundo, una sola pausa ante un 429), así que correr los dos a la vez no aumenta la carga sobre la web: cada uno avanza un poco más lento. Cada pantalla muestra solo el progreso de su propio carril y “Cancelar consulta” cancela solo ese.

**Cómo leer las lecturas de cada salida** (columna "Lecturas antes de salir"): una etiqueta por lectura, con el minuto y su resultado. Al pasar el cursor se ve la hora exacta, los vendidos antes → después, el error o el motivo por el que no se hizo.
- `✔ 120'` verde: se leyó bien.
- `✖ 70'` rojo: falló (se conservan los vendidos anteriores).
- `🔒 40'` ámbar: esa lectura encontró la venta cerrada.
- `– 180'` gris tachado: no se hizo (la venta ya había cerrado, el día se inició después, o se cambiaron los minutos).
- `40' · 10:20` con borde punteado: pendiente, se leerá a esa hora.

Si se cambian los minutos con el día en curso, las lecturas que ya se hicieron con los minutos anteriores se siguen mostrando.

**Dato viejo:** si una salida cerró o partió y su última lectura correcta fue una hora o más antes, aparece "⚠ último dato X h antes del cierre": sus vendidos finales pueden ser más.

**Filas que ya cerraron:** se ven atenuadas y se pueden ocultar con "Ocultar las que ya cerraron o partieron" (la preferencia queda en tu navegador).

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
- **📜 Ver logs** (barra superior): consola con las últimas 200 líneas del servidor. Se puede filtrar por texto, ver solo avisos y errores, actualizar cada 3 s y copiar. Tras reiniciar el servidor empieza vacía; el historial completo queda en `logs/AAAA-MM-DD.log`.

**¿Por qué pueden bajar los vendidos?** Las webs marcan como ocupados también los asientos reservados mientras alguien está pagando. Si esa reserva vence sin pagarse, o se anula un pasaje, el asiento vuelve a quedar libre y en la siguiente lectura los vendidos bajan (por ejemplo 15 → 14, “-1”). No es un error de lectura.

En **Monitoreo diario** también se ve el bloque “🎫 Servicios que consulta el monitoreo” (solo lectura; el administrador tiene el botón para cambiarlos).

## Días monitoreados (grilla)
Haz clic en una fila para desplegar su registro de actualizaciones y otra vez para ocultarlo; el botón **📊 Ver** abre el día. Lista un día por fila: etiqueta de origen (⏱ Automático, 👤 Usuario, 👤 Admin), hora del recorrido inicial, lecturas (✔ correctas · 🔒 encontraron la venta cerrada, que no es un error · ✖ fallas), última y próxima, servicios y vendidos.

**Días en monitoreo en morado:** los días que se están monitoreando ahora (hoy y los siguientes) llevan una etiqueta morada ("● hoy · en monitoreo", "● mañana · en monitoreo") y una franja morada a la izquierda; los días cuyo recorrido inicial todavía espera en la cola aparecen con "⏳" punteado. En la tarjeta del automático, las fechas del periodo usan los mismos colores (morado = en monitoreo, ⏳ = en cola, verde = completado).

**👁 Ver hoy:** si el día de hoy ya existe, el botón principal lo abre directamente (antes decía "Iniciar monitoreo" y mostraba una confirmación).

**Semana anterior:** la cabecera de un día muestra los vendidos del mismo día de la semana anterior, si se monitoreó. El registro de cada día muestra cada actualización con su tipo (recorrido inicial, ⏱ N min antes, 👤 manual, ↻ todas), la salida, los vendidos antes → después y el resultado (con el número de intento). La grilla se minimiza haciendo clic en su título. El admin puede borrar un día con 🗑.

Los reportes de una sola consulta (los anteriores y los nuevos) están en la sección **📋 Reporte al instante**.

El Excel de un día monitoreado trae además la hoja **Actualizaciones** y, en "Salidas", la hora de la última actualización de cada salida.

## Reporte al instante
En **📋 Reporte al instante** se genera una foto de los vendidos del día elegido (hoy o un día próximo, hasta el máximo configurado en ⚙ Configuración → Monitoreo; por defecto 7 días) en ese momento. Si eliges un día que ya se está monitoreando, la página ofrece abrirlo en el monitoreo (tiene lecturas automáticas y curva de ventas) o generar la foto igual. Corre en su propio carril, en paralelo con el monitoreo: no espera a que termine un recorrido o una actualización (comparten el ritmo de consultas a Cruz del Sur). Los reportes antiguos de varios días se pueden seguir abriendo desde "Reportes guardados".

## Cómo se calculan los datos
- **Cruz del Sur:** hace la búsqueda del día y, por cada viaje, pide el mapa de asientos. Vendidos = asientos con `occupied: true`, sumando todos los pisos y tarifas.
- **Menos consultas:** un mismo bus aparece varias veces (Javier Prado + Atocongo, Ica + Hotel Las Dunas). El id de cada viaje trae un código de bus que se repite en todas esas apariciones, así que el mapa de asientos se pide **una sola vez por bus** y se copia a las demás. En el detalle, las copias aparecen en gris y no se suman dos veces.
- **Ritmo:** una consulta por segundo (`espacioEntreConsultasMs`), con dos en curso a la vez. Si Cruz del Sur responde HTTP 429, se hace **una sola** pausa (`pausaAnte429Ms`, 15 s) y se sigue apenas un poco más despacio. Los buses que fallen se reintentan una vez; si aún fallan quedan **"sin dato"** y no se suman.
- **Peru Bus:** vendidos = capacidad del servicio (por defecto 46, corregible en ⚙) − "asientos restantes" que muestra su página. "Agotado" = bus lleno.

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
