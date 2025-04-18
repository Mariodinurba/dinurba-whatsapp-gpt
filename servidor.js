const express = require('express');
const axios = require('axios');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '1mb' }));

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
  if (!req.body || Object.keys(req.body).length === 0) {
    console.warn('⚠️ Webhook recibido sin cuerpo');
    return res.sendStatus(400);
  }

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

        let quotedInfo = `📝 wa_id recibido: ${wa_id}`;
        if (quotedId) {
          quotedInfo += `\n📎 quotedId (context.id) recibido: ${quotedId}`;
          quotedInfo += `\n🔍 Buscando mensaje con wa_id = ${quotedId}`;
        }

        await enviarMensajeWhatsApp(phoneNumber, quotedInfo, phone_id);

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

        const allMessages = await db.all(
          `SELECT * FROM conversaciones
           WHERE numero = ? AND timestamp >= ?
           ORDER BY timestamp ASC`,
          [phoneNumber, primerTimestamp]
        );

        const conocimiento = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));
        const sistema = conocimiento.map(instr => ({
          role: "system",
          content: instr
        }));

        const historial = [];
        const citas = [];

        for (const m of allMessages) {
          const citadoPorEste = m.wa_id === quotedId;

          if (m.rol === 'user') {
            const fueCita = m.wa_id === quotedId;
            if (!fueCita) {
              historial.push({ role: 'user', content: m.contenido });
            }
          } else {
            historial.push({ role: 'assistant', content: m.contenido });
          }

          if (quotedId && m.wa_id === quotedId) {
            const quien = m.rol === 'user' ? 'el cliente' : 'Dinurba';
            const bloqueCita = {
              role: 'system',
              content: `El cliente citó un mensaje anterior de ${quien}: "${m.contenido}". Luego escribió: "${messageText}". Responde interpretando la relación entre ambos.`
            };
            citas.push(bloqueCita);

            await enviarMensajeWhatsApp(phoneNumber, `✅ Mensaje citado encontrado:\n🧾 "${m.contenido}"`, phone_id);
            await enviarMensajeWhatsApp(phoneNumber, `🧠 Bloque system para IA:\n${bloqueCita.content}`, phone_id);
          }
        }

        const contexto = [...sistema, ...citas, ...historial];

        await enviarMensajeWhatsApp(phoneNumber, `📦 Contexto enviado a la IA:\n${JSON.stringify(contexto, null, 2)}`, phone_id);

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

      } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message;
        console.error("❌ Error:", errorMsg);
        await enviarMensajeWhatsApp(phoneNumber, `❌ Error: ${errorMsg}`, phone_id);
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
