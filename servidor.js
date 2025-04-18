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
        timestamp INTEGER,
        quoted_wa_id TEXT
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

        // Guardar el mensaje del usuario
        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp, quoted_wa_id) VALUES (?, ?, ?, ?, ?, ?)',
          [wa_id, phoneNumber, 'user', messageText, timestamp, quotedId]
        );

        // Obtener historial de los últimos 6 meses
        const seisMeses = 60 * 60 * 24 * 30 * 6;
        const desde = Date.now() / 1000 - seisMeses;
        const allMessages = await db.all(
          `SELECT * FROM conversaciones
           WHERE numero = ? AND timestamp >= ?
           ORDER BY timestamp ASC`,
          [phoneNumber, desde]
        );

        // Cargar instrucciones del sistema
        const conocimiento = JSON.parse(fs.readFileSync('./conocimiento_dinurba.json', 'utf8'));
        const sistema = conocimiento.map(instr => ({ role: "system", content: instr }));
        const contexto = [...sistema];

        // Construir el contexto
        for (let i = 0; i < allMessages.length; i++) {
          const m = allMessages[i];

          // Omitir mensajes citados para evitar duplicación
          if (m.quoted_wa_id && allMessages.some(msg => msg.quoted_wa_id === m.wa_id && msg.rol === 'system_cita')) {
            continue;
          }

          // Agregar mensajes de usuario o asistente
          if (m.rol === 'user' || m.rol === 'dinurba') {
            contexto.push({
              role: m.rol === 'user' ? 'user' : 'assistant',
              content: m.contenido
            });
          } else if (m.rol === 'system_cita') {
            // Agregar bloques system_cita almacenados
            contexto.push(JSON.parse(m.contenido));
          }

          // Generar y guardar bloque system para la cita actual
          if (quotedId && m.wa_id === wa_id) {
            const citado = allMessages.find(msg => msg.wa_id === quotedId);
            if (citado) {
              const quien = citado.rol === 'user' ? 'el cliente' : 'Dinurba';
              const bloque = {
                role: 'system',
                content: `El cliente citó un mensaje anterior de ${quien}: "${citado.contenido}". Luego escribió: "${messageText}". Responde interpretando la relación entre ambos.`
              };
              contexto.push(bloque);

              // Guardar el bloque en la base de datos
              await db.run(
                'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp, quoted_wa_id) VALUES (?, ?, ?, ?, ?, ?)',
                [`system_${wa_id}`, phoneNumber, 'system_cita', JSON.stringify(bloque), timestamp + 0.1, quotedId]
              );

              // Enviar bloque al cliente para transparencia
              await enviarMensajeWhatsApp(
                phoneNumber,
                `Bloque generado para IA:\n${JSON.stringify(bloque, null, 2)}`,
                phone_id
              );
            } else {
              await enviarMensajeWhatsApp(
                phoneNumber,
                `⚠️ No se encontró el mensaje citado.`,
                phone_id
              );
            }
          }
        }

        // Enviar contexto final para depuración
        await enviarMensajeWhatsApp(
          phoneNumber,
          `📦 Contexto final enviado a la IA:\n${JSON.stringify(contexto, null, 2)}`,
          phone_id
        );

        // Llamada a la API de OpenAI
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

        // Enviar respuesta al cliente
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

        // Guardar respuesta del bot
        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp, quoted_wa_id) VALUES (?, ?, ?, ?, ?, ?)',
          [respuestaId, phoneNumber, 'dinurba', "🤖 " + respuestaGenerada, Date.now() / 1000, null]
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
