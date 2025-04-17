const express = require('express');
const axios = require('axios');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VERIFY_TOKEN = process.env.VERY_TOKEN;
const WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v18.0';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4';

// Inicializar conexión a la base de datos una vez
let db;
async function initializeDB() {
  db = await open({
    filename: './conversaciones.db',
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS conversaciones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      numero TEXT,
      rol TEXT,
      contenido TEXT,
      timestamp INTEGER
    )
  `);
}

// Validar firma del webhook de WhatsApp
function verifyWebhookSignature(req, res, next) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return res.sendStatus(401);

  const hmac = crypto
    .createHmac('sha256', WHATSAPP_TOKEN)
    .update(JSON.stringify(req.body))
    .digest('hex');
  const expectedSignature = `sha256=${hmac}`;

  if (signature !== expectedSignature) return res.sendStatus(403);
  next();
}

app.post('/webhook', verifyWebhookSignature, async (req, res) => {
  const body = req.body;

  if (!body.object) return res.sendStatus(404);

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messageObject = value?.messages?.[0];

  if (!messageObject) return res.sendStatus(200);

  const rawNumber = messageObject.from;
  const phoneNumber = rawNumber.replace(/^521/, '52');
  const messageText = messageObject.text?.body;
  const timestamp = parseInt(messageObject.timestamp);
  const quotedMessage = messageObject.context?.id || null;

  console.log(`📩 Mensaje recibido de ${phoneNumber}: ${messageText}`);

  try {
    // Guardar mensaje del usuario
    await db.run(
      'INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
      [phoneNumber, 'user', messageText, timestamp]
    );

    // Obtener historial de conversación (últimos 30 mensajes, 6 meses)
    const rows = await db.all(
      `SELECT * FROM conversaciones 
       WHERE numero = ? AND timestamp >= ? 
       ORDER BY timestamp ASC LIMIT 30`,
      [phoneNumber, Date.now() / 1000 - 60 * 60 * 24 * 30 * 6]
    );

    const historial = rows.map((m) => ({
      role: m.rol === 'user' ? 'user' : 'assistant',
      content: m.contenido,
    }));

    // Cargar contexto del negocio
    const conocimiento_dinurba = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));
    const instrucciones = conocimiento_dinurba.instrucciones_respuesta || [];

    const sistema = [
      {
        role: 'system',
        content: conocimiento_dinurba.contexto_negocio || 'Eres un asistente virtual de Dinurba.',
      },
      ...instrucciones.map((instr) => ({
        role: 'system',
        content: instr,
      })),
    ];

    // Manejar mensaje citado
    let citado = null;
    if (quotedMessage) {
      const mensajeCitado = await db.get('SELECT * FROM conversaciones WHERE id = ?', [quotedMessage]);
      if (mensajeCitado) {
        const quien = mensajeCitado.rol === 'user' ? 'el cliente' : 'Dinurba';
        citado = {
          role: 'system',
          content: `El cliente está citando un mensaje anterior de ${quien}, que decía: "${mensajeCitado.contenido}".`,
        };
      }
    }

    const contexto = citado ? [...sistema, citado, ...historial] : [...sistema, ...historial];

    // Generar respuesta de IA
    const respuestaIA = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: OPENAI_MODEL,
        messages: contexto,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const respuesta = respuestaIA.data.choices[0].message.content;

    // Guardar respuesta del bot
    await db.run(
      'INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
      [phoneNumber, 'dinurba', respuesta, Date.now() / 1000]
    );

    // Enviar respuesta a WhatsApp
    await axios.post(
      `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${value.metadata.phone_number_id}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phoneNumber,
        text: { body: `🤖 ${respuesta}` },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log('✅ Respuesta enviada a WhatsApp.');
    return res.sendStatus(200);
  } catch (error) {
    console.error('❌ Error:', error.response?.data || error.message);
    return res.sendStatus(500);
  }
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Webhook verificado.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Iniciar servidor y base de datos
(async () => {
  try {
    await initializeDB();
    app.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
    });
  } catch (error) {
    console.error('❌ Error iniciando el servidor:', error);
    process.exit(1);
  }
})();
