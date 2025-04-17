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
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

const openDB = async () => {
  const db = await open({
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

  return db;
};

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  } else {
    return res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObject = value?.messages?.[0];

    if (messageObject) {
      const rawNumber = messageObject.from;
      const phoneNumber = rawNumber.replace(/^52\s*1(?=\d{10}$)/, '521');
      const messageText = messageObject.text?.body;
      const timestamp = parseInt(messageObject.timestamp) * 1000;

      console.log("📩 Mensaje recibido de " + phoneNumber + ": " + messageText);

      try {
        const db = await openDB();

        await db.run(
          'INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
          [phoneNumber, 'user', messageText, timestamp]
        );

        const seisMesesAtras = Date.now() - 15778463000; // 6 meses
        const mensajesCliente = await db.all(
          'SELECT * FROM conversaciones WHERE numero = ? AND rol = ? AND timestamp >= ? ORDER BY timestamp DESC LIMIT 30',
          [phoneNumber, 'user', seisMesesAtras]
        );

        let historial = mensajesCliente;

        if (mensajesCliente.length > 0) {
          const timestampReferencia = mensajesCliente[mensajesCliente.length - 1].timestamp;
          const mensajesDinurba = await db.all(
            'SELECT * FROM conversaciones WHERE numero = ? AND rol = ? AND timestamp >= ? ORDER BY timestamp ASC',
            [phoneNumber, 'assistant', timestampReferencia]
          );
          historial = [...mensajesCliente, ...mensajesDinurba];
        }

        const mensajesFormateados = historial.map(m => ({
          role: m.rol,
          content: m.contenido.replace(/^🤖 /, '')
        }));

        const conocimiento = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));

        mensajesFormateados.unshift({
          role: 'system',
          content: `${conocimiento.contexto_negocio}\n${conocimiento.instrucciones_respuesta.join('\n')}`
        });

        const respuestaIA = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4',
            messages: mensajesFormateados,
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
          [phoneNumber, 'assistant', respuesta, Date.now()]
        );

        await axios.post(
          `https://graph.facebook.com/v18.0/${value.metadata.phone_number_id}/messages`,
          {
            messaging_product: 'whatsapp',
            to: phoneNumber,
            text: { body: `🤖 ${respuesta}` }
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

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
