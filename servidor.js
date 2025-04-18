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
      // Log de la estructura completa del mensaje para depuración
      console.log("📝 Estructura completa del mensaje:", JSON.stringify(messageObject, null, 2));
      
      const rawNumber = messageObject.from;
      const phoneNumber = rawNumber.replace(/^521/, '52');
      const messageText = messageObject.text?.body;
      const timestamp = parseInt(messageObject.timestamp);
      
      // Mejora en la obtención del ID del mensaje citado
      const quotedMessage = messageObject.context?.id || messageObject.context?.message_id || null;
      console.log("🔗 ID del mensaje citado:", quotedMessage);

      console.log("📩 Mensaje recibido de " + phoneNumber + ": " + messageText);

      try {
        const db = await openDB();

        await db.run(
          'INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
          [phoneNumber, 'user', messageText, timestamp]
        );

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
        if (messageObject.context) {
          console.log("📋 Contexto completo:", JSON.stringify(messageObject.context, null, 2));
          
          // Intenta obtener el mensaje citado de la base de datos
          console.log("🔍 Buscando mensaje con ID:", quotedMessage);
          const mensajeCitado = await db.get('SELECT * FROM conversaciones WHERE id = ?', [quotedMessage]);
          console.log("🔎 Resultado de la búsqueda:", mensajeCitado);
          
          // Si existe en la base de datos, úsalo
          if (mensajeCitado) {
            const quien = mensajeCitado.rol === 'user' ? 'el cliente' : 'Dinurba';
            citado = {
              role: 'system',
              content: `IMPORTANTE: El cliente acaba de citar un mensaje anterior que decía: "${mensajeCitado.contenido}". 
              Luego escribió: "${messageText}". 
              Este nuevo mensaje hace referencia directa al mensaje citado.
              Responde interpretando la relación entre ambos mensajes.`
            };
          } 
          // Si no está en la base de datos pero la API proporciona el contenido
          else if (messageObject.context.quoted_message) {
            citado = {
              role: 'system',
              content: `IMPORTANTE: El cliente acaba de citar un mensaje que decía: "${messageObject.context.quoted_message}". 
              Luego escribió: "${messageText}". 
              Responde interpretando la relación entre ambos mensajes.`
            };
          }
          // Si no hay forma de obtener el contenido citado
          else {
            citado = {
              role: 'system',
              content: `El cliente está respondiendo a un mensaje anterior, pero no tenemos acceso a su contenido. 
              El cliente escribió: "${messageText}". 
              Responde lo mejor posible basándote en el contexto general de la conversación, sin mencionar 
              que no puedes ver el mensaje citado. Simplemente responde de la manera más útil posible.`
            };
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
