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

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObject = value?.messages?.[0];

    if (messageObject) {
      const rawNumber = messageObject.from;
      const phoneNumber = rawNumber.replace(/^521/, '52');
      const messageText = messageObject.text?.body;
      const timestamp = parseInt(messageObject.timestamp);
      const wa_id = messageObject.id;
      const quotedId = messageObject.context?.id || null;

      console.log("📩 Mensaje recibido de " + phoneNumber + ": " + messageText);

      try {
        const db = await openDB();

        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
          [wa_id, phoneNumber, 'user', messageText, timestamp]
        );

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

        const historial = allMessages.map(m => ({
          role: m.rol === 'user' ? 'user' : 'assistant',
          content: m.contenido
        }));

        const conocimiento = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));
        const instrucciones = conocimiento.instrucciones_respuesta || [];

        const sistema = [
          { role: "system", content: conocimiento.contexto_negocio || "Eres un asistente virtual de Dinurba." },
          ...instrucciones.map(instr => ({ role: "system", content: instr }))
        ];

        // 🔍 Carga del mensaje citado
        let citado = null;
        let mensajeCitadoTexto = null;
        console.log("📌 quotedId recibido:", quotedId);

        if (quotedId) {
          let citadoDB = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);

          if (!citadoDB) {
            console.log("⏳ No encontrado, esperando 300ms y reintentando...");
            await new Promise(resolve => setTimeout(resolve, 300));
            citadoDB = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
          }

          if (citadoDB) {
            const quien = citadoDB.rol === 'user' ? 'el cliente' : 'Dinurba';
            mensajeCitadoTexto = citadoDB.contenido;
            console.log("✅ Mensaje citado encontrado:", mensajeCitadoTexto);
            citado = {
              role: 'system',
              content: `El cliente citó un mensaje anterior de ${quien}: "${mensajeCitadoTexto}". Luego escribió: "${messageText}". Responde interpretando la relación entre ambos.`
            };
          } else {
            console.log("⚠️ No se encontró el mensaje citado.");
            citado = {
              role: 'system',
              content: `El cliente está respondiendo a un mensaje anterior que no se encontró. Su mensaje fue: "${messageText}".`
            };
          }
        }

        const contexto = citado
          ? [...sistema, citado, ...historial]
          : [...sistema, ...historial];

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

        // 🔧 Armar texto DEBUG para WhatsApp
        let debugText = `\n\n[🔍 DEBUG]\nquotedId recibido: ${quotedId || 'Ninguno'}`;
        if (mensajeCitadoTexto) {
          debugText += `\nMensaje citado encontrado: "${mensajeCitadoTexto}"`;
        }

        let respuesta = respuestaGenerada + debugText;

        const respuestaWa = await axios.post(
          `https://graph.facebook.com/v18.0/${value.metadata.phone_number_id}/messages`,
          {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: { body: "🤖 " + respuesta }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const respuestaId = respuestaWa.data.messages?.[0]?.id || null;
        console.log("🟢 ID de mensaje enviado:", respuestaId);

        // Agregar ID de mensaje enviado al texto que va por WhatsApp
        respuesta += `\nID de la respuesta enviada por el bot: ${respuestaId}`;

        // Guardar respuesta final (ya con ID correcto)
        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
          [respuestaId, phoneNumber, 'dinurba', respuesta, Date.now() / 1000]
        );

        console.log("✅ Respuesta enviada a WhatsApp.");
      } catch (error) {
        console.error("❌ Error:", error.response?.data || error.message);
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
