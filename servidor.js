// servidor.js
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

async function openDB() {
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
}

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object) {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messageObject = value?.messages?.[0];

    if (messageObject) {
      let phoneNumber = messageObject.from;

      // Arreglo para quitar el "1" que mete WhatsApp si aparece después del 52
      if (phoneNumber.startsWith('521')) {
        phoneNumber = phoneNumber.replace(/^521/, '52');
      }

      const messageText = messageObject.text?.body;
      console.log("📩 Mensaje recibido de " + phoneNumber + ": " + messageText);

      const db = await openDB();
      const timestamp = Math.floor(Date.now() / 1000);

      // Guardar mensaje del cliente
      await db.run('INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
        phoneNumber, 'cliente', messageText, timestamp);

      // Obtener contexto: últimos 30 mensajes del cliente dentro de los últimos 6 meses
      const seisMesesAtras = timestamp - 60 * 60 * 24 * 30 * 6;
      const mensajesCliente = await db.all(
        `SELECT * FROM conversaciones
         WHERE numero = ? AND rol = 'cliente' AND timestamp >= ?
         ORDER BY timestamp DESC
         LIMIT 30`,
        phoneNumber, seisMesesAtras
      );

      let mensajesContexto = mensajesCliente;
      if (mensajesCliente.length > 0) {
        const primerTimestamp = mensajesCliente[mensajesCliente.length - 1].timestamp;
        const mensajesIAoPersonal = await db.all(
          `SELECT * FROM conversaciones
           WHERE numero = ? AND rol = 'ia' AND timestamp >= ?
           ORDER BY timestamp`,
          phoneNumber, primerTimestamp
        );
        mensajesContexto = [...mensajesCliente.reverse(), ...mensajesIAoPersonal];
      }

      // Cargar conocimiento Dinurba
      const conocimiento = JSON.parse(fs.readFileSync(path.join(__dirname, 'conocimiento_dinurba.json'), 'utf8'));

      const mensajesFormateados = [
        { role: 'system', content: conocimiento.contexto_negocio },
        ...conocimiento.instrucciones_respuesta.map(inst => ({ role: 'system', content: inst })),
        ...mensajesContexto.map(msg => ({
          role: msg.rol === 'cliente' ? 'user' : 'assistant',
          content: msg.contenido
        })),
        { role: 'user', content: messageText }
      ];

      try {
        const respuestaIA = await axios.post('https://api.openai.com/v1/chat/completions', {
          model: 'gpt-4',
          messages: mensajesFormateados
        }, {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          }
        });

        const respuesta = respuestaIA.data.choices[0].message.content;

        // Guardar respuesta IA en base de datos
        await db.run('INSERT INTO conversaciones (numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?)',
          phoneNumber, 'ia', respuesta, timestamp);

        // Enviar mensaje a WhatsApp
        await axios.post(`https://graph.facebook.com/v18.0/${value.metadata.phone_number_id}/messages`, {
          messaging_product: 'whatsapp',
          to: phoneNumber,
          text: { body: '🤖 ' + respuesta }
        }, {
          headers: {
            Authorization: `Bearer ${WHATSAPP_TOKEN}`,
            'Content-Type': 'application/json'
          }
        });

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
