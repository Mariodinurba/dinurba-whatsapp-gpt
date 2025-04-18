const express = require('express');
const axios = require('axios');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

// ✅ Usamos el número de teléfono de value.metadata.phone_number_id directamente
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

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObject = value?.messages?.[0];
    const phone_id = value?.metadata?.phone_number_id;

    if (messageObject) {
      const rawNumber = messageObject.from;
      const phoneNumber = rawNumber.replace(/^521/, '52');
      const messageText = messageObject.text?.body;
      const timestamp = parseInt(messageObject.timestamp);
      const wa_id = messageObject.id;
      const quotedId = messageObject.context?.id || null;

      try {
        const db = await openDB();

        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
          [wa_id, phoneNumber, 'user', messageText, timestamp]
        );

        await enviarMensajeWhatsApp(phoneNumber, "🔹 Mensaje guardado en base de datos.", phone_id);

        const seisMeses = 60 * 60 * 24 * 30 * 6;
        const desde = Date.now() / 1000 - seisMeses;

        const userMessages = await db.all(
          `SELECT * FROM conversaciones 
           WHERE numero = ? AND rol = 'user' AND timestamp >= ?
           ORDER BY timestamp DESC LIMIT 30`,
          [phoneNumber, desde]
        );

        await enviarMensajeWhatsApp(phoneNumber, `🔹 Últimos ${userMessages.length} mensajes obtenidos.`, phone_id);

        const primerTimestamp = userMessages.length > 0
          ? userMessages[userMessages.length - 1].timestamp
          : Date.now() / 1000;

        const allMessages = await db.all(
          `SELECT * FROM conversaciones
           WHERE numero = ? AND timestamp >= ?
           ORDER BY timestamp ASC`,
          [phoneNumber, primerTimestamp]
        );

        const historial = allMessages.map(m => ({
          role: m.rol === 'user' ? 'user' : 'assistant',
          content: m.contenido
        }));

        await enviarMensajeWhatsApp(phoneNumber, "🔹 Historial preparado.", phone_id);

        const conocimiento = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));
        const sistema = conocimiento.map(instr => ({
          role: "system",
          content: instr
        }));

        let citado = null;

        if (quotedId) {
          await enviarMensajeWhatsApp(phoneNumber, `🔹 Buscando mensaje citado: ${quotedId}`, phone_id);
          let citadoDB = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);

          if (!citadoDB) {
            await new Promise(resolve => setTimeout(resolve, 300));
            citadoDB = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
          }

          if (citadoDB) {
            await enviarMensajeWhatsApp(phoneNumber, `🔹 Mensaje citado encontrado: "${citadoDB.contenido}"`, phone_id);
            const quien = citadoDB.rol === 'user' ? 'el cliente' : 'Dinurba';

            if (messageText.toLowerCase().includes("literalmente")) {
              citado = {
                role: 'system',
                content: `El cliente pidió conocer el contenido literal de un mensaje citado. Este fue el mensaje citado: "${citadoDB.contenido}". No agregues nada más.`
              };
            } else {
              citado = {
                role: 'system',
                content: `El cliente citó un mensaje anterior de ${quien}: "${citadoDB.contenido}". Luego escribió: "${messageText}". Responde interpretando la relación entre ambos.`
              };
            }
          } else {
            await enviarMensajeWhatsApp(phoneNumber, "⚠️ Mensaje citado no encontrado.", phone_id);
          }
        }

        let contexto = [...sistema];
        if (citado) contexto.push(citado);
        contexto.push(...historial);

        await enviarMensajeWhatsApp(phoneNumber, "🧠 Enviando contexto a IA...", phone_id);

        const respuestaIA = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: "gpt-4",
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

        await enviarMensajeWhatsApp(phoneNumber, "✅ IA respondió. Enviando mensaje final...", phone_id);

        const respuestaWa = await axios.post(
          `https://graph.facebook.com/v18.0/${phone_id}/messages`,
          {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: { body: "🤖 " + respuestaGenerada }
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
          [respuestaId, phoneNumber, 'dinurba', "🤖 " + respuestaGenerada, Date.now() / 1000]
        );

        await enviarMensajeWhatsApp(phoneNumber, "📦 Respuesta guardada en base de datos.", phone_id);

      } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        console.error("❌ Error:", errorMsg);
        await enviarMensajeWhatsApp(phoneNumber, `❌ Error detectado: ${errorMsg}`, phone_id);
      }
    }

    return res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

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

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
