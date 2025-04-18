// servidor.js

const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Base de datos SQLite
let db;
const openDB = async () => {
  if (!db) {
    db = await open({
      filename: './conversaciones.db',
      driver: sqlite3.Database
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS conversaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_id TEXT,
        numero TEXT,
        rol TEXT,
        contenido TEXT,
        timestamp INTEGER
      )
    `);
  }
  return db;
};

// Envío de mensaje por WhatsApp
const enviarMensajeWhatsApp = async (numero, texto, phone_id) => {
  await axios.post(
    `https://graph.facebook.com/v18.0/${phone_id}/messages`,
    {
      messaging_product: "whatsapp",
      to: numero,
      text: { body: "🤖 " + texto }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );
};

// Webhook de recepción de mensajes
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (!body.object) return res.sendStatus(404);

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messageObject = value?.messages?.[0];
  const phone_id = value?.metadata?.phone_number_id;

  if (!messageObject) return res.sendStatus(200);

  const rawNumber = messageObject.from;
  const phoneNumber = rawNumber.replace(/^521/, '52');
  const messageText = messageObject.text?.body;
  const timestamp = parseInt(messageObject.timestamp);
  const wa_id = messageObject.id;
  const quotedId = messageObject.context?.id || null;
  const tipo = messageObject.type || 'desconocido';

  // Ignorar mensajes sin texto
  if (!messageText) return res.sendStatus(200);

  try {
    const db = await openDB();

    // Notificación básica
    let info = `🧾 wa_id recibido:\n${wa_id}`;
    if (quotedId) {
      info += `\n📎 quotedId recibido:\n${quotedId}`;
      info += `\n🔍 Buscando mensaje con wa_id = ${quotedId}`;
    }
    await enviarMensajeWhatsApp(phoneNumber, info, phone_id);

    // Guardar mensaje del cliente
    await db.run(
      'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
      [wa_id, phoneNumber, 'user', messageText, timestamp]
    );

    // Historial de cliente
    const seisMeses = 60 * 60 * 24 * 30 * 6;
    const desde = Date.now() / 1000 - seisMeses;
    const userMessages = await db.all(
      `SELECT * FROM conversaciones 
       WHERE numero = ? AND rol = 'user' AND timestamp >= ?
       ORDER BY timestamp DESC LIMIT 30`,
      [phoneNumber, desde]
    );
    const primerTimestamp = userMessages.length > 0
      ? userMessages[userMessages.length - 1].timestamp
      : Date.now() / 1000;

    // Manejar mensaje citado
    if (quotedId) {
      let citadoDB = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);

      if (!citadoDB) {
        await new Promise(resolve => setTimeout(resolve, 300));
        citadoDB = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
      }

      if (citadoDB) {
        const quien = citadoDB.rol === 'user' ? 'el cliente' : 'Dinurba';

        await enviarMensajeWhatsApp(phoneNumber, `✅ Mensaje citado encontrado:\n"${citadoDB.contenido}"`, phone_id);

        const bloqueCita = `El cliente citó un mensaje anterior de ${quien}: "${citadoDB.contenido}". Luego escribió: "${messageText}". Interpreta la relación entre ambos. Si el cliente solo quiere saber qué decía exactamente el mensaje citado, responde solo el texto citado.`;

        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
          [`system-${wa_id}`, phoneNumber, 'system', bloqueCita, timestamp]
        );

        await enviarMensajeWhatsApp(phoneNumber, `🤖 Bloque system guardado:\n${bloqueCita}`, phone_id);

        await db.run('UPDATE conversaciones SET rol = ? WHERE wa_id = ?', ['user_omitido', wa_id]);
      }
    }

    // Construcción del contexto para la IA
    const allMessages = await db.all(
      `SELECT * FROM conversaciones
       WHERE numero = ? AND timestamp >= ? AND rol != 'user_omitido'
       ORDER BY timestamp ASC`,
      [phoneNumber, primerTimestamp]
    );

    const contexto = allMessages.map(msg => ({
      role: msg.rol === 'user' ? 'user' :
            msg.rol === 'assistant' ? 'assistant' :
            msg.rol === 'system' ? 'system' :
            msg.rol === 'dinurba' ? 'assistant' : 'assistant',
      content: msg.contenido
    }));

    await enviarMensajeWhatsApp(phoneNumber, `📦 Tipo de contenido recibido: ${tipo}`, phone_id);
    await enviarMensajeWhatsApp(phoneNumber, `🧠 Contexto enviado a la IA:\n\`\`\`\n${JSON.stringify(contexto, null, 2)}\n\`\`\``, phone_id);

    // Solicitud a OpenAI con GPT personalizado
    const respuestaIA = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: "g-6802cfdc02bc81919e03fb716c205149-dinurba", // 👈 Reemplaza con tu ID real
        messages: contexto
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const respuestaGenerada = respuestaIA.data.choices[0].message.content;

    // Enviar respuesta por WhatsApp
    const respuestaWa = await axios.post(
      `https://graph.facebook.com/v18.0/${phone_id}/messages`,
      {
        messaging_product: "whatsapp",
        to: phoneNumber,
        text: { body: "🤖 " + respuestaGenerada.slice(0, 4096) }
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          'Content-Type': 'application/json'
        }
      }
    );

    const respuestaId = respuestaWa.data.messages?.[0]?.id || null;

    await db.run(
      'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
      [respuestaId, phoneNumber, 'dinurba', respuestaGenerada, Date.now() / 1000]
    );

  } catch (error) {
    const errorMsg = error.response?.data?.error?.message || error.message;
    console.error("❌ Error:", errorMsg);
    await enviarMensajeWhatsApp(phoneNumber, `❌ Error: ${errorMsg}`, phone_id);
  }

  return res.sendStatus(200);
});

// Webhook GET (verificación con Meta)
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && token === process.env.VERIFY_TOKEN) {
    console.log("✅ Webhook verificado.");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Arranque del servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
