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
const ASSISTANT_ID = 'asst_WXEwYWFnqSP60RLicaGonUIi';

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
  const response = await axios.post(
    `https://graph.facebook.com/v18.0/${phone_id}/messages`,
    {
      messaging_product: 'whatsapp',
      to: numero,
      text: { body: '🤖 ' + texto }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  );

  return response.data.messages?.[0]?.id || null;
};

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
  const quotedId = messageObject.context?.id || null;
  const tipo = messageObject.type || 'desconocido';

  if (!messageText) return res.sendStatus(200);

  try {
    const db = await openDB();

    // Guardar mensaje del cliente
    await db.run(
      'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
      [wa_id, phoneNumber, 'user', messageText, timestamp]
    );

    // Mostrar IDs por WhatsApp
    let info = `🧾 wa_id recibido:\n${wa_id}\n📦 Tipo de contenido: ${tipo}`;
    if (quotedId) {
      info += `\n📎 quotedId recibido:\n${quotedId}\n🔍 Buscando mensaje con wa_id = ${quotedId}`;
    }
    await enviarMensajeWhatsApp(phoneNumber, info, phone_id);

    // Buscar mensaje citado
    if (quotedId) {
      let citado = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
      if (!citado) {
        await new Promise(resolve => setTimeout(resolve, 300));
        citado = await db.get('SELECT * FROM conversaciones WHERE wa_id = ?', [quotedId]);
      }

      if (['user', 'dinurba', 'assistant', 'system'].includes(citado?.rol)) {
        const quien =
          citado.rol === 'user' ? 'el cliente' :
          citado.rol === 'dinurba' || citado.rol === 'assistant' ? 'Dinurba' :
          'el sistema';

        await enviarMensajeWhatsApp(phoneNumber, `✅ Mensaje citado encontrado:\n"${citado.contenido}"`, phone_id);

        const bloque = `El cliente citó un mensaje anterior de ${quien}: "${citado.contenido}". Y escribió sobre el mensaje citado: "${messageText}".`;

        await db.run(
          'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
          [`system-${wa_id}`, phoneNumber, 'system', bloque, timestamp]
        );

        await enviarMensajeWhatsApp(phoneNumber, `🤖 Bloque system guardado:\n${bloque}`, phone_id);

        await db.run('UPDATE conversaciones SET rol = ? WHERE wa_id = ?', ['user_omitido', wa_id]);
      }
    }

    // Obtener contexto de 30 mensajes
    const seisMeses = 60 * 60 * 24 * 30 * 6;
    const desde = Date.now() / 1000 - seisMeses;

    const mensajesCliente = await db.all(
      `SELECT * FROM conversaciones WHERE numero = ? AND rol = 'user' AND timestamp >= ? ORDER BY timestamp DESC LIMIT 30`,
      [phoneNumber, desde]
    );

    const primerTimestamp = mensajesCliente.length > 0
      ? mensajesCliente[mensajesCliente.length - 1].timestamp
      : Date.now() / 1000;

    const allMessages = await db.all(
      `SELECT * FROM conversaciones WHERE numero = ? AND timestamp >= ? ORDER BY timestamp ASC`,
      [phoneNumber, primerTimestamp]
    );

    const contexto = allMessages
      .filter(msg => msg.rol !== 'user_omitido')
      .map(msg => ({
        role: msg.rol === 'system' ? 'user' : (msg.rol === 'user' ? 'user' : 'assistant'),
        content: msg.contenido
      }));

    await enviarMensajeWhatsApp(phoneNumber, `🧠 Contexto enviado a la IA:\n\`\`\`\n${JSON.stringify(contexto, null, 2)}\n\`\`\``, phone_id);

    // Crear thread en Assistants API
    const thread = await axios.post('https://api.openai.com/v1/threads', {}, {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
        'OpenAI-Beta': 'assistants=v2'
      }
    });

    const thread_id = thread.data.id;

    // Enviar todos los mensajes al thread
    for (const msg of contexto) {
      await axios.post(
        `https://api.openai.com/v1/threads/${thread_id}/messages`,
        { role: msg.role, content: msg.content },
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'Content-Type': 'application/json',
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );
    }

    // Ejecutar Assistant
    const run = await axios.post(
      `https://api.openai.com/v1/threads/${thread_id}/runs`,
      { assistant_id: ASSISTANT_ID },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'OpenAI-Beta': 'assistants=v2'
        }
      }
    );

    // Esperar a que termine
    let status = 'queued';
    while (status !== 'completed' && status !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const check = await axios.get(
        `https://api.openai.com/v1/threads/${thread_id}/runs/${run.data.id}`,
        {
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            'OpenAI-Beta': 'assistants=v2'
          }
        }
      );
      status = check.data.status;
    }

    // Obtener respuesta final
    if (status === 'completed') {
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
      const texto = respuesta?.content?.[0]?.text?.value || 'No hubo respuesta.';

      const respuestaId = await enviarMensajeWhatsApp(phoneNumber, texto.slice(0, 4096), phone_id);

      await db.run(
        'INSERT INTO conversaciones (wa_id, numero, rol, contenido, timestamp) VALUES (?, ?, ?, ?, ?)',
        [respuestaId, phoneNumber, 'dinurba', texto, Date.now() / 1000]
      );
    } else {
      await enviarMensajeWhatsApp(phoneNumber, '❌ El Assistant falló al procesar tu mensaje.', phone_id);
    }

  } catch (error) {
    const msg = error.response?.data?.error?.message || error.message;
    console.error('❌ Error:', msg);
    await enviarMensajeWhatsApp(phoneNumber, `❌ Error: ${msg}`, phone_id);
  }

  res.sendStatus(200);
});

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token && token === process.env.VERIFY_TOKEN) {
    console.log('✅ Webhook verificado.');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Servidor corriendo en el puerto ${PORT}`);
});
