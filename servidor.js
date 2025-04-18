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

    await db.exec(
      CREATE TABLE IF NOT EXISTS conversaciones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        wa_id TEXT,
        numero TEXT,
        rol TEXT,
        contenido TEXT,
        timestamp INTEGER
      )
    );
  }
  return db;
};

const enviarMensajeWhatsApp = async (numero, texto, phone_id) => {
  await axios.post(
    https://graph.facebook.com/v18.0/${phone_id}/messages,
    {
      messaging_product: "whatsapp",
      to: numero,
      text: { body: "🤖 " + texto }
    },
    {
      headers: {
        Authorization: Bearer ${WHATSAPP_TOKEN},
        'Content-Type': 'application/json'
      }
    }
  );
};

app.post('/webhook', async (req, res) => {
  if (!req.body || Object.keys(req.body).length === 0) {
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

        const seisMeses = 60 * 60 * 24 * 30 * 6;
        const desde = Date.now() / 1000 - seisMeses;

        const allMessages = await db.all(
          SELECT * FROM conversaciones
           WHERE numero = ? AND timestamp >= ?
           ORDER BY timestamp ASC,
          [phoneNumber, desde]
        );

        const conocimiento = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));
        const sistema = conocimiento.map(instr => ({ role: "system", content: instr }));

        const contexto = [...sistema];
        const wa_idsCitados = [];
        const bloquesSystem = [];
        let saltarUltimoMensajeUser = false;

        if (quotedId) {
          await enviarMensajeWhatsApp(phoneNumber, 📝 wa_id recibido:\n${wa_id}, phone_id);
          await enviarMensajeWhatsApp(phoneNumber, 📎 quotedId (context.id) recibido:\n${quotedId}, phone_id);
          await enviarMensajeWhatsApp(phoneNumber, 🔍 Buscando mensaje con wa_id =\n${quotedId}, phone_id);
        }

        for (let i = 0; i < allMessages.length; i++) {
          const m = allMessages[i];

          if (quotedId && m.wa_id === quotedId) {
            wa_idsCitados.push(m.wa_id);

            const quien = m.rol === 'user' ? 'el cliente' : 'Dinurba';
            const bloque = {
              role: 'system',
              content: El cliente citó un mensaje anterior de ${quien}: "${m.contenido}". Luego escribió: "${messageText}". Responde interpretando la relación entre ambos.
            };

            bloquesSystem.push({ posicion: i, bloque });

            await enviarMensajeWhatsApp(phoneNumber, ✅ Mensaje citado encontrado:\n"${m.contenido}", phone_id);
            await enviarMensajeWhatsApp(phoneNumber, 📦 Bloque generado para IA:\n${JSON.stringify(bloque, null, 2)}, phone_id);
            saltarUltimoMensajeUser = true;
          }
        }

        for (let i = 0; i < allMessages.length; i++) {
          const m = allMessages[i];

          if (m.rol === 'user' && wa_idsCitados.includes(m.wa_id)) {
            continue;
          }

          contexto.push({ role: m.rol === 'user' ? 'user' : 'assistant', content: m.contenido });

          const bloqueEnEstaPosicion = bloquesSystem.find(b => b.posicion === i);
          if (bloqueEnEstaPosicion) {
            contexto.push(bloqueEnEstaPosicion.bloque);
          }
        }

        if (!quotedId || !saltarUltimoMensajeUser) {
          contexto.push({ role: 'user', content: messageText });
        }

        const respuestaIA = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: "gpt-4",
            messages: contexto
          },
          {
            headers: {
              Authorization: Bearer ${OPENAI_API_KEY},
              'Content-Type': 'application/json'
            }
          }
        );

        const respuestaGenerada = respuestaIA.data.choices[0].message.content;

        const respuestaWa = await axios.post(
          https://graph.facebook.com/v18.0/${phone_id}/messages,
          {
            messaging_product: "whatsapp",
            to: phoneNumber,
            text: { body: "🤖 " + respuestaGenerada }
          },
          {
            headers: {
              Authorization: Bearer ${WHATSAPP_TOKEN},
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
        await enviarMensajeWhatsApp(phoneNumber, ❌ Error: ${errorMsg}, phone_id);
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
  console.log(🚀 Servidor corriendo en el puerto ${PORT});
});
