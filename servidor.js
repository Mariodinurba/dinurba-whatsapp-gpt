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
      const quotedMessageId = messageObject.context?.id || null;

      const pasos = [];
      const enviarPaso = async (texto) => {
        pasos.push(texto);
        await axios.post(
          `https://graph.facebook.com/v18.0/${value.metadata.phone_number_id}/messages`,
          {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: { body: `🤖 ${texto}` }
          },
          {
            headers: {
              Authorization: `Bearer ${WHATSAPP_TOKEN}`,
              'Content-Type': 'application/json'
            }
          }
        );
      };

      try {
        await enviarPaso("Paso 1: Se recibió un nuevo mensaje.");

        await enviarPaso("Paso 2: Número del cliente: " + phoneNumber);
        await enviarPaso("Paso 3: Texto del mensaje: " + messageText);

        if (quotedMessageId) {
          await enviarPaso("Paso 4: Este mensaje cita otro mensaje.");
          await enviarPaso("Paso 5: ID del mensaje citado: " + quotedMessageId);
        } else {
          await enviarPaso("Paso 4: Este mensaje no cita ningún otro.");
        }

        const db = await openDB();
        await enviarPaso("Paso 6: Guardando el mensaje recibido en la base de datos...");
        await db.run(
          'INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
          [phoneNumber, 'user', messageText, timestamp]
        );

        let citado = null;
        if (quotedMessageId) {
          await enviarPaso("Paso 7: Buscando el mensaje citado en la base de datos...");
          const mensajeCitado = await db.get(
            'SELECT * FROM conversaciones WHERE id = ?',
            [quotedMessageId]
          );

          if (mensajeCitado) {
            const quien = mensajeCitado.rol === 'user' ? 'el cliente' : 'Dinurba';
            await enviarPaso(`Paso 8: Mensaje citado encontrado. Lo escribió ${quien}.`);
            await enviarPaso("Contenido citado: " + mensajeCitado.contenido);
            citado = {
              role: 'system',
              content: `El cliente está citando el siguiente mensaje de ${quien}: "${mensajeCitado.contenido}". Luego escribió: "${messageText}". Interpreta ambos mensajes juntos y responde en consecuencia.`
            };
          } else {
            await enviarPaso("Paso 8: El mensaje citado no se encontró en la base de datos.");
          }
        }

        await enviarPaso("Paso 9: Cargando historial y contexto...");
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

        const userMessages = await db.all(
          `SELECT * FROM conversaciones 
           WHERE numero = ? AND rol = 'user' AND timestamp >= ? 
           ORDER BY timestamp DESC LIMIT 30`,
          [phoneNumber, Date.now() / 1000 - 60 * 60 * 24 * 30 * 6]
        );

        const primerTimestamp = userMessages.length > 0 ? userMessages[userMessages.length - 1].timestamp : Date.now() / 1000;

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

        const contexto = citado ? [...sistema, citado, ...historial] : [...sistema, ...historial];

        await enviarPaso("Paso 10: Enviando contexto a ChatGPT...");

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
        await enviarPaso("Paso 11: Respuesta generada por la IA: " + respuesta);

        await db.run(
          'INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
          [phoneNumber, 'dinurba', respuesta, Date.now() / 1000]
        );

        await enviarPaso("Paso 12: Enviando respuesta final al cliente...");

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

        console.log("✅ Respuesta enviada correctamente a WhatsApp.");
      } catch (error) {
        console.error("❌ Error general:", error.response?.data || error.message);
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
