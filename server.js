const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');
const { crearRecuperacion } = require('./recuperacion');

// ---- Fecha y hora en horario de España (Render trabaja en UTC) ----
const ZONA_HORARIA = 'Europe/Madrid';
function horaMadrid(fecha) {
  return new Date(fecha || Date.now()).toLocaleTimeString('es-ES', { timeZone: ZONA_HORARIA, hour: '2-digit', minute: '2-digit' });
}
function fechaHoraMadrid(fecha) {
  const f = new Date(fecha || Date.now());
  const dia = f.toLocaleDateString('es-ES', { timeZone: ZONA_HORARIA, day: '2-digit', month: '2-digit', year: 'numeric' });
  return `${dia} · ${horaMadrid(f)}`;
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 5 * 1024 * 1024 });

app.use((req, res, next) => {
  res.set('Referrer-Policy', 'no-referrer');
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ---- Fotos de perfil aprobadas (solo las autorizadas por el administrador se sirven aqui) ----
const avataresCache = new Map(); // usuarioClave -> { buf, mime, v }
function dataUrlABuffer(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const buf = Buffer.from(m[2], 'base64');
  const esJpg = buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
  const esPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
  const esWebp = buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';
  if (!(esJpg || esPng || esWebp)) return null;
  return { buf, mime: m[1] };
}
app.get('/avatar/:clave', (req, res) => {
  const a = avataresCache.get(String(req.params.clave || '').toLowerCase());
  if (!a) return res.status(404).end();
  res.set('Content-Type', a.mime);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.send(a.buf);
});

// La IP real llega en CF-Connecting-IP (Cloudflare la escribe y no se puede falsificar a través de él).
// Si no viniera, se usa X-Forwarded-For como hasta ahora.
function ipDeCabeceras(headers, directa) {
  const cf = String(headers['cf-connecting-ip'] || '').trim();
  if (cf) return cf;
  return String(headers['x-forwarded-for'] || directa || '').split(',')[0].trim();
}
function obtenerIPDesdeRequest(req) {
  return ipDeCabeceras(req.headers, req.socket.remoteAddress);
}

app.post('/api/apelar-baneo', async (req, res) => {
  const ip = obtenerIPDesdeRequest(req);
  const mensaje = String((req.body && req.body.mensaje) || '').trim().slice(0, 500);
  if (!mensaje) return res.status(400).json({ error: 'Escribe un mensaje.' });
  if (!baneadosCol) return res.status(503).json({ error: 'No disponible ahora mismo.' });

  await baneadosCol.updateOne(
    { ip },
    { $push: { mensajesApelacion: { texto: mensaje, fecha: new Date() } } }
  );

  [adminSocketId, ...moderadores].filter(Boolean).forEach(id => {
    io.to(id).emit('sistema', { texto: '📨 Alguien bloqueado ha dejado un mensaje. Revísalo en "IPs bloqueadas".' });
  });

  res.json({ ok: true });
});

// ---- Configuracion de limites ----
const MAX_SALAS = 10;
const MAX_SALAS_POR_USUARIO = 3;
const MAX_MODERADORES = 5;
const MAX_PRIVADOS_POR_USUARIO = 2;
const MAX_TAMANO_IMAGEN = 4 * 1024 * 1024; // 4MB en base64
const MAX_INTENTOS_LOGIN = 3;
const BLOQUEO_LOGIN_MS = 15 * 60 * 1000;
const intentosLogin = new Map(); // usuarioClave -> { intentos, bloqueadoHasta }
const ADMIN_KEY = process.env.ADMIN_KEY || 'CAMBIA-ESTA-CLAVE';

// Copia de las imagenes de las salas publicas para moderacion (24h) - no se usa para privados
const imagenesModeracion = new Map(); // id -> { dataUrl, nick, salaId, fecha }
const MAX_IMAGENES_RETENIDAS = 40;    // tope para no llenar la memoria del servidor gratuito

// ---- Mensajes recientes de cada sala (solo en memoria, hasta 100) ----
// Sirven para comprobar que una respuesta o una reacción apuntan a un mensaje real (nadie puede inventar citas).
const MAX_RECIENTES_POR_SALA = 100;
const REACCIONES_PERMITIDAS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
function recordarMensaje(sala, msg) {
  if (!sala.recientes) sala.recientes = [];
  sala.recientes.push({ id: msg.id, nick: msg.nick, tipo: msg.tipo, texto: msg.tipo === 'imagen' ? '' : msg.texto, reacciones: new Map() });
  if (sala.recientes.length > MAX_RECIENTES_POR_SALA) sala.recientes.shift();
}
const resumenCita = (m) => (m.tipo === 'imagen' ? '📷 Imagen' : String(m.texto).slice(0, 90));

function esImagenValida(dataUrl) {
  return typeof dataUrl === 'string' && /^data:image\/(png|jpe?g|gif|webp|bmp|svg\+xml);base64,/.test(dataUrl) && dataUrl.length <= MAX_TAMANO_IMAGEN;
}

// ---- Palabras para nicks aleatorios (usuarios no registrados) ----
const ADJETIVOS = ['Curioso', 'Sereno', 'Amable', 'Despierto', 'Ligero', 'Sabio', 'Alegre', 'Tranquilo'];
const ANIMALES = ['Zorro', 'Colibri', 'Delfin', 'Lince', 'Buho', 'Nutria', 'Halcon', 'Panda'];

function generarNick() {
  const a = ADJETIVOS[Math.floor(Math.random() * ADJETIVOS.length)];
  const n = ANIMALES[Math.floor(Math.random() * ANIMALES.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${a}${n}${num}`;
}

// ---- Conexion a la base de datos (guarda cuentas de forma permanente) ----
let usuariosCol = null;
let notasStaffCol = null;
let salasFijasCol = null;
const MAX_AVATAR_BASE64 = 90 * 1024;
let estadisticasCol = null;
let tokensCuentaCol = null;

const recuperacion = crearRecuperacion({
  app,
  bcrypt,
  getUsuarios: () => usuariosCol,
  getTokens: () => tokensCuentaCol,
  // Al cambiar la contraseña: se quitan los bloqueos de la cuenta y se expulsan sus sesiones abiertas
  alCambiarContrasena: (uClave) => {
    intentosLogin.delete(uClave);
    io.sockets.sockets.forEach(s => {
      if (s.data && s.data.usuario && s.data.usuario.toLowerCase() === uClave) s.disconnect(true);
    });
  }
});
async function conectarDB() {
  if (!process.env.MONGODB_URI) {
    console.log('Aviso: no hay MONGODB_URI configurada. El registro de usuarios no estara disponible.');
    return;
  }
  const cliente = new MongoClient(process.env.MONGODB_URI);
  await cliente.connect();
  usuariosCol = cliente.db('chat_educativo').collection('usuarios');

  // Migracion: las cuentas creadas antes de este cambio no tienen "usuarioClave" todavia
  const antiguas = await usuariosCol.find({ usuarioClave: { $exists: false } }).toArray();
  for (const doc of antiguas) {
    await usuariosCol.updateOne({ _id: doc._id }, { $set: { usuarioClave: doc.usuario.toLowerCase() } });
  }

  await usuariosCol.createIndex({ usuarioClave: 1 }, { unique: true });
  baneadosCol = cliente.db('chat_educativo').collection('baneados');
  await baneadosCol.createIndex({ ip: 1 }, { unique: true });
  notasStaffCol = cliente.db('chat_educativo').collection('notasStaff');
  estadisticasCol = cliente.db('chat_educativo').collection('estadisticas');
  tokensCuentaCol = cliente.db('chat_educativo').collection('tokensCuenta');
  historialBloqueosCol = cliente.db('chat_educativo').collection('historialBloqueos');
  salasFijasCol = cliente.db('chat_educativo').collection('salasFijas');
  await tokensCuentaCol.createIndex({ expira: 1 }, { expireAfterSeconds: 0 }); // Mongo borra los enlaces caducados
  await tokensCuentaCol.createIndex({ hash: 1 });
  await cargarBaneados();
  await cargarSalasFijas();
  await cargarAvatares();
  console.log('Conectado a la base de datos correctamente');
}

// ---- Estado en memoria de la sesion en curso ----
const usuariosConectados = new Map(); // socket.id -> nick actual
const salas = new Map();              // salaId -> { id, nombre, creador, usuarios:Set(socketId) }

// Sala fija, oculta y permanente solo para admin/moderadores. Nadie mas sabe que existe.
salas.set('staff', {
  id: 'staff', nombre: '👑 Sala Staff', creador: 'sistema',
  usuarios: new Set(), vacioDesde: null, permanente: true, oculta: true
});

// La Plaza: sala fija y pública, punto de encuentro de todo el mundo. No se puede cerrar nunca.
salas.set('plaza', {
  id: 'plaza', nombre: 'La Plaza', creador: 'sistema',
  usuarios: new Set(), vacioDesde: null, permanente: true, fija: true
});
let adminSocketId = null;
const moderadores = new Set();        // socketId

function esModOAdmin(socketId) {
  return socketId === adminSocketId || moderadores.has(socketId);
}

async function cargarAvatares() {
  if (!usuariosCol) return;
  try {
    const docs = await usuariosCol.find({ avatar: { $exists: true } }).toArray();
    docs.forEach(d => {
      const r = d.avatar && dataUrlABuffer(d.avatar.data);
      if (r) avataresCache.set(d.usuarioClave, { ...r, v: d.avatar.v || 1 });
    });
  } catch (e) { console.log('No se pudieron cargar las fotos de perfil:', e.message); }
}
function mapaAvatares() {
  const o = {};
  avataresCache.forEach((a, k) => { o[k] = a.v; });
  return o;
}

// ---- Icono de cada sala segun su nombre (palabras clave en español; si no reconoce nada, pone 💬) ----
const ICONOS_SALA = {
  '⚽': 'futbol soccer liga champions balon porra penalti',
  '🏀': 'baloncesto basket nba',
  '🏅': 'deporte deportes deportivo',
  '🎾': 'tenis padel',
  '🏊': 'natacion piscina nadar',
  '🚴': 'ciclismo bici bicicleta bicicletas ciclistas',
  '🏃': 'running correr atletismo maraton corredores',
  '🏋️': 'gimnasio gym fitness pesas crossfit entrenamiento',
  '🧘': 'yoga meditacion mindfulness relajacion',
  '🥊': 'boxeo mma karate judo',
  '🏎️': 'formula f1 carreras rallies',
  '🚗': 'coches coche automovil motor',
  '🏍️': 'motos moto motociclismo',
  '🎵': 'musica canciones rock pop rap reggaeton flamenco jazz hiphop dj playlist cantar',
  '🎤': 'karaoke cantantes conciertos',
  '🎸': 'guitarra bandas grupos',
  '🎹': 'piano',
  '🎬': 'cine peliculas pelis films cortos',
  '📺': 'series television tv netflix tele',
  '🎮': 'juegos videojuegos gamers gaming gamer play ps5 ps4 xbox nintendo fortnite minecraft consola consolas',
  '♟️': 'ajedrez',
  '🎲': 'dados rol parchis mesa',
  '🃏': 'cartas poker mus brisca tute',
  '📚': 'libros libro lectura lectores leer literatura novelas novela poesia',
  '✍️': 'escritores escribir relatos',
  '🎨': 'arte dibujo pintura manualidades',
  '📷': 'fotografia fotos foto',
  '💻': 'tecnologia informatica programacion programadores ordenadores ordenador pc linux android iphone apps internet',
  '🤖': 'ia inteligencia robots robotica',
  '🔬': 'ciencia ciencias fisica quimica biologia',
  '🚀': 'espacio astronomia nasa',
  '🌍': 'viajes viajar viajeros turismo mundo mochileros',
  '✈️': 'vuelos aviones aviacion',
  '🍳': 'cocina cocineros recetas cocinar gastronomia reposteria',
  '🍷': 'vino vinos tapas',
  '🍺': 'cerveza cervezas',
  '☕': 'cafe cafeteria tertulia',
  '🐶': 'perros perro',
  '🐱': 'gatos gato',
  '🐾': 'mascotas animales',
  '🌳': 'naturaleza campo bosque',
  '🌱': 'plantas jardin huerto jardineria',
  '⛰️': 'senderismo montana montanismo excursiones',
  '🎣': 'pesca',
  '🏖️': 'playa verano vacaciones',
  '⛷️': 'nieve esqui snowboard',
  '💼': 'trabajo empleo negocios emprendedores empresa autonomos',
  '💰': 'finanzas inversion bolsa dinero economia ahorro',
  '🎓': 'estudios estudiantes universidad oposiciones colegio',
  '🗣️': 'idiomas ingles frances aleman debates debate',
  '🩺': 'salud medicina',
  '❤️': 'amistad amigos amor parejas',
  '💘': 'citas solteros ligar',
  '😂': 'humor chistes risas memes',
  '🎉': 'fiesta fiestas cumpleanos celebracion',
  '👨‍👩‍👧': 'familia padres madres hijos',
  '👵': 'mayores jubilados abuelos',
  '🙏': 'fe religion oracion',
  '📰': 'noticias actualidad',
  '🗳️': 'politica elecciones',
  '🏛️': 'historia',
  '🛠️': 'bricolaje reparaciones mecanica',
  '👗': 'moda belleza',
  '🏡': 'casa hogar decoracion',
  '🌙': 'noche insomnes madrugada',
  '🎭': 'teatro',
  '👋': 'bienvenida bienvenidos presentaciones saludos novatos'
};
const MAPA_ICONOS_SALA = new Map();
Object.entries(ICONOS_SALA).forEach(([icono, palabras]) => palabras.split(' ').forEach(p => { if (!MAPA_ICONOS_SALA.has(p)) MAPA_ICONOS_SALA.set(p, icono); }));
function iconoParaNombre(nombre) {
  const texto = String(nombre || '');
  if (/^\s*\p{Extended_Pictographic}/u.test(texto)) return ''; // ya empieza por un emoji: se respeta
  const palabras = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
  for (const w of palabras) {
    if (MAPA_ICONOS_SALA.has(w)) return MAPA_ICONOS_SALA.get(w);
    if (w.length >= 5) { for (const [k, ic] of MAPA_ICONOS_SALA) { if (k.length >= 5 && w.startsWith(k)) return ic; } }
  }
  return '💬';
}

// ---- Salas fijas: sobreviven a reinicios porque se guardan en la base de datos ----
async function cargarSalasFijas() {
  if (!salasFijasCol) return;
  try {
    const docs = await salasFijasCol.find({}).toArray();
    docs.forEach(d => {
      if (!d._id || salas.has(d._id)) return;
      salas.set(d._id, { id: d._id, nombre: d.nombre, icono: d.icono !== undefined ? d.icono : iconoParaNombre(d.nombre), creador: d.creador || 'sistema', usuarios: new Set(), vacioDesde: null, permanente: true });
    });
  } catch (e) { console.log('No se pudieron cargar las salas fijas:', e.message); }
}
function guardarSalaFija(sala) {
  if (!salasFijasCol) return;
  salasFijasCol.updateOne({ _id: sala.id }, { $set: { nombre: sala.nombre, icono: sala.icono || '', creador: sala.creador } }, { upsert: true }).catch(() => {});
}
function borrarSalaFija(id) {
  if (!salasFijasCol) return;
  salasFijasCol.deleteOne({ _id: id }).catch(() => {});
}

// Salas en las que esta el usuario, sin contar La Plaza ni la sala Staff ni salas ya borradas
function salasPropiasDe(socket) {
  return Array.from(socket.data.salasUnidas).filter(id => {
    const sl = salas.get(id);
    return sl && !sl.fija && !sl.oculta;
  }).length;
}

function listaSalas() {
  return Array.from(salas.values()).map(s => ({
    id: s.id, nombre: s.nombre, numUsuarios: s.usuarios.size, permanente: !!s.permanente, fija: !!s.fija
  }));
}

// El creador de una sala se reconoce por su cuenta (o, si es invitado, por su conexion), NUNCA por el nombre:
// asi nadie puede "heredar" una sala registrandose despues con el mismo nick.
function claveCreador(socket) {
  return socket.data.registrado && socket.data.usuario ? 'u:' + socket.data.usuario.toLowerCase() : 's:' + socket.id;
}
function esCreadorDeSala(sala, socketId) {
  const sk = io.sockets.sockets.get(socketId);
  return !!sk && !!sala.creadorId && sala.creadorId === claveCreador(sk);
}

function listaSalasPara(socketId) {
  const privilegiado = esModOAdmin(socketId);
  return Array.from(salas.values())
    .filter(s => !s.oculta || privilegiado)
    .map(s => ({
      id: s.id, nombre: s.nombre, icono: s.icono || '', numUsuarios: s.usuarios.size, permanente: !!s.permanente, fija: !!s.fija,
      puedeCerrar: !s.oculta && !s.fija && (privilegiado || (esCreadorDeSala(s, socketId) && !s.permanente)),
      puedeFijar: privilegiado && !s.oculta && !s.fija
    }));
}

function emitirSalasATodos() {
  io.sockets.sockets.forEach((s) => s.emit('salasActualizadas', listaSalasPara(s.id)));
}

function registrarEstadistica(nick) {
  if (!estadisticasCol) return;
  const hoy = new Date().toISOString().slice(0, 10); // AAAA-MM-DD
  const hora = new Date().getHours();
  estadisticasCol.findOneAndUpdate(
    { _id: 'global' },
    { $inc: { totalMensajes: 1, [`porUsuario.${nick}`]: 1, [`porHora.${hora}`]: 1 } },
    { upsert: true }
  ).catch(() => {});
  estadisticasCol.findOneAndUpdate(
    { _id: 'dia_' + hoy },
    { $inc: { mensajes: 1 } },
    { upsert: true }
  ).catch(() => {});
}

function usuariosDeSala(sala) {
  return Array.from(sala.usuarios).map(id => usuariosConectados.get(id)).filter(Boolean);
}

// Une al socket a una sala (idempotente). "auto" = entrada automatica: el cliente no cambia de pestana.
function unirseASala(socket, sala, auto) {
  socket.join(sala.id);
  sala.usuarios.add(socket.id);
  socket.data.salasUnidas.add(sala.id);
  marcarEstadoVacio(sala);
  socket.emit('unido', { salaId: sala.id, auto: !!auto });
}

function abandonarSala(socket, salaId, avisar) {
  const sala = salas.get(salaId);
  socket.leave(salaId);
  socket.data.salasUnidas.delete(salaId);
  if (sala) {
    sala.usuarios.delete(socket.id);
    marcarEstadoVacio(sala);
    io.emit('usuariosDeSala', { salaId, usuarios: usuariosDeSala(sala) });
  }
  if (avisar) socket.emit('salaAbandonada', { salaId });
}

function unirseAStaff(socket) {
  const sala = salas.get('staff');
  if (!sala) return;
  unirseASala(socket, sala, true);
  enviarHistorialStaff(socket);
}

// Admin y moderadores entran siempre a La Plaza, a la sala Staff y a todas las salas existentes
// (pueden salir despues de cualquiera de ellas si quieren).
function unirStaffATodas(socket) {
  const plaza = salas.get('plaza');
  if (plaza && !socket.data.salasUnidas.has('plaza')) unirseASala(socket, plaza, true);
  if (!socket.data.salasUnidas.has('staff')) unirseAStaff(socket);
  salas.forEach(sala => {
    if (sala.oculta || sala.fija) return;
    if (!socket.data.salasUnidas.has(sala.id)) unirseASala(socket, sala, true);
  });
  salas.forEach(sala => io.emit('usuariosDeSala', { salaId: sala.id, usuarios: usuariosDeSala(sala) }));
}

// Historial de la sala staff: siempre se conservan como máximo 100 entradas.
// Al entrar la 101, se borra la más antigua (y cualquier sobrante que hubiera de antes).
const LIMITE_HISTORIAL_STAFF = 100;
async function guardarEnHistorialStaff(entrada) {
  if (!notasStaffCol) return;
  try {
    await notasStaffCol.insertOne({ ...entrada, fecha: new Date() });
    const sobrantes = await notasStaffCol
      .find({}, { projection: { _id: 1 } })
      .sort({ fecha: -1, _id: -1 })
      .skip(LIMITE_HISTORIAL_STAFF)
      .toArray();
    if (sobrantes.length) {
      await notasStaffCol.deleteMany({ _id: { $in: sobrantes.map(d => d._id) } });
    }
  } catch (e) { /* silencioso: el chat sigue funcionando aunque falle el guardado */ }
}

async function enviarHistorialStaff(socket) {
  if (!notasStaffCol) return;
  try {
    const historial = await notasStaffCol.find({}).sort({ fecha: -1, _id: -1 }).limit(LIMITE_HISTORIAL_STAFF).toArray();
    socket.emit('historialStaff', historial.reverse().map(n => n.tipo === 'sistema'
      ? { tipo: 'sistema', texto: `${fechaHoraMadrid(n.fecha)} — ${n.texto}` }
      : { id: n.msgId, nick: n.nick, texto: n.texto, hora: fechaHoraMadrid(n.fecha) }
    ));
  } catch (e) { /* silencioso: si falla, simplemente no hay historial */ }
}

function salirDeStaff(socket) {
  const sala = salas.get('staff');
  if (sala) sala.usuarios.delete(socket.id);
  socket.leave('staff');
  socket.data.salasUnidas.delete('staff');
}

function marcarEstadoVacio(sala) {
  if (sala.permanente) { sala.vacioDesde = null; return; }
  if (sala.usuarios.size === 0) {
    if (!sala.vacioDesde) sala.vacioDesde = Date.now();
  } else {
    sala.vacioDesde = null;
  }
}

function listaUsuarios() {
  return Array.from(usuariosConectados.entries()).map(([id, nick]) => ({
    id, nick,
    rol: id === adminSocketId ? 'admin' : (moderadores.has(id) ? 'moderador' : 'usuario')
  }));
}

// Moderadores que existen de verdad (cuentas guardadas), no solo los conectados ahora
async function totalModeradores() {
  if (!usuariosCol) return moderadores.size;
  return usuariosCol.countDocuments({ rol: 'moderador' });
}

// Equipo de moderación: quién es admin/moderador, si está conectado y en qué salas está ahora.
// Los roles valen para todo el chat; lo que cambia por sala es quién está presente en ella.
async function datosEquipo() {
  const vivos = [];
  io.sockets.sockets.forEach((s) => { if (esModOAdmin(s.id) && s.data.usuario) vivos.push(s); });
  const salasVisibles = Array.from(salas.values()).filter(sl => !sl.oculta);

  const mapa = new Map();
  if (usuariosCol) {
    const cuentas = await usuariosCol.find({ rol: { $in: ['admin', 'moderador'] } }).toArray();
    cuentas.forEach(c => mapa.set(c.usuarioClave, { usuario: c.usuario, rol: c.rol, conectado: false, salas: [] }));
  }
  vivos.forEach((s) => {
    const clave = s.data.usuario.toLowerCase();
    const e = mapa.get(clave) || { usuario: s.data.usuario, conectado: false, salas: [] };
    e.rol = rolDe(s.id);
    e.conectado = true;
    e.salas = salasVisibles.filter(sl => sl.usuarios.has(s.id)).map(sl => sl.nombre);
    mapa.set(clave, e);
  });
  const orden = { admin: 0, moderador: 1 };
  const equipo = Array.from(mapa.values()).sort((a, b) =>
    (orden[a.rol] - orden[b.rol]) || (Number(b.conectado) - Number(a.conectado)) || a.usuario.localeCompare(b.usuario));

  const porSala = salasVisibles.map(sl => ({
    nombre: sl.nombre,
    personas: sl.usuarios.size,
    staff: vivos.filter(s => sl.usuarios.has(s.id)).map(s => s.data.usuario),
    // Todas las personas que hay dentro (incluidos admin y moderadores), con su rol: solo lo ve el staff
    personasLista: Array.from(sl.usuarios).map(id => ({ nick: usuariosConectados.get(id), rol: rolDe(id) }))
      .filter(x => x.nick).sort((a, b) => (a.rol === 'usuario') - (b.rol === 'usuario') || a.nick.localeCompare(b.nick))
  }));
  return { equipo, porSala, moderadores: equipo.filter(e => e.rol === 'moderador').length, maxModeradores: MAX_MODERADORES };
}

function rolDe(socketId) {
  return socketId === adminSocketId ? 'admin' : (moderadores.has(socketId) ? 'moderador' : 'usuario');
}

// ---- Filtro basico de palabras malsonantes / faltas de respeto ----
// No es infalible (ningun filtro automatico lo es), pero cubre los casos mas comunes.
const PALABRAS_PROHIBIDAS = [
  'gilipollas', 'imbecil', 'idiota', 'subnormal', 'retrasado', 'tonto de remate',
  'hijo de puta', 'hijoputa', 'cabron', 'cabrona', 'zorra', 'puta', 'puto',
  'mierda', 'joder te', 'maricon', 'marica', 'negro de mierda', 'sudaca',
  'nazi', 'pedofilo'
];

function contieneMalasPalabras(texto) {
  const t = texto.toLowerCase();
  return PALABRAS_PROHIBIDAS.some(p => t.includes(p));
}

function censurar(texto) {
  let resultado = texto;
  PALABRAS_PROHIBIDAS.forEach(p => {
    const regex = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    resultado = resultado.replace(regex, m => m[0] + '*'.repeat(Math.max(m.length - 1, 1)));
  });
  return resultado;
}

// ---- Antispam: maximo de mensajes por usuario en una ventana de tiempo ----
const LIMITE_MENSAJES = 5;
const VENTANA_MS = 5000;
const historialMensajes = new Map(); // socket.id -> array de timestamps

function estaEnFlood(socketId) {
  const ahora = Date.now();
  const historial = (historialMensajes.get(socketId) || []).filter(t => ahora - t < VENTANA_MS);
  historial.push(ahora);
  historialMensajes.set(socketId, historial);
  return historial.length > LIMITE_MENSAJES;
}

// ---- IPs baneadas (persistentes si hay base de datos) ----
let baneadosCol = null;
const ipsBaneadasCache = new Map();     // ip -> { expira (ms) | null, motivo, nivel }
const cuentasBaneadasCache = new Map(); // usuarioClave -> { expira, motivo, nivel }
let historialBloqueosCol = null;        // cuántas veces se ha bloqueado a una IP / cuenta (para escalar)

const DURACIONES_BLOQUEO_HORAS = [24, 72, 168]; // 1.º bloqueo: 24 h · 2.º: 72 h · 3.º y siguientes: 7 días
const MOTIVOS_BLOQUEO = ['Falta de respeto', 'Falta de educación', 'Insultos', 'Imágenes no permitidas', 'Spam o publicidad', 'Acoso a otras personas', 'Otro motivo'];
const MOTIVO_BOT = 'Mensajes repetidos que incumplen las normas (detección automática)';

async function cargarBaneados() {
  if (!baneadosCol) return;
  const baneados = await baneadosCol.find({}).toArray();
  const ahora = Date.now();
  baneados.forEach(b => {
    const expira = b.expira ? new Date(b.expira).getTime() : null;
    if (expira && expira <= ahora) return;
    const d = { expira, motivo: b.motivo || null, nivel: b.nivel || 0 };
    ipsBaneadasCache.set(b.ip, d);
    if (b.usuarioClave) cuentasBaneadasCache.set(b.usuarioClave, d);
  });
}

function bloqueoActivo(cache, clave) {
  const d = cache.get(clave);
  if (!d) return null;
  if (d.expira && Date.now() > d.expira) { cache.delete(clave); return null; }
  return d;
}
function estaBaneada(ip) { return !!bloqueoActivo(ipsBaneadasCache, ip); }

// Lo que ve la persona bloqueada (solo ella): motivo, hasta cuándo y qué nivel de bloqueo es
function avisoBloqueo(d) {
  return { adminOnline: !!adminSocketId, modsOnline: moderadores.size > 0, motivo: d.motivo || 'Uso inadecuado del chat', hasta: d.expira || null, nivel: d.nivel || 0 };
}

// Nivel del próximo bloqueo: 24 h la primera vez, 72 h la segunda y 7 días de la tercera en adelante.
// Con cuenta registrada cuenta el historial de la cuenta; como invitado, el de la IP.
async function nivelSiguiente(ip, uClave) {
  let previos = 0;
  if (historialBloqueosCol) {
    const h = await historialBloqueosCol.findOne({ _id: uClave ? 'cta:' + uClave : 'ip:' + ip });
    previos = (h && h.total) || 0;
  }
  const nivel = Math.min(previos + 1, DURACIONES_BLOQUEO_HORAS.length);
  return { nivel, horas: DURACIONES_BLOQUEO_HORAS[nivel - 1], previos };
}
async function sumarBloqueo(ip, uClave, delta) {
  if (!historialBloqueosCol) return;
  for (const id of [ 'ip:' + ip, uClave ? 'cta:' + uClave : null ].filter(Boolean)) {
    const h = await historialBloqueosCol.findOne({ _id: id });
    const total = Math.max(0, ((h && h.total) || 0) + delta);
    await historialBloqueosCol.updateOne({ _id: id }, { $set: { total, ultimo: new Date() } }, { upsert: true });
  }
}
const textoDuracion = (h) => (h % 24 === 0 ? (h / 24 === 1 ? '24 horas' : `${h / 24} días`) : `${h} horas`);

function obtenerIP(socket) {
  return ipDeCabeceras(socket.handshake.headers, socket.handshake.address);
}

// Aplica un bloqueo escalado (24 h -> 72 h -> 7 dias) por IP y por cuenta, y avisa solo a la persona y al staff
async function aplicarBloqueo(socketDestino, nickObjetivo, motivoFinal, baneadoPor, horasElegidas) {
  const ip = obtenerIP(socketDestino);
  const uClave = socketDestino.data.registrado && socketDestino.data.usuario ? socketDestino.data.usuario.toLowerCase() : null;
  let { nivel, horas } = await nivelSiguiente(ip, uClave);
  const idx = DURACIONES_BLOQUEO_HORAS.indexOf(horasElegidas);
  if (idx >= 0) { horas = horasElegidas; nivel = idx + 1; } // duracion elegida a mano por el staff
  const expira = Date.now() + horas * 60 * 60 * 1000;
  const datos = { expira, motivo: motivoFinal, nivel };

  ipsBaneadasCache.set(ip, datos);
  if (uClave) cuentasBaneadasCache.set(uClave, datos);
  if (baneadosCol) {
    await baneadosCol.updateOne({ ip }, { $set: {
      nick: nickObjetivo, usuarioClave: uClave, motivo: motivoFinal, nivel, horas, baneadoPor,
      fecha: new Date(), expira: new Date(expira), mensajesApelacion: []
    } }, { upsert: true });
  }
  await sumarBloqueo(ip, uClave, +1);

  // El aviso con el motivo lo ve SOLO la persona bloqueada; al resto del chat no se le anuncia nada.
  socketDestino.emit('estasBaneado', avisoBloqueo(datos));
  socketDestino.disconnect(true);
  [adminSocketId, ...moderadores].filter(Boolean).forEach(id =>
    io.to(id).emit('sistema', { texto: `🚫 ${nickObjetivo} bloqueado ${textoDuracion(horas)} (nivel ${nivel}) · ${motivoFinal} · por ${baneadoPor}` }));
  return { nivel, horas };
}

// ---- Bot moderador (aparece como un nick cualquiera, no revela que es automatico) ----
const NICK_BOT = generarNick();
const infraccionesPorSocket = new Map(); // socket.id -> array de timestamps de infracciones
const VENTANA_INFRACCIONES_MS = 10 * 60 * 1000;
const MAX_INFRACCIONES_ANTES_DE_BANEO = 3;
const DURACION_BANEO_BOT_MS = 60 * 60 * 1000; // 1 hora

function hayStaffConectado() {
  return !!adminSocketId || moderadores.size > 0;
}

async function registrarInfraccionYComprobarEscalado(socket, ip, nick) {
  const ahora = Date.now();
  const historial = (infraccionesPorSocket.get(socket.id) || []).filter(t => ahora - t < VENTANA_INFRACCIONES_MS);
  historial.push(ahora);
  infraccionesPorSocket.set(socket.id, historial);

  if (historial.length >= MAX_INFRACCIONES_ANTES_DE_BANEO) {
    infraccionesPorSocket.delete(socket.id);
    const expira = Date.now() + DURACION_BANEO_BOT_MS;
    const datosBot = { expira, motivo: MOTIVO_BOT, nivel: 0 };
    ipsBaneadasCache.set(ip, datosBot);
    if (baneadosCol) {
      try {
        await baneadosCol.updateOne(
          { ip },
          { $set: { nick, baneadoPor: NICK_BOT + ' (automatico)', fecha: new Date(), expira: new Date(expira), motivo: MOTIVO_BOT, nivel: 0, mensajesApelacion: [] } },
          { upsert: true }
        );
      } catch (e) { /* silencioso */ }
    }
    socket.emit('estasBaneado', avisoBloqueo(datosBot));
    socket.disconnect(true);
    return true;
  }
  return false;
}

// ---- Mensajes repetidos: no se permite repetir el mismo texto (seguido ni pasado un rato) ----
const REPETICION_VENTANA_MS = 5 * 60 * 1000;   // se cuentan las veces que UNA MISMA PERSONA dice la misma frase en estos minutos
const REPETICION_MAX_IGUALES = 2;                // la misma frase se permite hasta 2 veces; la 3.ª ya es repetir
const REPETICION_AVISO_VALIDO_MS = 60 * 60 * 1000; // el aviso previo vale 1 hora; si repite despues de avisar, se bloquea
const historialTextos = new Map();   // persona -> [{ n, t }]  (solo sus propios mensajes)
const avisosRepeticion = new Map();  // persona -> momento del aviso

// Saludos y palabras de uso diario: nunca cuentan como repeticion ("hola", "ok", "buenos dias", "gracias"...)
const PALABRAS_COMUNES = new Set(('hola holaa buenas buenos dias dia tardes tarde noches noche a todos todas todo que tal como estas estais ' +
  'estas va vais gracias muchas vale ok okey oki si no sip nop claro bien genial guay jaja jeje jiji jajaja ' +
  'adios chao ciao bye hasta luego pronto manana saludos buen bienvenido bienvenida bienvenidos hey ey buenisimo igualmente ' +
  'de nada por favor perdon lo siento yo tu el ella nosotros y e o pero mas me te se').split(' '));
function normalizarTexto(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/(.)\1{2,}/g, '$1$1').trim();
}
// Cada persona cuenta por separado: la cuenta si la tiene, y si no, su conexion. NUNCA por IP
// (varias personas comparten IP en una casa, una oficina o los datos moviles).
function claveDePersona(socket) {
  return socket.data.registrado && socket.data.usuario ? 'u:' + socket.data.usuario.toLowerCase() : 's:' + socket.id;
}
function esFraseDeUsoComun(n) {
  const palabras = n.split(' ');
  return palabras.length < 2 || palabras.every(p => PALABRAS_COMUNES.has(p));
}
// Devuelve true si esta persona ya ha dicho esta misma frase demasiadas veces seguidas (sin guardarla).
function esRepeticion(socket, texto) {
  const n = normalizarTexto(texto);
  if (n.length < 4 || esFraseDeUsoComun(n)) return false; // palabras sueltas, saludos y emojis no cuentan
  const clave = claveDePersona(socket);
  const ahora = Date.now();
  const lista = (historialTextos.get(clave) || []).filter(x => ahora - x.t < REPETICION_VENTANA_MS);
  const veces = lista.filter(x => x.n === n).length;
  if (veces >= REPETICION_MAX_IGUALES) { historialTextos.set(clave, lista); return true; }
  lista.push({ n, t: ahora });
  if (lista.length > 30) lista.shift();
  historialTextos.set(clave, lista);
  return false;
}
// Quien "habla" en el aviso automatico: el administrador si esta, si no un moderador, si no el bot
function emisorAutomatico() {
  if (adminSocketId && usuariosConectados.get(adminSocketId)) return { nick: usuariosConectados.get(adminSocketId), rol: 'admin', registrado: true };
  const idMod = Array.from(moderadores).find(id => usuariosConectados.get(id));
  if (idMod) return { nick: usuariosConectados.get(idMod), rol: 'moderador', registrado: true };
  return { nick: NICK_BOT, rol: 'usuario', registrado: false };
}
setInterval(() => {
  const ahora = Date.now();
  historialTextos.forEach((l, k) => { if (!l.some(x => ahora - x.t < REPETICION_VENTANA_MS)) historialTextos.delete(k); });
  avisosRepeticion.forEach((t, k) => { if (ahora - t > REPETICION_AVISO_VALIDO_MS) avisosRepeticion.delete(k); });
}, 60 * 1000).unref();

// ---- Deteccion de "gritar" en mayusculas ----
const BLOQUEO_MAYUS_MS = 60 * 1000;
const bloqueadosPorMayus = new Map(); // socket.id -> timestamp hasta el que esta bloqueado

function esGritando(texto) {
  const soloLetras = texto.replace(/[^a-zA-ZÀ-ÿ]/g, '');
  if (soloLetras.length < 8) return false;
  const mayusculas = soloLetras.replace(/[^A-ZÀ-Ý]/g, '');
  return mayusculas.length / soloLetras.length > 0.8;
}

// ---- Reportes: aviso al staff cuando varias personas distintas reportan a la misma ----
const MOTIVOS_REPORTE = ['Acoso o insultos', 'Contenido sexual o inapropiado', 'Spam o publicidad', 'Otro motivo'];
const REPORTES_AVISO = 3;
const REPORTES_VENTANA_MS = 30 * 60 * 1000;
const reportesPorNick = new Map();  // nick en minusculas -> [{ por, t }]
const reportesAvisados = new Map(); // nick en minusculas -> momento del aviso
const textosPrivados = new Map();   // canalId -> ultimos textos (solo memoria, se borran al cerrar; sirven para adjuntarlos a una denuncia)
function avisarAlStaff(texto) {
  [adminSocketId, ...moderadores].filter(Boolean).forEach(id => io.to(id).emit('sistema', { texto }));
  guardarEnHistorialStaff({ tipo: 'sistema', texto });
}
function registrarReporte(reportado, porQuien) {
  const k = String(reportado).toLowerCase();
  const ahora = Date.now();
  const lista = (reportesPorNick.get(k) || []).filter(x => ahora - x.t < REPORTES_VENTANA_MS);
  lista.push({ por: String(porQuien).toLowerCase(), t: ahora });
  reportesPorNick.set(k, lista);
  const distintos = new Set(lista.map(x => x.por)).size;
  const avisadoEn = reportesAvisados.get(k);
  if (distintos >= REPORTES_AVISO && !(avisadoEn && ahora - avisadoEn < REPORTES_VENTANA_MS)) {
    reportesAvisados.set(k, ahora);
    avisarAlStaff(`⚠️ ${reportado} ya tiene reportes de ${distintos} personas distintas en los últimos 30 minutos. Conviene revisarlo.`);
  }
}
setInterval(() => {
  const ahora = Date.now();
  reportesPorNick.forEach((l, k) => { if (!l.some(x => ahora - x.t < REPORTES_VENTANA_MS)) reportesPorNick.delete(k); });
  reportesAvisados.forEach((t, k) => { if (ahora - t > REPORTES_VENTANA_MS) reportesAvisados.delete(k); });
}, 5 * 60 * 1000).unref();

// ---- Videollamada en chats privados: el servidor solo reenvia la señalizacion entre las dos personas ----
const llamadas = new Map(); // canalId -> { a, b, estado: 'solicitada'|'activa', timer }
function terminarLlamada(canalId, motivo) {
  const l = llamadas.get(canalId);
  if (!l) return;
  clearTimeout(l.timer);
  llamadas.delete(canalId);
  [l.a, l.b].forEach(id => {
    const sk = io.sockets.sockets.get(id);
    if (!sk) return;
    if (sk.data.llamadaCanal === canalId) sk.data.llamadaCanal = null;
    sk.emit('llamadaFin', { canalId, motivo });
  });
}
// STUN publico por defecto. Si algun dia hace falta TURN (redes que bloquean la conexion directa),
// se activa con las variables de Render TURN_URLS, TURN_USERNAME y TURN_CREDENTIAL.
function construirIce() {
  const lista = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.TURN_URLS) {
    lista.push({ urls: process.env.TURN_URLS.split(',').map(x => x.trim()).filter(Boolean), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_CREDENTIAL || '' });
  }
  return lista;
}
const ICE_SERVERS = construirIce();

io.on('connection', (socket) => {
  const ip = obtenerIP(socket);
  const bloqueoIP = bloqueoActivo(ipsBaneadasCache, ip);
  if (bloqueoIP) {
    socket.emit('estasBaneado', avisoBloqueo(bloqueoIP));
    socket.disconnect(true);
    return;
  }

  const nick = generarNick();
  usuariosConectados.set(socket.id, nick);
  socket.data.salasUnidas = new Set();
  socket.data.privados = new Map(); // otroNick -> canalId
  socket.data.registrado = false;

  socket.emit('bienvenida', { nick, totalConectados: usuariosConectados.size, salas: listaSalasPara(socket.id) });
  socket.emit('configCuenta', { recuperacion: recuperacion.activo() });
  socket.emit('avatares', mapaAvatares());
  socket.emit('iceServers', ICE_SERVERS);
  socket.broadcast.emit('sistema', { texto: `${nick} se ha conectado` });
  io.emit('totalConectados', usuariosConectados.size);

  // ---- Registro de cuenta nueva ----
  // ---- Cerrar sesion (vuelve a ser usuario anonimo con nick aleatorio) ----
  const hacerCerrarSesion = () => {
    const nickAnterior = usuariosConectados.get(socket.id);
    if (adminSocketId === socket.id) adminSocketId = null;
    moderadores.delete(socket.id);
    Array.from(socket.data.privados.values()).forEach(canalId => cerrarPrivadoInterno(socket, canalId, 'desconexion'));
    Array.from(socket.data.salasUnidas).forEach(id => abandonarSala(socket, id, false));
    socket.data.registrado = false;
    socket.data.usuario = null;

    const nuevoNick = generarNick();
    usuariosConectados.set(socket.id, nuevoNick);

    socket.emit('sesionCerrada', { nick: nuevoNick });
    io.emit('sistema', { texto: `${nickAnterior} ha cerrado sesion` });
    io.emit('totalConectados', usuariosConectados.size);
    emitirSalasATodos();
  };
  socket.on('cerrarSesion', hacerCerrarSesion);

  socket.on('registrar', async ({ usuario, contrasena, mayorDeEdad, email }) => {
    if (!usuariosCol) { socket.emit('error_app', 'El registro no esta disponible ahora mismo.'); return; }
    if (!mayorDeEdad) { socket.emit('error_app', 'Debes confirmar que eres mayor de 18 años para registrarte.'); return; }
    const u = String(usuario || '').trim();
    const uClave = u.toLowerCase();
    const p = String(contrasena || '');
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(u)) {
      socket.emit('error_app', 'El usuario debe tener 3-20 caracteres: letras, numeros, guion (-), guion bajo (_) o punto (.), sin espacios.');
      return;
    }
    const errorContrasena = recuperacion.validarContrasena(p, uClave);
    if (errorContrasena) { socket.emit('error_app', errorContrasena); return; }
    let correo = null;
    if (recuperacion.activo()) {
      correo = recuperacion.normalizarEmail(email);
      if (!recuperacion.emailValido(correo)) {
        socket.emit('error_app', 'Escribe un correo electrónico válido. Lo necesitarás para recuperar tu contraseña.');
        return;
      }
    }
    try {
      const hash = await bcrypt.hash(p, 10);
      await usuariosCol.insertOne({ usuario: u, usuarioClave: uClave, hash, rol: 'usuario', mayorDeEdad: true, email: correo, emailVerificado: false, creado: new Date() });
      aplicarSesion(socket, u, 'usuario');
      socket.emit('sesionIniciada', { usuario: u, rol: 'usuario' });
      io.emit('sistema', { texto: `${u} se ha registrado` });
      if (correo) {
        const enviado = await recuperacion.enviarVerificacion({ usuario: u, usuarioClave: uClave }, correo);
        socket.emit('estadoCorreo', { email: recuperacion.enmascarar(correo), verificado: false });
        socket.emit('correoGuardado', { enviado });
      }
    } catch (err) {
      if (err.code === 11000) socket.emit('error_app', 'Ese nombre de usuario ya existe (no distingue mayusculas de minusculas).');
      else socket.emit('error_app', 'No se pudo completar el registro.');
    }
  });

  // ---- Inicio de sesion ----
  socket.on('iniciarSesion', async ({ usuario, contrasena }) => {
    if (!usuariosCol) { socket.emit('error_app', 'El inicio de sesion no esta disponible ahora mismo.'); return; }
    const uClave = String(usuario || '').trim().toLowerCase();

    const bloqueo = intentosLogin.get(uClave);
    if (bloqueo && bloqueo.bloqueadoHasta && Date.now() < bloqueo.bloqueadoHasta) {
      const minutosRestantes = Math.ceil((bloqueo.bloqueadoHasta - Date.now()) / 60000);
      socket.emit('error_app', `Demasiados intentos fallidos. Espera ${minutosRestantes} minuto(s) antes de volver a intentarlo.`);
      return;
    }

    const doc = await usuariosCol.findOne({ usuarioClave: uClave });
    const ok = doc && await bcrypt.compare(String(contrasena || ''), doc.hash);

    if (!ok) {
      const actual = intentosLogin.get(uClave) || { intentos: 0, bloqueadoHasta: null };
      actual.intentos += 1;
      if (actual.intentos >= MAX_INTENTOS_LOGIN) {
        actual.bloqueadoHasta = Date.now() + BLOQUEO_LOGIN_MS;
        actual.intentos = 0;
        intentosLogin.set(uClave, actual);
        socket.emit('error_app', 'Demasiados intentos fallidos. Esta cuenta se bloquea 15 minutos por seguridad.');
      } else {
        intentosLogin.set(uClave, actual);
        const restantes = MAX_INTENTOS_LOGIN - actual.intentos;
        socket.emit('error_app', `Usuario o contrasena incorrectos. Te queda${restantes === 1 ? '' : 'n'} ${restantes} intento${restantes === 1 ? '' : 's'} antes de un bloqueo temporal.`);
      }
      return;
    }

    intentosLogin.delete(uClave);
    const bloqueoCuenta = bloqueoActivo(cuentasBaneadasCache, uClave);
    if (bloqueoCuenta) {
      socket.emit('estasBaneado', avisoBloqueo(bloqueoCuenta));
      socket.disconnect(true);
      return;
    }
    aplicarSesion(socket, doc.usuario, doc.rol);
    socket.emit('sesionIniciada', { usuario: doc.usuario, rol: doc.rol });
    socket.emit('estadoCorreo', { email: doc.email ? recuperacion.enmascarar(doc.email) : null, verificado: !!doc.emailVerificado });
    io.emit('sistema', { texto: `${doc.usuario} ha iniciado sesion` });
  });

  // ---- Eliminar la propia cuenta (hay que repetir la contraseña) ----
  socket.on('eliminarCuenta', async ({ contrasena }) => {
    if (!usuariosCol || !socket.data.registrado || !socket.data.usuario) { socket.emit('error_app', 'Inicia sesión con tu cuenta para poder eliminarla.'); return; }
    const uClave = socket.data.usuario.toLowerCase();
    if (!recuperacion.permitir('del-cta:' + uClave, 5, 60 * 60 * 1000)) { socket.emit('error_app', 'Demasiados intentos. Inténtalo de nuevo más tarde.'); return; }
    const doc = await usuariosCol.findOne({ usuarioClave: uClave });
    if (!doc || !(await bcrypt.compare(String(contrasena || ''), doc.hash))) { socket.emit('error_app', 'La contraseña no es correcta.'); return; }
    if (doc.rol === 'admin') { socket.emit('error_app', 'La cuenta de administrador no se puede eliminar desde aquí.'); return; }

    await usuariosCol.deleteOne({ usuarioClave: uClave });
    if (avataresCache.delete(uClave)) io.emit('avatar', { clave: uClave, v: null });
    if (tokensCuentaCol) await tokensCuentaCol.deleteMany({ usuarioClave: uClave });
    if (notasStaffCol) await notasStaffCol.deleteMany({ nick: doc.usuario });
    if (estadisticasCol) estadisticasCol.updateOne({ _id: 'global' }, { $unset: { [`porUsuario.${doc.usuario}`]: '' } }).catch(() => {});
    if (doc.email && doc.emailVerificado) recuperacion.avisarEliminacion(doc.email, doc.usuario);

    hacerCerrarSesion();
    socket.emit('cuentaEliminada');
  });

  // ---- Foto de perfil: la sube la persona y NO se ve hasta que la aprueba el administrador ----
  socket.on('subirAvatar', async ({ dataUrl }) => {
    if (!usuariosCol || !socket.data.registrado || !socket.data.usuario) { socket.emit('error_app', 'Para poner una foto necesitas una cuenta (los invitados no pueden).'); return; }
    const uClave = socket.data.usuario.toLowerCase();
    if (!recuperacion.permitir('avatar:' + uClave, 6, 60 * 60 * 1000)) { socket.emit('error_app', 'Demasiados cambios de foto. Inténtalo más tarde.'); return; }
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_AVATAR_BASE64 || !dataUrlABuffer(dataUrl)) { socket.emit('error_app', 'La foto no es válida. Usa una imagen JPG, PNG o WebP pequeña.'); return; }
    const esAdmin = socket.id === adminSocketId;
    if (esAdmin) {
      // El administrador es quien revisa: su propia foto queda aprobada directamente
      await aprobarAvatar(uClave, socket.data.usuario, dataUrl);
    } else {
      await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { avatarPendiente: { data: dataUrl, fecha: new Date() } }, $unset: { avatarRechazada: '' } });
      if (adminSocketId) io.to(adminSocketId).emit('sistema', { texto: `🖼️ ${socket.data.usuario} ha enviado una foto de perfil. Revísala en el Panel de moderación.` });
      avisarPendientesAdmin().catch(() => {});
    }
    await enviarEstadoAvatarATodosSusSockets(uClave);
  });

  socket.on('quitarAvatar', async () => {
    if (!usuariosCol || !socket.data.registrado || !socket.data.usuario) return;
    const uClave = socket.data.usuario.toLowerCase();
    await usuariosCol.updateOne({ usuarioClave: uClave }, { $unset: { avatar: '', avatarPendiente: '', avatarRechazada: '' } });
    if (avataresCache.delete(uClave)) io.emit('avatar', { clave: uClave, v: null });
    await enviarEstadoAvatarATodosSusSockets(uClave);
    avisarPendientesAdmin().catch(() => {});
  });

  socket.on('pedirAvataresPendientes', async () => {
    if (socket.id !== adminSocketId || !usuariosCol) return;
    const docs = await usuariosCol.find({ avatarPendiente: { $exists: true } }).sort({ _id: 1 }).limit(30).toArray();
    socket.emit('avataresPendientes', docs.map(d => ({ usuario: d.usuario, data: d.avatarPendiente.data, fecha: d.avatarPendiente.fecha })));
  });

  socket.on('resolverAvatar', async ({ usuario, aprobar }) => {
    if (socket.id !== adminSocketId || !usuariosCol) return;
    const uClave = String(usuario || '').toLowerCase();
    const doc = await usuariosCol.findOne({ usuarioClave: uClave });
    if (!doc || !doc.avatarPendiente) { socket.emit('error_app', 'Esa foto ya no está pendiente.'); return; }
    if (aprobar) await aprobarAvatar(uClave, doc.usuario, doc.avatarPendiente.data);
    else await usuariosCol.updateOne({ usuarioClave: uClave }, { $unset: { avatarPendiente: '' }, $set: { avatarRechazada: 'La foto no cumple las normas del chat. Puedes probar con otra.' } });
    await enviarEstadoAvatarATodosSusSockets(uClave);
    const pend = await usuariosCol.find({ avatarPendiente: { $exists: true } }).sort({ _id: 1 }).limit(30).toArray();
    socket.emit('avataresPendientes', pend.map(d => ({ usuario: d.usuario, data: d.avatarPendiente.data, fecha: d.avatarPendiente.fecha })));
    avisarPendientesAdmin().catch(() => {});
  });

  async function aprobarAvatar(uClave, nombre, dataUrl) {
    const r = dataUrlABuffer(dataUrl);
    if (!r) return;
    const v = Date.now();
    await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { avatar: { data: dataUrl, v } }, $unset: { avatarPendiente: '', avatarRechazada: '' } });
    avataresCache.set(uClave, { ...r, v });
    io.emit('avatar', { clave: uClave, v });
  }
  async function enviarEstadoAvatarATodosSusSockets(uClave) {
    for (const [id, nombre] of usuariosConectados.entries()) {
      if (String(nombre).toLowerCase() !== uClave) continue;
      const sk = io.sockets.sockets.get(id);
      if (sk && sk.data.registrado) await enviarEstadoAvatar(sk);
    }
  }

  // ---- Añadir o cambiar el correo de recuperación (hay que repetir la contraseña) ----
  socket.on('guardarCorreo', async ({ email, contrasena }) => {
    if (!usuariosCol || !socket.data.registrado || !socket.data.usuario) { socket.emit('error_app', 'Inicia sesión con tu cuenta para añadir un correo.'); return; }
    if (!recuperacion.activo()) { socket.emit('error_app', 'El envío de correos no está activo ahora mismo.'); return; }
    const uClave = socket.data.usuario.toLowerCase();
    if (!recuperacion.permitir('mail-cta:' + uClave, 5, 60 * 60 * 1000)) { socket.emit('error_app', 'Demasiados intentos. Inténtalo de nuevo más tarde.'); return; }
    const nuevo = recuperacion.normalizarEmail(email);
    if (!recuperacion.emailValido(nuevo)) { socket.emit('error_app', 'Escribe un correo electrónico válido.'); return; }
    const doc = await usuariosCol.findOne({ usuarioClave: uClave });
    if (!doc || !(await bcrypt.compare(String(contrasena || ''), doc.hash))) { socket.emit('error_app', 'La contraseña no es correcta.'); return; }
    const anterior = doc.email && doc.emailVerificado ? doc.email : null;
    await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { email: nuevo, emailVerificado: false } });
    const enviado = await recuperacion.enviarVerificacion(doc, nuevo);
    if (anterior && anterior !== nuevo) recuperacion.avisarCambioCorreo(anterior, doc.usuario);
    socket.emit('estadoCorreo', { email: recuperacion.enmascarar(nuevo), verificado: false });
    socket.emit('correoGuardado', { enviado });
  });

  async function enviarEstadoAvatar(sk) {
    if (!usuariosCol || !sk.data.usuario) return;
    const doc = await usuariosCol.findOne({ usuarioClave: sk.data.usuario.toLowerCase() });
    if (!doc) return;
    sk.emit('avatarEstado', {
      tiene: !!doc.avatar, v: doc.avatar ? doc.avatar.v : null,
      pendiente: doc.avatarPendiente ? doc.avatarPendiente.data : null,
      rechazada: doc.avatarRechazada || null
    });
  }
  async function avisarPendientesAdmin() {
    if (!adminSocketId || !usuariosCol) return;
    const n = await usuariosCol.countDocuments({ avatarPendiente: { $exists: true } });
    io.to(adminSocketId).emit('avataresPendientesN', n);
  }

  function aplicarSesion(socket, usuario, rol) {
    usuariosConectados.set(socket.id, usuario);
    socket.data.registrado = true;
    socket.data.usuario = usuario;
    if (rol === 'admin') adminSocketId = socket.id;
    if (rol === 'moderador') moderadores.add(socket.id);
    if (rol === 'admin' || rol === 'moderador') unirStaffATodas(socket);
    salas.forEach(sl => { if (sl.creadorId === 's:' + socket.id) { sl.creadorId = claveCreador(socket); sl.creador = usuario; } });
    enviarEstadoAvatar(socket).catch(() => {});
    if (rol === 'admin') avisarPendientesAdmin().catch(() => {});
    io.emit('totalConectados', usuariosConectados.size);
    emitirSalasATodos();
    // El nombre ha cambiado (de invitado a cuenta): se refresca la lista de personas de sus salas
    socket.data.salasUnidas.forEach(id => {
      const sl = salas.get(id);
      if (sl) io.emit('usuariosDeSala', { salaId: id, usuarios: usuariosDeSala(sl) });
    });
  }

  // ---- Crear sala ----
  socket.on('crearSala', ({ nombre }) => {
    const nombreLimpio = String(nombre || '').trim().slice(0, 30);
    if (!nombreLimpio) return;
    const privilegiado = esModOAdmin(socket.id);
    const salasVisibles = Array.from(salas.values()).filter(s => !s.oculta && !s.fija).length;
    if (salasVisibles >= MAX_SALAS) { socket.emit('error_app', 'Ya existen 10 salas, el maximo permitido.'); return; }
    if (!privilegiado && salasPropiasDe(socket) >= MAX_SALAS_POR_USUARIO) {
      socket.emit('error_app', `Ya estas en ${MAX_SALAS_POR_USUARIO} salas. Sal de alguna para poder crear otra.`);
      return;
    }
    const id = 'sala_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const sala = { id, nombre: nombreLimpio, icono: iconoParaNombre(nombreLimpio), creador: usuariosConectados.get(socket.id), creadorId: claveCreador(socket), usuarios: new Set(), vacioDesde: null, permanente: privilegiado };
    salas.set(id, sala);
    if (sala.permanente) guardarSalaFija(sala);
    // Quien la crea entra directamente; el staff conectado (admin y moderadores) tambien, para tenerla controlada
    unirseASala(socket, sala, false);
    io.sockets.sockets.forEach(s => {
      if (s.id !== socket.id && esModOAdmin(s.id) && s.data.salasUnidas) unirseASala(s, sala, true);
    });
    emitirSalasATodos();
    io.emit('usuariosDeSala', { salaId: id, usuarios: usuariosDeSala(sala) });
    const totalAhora = Array.from(salas.values()).filter(x => !x.oculta && !x.fija).length;
    const esLaUltima = totalAhora >= MAX_SALAS;
    io.emit('sistema', { texto: `${usuariosConectados.get(socket.id)} ha creado la sala "${nombreLimpio}"` + (esLaUltima ? ` · Ya hay ${MAX_SALAS} salas: no se podrán crear más hasta que se elimine alguna.` : '') });
    if (esLaUltima) socket.emit('avisoOk', `Has creado la última sala que se puede crear (${MAX_SALAS} de ${MAX_SALAS}). No se podrán crear más hasta que se elimine alguna.`);
  });

  // ---- Fijar / desfijar una sala (solo staff). Una sala fija no se borra aunque quede vacia ----
  socket.on('fijarSala', ({ salaId, fijar }) => {
    if (!esModOAdmin(socket.id)) return;
    const sala = salas.get(salaId);
    if (!sala || sala.oculta || sala.fija) return;
    sala.permanente = !!fijar;
    if (sala.permanente) { sala.vacioDesde = null; guardarSalaFija(sala); }
    else { marcarEstadoVacio(sala); borrarSalaFija(sala.id); }
    emitirSalasATodos();
    io.emit('sistema', { texto: sala.permanente ? `La sala "${sala.nombre}" ha quedado fija` : `La sala "${sala.nombre}" ya no esta fija` });
  });

  // ---- Unirse a sala ----
  socket.on('unirseSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    if (!sala) return;
    const privilegiado = esModOAdmin(socket.id);
    if (sala.oculta && !privilegiado) return;
    const yaUnido = socket.data.salasUnidas.has(salaId);
    if (!yaUnido && !privilegiado && !sala.fija && salasPropiasDe(socket) >= MAX_SALAS_POR_USUARIO) {
      socket.emit('error_app', `Solo puedes estar en ${MAX_SALAS_POR_USUARIO} salas a la vez. Sal de alguna para entrar en esta.`);
      return;
    }
    unirseASala(socket, sala, false);
    if (salaId === 'staff') enviarHistorialStaff(socket);
    emitirSalasATodos();
    io.emit('usuariosDeSala', { salaId, usuarios: usuariosDeSala(sala) });
  });

  // ---- Salir de sala ----
  socket.on('salirSala', ({ salaId }) => {
    abandonarSala(socket, salaId, true);
    emitirSalasATodos();
  });

  // ---- Mensaje en una sala ----
  socket.on('mensajeSala', async ({ salaId, texto, imagenDataUrl, imagenNombre, respuestaAId }) => {
    const sala = salas.get(salaId);
    if (!sala) return;
    const privilegiado = esModOAdmin(socket.id);
    if (!socket.data.salasUnidas.has(salaId)) return;

    if (estaEnFlood(socket.id)) {
      socket.emit('error_app', 'Estas enviando mensajes demasiado rapido. Espera unos segundos.');
      return;
    }

    const bloqueadoHasta = bloqueadosPorMayus.get(socket.id);
    if (bloqueadoHasta && Date.now() < bloqueadoHasta) {
      const segundosRestantes = Math.ceil((bloqueadoHasta - Date.now()) / 1000);
      socket.emit('error_app', `Espera ${segundosRestantes} segundos antes de volver a escribir.`);
      return;
    }

    const nick = usuariosConectados.get(socket.id);
    const ip = obtenerIP(socket);
    const hora = salaId === 'staff' ? fechaHoraMadrid() : horaMadrid();
    // Si responde a un mensaje, la cita se toma del servidor (no de lo que diga el cliente)
    const citada = respuestaAId ? (sala.recientes || []).find(m => m.id === String(respuestaAId)) : null;
    const respuesta = citada ? { id: citada.id, nick: citada.nick, texto: resumenCita(citada) } : null;

    if (!imagenDataUrl && esGritando(String(texto || ''))) {
      bloqueadosPorMayus.set(socket.id, Date.now() + BLOQUEO_MAYUS_MS);
      socket.emit('error_app', '🤫 Tómate un respiro antes de responder. Aquí no se grita, evita las mayúsculas.');
      registrarInfraccionYComprobarEscalado(socket, ip, nick);
      if (!hayStaffConectado()) {
        io.to(salaId).emit('mensajeSala', {
          salaId, id: 'bot_' + Date.now(), nick: NICK_BOT, rol: 'usuario', registrado: false, tipo: 'texto',
          texto: `@${nick} tómate un respiro antes de responder 🙏 aquí no se grita`, hora
        });
      }
      return;
    }

    if (imagenDataUrl) {
      if (!esImagenValida(imagenDataUrl)) {
        socket.emit('error_app', 'Solo se permiten imagenes (foto o GIF) de hasta 4MB.');
        return;
      }
      const id = 'img_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
      imagenesModeracion.set(id, { dataUrl: imagenDataUrl, nick, salaId, fecha: Date.now() });
      setTimeout(() => imagenesModeracion.delete(id), 24 * 60 * 60 * 1000);
      while (imagenesModeracion.size > MAX_IMAGENES_RETENIDAS) imagenesModeracion.delete(imagenesModeracion.keys().next().value);

      const msg = { salaId, id, nick, rol: rolDe(socket.id), registrado: !!socket.data.registrado, tipo: 'imagen', imagenDataUrl, imagenNombre: String(imagenNombre || 'imagen'), hora };
      if (respuesta) msg.respuesta = respuesta;
      recordarMensaje(sala, msg);
      io.to(salaId).emit('mensajeSala', msg);
      const espectadores = [adminSocketId, ...moderadores].filter(sid => sid && !sala.usuarios.has(sid));
      espectadores.forEach(sid => io.to(sid).emit('mensajeSala', msg));
      socket.emit('sistema', { texto: 'Tu imagen se retira de la vista en 3 minutos. Se guarda una copia solo para moderacion durante 24h.' });
      return;
    }

    let textoLimpio = String(texto || '').trim().slice(0, 400);
    if (!textoLimpio) return;

    // Repeticiones (el staff queda fuera de esta norma)
    if (!privilegiado && esRepeticion(socket, textoLimpio)) {
      const clave = claveDePersona(socket);
      const avisadoEn = avisosRepeticion.get(clave);
      const emisor = emisorAutomatico();
      if (avisadoEn && Date.now() - avisadoEn < REPETICION_AVISO_VALIDO_MS) {
        avisosRepeticion.delete(clave);
        await aplicarBloqueo(socket, nick, 'Spam o publicidad', emisor.rol === 'usuario' ? NICK_BOT + ' (automatico)' : emisor.nick + ' (automatico)');
        return;
      }
      avisosRepeticion.set(clave, Date.now());
      socket.emit('error_app', 'No se permite repetir varias veces la misma frase.');
      io.to(salaId).emit('mensajeSala', {
        salaId, id: 'auto_' + Date.now() + '_' + Math.floor(Math.random() * 1000), nick: emisor.nick, rol: emisor.rol,
        registrado: emisor.registrado, tipo: 'texto', hora,
        texto: `@${nick} no está permitido repetir varias veces la misma frase. Si lo vuelves a hacer serás bloqueado durante 24 horas.`
      });
      return;
    }

    if (contieneMalasPalabras(textoLimpio)) {
      textoLimpio = censurar(textoLimpio);
      registrarInfraccionYComprobarEscalado(socket, ip, nick);
    }

    const msgId = 'msg_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    const msg = { salaId, id: msgId, nick, rol: rolDe(socket.id), registrado: !!socket.data.registrado, tipo: 'texto', texto: textoLimpio, hora };
    if (respuesta) msg.respuesta = respuesta;
    recordarMensaje(sala, msg);
    if (salaId === 'staff' && notasStaffCol) {
      guardarEnHistorialStaff({ tipo: 'texto', msgId, nick, texto: textoLimpio });
    } else {
      registrarEstadistica(nick);
    }
    io.to(salaId).emit('mensajeSala', msg);
    const espectadores = [adminSocketId, ...moderadores].filter(id => id && !sala.usuarios.has(id));
    espectadores.forEach(id => io.to(id).emit('mensajeSala', msg));
  });

  socket.on('reaccionar', ({ salaId, mensajeId, emoji }) => {
    const sala = salas.get(salaId);
    if (!sala || !REACCIONES_PERMITIDAS.includes(emoji)) return;
    if (!esModOAdmin(socket.id) && !socket.data.salasUnidas.has(salaId)) return;
    if (!recuperacion.permitir('reac:' + socket.id, 20, 10 * 1000)) return;
    const m = (sala.recientes || []).find(x => x.id === String(mensajeId));
    if (!m) return;
    const nick = usuariosConectados.get(socket.id);
    if (m.reacciones.get(nick) === emoji) m.reacciones.delete(nick); else m.reacciones.set(nick, emoji);
    const reacciones = {};
    m.reacciones.forEach((e, n) => { (reacciones[e] = reacciones[e] || []).push(n); });
    const payload = { salaId, mensajeId: m.id, reacciones };
    io.to(salaId).emit('reacciones', payload);
    [adminSocketId, ...moderadores].filter(id => id && !sala.usuarios.has(id)).forEach(id => io.to(id).emit('reacciones', payload));
  });

  // ---- Reclamar rol de administrador (requiere estar registrado) ----
  socket.on('reclamarAdmin', async ({ clave }) => {
    if (!socket.data.registrado) { socket.emit('error_app', 'Debes registrarte e iniciar sesion primero.'); return; }
    if (adminSocketId && adminSocketId !== socket.id) { socket.emit('error_app', 'Ya hay un administrador asignado en este chat.'); return; }
    if (clave !== ADMIN_KEY) { socket.emit('error_app', 'Clave incorrecta.'); return; }
    adminSocketId = socket.id;
    unirStaffATodas(socket);
    avisarPendientesAdmin().catch(() => {});
    if (usuariosCol) await usuariosCol.updateOne({ usuario: socket.data.usuario }, { $set: { rol: 'admin' } });
    socket.emit('rolAsignado', { rol: 'admin' });
    emitirSalasATodos();
    io.emit('sistema', { texto: `${socket.data.usuario} es ahora el administrador del chat` });
  });

  // ---- Asignar moderador (solo admin, el objetivo debe estar registrado) ----
  // ---- Crear directamente una cuenta nueva de moderador (solo admin) ----
  socket.on('crearCuentaModerador', async ({ usuario, contrasena }) => {
    if (socket.id !== adminSocketId) return;
    if (!usuariosCol) { socket.emit('error_app', 'La base de datos no esta disponible ahora mismo.'); return; }
    if ((await totalModeradores()) >= MAX_MODERADORES) { socket.emit('error_app', 'Ya hay 5 moderadores, el maximo permitido.'); return; }
    const u = String(usuario || '').trim();
    const uClave = u.toLowerCase();
    const p = String(contrasena || '');
    if (!/^[a-zA-Z0-9_.-]{3,20}$/.test(u)) {
      socket.emit('error_app', 'El usuario debe tener 3-20 caracteres: letras, numeros, guion (-), guion bajo (_) o punto (.).');
      return;
    }
    { const e = recuperacion.validarContrasena(p, null); if (e) { socket.emit('error_app', e); return; } }
    try {
      const hash = await bcrypt.hash(p, 10);
      await usuariosCol.insertOne({ usuario: u, usuarioClave: uClave, hash, rol: 'moderador', mayorDeEdad: true, creado: new Date() });
      socket.emit('avisoOk', `Cuenta "${u}" creada como moderador. Dale la contrasena a esa persona para que inicie sesion con ella.`);
    } catch (err) {
      if (err.code === 11000) socket.emit('error_app', 'Ya existe una cuenta con ese nombre de usuario.');
      else socket.emit('error_app', 'No se pudo crear la cuenta.');
    }
  });

  socket.on('asignarModerador', async ({ nickObjetivo }) => {
    if (socket.id !== adminSocketId) return;
    if ((await totalModeradores()) >= MAX_MODERADORES) { socket.emit('error_app', 'Ya hay 5 moderadores, el maximo permitido.'); return; }
    const uClave = String(nickObjetivo || '').trim().toLowerCase();
    let nombreReal = nickObjetivo;
    if (usuariosCol) {
      const doc = await usuariosCol.findOne({ usuarioClave: uClave });
      if (!doc) { socket.emit('error_app', 'Ese usuario no esta registrado.'); return; }
      nombreReal = doc.usuario;
      await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { rol: 'moderador' } });
    }
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n.toLowerCase() === uClave);
    if (destino) {
      moderadores.add(destino[0]);
      const socketDestino = io.sockets.sockets.get(destino[0]);
      if (socketDestino) unirStaffATodas(socketDestino);
      io.to(destino[0]).emit('rolAsignado', { rol: 'moderador' });
    }
    io.emit('sistema', { texto: `${nombreReal} es ahora moderador` });
    emitirSalasATodos();
  });

  // ---- Quitar moderador (solo admin) ----
  socket.on('quitarModerador', async ({ nickObjetivo }) => {
    if (socket.id !== adminSocketId) return;
    const uClave = String(nickObjetivo || '').trim().toLowerCase();
    let nombreReal = nickObjetivo;
    if (usuariosCol) {
      const doc = await usuariosCol.findOne({ usuarioClave: uClave });
      if (doc) nombreReal = doc.usuario;
      await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { rol: 'usuario' } });
    }
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n.toLowerCase() === uClave);
    if (destino) {
      moderadores.delete(destino[0]);
      const socketDestino = io.sockets.sockets.get(destino[0]);
      if (socketDestino) {
        // Vuelve a ser usuario normal: se queda solo en La Plaza
        Array.from(socketDestino.data.salasUnidas).filter(id => id !== 'plaza').forEach(id => abandonarSala(socketDestino, id, true));
      }
      io.to(destino[0]).emit('rolAsignado', { rol: 'usuario' });
    }
    io.emit('sistema', { texto: `${nombreReal} ya no es moderador` });
    emitirSalasATodos();
  });

  // ---- Indicador de "esta escribiendo" ----
  socket.on('escribiendo', ({ salaId }) => {
    if (!salaId) return;
    socket.to(salaId).emit('escribiendo', { salaId, nick: usuariosConectados.get(socket.id) });
  });

  socket.on('dejoEscribir', ({ salaId }) => {
    if (!salaId) return;
    socket.to(salaId).emit('dejoEscribir', { salaId, nick: usuariosConectados.get(socket.id) });
  });

  // ---- Eliminar sala (admin o quien la creo) ----
  // ---- Banear IP (admin o moderador) ----
  // ---- Restablecer contraseña de un usuario (admin o moderador) ----
  socket.on('restablecerContrasena', async ({ usuario, nuevaContrasena }) => {
    if (!esModOAdmin(socket.id)) return;
    if (!usuariosCol) { socket.emit('error_app', 'La base de datos no esta disponible ahora mismo.'); return; }
    const uClave = String(usuario || '').trim().toLowerCase();
    const p = String(nuevaContrasena || '');
    { const e = recuperacion.validarContrasena(p, null); if (e) { socket.emit('error_app', e); return; } }
    const doc = await usuariosCol.findOne({ usuarioClave: uClave });
    if (!doc) { socket.emit('error_app', 'Ese usuario no existe.'); return; }
    const hash = await bcrypt.hash(p, 10);
    await usuariosCol.updateOne({ usuarioClave: uClave }, { $set: { hash } });
    socket.emit('avisoOk', `Contrasena de ${doc.usuario} restablecida correctamente.`);
  });

  // Localiza a la persona a bloquear y comprueba quién puede bloquear a quién
  function destinoDeBloqueo(solicitante, nickObjetivo) {
    const destino = Array.from(usuariosConectados.entries()).find(([, n]) => n === nickObjetivo);
    if (!destino) return { error: 'Ese usuario no esta conectado ahora mismo.' };
    const socketDestino = io.sockets.sockets.get(destino[0]);
    if (!socketDestino) return { error: 'Ese usuario no esta conectado ahora mismo.' };
    if (socketDestino.id === solicitante.id) return { error: 'No puedes bloquearte a ti mismo.' };
    const rolDestino = rolDe(socketDestino.id);
    if (rolDestino === 'admin') return { error: 'No se puede bloquear al administrador.' };
    if (rolDestino === 'moderador' && solicitante.id !== adminSocketId) return { error: 'Solo el administrador puede bloquear a un moderador.' };
    return { socketDestino };
  }

  // Vista previa: qué nivel de bloqueo le tocaría a esa persona
  socket.on('previsualizarBloqueo', async ({ nickObjetivo }) => {
    if (!esModOAdmin(socket.id)) return;
    const { socketDestino, error } = destinoDeBloqueo(socket, nickObjetivo);
    if (error) { socket.emit('error_app', error); return; }
    const uClave = socketDestino.data.registrado && socketDestino.data.usuario ? socketDestino.data.usuario.toLowerCase() : null;
    const n = await nivelSiguiente(obtenerIP(socketDestino), uClave);
    socket.emit('previaBloqueo', { nick: nickObjetivo, nivel: n.nivel, horas: n.horas, duracion: textoDuracion(n.horas), previos: n.previos, registrado: !!uClave });
  });

  socket.on('banearIP', async ({ nickObjetivo, motivo, horas }) => {
    if (!esModOAdmin(socket.id)) return;
    const { socketDestino, error } = destinoDeBloqueo(socket, nickObjetivo);
    if (error) { socket.emit('error_app', error); return; }
    const motivoFinal = MOTIVOS_BLOQUEO.includes(motivo) ? motivo : 'Otro motivo';
    await aplicarBloqueo(socketDestino, nickObjetivo, motivoFinal, usuariosConectados.get(socket.id), Number(horas));
  });

  // ---- Listado y desbaneo de IPs (admin o moderador) ----
  socket.on('pedirEstadisticas', async () => {
    if (!esModOAdmin(socket.id)) return;
    if (!estadisticasCol || !usuariosCol) { socket.emit('error_app', 'Estadisticas no disponibles ahora mismo.'); return; }

    const global = await estadisticasCol.findOne({ _id: 'global' });
    const hoy = new Date().toISOString().slice(0, 10);
    const deHoy = await estadisticasCol.findOne({ _id: 'dia_' + hoy });
    const totalRegistrados = await usuariosCol.countDocuments({});

    let topUsuarios = [];
    let horaPico = null;
    if (global && global.porUsuario) {
      topUsuarios = Object.entries(global.porUsuario)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([nick, total]) => ({ nick, total }));
    }
    if (global && global.porHora) {
      const entradas = Object.entries(global.porHora).sort((a, b) => b[1] - a[1]);
      if (entradas.length) horaPico = `${entradas[0][0]}:00 - ${Number(entradas[0][0]) + 1}:00`;
    }

    socket.emit('estadisticas', {
      totalMensajes: (global && global.totalMensajes) || 0,
      mensajesHoy: (deHoy && deHoy.mensajes) || 0,
      conectadosAhora: usuariosConectados.size,
      salasActivas: Array.from(salas.values()).filter(s => !s.oculta).length,
      totalRegistrados,
      horaPico,
      topUsuarios
    });
  });

  async function listaBaneadosPanel() {
    if (!baneadosCol) return [];
    const ahora = Date.now();
    const lista = await baneadosCol.find({}).sort({ fecha: -1 }).toArray();
    return lista
      .filter(b => !b.expira || new Date(b.expira).getTime() > ahora)
      .map(b => ({
        ip: b.ip, nick: b.nick, baneadoPor: b.baneadoPor || '—',
        fecha: new Date(b.fecha).toLocaleString('es-ES', { timeZone: ZONA_HORARIA }),
        motivo: b.motivo || null, nivel: b.nivel || 0, cuenta: !!b.usuarioClave,
        hasta: b.expira ? new Date(b.expira).toLocaleString('es-ES', { timeZone: ZONA_HORARIA }) : null,
        mensajesApelacion: (b.mensajesApelacion || []).map(m => ({ texto: m.texto, fecha: new Date(m.fecha).toLocaleString('es-ES', { timeZone: ZONA_HORARIA }) }))
      }));
  }
  socket.on('pedirBaneados', async () => {
    if (!esModOAdmin(socket.id) || !baneadosCol) return;
    socket.emit('listaBaneados', await listaBaneadosPanel());
  });

  socket.on('desbanearIP', async ({ ip }) => {
    if (!esModOAdmin(socket.id)) return;
    const doc = baneadosCol ? await baneadosCol.findOne({ ip }) : null;
    ipsBaneadasCache.delete(ip);
    if (doc && doc.usuarioClave) cuentasBaneadasCache.delete(doc.usuarioClave);
    // Si se retira un bloqueo que seguía activo (por error), no cuenta como reincidencia
    if (doc && doc.nivel > 0 && doc.expira && new Date(doc.expira).getTime() > Date.now()) await sumarBloqueo(ip, doc.usuarioClave, -1);
    if (baneadosCol) await baneadosCol.deleteOne({ ip });
    socket.emit('avisoOk', 'IP desbloqueada correctamente.');
    socket.emit('listaBaneados', await listaBaneadosPanel());
  });

  // ---- Chats privados (100% anonimos, ni siquiera admin/mod los ven) ----
  function socketPorNick(nickBuscado) {
    const entrada = Array.from(usuariosConectados.entries()).find(([, n]) => n === nickBuscado);
    return entrada ? io.sockets.sockets.get(entrada[0]) : null;
  }

  socket.on('abrirPrivado', ({ nickObjetivo }) => {
    const miNick = usuariosConectados.get(socket.id);
    if (!nickObjetivo || nickObjetivo === miNick) return;
    if (socket.data.privados.has(nickObjetivo)) {
      const canalExistente = socket.data.privados.get(nickObjetivo);
      socket.emit('privadoAbierto', { canalId: canalExistente, conNick: nickObjetivo, iniciaste: true });
      return;
    }
    const otro = socketPorNick(nickObjetivo);
    if (!otro) { socket.emit('error_app', 'Ese usuario ya no esta conectado.'); return; }
    if (socket.data.privados.size >= MAX_PRIVADOS_POR_USUARIO) {
      socket.emit('error_app', `Solo puedes tener ${MAX_PRIVADOS_POR_USUARIO} chats privados a la vez.`);
      return;
    }
    if (otro.data.privados.size >= MAX_PRIVADOS_POR_USUARIO) {
      socket.emit('error_app', `${nickObjetivo} ya tiene ${MAX_PRIVADOS_POR_USUARIO} chats privados abiertos ahora mismo.`);
      return;
    }
    const canalId = 'priv_' + [miNick, nickObjetivo].sort().join('_').replace(/[^a-zA-Z0-9_]/g, '');
    socket.join(canalId);
    otro.join(canalId);
    socket.data.privados.set(nickObjetivo, canalId);
    otro.data.privados.set(miNick, canalId);
    socket.emit('privadoAbierto', { canalId, conNick: nickObjetivo, iniciaste: true });
    otro.emit('privadoAbierto', { canalId, conNick: miNick, iniciaste: false });
  });

  socket.on('mensajePrivado', ({ canalId, texto }) => {
    if (!socket.rooms.has(canalId)) return;
    const textoLimpio = String(texto || '').trim().slice(0, 400);
    if (!textoLimpio) return;
    const lista = textosPrivados.get(canalId) || [];
    lista.push({ nick: usuariosConectados.get(socket.id), texto: textoLimpio });
    if (lista.length > 10) lista.shift();
    textosPrivados.set(canalId, lista);
    io.to(canalId).emit('mensajePrivado', {
      canalId, nick: usuariosConectados.get(socket.id), texto: textoLimpio,
      hora: horaMadrid()
    });
  });

  socket.on('imagenPrivada', ({ canalId, imagenDataUrl, imagenNombre }) => {
    if (!socket.rooms.has(canalId)) return;
    if (!esImagenValida(imagenDataUrl)) { socket.emit('error_app', 'Solo se permiten imagenes (foto o GIF) de hasta 4MB.'); return; }
    io.to(canalId).emit('imagenPrivada', {
      canalId, nick: usuariosConectados.get(socket.id), imagenDataUrl, imagenNombre: String(imagenNombre || 'imagen'),
      hora: horaMadrid()
    });
    const lista = textosPrivados.get(canalId) || [];
    lista.push({ nick: usuariosConectados.get(socket.id), texto: '[imagen]' });
    if (lista.length > 10) lista.shift();
    textosPrivados.set(canalId, lista);
    // Las imagenes no se guardan: el privado se borra al cerrarse.
  });

  function cerrarPrivadoInterno(socketOrigen, canalId, motivo) {
    terminarLlamada(canalId, 'privado_cerrado');
    textosPrivados.delete(canalId);
    const miNickOrigen = usuariosConectados.get(socketOrigen.id);
    let otroNick = null;
    socketOrigen.data.privados.forEach((c, nick) => { if (c === canalId) otroNick = nick; });
    socketOrigen.leave(canalId);
    if (otroNick) socketOrigen.data.privados.delete(otroNick);
    io.to(canalId).emit('privadoCerrado', { canalId, motivo: motivo || 'cerrado', porQuien: miNickOrigen });
    const otro = otroNick ? socketPorNick(otroNick) : null;
    if (otro) { otro.leave(canalId); otro.data.privados.delete(miNickOrigen); }
  }

  socket.on('cerrarPrivado', ({ canalId }) => cerrarPrivadoInterno(socket, canalId, 'cerrado'));

  // ---- Videollamada: solo entre las dos personas de un privado y solo si la otra acepta ----
  function otroDelCanal(canalId) {
    let nick = null;
    socket.data.privados.forEach((c, n) => { if (c === canalId) nick = n; });
    return nick ? socketPorNick(nick) : null;
  }
  // ---- Denunciar un chat privado: la persona decide enviar a moderacion los ultimos mensajes ----
  socket.on('reportarPrivado', ({ canalId, motivo }) => {
    const otro = otroDelCanal(canalId);
    const yo = usuariosConectados.get(socket.id);
    if (!otro) { socket.emit('error_app', 'No se puede enviar el reporte: la otra persona ya no está en el chat.'); return; }
    if (!recuperacion.permitir('repp:' + socket.id, 5, 60 * 60 * 1000)) { socket.emit('error_app', 'Has enviado muchos reportes seguidos. Espera un poco.'); return; }
    const m = MOTIVOS_REPORTE.includes(motivo) ? motivo : 'Otro motivo';
    const nickOtro = usuariosConectados.get(otro.id);
    const ultimos = (textosPrivados.get(canalId) || []).slice(-8).map(x => `${x.nick}: ${String(x.texto).slice(0, 100)}`).join(' | ');
    avisarAlStaff((`🚩 PRIVADO · ${yo} denuncia a ${nickOtro} · ${m}` + (ultimos ? ` · Últimos mensajes → ${ultimos}` : '')).slice(0, 900));
    registrarReporte(nickOtro, yo);
    socket.emit('avisoOk', 'Gracias. Hemos enviado tu denuncia y los últimos mensajes de esta conversación a los moderadores. Nadie más los ha visto.');
  });

  socket.on('llamadaSolicitar', ({ canalId }) => {
    if (typeof canalId !== 'string') return;
    const otro = otroDelCanal(canalId);
    if (!otro) { socket.emit('error_app', 'La otra persona ya no está conectada.'); return; }
    if (socket.data.llamadaCanal) { socket.emit('error_app', 'Ya estás en una videollamada.'); return; }
    if (otro.data.llamadaCanal) { socket.emit('error_app', 'Esa persona está ahora en otra videollamada.'); return; }
    if (!recuperacion.permitir('llam:' + socket.id, 6, 10 * 60 * 1000)) { socket.emit('error_app', 'Demasiados intentos de videollamada. Espera un poco.'); return; }
    const l = { a: socket.id, b: otro.id, estado: 'solicitada', timer: setTimeout(() => terminarLlamada(canalId, 'sin_respuesta'), 45 * 1000) };
    llamadas.set(canalId, l);
    socket.data.llamadaCanal = canalId;
    otro.data.llamadaCanal = canalId;
    otro.emit('llamadaSolicitud', { canalId, de: usuariosConectados.get(socket.id) });
  });
  socket.on('llamadaResponder', ({ canalId, aceptar }) => {
    const l = llamadas.get(canalId);
    if (!l || l.estado !== 'solicitada' || l.b !== socket.id) return;
    if (!aceptar) { terminarLlamada(canalId, 'rechazada'); return; }
    clearTimeout(l.timer);
    l.estado = 'activa';
    const quien = io.sockets.sockets.get(l.a);
    if (quien) quien.emit('llamadaAceptada', { canalId });
  });
  socket.on('llamadaSenal', ({ canalId, data }) => {
    const l = llamadas.get(canalId);
    if (!l || l.estado !== 'activa' || (socket.id !== l.a && socket.id !== l.b)) return;
    if (!recuperacion.permitir('senal:' + socket.id, 400, 60 * 1000)) return;
    let largo = 0;
    try { largo = JSON.stringify(data || {}).length; } catch (e) { return; }
    if (largo > 20000) return;
    const destino = io.sockets.sockets.get(socket.id === l.a ? l.b : l.a);
    if (destino) destino.emit('llamadaSenal', { canalId, data });
  });
  socket.on('llamadaColgar', ({ canalId }) => {
    const l = llamadas.get(canalId);
    if (l && (l.a === socket.id || l.b === socket.id)) terminarLlamada(canalId, 'colgada');
  });

  // ---- Reportar mensaje (cualquier usuario) ----
  // ---- Eliminar un mensaje concreto (admin o moderador), dejando constancia ----
  socket.on('eliminarMensaje', ({ salaId, mensajeId }) => {
    if (!esModOAdmin(socket.id)) return;
    if (!salaId || !mensajeId) return;
    { const sl = salas.get(salaId); if (sl && sl.recientes) sl.recientes = sl.recientes.filter(m => m.id !== String(mensajeId)); }
    if (salaId === 'staff' && notasStaffCol) notasStaffCol.deleteOne({ msgId: String(mensajeId) }).catch(() => {});
    io.to(salaId).emit('mensajeEliminado', { salaId, mensajeId });
    const sala = salas.get(salaId);
    if (sala) {
      const espectadores = [adminSocketId, ...moderadores].filter(id => id && !sala.usuarios.has(id));
      espectadores.forEach(id => io.to(id).emit('mensajeEliminado', { salaId, mensajeId }));
    }
  });

  socket.on('reportarMensaje', ({ salaId, nickReportado, texto }) => {
    const sala = salas.get(salaId);
    const nombreSala = sala ? sala.nombre : salaId;
    const quienReporta = usuariosConectados.get(socket.id);
    const resumen = String(texto || '').slice(0, 120);
    const aviso = `🚩 ${quienReporta} reportó a ${nickReportado} en "${nombreSala}": "${resumen}"`;
    if (!recuperacion.permitir('rep:' + socket.id, 10, 60 * 60 * 1000)) { socket.emit('error_app', 'Has enviado muchos reportes seguidos. Espera un poco.'); return; }
    avisarAlStaff(aviso);
    registrarReporte(nickReportado, quienReporta);
    socket.emit('avisoOk', 'Gracias, tu reporte se ha enviado a los moderadores.');
  });

  socket.on('eliminarSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    if (!sala) return;
    if (sala.oculta) return;
    if (sala.fija) { socket.emit('error_app', 'La Plaza es la sala principal y no se puede cerrar.'); return; }
    const esCreador = esCreadorDeSala(sala, socket.id);
    const esPriv = esModOAdmin(socket.id);

    if (!esPriv && (!esCreador || sala.permanente)) { socket.emit('error_app', 'No puedes cerrar esta sala.'); return; }

    if (!esPriv && esCreador) {
      const hayOtrosDentro = Array.from(sala.usuarios).some(id => id !== socket.id);
      if (hayOtrosDentro) {
        socket.emit('error_app', 'No puedes cerrar la sala mientras haya otras personas dentro.');
        return;
      }
    }

    salas.delete(salaId);
    borrarSalaFija(salaId);
    io.socketsLeave(salaId);
    emitirSalasATodos();
    io.emit('salaEliminada', { salaId });
    io.emit('sistema', { texto: `La sala "${sala.nombre}" ha sido cerrada` });
  });

  socket.on('pedirUsuariosDeSala', ({ salaId }) => {
    const sala = salas.get(salaId);
    if (sala) socket.emit('usuariosDeSala', { salaId, usuarios: usuariosDeSala(sala) });
  });

  // ---- Revisión de imágenes retenidas (solo staff) ----
  const nombreDeSala = (id) => (salas.get(id) ? salas.get(id).nombre : 'sala cerrada');
  socket.on('pedirImagenes', () => {
    if (!esModOAdmin(socket.id)) return;
    const lista = Array.from(imagenesModeracion.entries())
      .map(([id, im]) => ({ id, nick: im.nick, sala: nombreDeSala(im.salaId), salaId: im.salaId, fecha: im.fecha }))
      .sort((a, b) => b.fecha - a.fecha);
    socket.emit('listaImagenes', lista);
  });
  socket.on('verImagen', ({ id }) => {
    if (!esModOAdmin(socket.id)) return;
    const im = imagenesModeracion.get(String(id));
    if (!im) { socket.emit('error_app', 'Esa imagen ya no está guardada.'); return; }
    socket.emit('imagenModeracion', { id: String(id), nick: im.nick, sala: nombreDeSala(im.salaId), salaId: im.salaId, fecha: im.fecha, dataUrl: im.dataUrl });
  });

  // ---- Diagnóstico de cómo ve el servidor la conexión del admin (para revisar el bloqueo por IP) ----
  socket.on('diagnosticoIP', () => {
    if (socket.id !== adminSocketId) return;
    const h = socket.handshake.headers;
    socket.emit('diagnosticoIP', { detectada: obtenerIP(socket), cf: h['cf-connecting-ip'] || null, xff: h['x-forwarded-for'] || null, directa: socket.handshake.address || null });
  });

  socket.on('pedirEquipo', async () => {
    if (!esModOAdmin(socket.id)) return;
    try { socket.emit('listaEquipo', await datosEquipo()); } catch (e) { console.error('Equipo:', e.message); }
  });

  socket.on('pedirUsuarios', () => {
    if (esModOAdmin(socket.id)) socket.emit('listaUsuarios', listaUsuarios());
  });

  // ---- Desconexion ----
  socket.on('disconnect', () => {
    const nickSaliente = usuariosConectados.get(socket.id);
    socket.data.privados.forEach((canalId, otroNick) => {
      terminarLlamada(canalId, 'desconexion');
      textosPrivados.delete(canalId);
      io.to(canalId).emit('privadoCerrado', { canalId, motivo: 'desconexion', porQuien: nickSaliente });
      const otro = socketPorNick(otroNick);
      if (otro) { otro.leave(canalId); otro.data.privados.delete(nickSaliente); }
    });
    usuariosConectados.delete(socket.id);
    salas.forEach(sala => {
      if (sala.usuarios.has(socket.id)) {
        sala.usuarios.delete(socket.id);
        marcarEstadoVacio(sala);
        io.emit('usuariosDeSala', { salaId: sala.id, usuarios: usuariosDeSala(sala) });
      }
    });
    if (adminSocketId === socket.id) adminSocketId = null;
    moderadores.delete(socket.id);
    io.emit('sistema', { texto: `${nickSaliente} se ha desconectado` });
    io.emit('totalConectados', usuariosConectados.size);
    emitirSalasATodos();
  });
});

const PUERTO = process.env.PORT || 3000;

// Cada minuto, borra las salas que llevan 5 minutos o mas sin nadie dentro
setInterval(() => {
  const ahora = Date.now();
  salas.forEach((sala, id) => {
    if (sala.vacioDesde && ahora - sala.vacioDesde >= 5 * 60 * 1000) {
      salas.delete(id);
      emitirSalasATodos();
      io.emit('salaEliminada', { salaId: id });
      io.emit('sistema', { texto: `La sala "${sala.nombre}" se elimino por estar vacia` });
    }
  });
}, 60 * 1000);

async function limpiarBloqueosCaducados() {
  if (!baneadosCol) return;
  try {
    const ahora = Date.now();
    const lista = await baneadosCol.find({}).toArray();
    for (const b of lista) if (b.expira && new Date(b.expira).getTime() <= ahora) await baneadosCol.deleteOne({ ip: b.ip });
  } catch (e) { /* silencioso */ }
}
setInterval(limpiarBloqueosCaducados, 60 * 60 * 1000).unref();

app.get('/salud', (req, res) => res.json({ ok: true }));
// Si en Render se define URL_PUBLICA (la direccion del chat), el servidor se visita a si mismo cada 10 minutos
if (process.env.URL_PUBLICA) {
  const urlSalud = process.env.URL_PUBLICA.replace(/\/$/, '') + '/salud';
  setInterval(() => { fetch(urlSalud).catch(() => {}); }, 10 * 60 * 1000).unref();
}

conectarDB().finally(() => {
  limpiarBloqueosCaducados();
  server.listen(PUERTO, () => console.log(`Chat educativo escuchando en el puerto ${PUERTO}`));
});
