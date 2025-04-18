const express = require('express');
const axios = require('axios');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ASSISTANT_ID = 'asst_NSwFHnPDYNWpuC9Yys5UozJR';

// ==================== Base de datos ====================

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

// ==================== WhatsApp ====================

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

// ==================== Webhook POST ====================

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (!body.object) return res.sendStatus(404);

  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messageObject = value?.messages?.[0];
  const phone_id = value?.metadata?.phone_number_id;

  if (!messageObject) return res.sendStatus(200);

  const rawNumber = messageObject.from;
  const phoneNumber = rawNumber.replace(/^521/, '52');
  const messageText = messageObject.text?.body;
  const timestamp = parseInt(messageObject.timestamp);
  const wa_id = messageObject.id;

  if (!messageText) return res.sendStatus(200);

  try {
    const db = await openDB();

    // Guardar mensaje del cliente
    await db.run(
      'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
      [wa_id, phoneNumber, 'user', messageText, timestamp]
    );

    // ==================== Assistant API ====================

    // 1. Crear un thread
    const thread = await axios.post(
      'https://api.openai.com/v1/threads',
      {},
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    const thread_id = thread.data.id;

    // 2. Agregar el mensaje del usuario al thread
    await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/messages`,
      {
        role: "user",
        content: messageText
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    // 3. Ejecutar el assistant
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      {
        assistant_id: ASSISTANT_ID
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    const run_id = run.data.id;

    // 4. Esperar a que el run finalice (polling)
    let status = "queued";
    while (status !== "completed" && status !== "failed") {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const check = await axios.get(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${run_id}`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );
      status = check.data.status;
    }

    // 5. Obtener la respuesta final
    if (status === "completed") {
      const messages = await axios.get(
        `https://api.openai.com/v1/threads/${thread_id}/messages`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );

      const respuesta = messages.data.data.find(m => m.role === 'assistant');
      const texto = respuesta?.content?.[0]?.text?.value || "No hubo respuesta.";

      await enviarMensajeWhatsApp(phoneNumber, texto.slice(0, 4096), phone_id);

      await db.run(
        'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
        [run_id, phoneNumber, 'dinurba', texto, Date.now() / 1000]
      );
    } else {
      await enviarMensajeWhatsApp(phoneNumber, "❌ El Assistant falló al procesar tu mensaje.", phone_id);
    }

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error("❌ Error:", msg);
    await enviarMensajeWhatsApp(phoneNumber, `❌ Error: ${msg}`, phone_id);
  }

  res.sendStatus(200);
});

// ==================== Webhook GET ====================

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

// ==================== Iniciar servidor ====================

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
