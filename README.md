# Monitor Lima ⇄ Ica · Cruz del Sur vs Peru Bus

Aplicación web en Node.js. Eliges **un día** o un **rango de fechas** y ves, en pestañas separadas para Lima → Ica e Ica → Lima:

- los asientos vendidos de cada empresa;
- los horarios en que salen las dos a la misma hora;
- la diferencia de vendidos entre ambas.

Si pasas el cursor sobre los vendidos de Cruz del Sur, aparece el desglose por servicio, tarifa y piso, y el ingreso estimado.

## Estructura
```
server.js               servidor web, acceso con contraseña, cola de consultas y progreso
scrapers/cruzdelsur.js  Cruz del Sur: solo consultas HTTP (fetch)
scrapers/perubus.js     Peru Bus: lee la página con un navegador sin ventana (opcional)
public/index.html       la pantalla principal
public/login.html       la pantalla de bloqueo
lib/xlsx.js             generador de Excel (sin dependencias)
lib/reporteExcel.js     contenido de cada hoja del Excel
data/                   reportes guardados (JSON)
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
- **Usuarios normales:** pueden generar reportes y elegir los servicios a consultar. No ven contraseñas ni el token.
- Tras 5 contraseñas incorrectas desde la misma IP, esa IP queda bloqueada unos minutos.
- Las sesiones duran 12 horas (`horasSesion` en `config.json`).

Cómo obtener el token: abre viajes.cruzdelsur.com.pe, busca un viaje, pulsa F12 → Red (Network) → filtra `one-api` → abre una consulta → Request Headers → `authorization`. Copia el valor completo.

## Servicios a consultar
En ⚙ Configuración → **Servicios a consultar** se marcan los servicios de cada empresa:
- **Cruz del Sur:** Evolution, Suite, Confort Suite, Ica Express, Ica Eco Express, Cruzero Plus.
- **Peru Bus:** Servicio Vip, Express, Express Paracas, Salon Cama.

Detalles:
- Por defecto están todos marcados. Si aparece un servicio nuevo, se agrega solo, ya marcado.
- La selección se guarda en `data/ajustes.json`, en el servidor, así que vale para todos los usuarios y no se pierde al reiniciar.
- En Cruz del Sur, desmarcar servicios **reduce las consultas** y acelera el reporte. En Peru Bus solo filtra el resultado, porque la página trae todo de una vez.
- Cada reporte indica arriba qué servicios incluyó.

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
Hay tres botones para el reporte abierto:
- **Exportar CSV:** una tabla simple con todas las salidas.
- **⬇ Descargar Excel:** un `.xlsx` completo, con las hojas que se detallan abajo.
- **JSON:** los datos crudos del reporte.

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

## Consulta automática diaria (admin)
En ⚙ Configuración → **Automático**, el administrador puede activar un reporte diario a una hora fija (hora de Lima). Ahí se elige:
- desde qué día consultar: hoy, mañana, etc.;
- cuántos días seguidos consultar.

Funcionamiento:
- El servidor lo genera solo, aunque nadie tenga la página abierta, y lo guarda con ⏱ en "Reportes guardados". Así se va armando un historial.
- Si a esa hora hay otra consulta en curso, lo intenta en los minutos siguientes, hasta 3 horas después.
- El resultado de la última ejecución se muestra en esa misma pestaña.

## Eliminar reportes (admin)
El administrador ve un botón 🗑 junto a "Reportes guardados" para borrar el reporte abierto.

## Búsqueda por varios días
Por defecto, solo el **administrador** ve la opción "Rango de fechas". El administrador puede permitírsela a los demás usuarios en ⚙ Configuración → **Permisos**. Ese permiso se guarda en `data/ajustes.json`. Además, el servidor también lo verifica, así que no se puede saltar desde el navegador.

## Cómo se calculan los datos
- **Cruz del Sur:** hace la búsqueda del día y, por cada viaje, pide el mapa de asientos. Vendidos = asientos con `occupied: true`, sumando todos los pisos y tarifas.
- **Menos consultas:** un mismo bus aparece varias veces (Javier Prado + Atocongo, Ica + Hotel Las Dunas). El id de cada viaje trae un código de bus que se repite en todas esas apariciones, así que el mapa de asientos se pide **una sola vez por bus** y se copia a las demás. En el detalle, las copias aparecen en gris y no se suman dos veces.
- **Ritmo:** una consulta por segundo (`espacioEntreConsultasMs`), con dos en curso a la vez. Si Cruz del Sur responde HTTP 429, se hace **una sola** pausa (`pausaAnte429Ms`, 15 s) y se sigue apenas un poco más despacio. Los buses que fallen se reintentan una vez; si aún fallan quedan **"sin dato"** y no se suman.
- **Peru Bus:** vendidos = capacidad (46) − "asientos restantes" que muestra su página.

## ¿Qué pasa si recargo la página mientras genera el reporte?
Nada se pierde: la consulta corre en el servidor, no en tu navegador. Al recargar, la página detecta la consulta en curso y vuelve a mostrar la barra de progreso. Puedes incluso cerrar la pestaña y volver después: el reporte queda guardado en "Reportes guardados".

Lo único que la corta es **reiniciar o detener el servidor** (`Ctrl+C`, `pm2 restart`). También puedes pararla con **Cancelar consulta**. Solo se permite una consulta a la vez.

## Tiempos
Con todos los servicios marcados, cada día y ruta toma alrededor de 1 minuto (unos 30 buses distintos, 2 consultas cada uno). Un rango de 7 días con las dos rutas toma unos 15 minutos. Desmarcar servicios lo acorta.

No conviene bajar `espacioEntreConsultasMs` de 1000: Cruz del Sur empieza a responder 429 y al final se tarda más.

## Límites
- Es una foto del momento: los vendidos cambian con cada venta.
- Si alguna web cambia sus consultas o su diseño, hay que ajustar el archivo correspondiente en `scrapers/`.
- Úsalo con moderación y revisa los términos de uso de cada sitio.
