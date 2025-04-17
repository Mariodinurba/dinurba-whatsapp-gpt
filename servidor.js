const express = require('express');
const axios = require('axios');
const fs = require('fs');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const openDB = async () => {
  const db = await open({
    filename: './conversaciones.db',
    driver: sqlite3.Database
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
      const quotedMessage = messageObject.context?.id || null;

      console.log("📩 Mensaje recibido de " + phoneNumber + ": " + messageText);

      try {
        const db = await openDB();

        await db.run(
          'INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
          [phoneNumber, 'user', messageText, timestamp]
        );

        const rows = await db.all(
          `SELECT * FROM conversaciones 
           WHERE numero = ? AND timestamp >= ? 
           ORDER BY timestamp DESC LIMIT 30`,
          [phoneNumber, Date.now() / 1000 - 60 * 60 * 24 * 30 * 6]
        );

        const primerosMensajes = rows.reverse();
        const primerTimestamp = primerosMensajes[0]?.timestamp || 0;

        const enviadosPorDinurba = await db.all(
          `SELECT * FROM conversaciones 
           WHERE numero = ? AND rol = 'dinurba' AND timestamp >= ?
           ORDER BY timestamp ASC`,
          [phoneNumber, primerTimestamp]
        );

        const historial = [...primerosMensajes, ...enviadosPorDinurba].map(m => ({
          role: m.rol === 'user' ? 'user' : 'assistant',
          content: m.contenido
        }));

        const conocimiento_dinurba = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));
        const instrucciones = conocimiento_dinurba.instrucciones_respuesta || [];

        const sistema = [
          {
            role: "system",
            content: conocimiento_dinurba.contexto_negocio || "Eres un asistente virtual de Dinurba."
          },
          ...instrucciones.map(instr => ({
            role: "system",
            content: instr
          }))
        ];

        let citado = null;
        if (quotedMessage) {
          const mensajeCitado = await db.get('SELECT * FROM conversaciones WHERE id = ?', [quotedMessage]);
          if (mensajeCitado) {
            const quien = mensajeCitado.rol === 'user' ? 'el cliente' : 'Dinurba';
            
            // Instrucción más clara sobre cómo interpretar la relación
            citado = {
              role: 'system',
              content: `IMPORTANTE: El cliente acaba de citar un mensaje anterior que decía: "${mensajeCitado.contenido}". 
              Luego escribió: "${messageText}". 
              Este nuevo mensaje hace referencia directa al mensaje citado y NO son mensajes independientes.
              El cliente está preguntando, comentando o reaccionando específicamente al contenido citado.
              Responde tomando en cuenta esta relación contextual, como lo haría un humano en una conversación natural.`
            };
            
            // También podemos añadir un log para depuración
            console.log("🔍 Mensaje citado detectado:", mensajeCitado.contenido);
            console.log("📝 Nuevo mensaje relacionado:", messageText);
          }
        }

        const contexto = citado ? [...sistema, citado, ...historial] : [...sistema, ...historial];

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

        const respuesta = respuestaIA.data.choices[0].message.content;

        await db.run(
          'INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
          [phoneNumber, 'dinurba', respuesta, Date.now() / 1000]
        );

        await axios.post(
          `https://graph.facebook.com/v18.0/${value.metadata.phone_number_id}/messages`,
          {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: {
              body: "🤖 " + respuesta
            }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );

        console.log("✅ Respuesta enviada a WhatsApp.");
      } catch (error) {
        console.error("❌ Error enviando mensaje a WhatsApp o generando respuesta de IA:", error.response?.data || error.message);
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
